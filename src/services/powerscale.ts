import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../utils/logger';

// Normalized, full-fidelity snapshot of a source export/share so the target
// can be recreated faithfully (real client lists, RO/RW split, root mapping,
// security flavors) instead of a generic clients=* export.
export interface ExportRawConfig {
  paths?: string[];
  clients?: string[];
  root_clients?: string[];
  read_only_clients?: string[];
  read_write_clients?: string[];
  read_only?: boolean;
  all_dirs?: boolean;
  security_flavors?: string[];
  map_root?: { enabled?: boolean; user?: string };
  map_all?: { enabled?: boolean; user?: string };
  description?: string;
  zone?: string;
  // SMB-only
  smb_name?: string;
  smb_browsable?: boolean;
}

export interface PowerScaleExport {
  id: string;
  path: string;
  type: 'nfs' | 'smb' | 'both';
  clients: string[];
  permissions: string;
  description: string;
  size: number;
  rawConfig?: ExportRawConfig;
}

export interface NfsAlias {
  name: string;
  path: string;
  zone?: string;
  health?: string;
}

export interface MigrationConfig {
  sourceExports: { path: string; type: string; rawConfig?: ExportRawConfig }[];
  aliases?: NfsAlias[];
  targetBasePath: string;
  nfsSettings: {
    rootSquash: boolean;
    accessZone: string;
  };
  smbSettings: {
    allowGuest: boolean;
    accessZone: string;
  };
}

export class PowerScaleClient {
  private client: AxiosInstance;
  private hostname: string;
  private username: string;
  private password: string;
  private sessionCookie: string | null = null;

  constructor(hostname: string, port: number, username: string, password: string) {
    this.hostname = hostname;
    this.username = username;
    this.password = password;

    this.client = axios.create({
      baseURL: `https://${hostname}:${port}`,
      timeout: 30000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      })
    });
  }

  async authenticate(): Promise<boolean> {
    try {
      const response = await this.client.post('/session/1/session', {
        username: this.username,
        password: this.password,
        services: ['platform', 'namespace']
      });

      if (response.headers['set-cookie']) {
        this.sessionCookie = response.headers['set-cookie'][0];
        this.client.defaults.headers.common['Cookie'] = this.sessionCookie;
      }

      logger.info(`Authenticated with PowerScale: ${this.hostname}`);
      return true;
    } catch (error) {
      logger.error(`PowerScale authentication failed for ${this.hostname}:`, error);
      return false;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.authenticate();
      const response = await this.client.get('/platform/1/cluster/identity');
      return response.status === 200;
    } catch (error) {
      logger.error(`PowerScale connection test failed:`, error);
      return false;
    }
  }

  async getClusterInfo(): Promise<any> {
    await this.authenticate();
    const response = await this.client.get('/platform/1/cluster/identity');
    return response.data;
  }

  async discoverExports(): Promise<PowerScaleExport[]> {
    await this.authenticate();
    const exports: PowerScaleExport[] = [];

    // Discover NFS exports
    try {
      const nfsResponse = await this.client.get('/platform/4/protocols/nfs/exports');
      if (nfsResponse.data.exports) {
        for (const exp of nfsResponse.data.exports) {
          const path = exp.paths?.[0] || exp.path;
          exports.push({
            id: `nfs-${exp.id}`,
            path,
            type: 'nfs',
            clients: exp.clients || ['*'],
            permissions: exp.root_clients?.length ? 'no_root_squash' : 'root_squash',
            description: exp.description || `NFS Export: ${path}`,
            size: 0,
            rawConfig: {
              paths: exp.paths || (exp.path ? [exp.path] : []),
              clients: exp.clients || [],
              root_clients: exp.root_clients || [],
              read_only_clients: exp.read_only_clients || [],
              read_write_clients: exp.read_write_clients || [],
              read_only: !!exp.read_only,
              all_dirs: !!exp.all_dirs,
              security_flavors: exp.security_flavors || [],
              map_root: exp.map_root && exp.map_root.enabled
                ? { enabled: true, user: exp.map_root.user?.name || exp.map_root.user?.id }
                : { enabled: false },
              map_all: exp.map_all && exp.map_all.enabled
                ? { enabled: true, user: exp.map_all.user?.name || exp.map_all.user?.id }
                : { enabled: false },
              description: exp.description || '',
              zone: exp.zone || 'System'
            }
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to get NFS exports from PowerScale:', error);
    }

    // Discover SMB shares
    try {
      const smbResponse = await this.client.get('/platform/12/protocols/smb/shares');
      if (smbResponse.data.shares) {
        for (const share of smbResponse.data.shares) {
          const smbRaw: ExportRawConfig = {
            smb_name: share.name,
            smb_browsable: share.browsable !== false,
            description: share.description || '',
            zone: share.zone || 'System'
          };
          const existingIndex = exports.findIndex(e => e.path === share.path);
          if (existingIndex >= 0) {
            exports[existingIndex].type = 'both';
            // keep both the NFS rawConfig and the SMB name/description
            exports[existingIndex].rawConfig = {
              ...(exports[existingIndex].rawConfig || {}),
              smb_name: smbRaw.smb_name,
              smb_browsable: smbRaw.smb_browsable
            };
          } else {
            exports.push({
              id: `smb-${share.id}`,
              path: share.path,
              type: 'smb',
              clients: ['*'],
              permissions: 'read-write',
              description: share.description || `SMB Share: ${share.name}`,
              size: 0,
              rawConfig: smbRaw
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to get SMB shares from PowerScale:', error);
    }

    return exports;
  }

  // Discover NFS aliases (short names like /rht that point at a real /ifs path).
  // These are separate from exports and are otherwise easy to miss in a migration.
  async discoverAliases(): Promise<NfsAlias[]> {
    await this.authenticate();
    const aliases: NfsAlias[] = [];
    try {
      const resp = await this.client.get('/platform/4/protocols/nfs/aliases');
      for (const a of resp.data.aliases || []) {
        aliases.push({
          name: a.name,
          path: a.path,
          zone: a.zone || 'System',
          health: a.health
        });
      }
    } catch (error) {
      logger.warn('Failed to get NFS aliases from PowerScale:', error);
    }
    return aliases;
  }

  async createNfsAlias(name: string, path: string, zone: string = 'System'): Promise<any> {
    await this.authenticate();
    const response = await this.client.post('/platform/4/protocols/nfs/aliases', {
      name,
      path,
      zone
    });
    logger.info(`Created NFS alias ${name} -> ${path} on PowerScale ${this.hostname}`);
    return response.data;
  }

  // Create an NFS export on the target. When `raw` (the source export's full
  // config) is provided, the real client lists / RO-RW split / root mapping /
  // security flavors are reproduced; otherwise falls back to a generic export.
  async createNfsExport(targetPath: string, raw?: ExportRawConfig, rootSquash: boolean = true): Promise<any> {
    await this.authenticate();

    const body: any = { paths: [targetPath] };
    if (raw) {
      if (raw.clients?.length) body.clients = raw.clients;
      if (raw.root_clients?.length) body.root_clients = raw.root_clients;
      if (raw.read_only_clients?.length) body.read_only_clients = raw.read_only_clients;
      if (raw.read_write_clients?.length) body.read_write_clients = raw.read_write_clients;
      if (raw.security_flavors?.length) body.security_flavors = raw.security_flavors;
      if (typeof raw.read_only === 'boolean') body.read_only = raw.read_only;
      if (typeof raw.all_dirs === 'boolean') body.all_dirs = raw.all_dirs;
      if (raw.description) body.description = raw.description;
      if (raw.map_root?.enabled && raw.map_root.user) {
        body.map_root = { enabled: true, user: { name: raw.map_root.user } };
      }
      if (raw.map_all?.enabled && raw.map_all.user) {
        body.map_all = { enabled: true, user: { name: raw.map_all.user } };
      }
    } else {
      // Generic fallback (no captured source config)
      body.clients = ['*'];
      body.read_write_clients = ['*'];
      if (!rootSquash) body.root_clients = ['*'];
      body.security_flavors = ['unix'];
    }

    const response = await this.client.post('/platform/4/protocols/nfs/exports', body);
    logger.info(`Created NFS export for ${targetPath} on PowerScale ${this.hostname}`);
    return response.data;
  }

  async createSmbShare(name: string, path: string, description: string = '', browsable: boolean = true): Promise<any> {
    await this.authenticate();

    const shareConfig = {
      name: name,
      path: path,
      description: description,
      browsable: browsable,
      permissions: [
        {
          permission: 'full',
          permission_type: 'allow',
          trustee: {
            id: 'SID:S-1-1-0', // Everyone
            name: 'Everyone',
            type: 'wellknown'
          }
        }
      ]
    };

    const response = await this.client.post('/platform/12/protocols/smb/shares', shareConfig);
    logger.info(`Created SMB share ${name} on PowerScale ${this.hostname}`);
    return response.data;
  }

  // Build the `isi nfs exports create` CLI line, reproducing source fidelity
  // when `raw` is present. NOTE: uses --root-clients / map-root rather than the
  // (non-existent) --root-squash flag.
  private nfsExportCreateCmd(targetPath: string, zone: string, raw?: ExportRawConfig, rootSquash = true): string {
    const parts = [`isi nfs exports create "${targetPath}" --zone="${zone}"`];
    const repeat = (flag: string, vals?: string[]) => {
      for (const v of vals || []) parts.push(`${flag}="${v}"`);
    };
    if (raw) {
      repeat('--clients', raw.clients);
      repeat('--root-clients', raw.root_clients);
      repeat('--read-only-clients', raw.read_only_clients);
      repeat('--read-write-clients', raw.read_write_clients);
      repeat('--security-flavors', raw.security_flavors);
      if (raw.read_only) parts.push('--read-only=true');
      if (raw.all_dirs) parts.push('--all-dirs=true');
      if (raw.description) parts.push(`--description="${raw.description}"`);
      if (raw.map_root?.enabled && raw.map_root.user) {
        parts.push(`--map-root-enabled=true`, `--map-root-user="${raw.map_root.user}"`);
      }
      if (raw.map_all?.enabled && raw.map_all.user) {
        parts.push(`--map-all-enabled=true`, `--map-all-user="${raw.map_all.user}"`);
      }
    } else {
      parts.push('--clients="*"');
      parts.push('--read-write-clients="*"');
      // Root is squashed by default on OneFS; only grant root access when asked.
      if (!rootSquash) parts.push('--root-clients="*"');
    }
    return parts.join(' ');
  }

  async createDirectory(path: string): Promise<boolean> {
    await this.authenticate();
    try {
      await this.client.put(`/namespace${path}`, null, {
        headers: { 'x-isi-ifs-target-type': 'container' }
      });
      logger.info(`Created directory ${path} on PowerScale ${this.hostname}`);
      return true;
    } catch (error) {
      logger.error(`Failed to create directory ${path}:`, error);
      return false;
    }
  }

  async generateMigrationConfig(config: MigrationConfig): Promise<string> {
    const script: string[] = [
      '#!/bin/bash',
      '# PowerScale Migration Configuration Script',
      `# Generated by StorageMover on ${new Date().toISOString()}`,
      '',
      '# Exit on error',
      'set -e',
      '',
      '# Configuration Variables',
      `ACCESS_ZONE="${config.nfsSettings.accessZone || 'System'}"`,
      '',
      '# Create base directory structure'
    ];

    for (const exp of config.sourceExports) {
      const targetPath = `${config.targetBasePath}${exp.path}`;
      script.push(`mkdir -p "${targetPath}"`);
    }

    script.push('');
    script.push('# Create NFS Exports');

    for (const exp of config.sourceExports) {
      if (exp.type === 'nfs' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`;
        script.push(this.nfsExportCreateCmd(targetPath, '$ACCESS_ZONE', exp.rawConfig, config.nfsSettings.rootSquash));
      }
    }

    script.push('');
    script.push('# Create SMB Shares');

    for (const exp of config.sourceExports) {
      if (exp.type === 'smb' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`;
        const shareName = exp.rawConfig?.smb_name || exp.path.split('/').filter(Boolean).pop() || 'share';
        let line = `isi smb shares create "${shareName}" "${targetPath}" --zone="$ACCESS_ZONE"`;
        if (exp.rawConfig?.description) line += ` --description="${exp.rawConfig.description}"`;
        if (config.smbSettings.allowGuest) line += ` --allow-guest`;
        script.push(line);
        // SMB share ACLs are not reproduced automatically; review manually:
        script.push(`#   review permissions for share "${shareName}": isi smb shares permission list "${shareName}" --zone="$ACCESS_ZONE"`);
      }
    }

    if (config.aliases && config.aliases.length) {
      script.push('');
      script.push('# Create NFS Aliases');
      for (const alias of config.aliases) {
        const targetPath = `${config.targetBasePath}${alias.path}`;
        script.push(`isi nfs aliases create "${alias.name}" "${targetPath}" --zone="$ACCESS_ZONE"`);
      }
    }

    script.push('');
    script.push('echo "Migration configuration applied successfully"');

    return script.join('\n');
  }

  async applyMigrationConfig(config: MigrationConfig): Promise<{ success: boolean; results: any[] }> {
    await this.authenticate();
    const results: any[] = [];

    // Create directories
    for (const exp of config.sourceExports) {
      const targetPath = `${config.targetBasePath}${exp.path}`;
      try {
        await this.createDirectory(targetPath);
        results.push({ action: 'createDirectory', path: targetPath, success: true });
      } catch (error) {
        results.push({ action: 'createDirectory', path: targetPath, success: false, error: (error as Error).message });
      }
    }

    // Create NFS exports
    for (const exp of config.sourceExports) {
      if (exp.type === 'nfs' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`;
        try {
          await this.createNfsExport(targetPath, exp.rawConfig, config.nfsSettings.rootSquash);
          results.push({ action: 'createNfsExport', path: targetPath, success: true });
        } catch (error) {
          results.push({ action: 'createNfsExport', path: targetPath, success: false, error: (error as Error).message });
        }
      }
    }

    // Create SMB shares
    for (const exp of config.sourceExports) {
      if (exp.type === 'smb' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`;
        const shareName = exp.rawConfig?.smb_name || exp.path.split('/').filter(Boolean).pop() || 'share';
        try {
          await this.createSmbShare(
            shareName,
            targetPath,
            exp.rawConfig?.description || '',
            exp.rawConfig?.smb_browsable !== false
          );
          results.push({ action: 'createSmbShare', name: shareName, path: targetPath, success: true });
        } catch (error) {
          results.push({ action: 'createSmbShare', name: shareName, path: targetPath, success: false, error: (error as Error).message });
        }
      }
    }

    // Create NFS aliases
    for (const alias of config.aliases || []) {
      const targetPath = `${config.targetBasePath}${alias.path}`;
      try {
        await this.createNfsAlias(alias.name, targetPath, config.nfsSettings.accessZone || 'System');
        results.push({ action: 'createNfsAlias', name: alias.name, path: targetPath, success: true });
      } catch (error) {
        results.push({ action: 'createNfsAlias', name: alias.name, path: targetPath, success: false, error: (error as Error).message });
      }
    }

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  }
}
