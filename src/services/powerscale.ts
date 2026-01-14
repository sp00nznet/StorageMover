import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../utils/logger';

export interface PowerScaleExport {
  id: string;
  path: string;
  type: 'nfs' | 'smb' | 'both';
  clients: string[];
  permissions: string;
  description: string;
  size: number;
}

export interface MigrationConfig {
  sourceExports: { path: string; type: string }[];
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
          exports.push({
            id: `nfs-${exp.id}`,
            path: exp.paths?.[0] || exp.path,
            type: 'nfs',
            clients: exp.clients || ['*'],
            permissions: exp.root_clients?.length ? 'no_root_squash' : 'root_squash',
            description: exp.description || `NFS Export: ${exp.paths?.[0] || exp.path}`,
            size: 0
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
          const existingIndex = exports.findIndex(e => e.path === share.path);
          if (existingIndex >= 0) {
            exports[existingIndex].type = 'both';
          } else {
            exports.push({
              id: `smb-${share.id}`,
              path: share.path,
              type: 'smb',
              clients: ['*'],
              permissions: 'read-write',
              description: share.description || `SMB Share: ${share.name}`,
              size: 0
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to get SMB shares from PowerScale:', error);
    }

    return exports;
  }

  async createNfsExport(path: string, clients: string[] = ['*'], rootSquash: boolean = true): Promise<any> {
    await this.authenticate();

    const exportConfig = {
      paths: [path],
      clients: clients,
      root_clients: rootSquash ? [] : clients,
      read_write_clients: clients,
      security_flavors: ['unix', 'krb5']
    };

    const response = await this.client.post('/platform/4/protocols/nfs/exports', exportConfig);
    logger.info(`Created NFS export for ${path} on PowerScale ${this.hostname}`);
    return response.data;
  }

  async createSmbShare(name: string, path: string, description: string = ''): Promise<any> {
    await this.authenticate();

    const shareConfig = {
      name: name,
      path: path,
      description: description,
      browsable: true,
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
        script.push(`isi nfs exports create "${targetPath}" --zone="$ACCESS_ZONE" --clients="*" ${config.nfsSettings.rootSquash ? '--root-squash' : '--no-root-squash'}`);
      }
    }

    script.push('');
    script.push('# Create SMB Shares');

    for (const exp of config.sourceExports) {
      if (exp.type === 'smb' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`;
        const shareName = exp.path.split('/').filter(Boolean).pop() || 'share';
        script.push(`isi smb shares create "${shareName}" "${targetPath}" --zone="$ACCESS_ZONE" ${config.smbSettings.allowGuest ? '--allow-guest' : ''}`);
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
          await this.createNfsExport(targetPath, ['*'], config.nfsSettings.rootSquash);
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
        const shareName = exp.path.split('/').filter(Boolean).pop() || 'share';
        try {
          await this.createSmbShare(shareName, targetPath);
          results.push({ action: 'createSmbShare', name: shareName, path: targetPath, success: true });
        } catch (error) {
          results.push({ action: 'createSmbShare', name: shareName, path: targetPath, success: false, error: (error as Error).message });
        }
      }
    }

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  }
}
