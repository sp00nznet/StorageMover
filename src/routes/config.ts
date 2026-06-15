import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../database/init';
import { logger } from '../utils/logger';
import { authenticateToken } from './auth';
import { decryptPassword } from '../utils/crypto';
import { PowerScaleClient, MigrationConfig, NfsAlias } from '../services/powerscale';
import { PowerStoreClient } from '../services/powerstore';
import { WindowsFileServerClient, WindowsExportConfig } from '../services/windows';

export const configRouter = Router();

configRouter.use(authenticateToken);

// Collect NFS aliases for the source device behind a set of selected exports.
// Prefers an explicit sourceDeviceId; otherwise derives it from the exports'
// own device_id. Aliases are device-wide, so all of the source's are returned.
async function getAliasesForExports(
  exports: { device_id?: string }[],
  sourceDeviceId?: string
): Promise<NfsAlias[]> {
  const deviceIds = new Set<string>();
  if (sourceDeviceId) deviceIds.add(sourceDeviceId);
  for (const e of exports) {
    if (e.device_id) deviceIds.add(e.device_id);
  }
  if (deviceIds.size === 0) return [];

  const ids = Array.from(deviceIds);
  const rows = await dbAll<{ name: string; path: string; zone: string }>(
    `SELECT name, path, zone FROM nfs_aliases WHERE device_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return rows.map(r => ({ name: r.name, path: r.path, zone: r.zone || 'System' }));
}

interface Device {
  id: string;
  name: string;
  type: string;
  hostname: string;
  port: number;
  username: string;
  password_encrypted: string;
}

interface ConfigExport {
  id: string;
  device_id: string;
  config_type: string;
  config_data: string;
  created_at: string;
}

// Generate PowerScale migration configuration script
configRouter.post('/powerscale/generate', async (req: Request, res: Response) => {
  try {
    const { targetDeviceId, sourceDeviceId, exportIds, targetBasePath, nfsSettings, smbSettings } = req.body;

    if (!targetDeviceId || !exportIds?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [targetDeviceId]);
    if (!targetDevice || targetDevice.type !== 'powerscale') {
      return res.status(400).json({ error: 'Target device must be a PowerScale device' });
    }

    // Get source exports (with full captured config for faithful recreation)
    const exports = await dbAll<{ export_path: string; export_type: string; raw_config: string | null; device_id: string }>(`
      SELECT export_path, export_type, raw_config, device_id FROM exports WHERE id IN (${exportIds.map(() => '?').join(',')})
    `, exportIds);

    // Pull NFS aliases for the source device(s) so they migrate too
    const aliases = await getAliasesForExports(exports, sourceDeviceId);

    const config: MigrationConfig = {
      sourceExports: exports.map(e => ({
        path: e.export_path,
        type: e.export_type,
        rawConfig: e.raw_config ? JSON.parse(e.raw_config) : undefined
      })),
      aliases,
      targetBasePath: targetBasePath || '',
      nfsSettings: {
        rootSquash: nfsSettings?.rootSquash ?? true,
        accessZone: nfsSettings?.accessZone || 'System'
      },
      smbSettings: {
        allowGuest: smbSettings?.allowGuest ?? false,
        accessZone: smbSettings?.accessZone || 'System'
      }
    };

    const password = decryptPassword(targetDevice.password_encrypted);
    const client = new PowerScaleClient(targetDevice.hostname, targetDevice.port, targetDevice.username, password);

    const script = await client.generateMigrationConfig(config);

    // Save configuration
    const configId = uuidv4();
    await dbRun(`
      INSERT INTO config_exports (id, device_id, config_type, config_data)
      VALUES (?, ?, 'powerscale_migration', ?)
    `, [configId, targetDeviceId, script]);

    res.json({
      configId,
      script,
      exportCount: exports.length
    });
  } catch (error) {
    logger.error('Failed to generate PowerScale config:', error);
    res.status(500).json({ error: 'Failed to generate configuration' });
  }
});

// Apply PowerScale configuration directly
configRouter.post('/powerscale/apply', async (req: Request, res: Response) => {
  try {
    const { targetDeviceId, sourceDeviceId, exportIds, targetBasePath, nfsSettings, smbSettings } = req.body;

    if (!targetDeviceId || !exportIds?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [targetDeviceId]);
    if (!targetDevice || targetDevice.type !== 'powerscale') {
      return res.status(400).json({ error: 'Target device must be a PowerScale device' });
    }

    // Get source exports (with full captured config for faithful recreation)
    const exports = await dbAll<{ export_path: string; export_type: string; raw_config: string | null; device_id: string }>(`
      SELECT export_path, export_type, raw_config, device_id FROM exports WHERE id IN (${exportIds.map(() => '?').join(',')})
    `, exportIds);

    const aliases = await getAliasesForExports(exports, sourceDeviceId);

    const config: MigrationConfig = {
      sourceExports: exports.map(e => ({
        path: e.export_path,
        type: e.export_type,
        rawConfig: e.raw_config ? JSON.parse(e.raw_config) : undefined
      })),
      aliases,
      targetBasePath: targetBasePath || '',
      nfsSettings: {
        rootSquash: nfsSettings?.rootSquash ?? true,
        accessZone: nfsSettings?.accessZone || 'System'
      },
      smbSettings: {
        allowGuest: smbSettings?.allowGuest ?? false,
        accessZone: smbSettings?.accessZone || 'System'
      }
    };

    const password = decryptPassword(targetDevice.password_encrypted);
    const client = new PowerScaleClient(targetDevice.hostname, targetDevice.port, targetDevice.username, password);

    const result = await client.applyMigrationConfig(config);

    res.json({
      success: result.success,
      results: result.results
    });
  } catch (error) {
    logger.error('Failed to apply PowerScale config:', error);
    res.status(500).json({ error: 'Failed to apply configuration' });
  }
});

// Export PowerStore configuration
configRouter.post('/powerstore/export', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const device = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device || device.type !== 'powerstore') {
      return res.status(400).json({ error: 'Device must be a PowerStore device' });
    }

    const password = decryptPassword(device.password_encrypted);
    const client = new PowerStoreClient(device.hostname, device.port, device.username, password);

    const config = await client.exportConfiguration();
    const configScript = client.generateConfigScript(config);

    // Save configuration
    const configId = uuidv4();
    await dbRun(`
      INSERT INTO config_exports (id, device_id, config_type, config_data)
      VALUES (?, ?, 'powerstore_export', ?)
    `, [configId, deviceId, configScript]);

    res.json({
      configId,
      config,
      script: configScript
    });
  } catch (error) {
    logger.error('Failed to export PowerStore config:', error);
    res.status(500).json({ error: 'Failed to export configuration' });
  }
});

// Import configuration to PowerStore
configRouter.post('/powerstore/import', async (req: Request, res: Response) => {
  try {
    const { deviceId, config } = req.body;

    if (!deviceId || !config) {
      return res.status(400).json({ error: 'Device ID and config are required' });
    }

    const device = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device || device.type !== 'powerstore') {
      return res.status(400).json({ error: 'Device must be a PowerStore device' });
    }

    const password = decryptPassword(device.password_encrypted);
    const client = new PowerStoreClient(device.hostname, device.port, device.username, password);

    const result = await client.importConfiguration(config);

    res.json({
      success: result.success,
      results: result.results
    });
  } catch (error) {
    logger.error('Failed to import PowerStore config:', error);
    res.status(500).json({ error: 'Failed to import configuration' });
  }
});

// Generate Windows file server configuration script
configRouter.post('/windows/generate', async (req: Request, res: Response) => {
  try {
    const { targetDeviceId, exportIds, targetBasePath, smbSettings, nfsSettings } = req.body;

    if (!targetDeviceId || !exportIds?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [targetDeviceId]);
    if (!targetDevice || targetDevice.type !== 'windows') {
      return res.status(400).json({ error: 'Target device must be a Windows file server' });
    }

    // Get source exports with additional details
    const exports = await dbAll<{
      export_path: string;
      export_type: string;
      clients: string;
      permissions: string;
      description: string;
    }>(`
      SELECT export_path, export_type, clients, permissions, description
      FROM exports
      WHERE id IN (${exportIds.map(() => '?').join(',')})
    `, exportIds);

    const config: WindowsExportConfig = {
      sourceExports: exports.map(e => ({
        path: e.export_path,
        type: e.export_type as 'nfs' | 'smb' | 'both',
        clients: e.clients ? JSON.parse(e.clients) : ['*'],
        permissions: e.permissions,
        description: e.description
      })),
      targetBasePath: targetBasePath || 'C:\\Shares',
      smbSettings: {
        fullAccess: smbSettings?.fullAccess || ['Everyone'],
        changeAccess: smbSettings?.changeAccess || [],
        readAccess: smbSettings?.readAccess || [],
        noAccess: smbSettings?.noAccess || [],
        cachingMode: smbSettings?.cachingMode || 'Manual',
        encryptData: smbSettings?.encryptData || false
      },
      nfsSettings: nfsSettings || {
        allowRootAccess: false,
        enableUnmappedAccess: true,
        authentication: ['sys', 'krb5', 'krb5i']
      }
    };

    const password = decryptPassword(targetDevice.password_encrypted);
    const client = new WindowsFileServerClient(
      targetDevice.hostname,
      targetDevice.port,
      targetDevice.username,
      password
    );

    const script = await client.generateExportScript(config);

    // Save configuration
    const configId = uuidv4();
    await dbRun(`
      INSERT INTO config_exports (id, device_id, config_type, config_data)
      VALUES (?, ?, 'windows_export', ?)
    `, [configId, targetDeviceId, script]);

    res.json({
      configId,
      script,
      exportCount: exports.length
    });
  } catch (error) {
    logger.error('Failed to generate Windows config:', error);
    res.status(500).json({ error: 'Failed to generate configuration' });
  }
});

// Apply Windows file server configuration directly
configRouter.post('/windows/apply', async (req: Request, res: Response) => {
  try {
    const { targetDeviceId, exportIds, targetBasePath, smbSettings, nfsSettings } = req.body;

    if (!targetDeviceId || !exportIds?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [targetDeviceId]);
    if (!targetDevice || targetDevice.type !== 'windows') {
      return res.status(400).json({ error: 'Target device must be a Windows file server' });
    }

    // Get source exports with additional details
    const exports = await dbAll<{
      export_path: string;
      export_type: string;
      clients: string;
      permissions: string;
      description: string;
    }>(`
      SELECT export_path, export_type, clients, permissions, description
      FROM exports
      WHERE id IN (${exportIds.map(() => '?').join(',')})
    `, exportIds);

    const config: WindowsExportConfig = {
      sourceExports: exports.map(e => ({
        path: e.export_path,
        type: e.export_type as 'nfs' | 'smb' | 'both',
        clients: e.clients ? JSON.parse(e.clients) : ['*'],
        permissions: e.permissions,
        description: e.description
      })),
      targetBasePath: targetBasePath || 'C:\\Shares',
      smbSettings: {
        fullAccess: smbSettings?.fullAccess || ['Everyone'],
        changeAccess: smbSettings?.changeAccess || [],
        readAccess: smbSettings?.readAccess || [],
        noAccess: smbSettings?.noAccess || [],
        cachingMode: smbSettings?.cachingMode || 'Manual',
        encryptData: smbSettings?.encryptData || false
      },
      nfsSettings: nfsSettings || {
        allowRootAccess: false,
        enableUnmappedAccess: true,
        authentication: ['sys', 'krb5', 'krb5i']
      }
    };

    const password = decryptPassword(targetDevice.password_encrypted);
    const client = new WindowsFileServerClient(
      targetDevice.hostname,
      targetDevice.port,
      targetDevice.username,
      password
    );

    const result = await client.applyExportConfig(config);

    res.json({
      success: result.success,
      results: result.results
    });
  } catch (error) {
    logger.error('Failed to apply Windows config:', error);
    res.status(500).json({ error: 'Failed to apply configuration' });
  }
});

// Get saved configurations
configRouter.get('/saved', async (req: Request, res: Response) => {
  try {
    const deviceId = req.query.deviceId as string;
    let query = `
      SELECT ce.*, d.name as device_name
      FROM config_exports ce
      JOIN devices d ON ce.device_id = d.id
    `;
    const params: any[] = [];

    if (deviceId) {
      query += ' WHERE ce.device_id = ?';
      params.push(deviceId);
    }

    query += ' ORDER BY ce.created_at DESC';

    const configs = await dbAll<ConfigExport & { device_name: string }>(query, params);
    res.json(configs);
  } catch (error) {
    logger.error('Failed to get saved configs:', error);
    res.status(500).json({ error: 'Failed to get saved configurations' });
  }
});

// Get single configuration
configRouter.get('/saved/:id', async (req: Request, res: Response) => {
  try {
    const config = await dbGet<ConfigExport & { device_name: string }>(`
      SELECT ce.*, d.name as device_name
      FROM config_exports ce
      JOIN devices d ON ce.device_id = d.id
      WHERE ce.id = ?
    `, [req.params.id]);

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    res.json(config);
  } catch (error) {
    logger.error('Failed to get config:', error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

// Delete saved configuration
configRouter.delete('/saved/:id', async (req: Request, res: Response) => {
  try {
    await dbRun('DELETE FROM config_exports WHERE id = ?', [req.params.id]);
    res.json({ message: 'Configuration deleted' });
  } catch (error) {
    logger.error('Failed to delete config:', error);
    res.status(500).json({ error: 'Failed to delete configuration' });
  }
});

// Download configuration as file
configRouter.get('/download/:id', async (req: Request, res: Response) => {
  try {
    const config = await dbGet<ConfigExport>('SELECT * FROM config_exports WHERE id = ?', [req.params.id]);

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    let extension = 'sh';
    if (config.config_type.includes('powerstore')) {
      extension = 'json';
    } else if (config.config_type.includes('windows')) {
      extension = 'ps1';
    }
    const filename = `storagemover_config_${config.config_type}_${new Date().toISOString().split('T')[0]}.${extension}`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(config.config_data);
  } catch (error) {
    logger.error('Failed to download config:', error);
    res.status(500).json({ error: 'Failed to download configuration' });
  }
});
