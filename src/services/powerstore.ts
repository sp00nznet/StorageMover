import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../utils/logger';

export interface PowerStoreExport {
  id: string;
  name: string;
  path: string;
  type: 'nfs' | 'smb';
  nasServerId: string;
  fileSystemId: string;
  description: string;
  size: number;
}

export interface PowerStoreConfigExport {
  nasServers: any[];
  fileSystems: any[];
  nfsExports: any[];
  smbShares: any[];
}

export class PowerStoreClient {
  private client: AxiosInstance;
  private hostname: string;
  private username: string;
  private password: string;
  private authToken: string | null = null;

  constructor(hostname: string, port: number, username: string, password: string) {
    this.hostname = hostname;
    this.username = username;
    this.password = password;

    this.client = axios.create({
      baseURL: `https://${hostname}/api/rest`,
      timeout: 30000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  async authenticate(): Promise<boolean> {
    try {
      const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');

      const response = await this.client.get('/login_session', {
        headers: {
          'Authorization': `Basic ${credentials}`
        }
      });

      if (response.headers['dell-emc-token']) {
        this.authToken = response.headers['dell-emc-token'];
        this.client.defaults.headers.common['DELL-EMC-TOKEN'] = this.authToken;
      }

      // Also set basic auth for subsequent requests
      this.client.defaults.headers.common['Authorization'] = `Basic ${credentials}`;

      logger.info(`Authenticated with PowerStore: ${this.hostname}`);
      return true;
    } catch (error) {
      logger.error(`PowerStore authentication failed for ${this.hostname}:`, error);
      return false;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.authenticate();
      const response = await this.client.get('/cluster');
      return response.status === 200;
    } catch (error) {
      logger.error(`PowerStore connection test failed:`, error);
      return false;
    }
  }

  async getClusterInfo(): Promise<any> {
    await this.authenticate();
    const response = await this.client.get('/cluster');
    return response.data;
  }

  async getNasServers(): Promise<any[]> {
    await this.authenticate();
    const response = await this.client.get('/nas_server');
    return response.data || [];
  }

  async getFileSystems(): Promise<any[]> {
    await this.authenticate();
    const response = await this.client.get('/file_system');
    return response.data || [];
  }

  async discoverExports(): Promise<PowerStoreExport[]> {
    await this.authenticate();
    const exports: PowerStoreExport[] = [];

    // Get NFS exports
    try {
      const nfsResponse = await this.client.get('/nfs_export');
      if (nfsResponse.data) {
        for (const exp of nfsResponse.data) {
          exports.push({
            id: exp.id,
            name: exp.name,
            path: exp.path || `/nfs/${exp.name}`,
            type: 'nfs',
            nasServerId: exp.nas_server_id,
            fileSystemId: exp.file_system_id,
            description: exp.description || `NFS Export: ${exp.name}`,
            size: 0
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to get NFS exports from PowerStore:', error);
    }

    // Get SMB shares
    try {
      const smbResponse = await this.client.get('/smb_share');
      if (smbResponse.data) {
        for (const share of smbResponse.data) {
          exports.push({
            id: share.id,
            name: share.name,
            path: share.path || `/smb/${share.name}`,
            type: 'smb',
            nasServerId: share.nas_server_id,
            fileSystemId: share.file_system_id,
            description: share.description || `SMB Share: ${share.name}`,
            size: 0
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to get SMB shares from PowerStore:', error);
    }

    return exports;
  }

  async createNasServer(name: string): Promise<any> {
    await this.authenticate();
    const response = await this.client.post('/nas_server', {
      name: name,
      description: `NAS Server created by StorageMover`
    });
    logger.info(`Created NAS server ${name} on PowerStore ${this.hostname}`);
    return response.data;
  }

  async createFileSystem(name: string, nasServerId: string, sizeGb: number): Promise<any> {
    await this.authenticate();
    const response = await this.client.post('/file_system', {
      name: name,
      nas_server_id: nasServerId,
      size_total: sizeGb * 1024 * 1024 * 1024, // Convert GB to bytes
      description: `File system created by StorageMover`
    });
    logger.info(`Created file system ${name} on PowerStore ${this.hostname}`);
    return response.data;
  }

  async createNfsExport(name: string, fileSystemId: string, path: string): Promise<any> {
    await this.authenticate();
    const response = await this.client.post('/nfs_export', {
      name: name,
      file_system_id: fileSystemId,
      path: path,
      description: `NFS export created by StorageMover`,
      default_access: 'Read_Write',
      min_security: 'Sys'
    });
    logger.info(`Created NFS export ${name} on PowerStore ${this.hostname}`);
    return response.data;
  }

  async createSmbShare(name: string, fileSystemId: string, path: string): Promise<any> {
    await this.authenticate();
    const response = await this.client.post('/smb_share', {
      name: name,
      file_system_id: fileSystemId,
      path: path,
      description: `SMB share created by StorageMover`
    });
    logger.info(`Created SMB share ${name} on PowerStore ${this.hostname}`);
    return response.data;
  }

  async exportConfiguration(): Promise<PowerStoreConfigExport> {
    await this.authenticate();

    const config: PowerStoreConfigExport = {
      nasServers: [],
      fileSystems: [],
      nfsExports: [],
      smbShares: []
    };

    try {
      config.nasServers = await this.getNasServers();
    } catch (error) {
      logger.warn('Failed to export NAS servers:', error);
    }

    try {
      config.fileSystems = await this.getFileSystems();
    } catch (error) {
      logger.warn('Failed to export file systems:', error);
    }

    try {
      const nfsResponse = await this.client.get('/nfs_export');
      config.nfsExports = nfsResponse.data || [];
    } catch (error) {
      logger.warn('Failed to export NFS exports:', error);
    }

    try {
      const smbResponse = await this.client.get('/smb_share');
      config.smbShares = smbResponse.data || [];
    } catch (error) {
      logger.warn('Failed to export SMB shares:', error);
    }

    return config;
  }

  async importConfiguration(config: PowerStoreConfigExport): Promise<{ success: boolean; results: any[] }> {
    await this.authenticate();
    const results: any[] = [];

    // Create NAS servers
    for (const nas of config.nasServers) {
      try {
        await this.createNasServer(nas.name);
        results.push({ type: 'nasServer', name: nas.name, success: true });
      } catch (error) {
        results.push({ type: 'nasServer', name: nas.name, success: false, error: (error as Error).message });
      }
    }

    // Create file systems
    for (const fs of config.fileSystems) {
      try {
        await this.createFileSystem(fs.name, fs.nas_server_id, fs.size_total / (1024 * 1024 * 1024));
        results.push({ type: 'fileSystem', name: fs.name, success: true });
      } catch (error) {
        results.push({ type: 'fileSystem', name: fs.name, success: false, error: (error as Error).message });
      }
    }

    // Create NFS exports
    for (const exp of config.nfsExports) {
      try {
        await this.createNfsExport(exp.name, exp.file_system_id, exp.path);
        results.push({ type: 'nfsExport', name: exp.name, success: true });
      } catch (error) {
        results.push({ type: 'nfsExport', name: exp.name, success: false, error: (error as Error).message });
      }
    }

    // Create SMB shares
    for (const share of config.smbShares) {
      try {
        await this.createSmbShare(share.name, share.file_system_id, share.path);
        results.push({ type: 'smbShare', name: share.name, success: true });
      } catch (error) {
        results.push({ type: 'smbShare', name: share.name, success: false, error: (error as Error).message });
      }
    }

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  }

  generateConfigScript(config: PowerStoreConfigExport): string {
    const lines: string[] = [
      '# PowerStore Configuration Export',
      `# Generated by StorageMover on ${new Date().toISOString()}`,
      '# This is a JSON representation of the PowerStore configuration',
      '',
      JSON.stringify(config, null, 2)
    ];
    return lines.join('\n');
  }
}
