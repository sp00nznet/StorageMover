import { Router, Request, Response } from 'express';
import { authenticateToken } from './auth';
import { logger } from '../utils/logger';
import { mountCloningService, CreateMountCloneRequest } from '../services/mountCloning';
import { dbGet, dbAll } from '../database/init';
import { WindowsFileServerClient } from '../services/windows';
import { decryptPassword } from '../utils/crypto';

export const mountCloneRouter = Router();

// Apply authentication to all mount clone routes
mountCloneRouter.use(authenticateToken);

interface Device {
  id: string;
  name: string;
  type: string;
  hostname: string;
  port: number;
  username: string;
  password_encrypted: string;
}

// Get all mount clones
mountCloneRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { targetDeviceId } = req.query;
    const clones = await mountCloningService.listMountClones(targetDeviceId as string);
    res.json(clones);
  } catch (error) {
    logger.error('Failed to get mount clones:', error);
    res.status(500).json({ error: 'Failed to get mount clones' });
  }
});

// Get single mount clone with status and logs
mountCloneRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const status = await mountCloningService.getMountCloneStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Mount clone not found' });
    }
    res.json(status);
  } catch (error) {
    logger.error('Failed to get mount clone:', error);
    res.status(500).json({ error: 'Failed to get mount clone' });
  }
});

// Get logs for a mount clone
mountCloneRouter.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const logs = await mountCloningService.getCloneLogs(req.params.id, limit);
    res.json(logs);
  } catch (error) {
    logger.error('Failed to get mount clone logs:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// Create new mount clone
mountCloneRouter.post('/', async (req: Request, res: Response) => {
  try {
    const {
      name,
      sourceType,
      sourceHostname,
      sourcePath,
      sourceUsername,
      sourcePassword,
      targetDeviceId,
      shareName,
      shareType,
      persistent
    } = req.body;

    if (!name || !sourceType || !sourceHostname || !sourcePath || !targetDeviceId) {
      return res.status(400).json({ error: 'Missing required fields: name, sourceType, sourceHostname, sourcePath, targetDeviceId' });
    }

    const validSourceTypes = ['linux_nfs', 'linux_smb', 'windows_smb', 'powerscale_nfs', 'powerscale_smb', 'isilon_nfs', 'isilon_smb'];
    if (!validSourceTypes.includes(sourceType)) {
      return res.status(400).json({ error: `Invalid sourceType. Must be one of: ${validSourceTypes.join(', ')}` });
    }

    const request: CreateMountCloneRequest = {
      name,
      sourceType,
      sourceHostname,
      sourcePath,
      sourceUsername,
      sourcePassword,
      targetDeviceId,
      shareName,
      shareType,
      persistent
    };

    const result = await mountCloningService.createMountClone(request);

    if (result.success) {
      logger.info(`Mount clone created: ${name} (${result.cloneId})`);
      res.status(201).json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error('Failed to create mount clone:', error);
    res.status(500).json({ error: 'Failed to create mount clone' });
  }
});

// Create mount clone from existing export
mountCloneRouter.post('/from-export', async (req: Request, res: Response) => {
  try {
    const { exportId, targetDeviceId, shareName, shareType, persistent } = req.body;

    if (!exportId || !targetDeviceId) {
      return res.status(400).json({ error: 'Missing required fields: exportId, targetDeviceId' });
    }

    const result = await mountCloningService.cloneFromExport(exportId, targetDeviceId, {
      shareName,
      shareType,
      persistent
    });

    if (result.success) {
      logger.info(`Mount clone created from export: ${exportId} -> ${result.cloneId}`);
      res.status(201).json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error('Failed to create mount clone from export:', error);
    res.status(500).json({ error: 'Failed to create mount clone from export' });
  }
});

// Batch create mount clones from exports
mountCloneRouter.post('/from-exports-batch', async (req: Request, res: Response) => {
  try {
    const { exportIds, targetDeviceId, shareType, persistent } = req.body;

    if (!exportIds?.length || !targetDeviceId) {
      return res.status(400).json({ error: 'Missing required fields: exportIds (array), targetDeviceId' });
    }

    const result = await mountCloningService.cloneExportsBatch(exportIds, targetDeviceId, {
      shareType,
      persistent
    });

    logger.info(`Batch mount clone: ${result.summary.succeeded}/${result.summary.total} succeeded`);
    res.json(result);
  } catch (error) {
    logger.error('Failed to batch create mount clones:', error);
    res.status(500).json({ error: 'Failed to batch create mount clones' });
  }
});

// Retry failed mount clone
mountCloneRouter.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const result = await mountCloningService.retryMountClone(req.params.id);

    if (result.success) {
      logger.info(`Mount clone retry initiated: ${req.params.id}`);
      res.json({ message: 'Retry initiated', cloneId: req.params.id });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error('Failed to retry mount clone:', error);
    res.status(500).json({ error: 'Failed to retry mount clone' });
  }
});

// Remove mount clone
mountCloneRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await mountCloningService.removeMountClone(req.params.id);

    if (result.success) {
      logger.info(`Mount clone removed: ${req.params.id}`);
      res.json({ message: 'Mount clone removed' });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error('Failed to remove mount clone:', error);
    res.status(500).json({ error: 'Failed to remove mount clone' });
  }
});

// Health check all active clones
mountCloneRouter.get('/health/all', async (req: Request, res: Response) => {
  try {
    const result = await mountCloningService.healthCheckAll();
    res.json(result);
  } catch (error) {
    logger.error('Failed to health check mount clones:', error);
    res.status(500).json({ error: 'Failed to health check' });
  }
});

// Health check single clone
mountCloneRouter.post('/:id/health-check', async (req: Request, res: Response) => {
  try {
    const status = await mountCloningService.getMountCloneStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Mount clone not found' });
    }
    res.json({ health: status.health, clone: status.clone });
  } catch (error) {
    logger.error('Failed to health check mount clone:', error);
    res.status(500).json({ error: 'Failed to health check' });
  }
});

// Discover remote shares from a host (for finding what can be cloned)
mountCloneRouter.post('/discover-remote', async (req: Request, res: Response) => {
  try {
    const { targetDeviceId, remoteHostname, shareType, username, password } = req.body;

    if (!targetDeviceId || !remoteHostname || !shareType) {
      return res.status(400).json({ error: 'Missing required fields: targetDeviceId, remoteHostname, shareType' });
    }

    // Get target Windows device
    const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [targetDeviceId]);
    if (!targetDevice) {
      return res.status(404).json({ error: 'Target device not found' });
    }
    if (targetDevice.type !== 'windows') {
      return res.status(400).json({ error: 'Target device must be a Windows file server' });
    }

    // Create Windows client and discover shares
    const targetPassword = decryptPassword(targetDevice.password_encrypted);
    const windowsClient = new WindowsFileServerClient(
      targetDevice.hostname,
      targetDevice.port,
      targetDevice.username,
      targetPassword
    );

    const result = await windowsClient.discoverRemoteShares(
      remoteHostname,
      shareType,
      username,
      password
    );

    logger.info(`Discovered ${result.shares.length} ${shareType} shares on ${remoteHostname}`);
    res.json(result);
  } catch (error) {
    logger.error('Failed to discover remote shares:', error);
    res.status(500).json({ error: 'Failed to discover remote shares' });
  }
});

// Get mount clone statistics
mountCloneRouter.get('/stats/summary', async (req: Request, res: Response) => {
  try {
    const stats = await dbGet<{
      total: number;
      pending: number;
      active: number;
      failed: number;
      disconnected: number;
    }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' OR status = 'mounting' OR status = 'creating_share' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END) as disconnected
      FROM mount_clones
      WHERE status != 'removed'
    `, []);

    res.json(stats);
  } catch (error) {
    logger.error('Failed to get mount clone statistics:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// List cloned mounts on Windows server (direct query)
mountCloneRouter.get('/windows/:deviceId/mounts', async (req: Request, res: Response) => {
  try {
    const device = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [req.params.deviceId]);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    if (device.type !== 'windows') {
      return res.status(400).json({ error: 'Device must be a Windows file server' });
    }

    const password = decryptPassword(device.password_encrypted);
    const windowsClient = new WindowsFileServerClient(device.hostname, device.port, device.username, password);

    const result = await windowsClient.listClonedMounts();
    res.json(result);
  } catch (error) {
    logger.error('Failed to list cloned mounts:', error);
    res.status(500).json({ error: 'Failed to list cloned mounts' });
  }
});
