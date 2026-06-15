import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../utils/logger';
import { ExportRawConfig, NfsAlias } from './powerscale';

export interface IsilonExport {
  id: string;
  path: string;
  type: 'nfs' | 'smb' | 'both';
  clients: string[];
  permissions: string;
  description: string;
  size: number;
  rawConfig?: ExportRawConfig;
}

export class IsilonClient {
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
        rejectUnauthorized: false // Allow self-signed certs for lab environments
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

      logger.info(`Authenticated with Isilon: ${this.hostname}`);
      return true;
    } catch (error) {
      logger.error(`Isilon authentication failed for ${this.hostname}:`, error);
      return false;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.authenticate();
      const response = await this.client.get('/platform/1/cluster/identity');
      return response.status === 200;
    } catch (error) {
      logger.error(`Isilon connection test failed:`, error);
      return false;
    }
  }

  async getClusterInfo(): Promise<any> {
    await this.authenticate();
    const response = await this.client.get('/platform/1/cluster/identity');
    return response.data;
  }

  async discoverExports(): Promise<IsilonExport[]> {
    await this.authenticate();
    const exports: IsilonExport[] = [];

    // Discover NFS exports
    try {
      const nfsResponse = await this.client.get('/platform/2/protocols/nfs/exports');
      if (nfsResponse.data.exports) {
        for (const exp of nfsResponse.data.exports) {
          const path = exp.paths?.[0] || exp.path;
          exports.push({
            id: `nfs-${exp.id}`,
            path,
            type: 'nfs',
            clients: exp.clients || ['*'],
            permissions: exp.map_root?.enabled ? 'root_squash' : 'no_root_squash',
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
      logger.warn('Failed to get NFS exports:', error);
    }

    // Discover SMB shares
    try {
      const smbResponse = await this.client.get('/platform/4/protocols/smb/shares');
      if (smbResponse.data.shares) {
        for (const share of smbResponse.data.shares) {
          // Check if this path already exists as NFS
          const existingIndex = exports.findIndex(e => e.path === share.path);
          if (existingIndex >= 0) {
            exports[existingIndex].type = 'both';
            exports[existingIndex].rawConfig = {
              ...(exports[existingIndex].rawConfig || {}),
              smb_name: share.name,
              smb_browsable: share.browsable !== false
            };
          } else {
            exports.push({
              id: `smb-${share.id}`,
              path: share.path,
              type: 'smb',
              clients: ['*'],
              permissions: share.permissions?.join(',') || 'read',
              description: share.description || `SMB Share: ${share.name}`,
              size: 0,
              rawConfig: {
                smb_name: share.name,
                smb_browsable: share.browsable !== false,
                description: share.description || '',
                zone: share.zone || 'System'
              }
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to get SMB shares:', error);
    }

    // Try to get directory sizes
    for (const exp of exports) {
      try {
        const quotaResponse = await this.client.get(`/platform/1/quota/quotas?path=${encodeURIComponent(exp.path)}`);
        if (quotaResponse.data.quotas?.[0]) {
          exp.size = quotaResponse.data.quotas[0].usage?.logical || 0;
        }
      } catch (error) {
        // Size information not available
      }
    }

    logger.info(`Discovered ${exports.length} exports from Isilon ${this.hostname}`);
    return exports;
  }

  // Discover NFS aliases (short names like /rht that point at a real /ifs path).
  async discoverAliases(): Promise<NfsAlias[]> {
    await this.authenticate();
    const aliases: NfsAlias[] = [];
    try {
      const resp = await this.client.get('/platform/2/protocols/nfs/aliases');
      for (const a of resp.data.aliases || []) {
        aliases.push({
          name: a.name,
          path: a.path,
          zone: a.zone || 'System',
          health: a.health
        });
      }
    } catch (error) {
      logger.warn('Failed to get NFS aliases from Isilon:', error);
    }
    return aliases;
  }

  async getExportDetails(exportPath: string): Promise<any> {
    await this.authenticate();
    const response = await this.client.get(`/namespace${exportPath}?detail=default`);
    return response.data;
  }

  async listDirectory(path: string): Promise<any[]> {
    await this.authenticate();
    const response = await this.client.get(`/namespace${path}?detail=default`);
    return response.data.children || [];
  }
}
