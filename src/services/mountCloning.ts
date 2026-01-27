import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../database/init';
import { logger } from '../utils/logger';
import { decryptPassword, encryptPassword } from '../utils/crypto';
import { broadcastMessage } from '../websocket/handler';
import {
  WindowsFileServerClient,
  MountCloneConfig,
  MountCloneResult,
  MountCloneLog,
  MountSourceType,
  MountHealthStatus
} from './windows';

export interface MountClone {
  id: string;
  name: string;
  source_type: MountSourceType;
  source_hostname: string;
  source_path: string;
  source_username: string | null;
  source_password_encrypted: string | null;
  target_device_id: string;
  mount_point: string | null;
  share_name: string | null;
  share_type: 'nfs' | 'smb' | 'both' | null;
  status: 'pending' | 'mounting' | 'creating_share' | 'active' | 'failed' | 'disconnected' | 'removed';
  error_message: string | null;
  persistent: number;
  created_at: string;
  updated_at: string;
  last_health_check: string | null;
}

export interface CreateMountCloneRequest {
  name: string;
  sourceType: MountSourceType;
  sourceHostname: string;
  sourcePath: string;
  sourceUsername?: string;
  sourcePassword?: string;
  targetDeviceId: string;
  shareName?: string;
  shareType?: 'nfs' | 'smb' | 'both';
  persistent?: boolean;
}

export interface MountCloneStatus {
  clone: MountClone;
  health?: MountHealthStatus;
  recentLogs: Array<{
    id: string;
    level: string;
    message: string;
    details: string | null;
    created_at: string;
  }>;
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

export class MountCloningService {
  private activeOperations: Map<string, boolean> = new Map();

  /**
   * Create and execute a mount clone operation
   */
  async createMountClone(request: CreateMountCloneRequest): Promise<{ cloneId: string; success: boolean; error?: string }> {
    const cloneId = uuidv4();

    try {
      // Validate target device
      const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [request.targetDeviceId]);
      if (!targetDevice) {
        throw new Error('Target device not found');
      }
      if (targetDevice.type !== 'windows') {
        throw new Error('Target device must be a Windows file server');
      }

      // Encrypt source password if provided
      const encryptedSourcePassword = request.sourcePassword
        ? encryptPassword(request.sourcePassword)
        : null;

      // Create clone record
      await dbRun(`
        INSERT INTO mount_clones (
          id, name, source_type, source_hostname, source_path,
          source_username, source_password_encrypted, target_device_id,
          share_name, share_type, status, persistent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `, [
        cloneId,
        request.name,
        request.sourceType,
        request.sourceHostname,
        request.sourcePath,
        request.sourceUsername || null,
        encryptedSourcePassword,
        request.targetDeviceId,
        request.shareName || null,
        request.shareType || 'smb',
        request.persistent !== false ? 1 : 0
      ]);

      this.addLog(cloneId, 'info', `Mount clone created: ${request.name}`);

      // Start the clone operation asynchronously
      this.executeMountClone(cloneId).catch(error => {
        logger.error(`Mount clone ${cloneId} failed:`, error);
      });

      broadcastMessage({
        type: 'mount_clone_created',
        cloneId,
        name: request.name,
        status: 'pending'
      });

      return { cloneId, success: true };

    } catch (error: any) {
      logger.error('Failed to create mount clone:', error);
      return { cloneId, success: false, error: error.message };
    }
  }

  /**
   * Execute the mount clone operation
   */
  private async executeMountClone(cloneId: string): Promise<void> {
    if (this.activeOperations.get(cloneId)) {
      logger.warn(`Mount clone ${cloneId} is already running`);
      return;
    }

    this.activeOperations.set(cloneId, true);

    try {
      const clone = await dbGet<MountClone>('SELECT * FROM mount_clones WHERE id = ?', [cloneId]);
      if (!clone) {
        throw new Error('Mount clone not found');
      }

      const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [clone.target_device_id]);
      if (!targetDevice) {
        throw new Error('Target device not found');
      }

      // Update status to mounting
      await this.updateStatus(cloneId, 'mounting');
      this.addLog(cloneId, 'info', 'Starting mount operation...');

      // Create Windows client
      const targetPassword = decryptPassword(targetDevice.password_encrypted);
      const windowsClient = new WindowsFileServerClient(
        targetDevice.hostname,
        targetDevice.port,
        targetDevice.username,
        targetPassword
      );

      // Prepare clone config
      const sourcePassword = clone.source_password_encrypted
        ? decryptPassword(clone.source_password_encrypted)
        : undefined;

      const cloneConfig: MountCloneConfig = {
        name: clone.name,
        sourceType: clone.source_type as MountSourceType,
        sourceHostname: clone.source_hostname,
        sourcePath: clone.source_path,
        sourceUsername: clone.source_username || undefined,
        sourcePassword: sourcePassword,
        shareName: clone.share_name || undefined,
        shareType: (clone.share_type as 'nfs' | 'smb' | 'both') || 'smb',
        persistent: clone.persistent === 1
      };

      // Execute the clone
      const result = await windowsClient.cloneMount(cloneConfig);

      // Store logs
      for (const log of result.logs) {
        await this.addLog(cloneId, log.level, log.message, log.details);
      }

      if (result.success) {
        // Update with success
        await dbRun(`
          UPDATE mount_clones
          SET status = 'active',
              mount_point = ?,
              share_name = ?,
              share_type = ?,
              error_message = NULL,
              updated_at = CURRENT_TIMESTAMP,
              last_health_check = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [result.mountPoint, result.shareName, result.shareType, cloneId]);

        this.addLog(cloneId, 'info', `Mount clone active: ${result.shareName} at ${result.mountPoint}`);

        broadcastMessage({
          type: 'mount_clone_active',
          cloneId,
          mountPoint: result.mountPoint,
          shareName: result.shareName,
          shareType: result.shareType
        });

      } else {
        // Update with failure
        await this.updateStatus(cloneId, 'failed', result.error);

        broadcastMessage({
          type: 'mount_clone_failed',
          cloneId,
          error: result.error
        });
      }

    } catch (error: any) {
      logger.error(`Mount clone ${cloneId} execution failed:`, error);
      await this.updateStatus(cloneId, 'failed', error.message);
      this.addLog(cloneId, 'error', `Execution failed: ${error.message}`, error.stack);

      broadcastMessage({
        type: 'mount_clone_failed',
        cloneId,
        error: error.message
      });

    } finally {
      this.activeOperations.delete(cloneId);
    }
  }

  /**
   * Get mount clone status with health check and recent logs
   */
  async getMountCloneStatus(cloneId: string): Promise<MountCloneStatus | null> {
    const clone = await dbGet<MountClone>('SELECT * FROM mount_clones WHERE id = ?', [cloneId]);
    if (!clone) {
      return null;
    }

    // Get recent logs
    const recentLogs = await dbAll<{
      id: string;
      level: string;
      message: string;
      details: string | null;
      created_at: string;
    }>(`
      SELECT id, level, message, details, created_at
      FROM mount_clone_logs
      WHERE clone_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [cloneId]);

    // If active, perform health check
    let health: MountHealthStatus | undefined;
    if (clone.status === 'active' && clone.mount_point && clone.share_name) {
      const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [clone.target_device_id]);
      if (targetDevice) {
        try {
          const targetPassword = decryptPassword(targetDevice.password_encrypted);
          const windowsClient = new WindowsFileServerClient(
            targetDevice.hostname,
            targetDevice.port,
            targetDevice.username,
            targetPassword
          );
          health = await windowsClient.checkMountHealth(clone.mount_point, clone.share_name);

          // Update last health check
          await dbRun(`
            UPDATE mount_clones
            SET last_health_check = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [cloneId]);

          // If health check shows issues, update status
          if (!health.accessible) {
            await this.updateStatus(cloneId, 'disconnected', health.error);
          }
        } catch (error: any) {
          logger.warn(`Health check failed for ${cloneId}:`, error.message);
        }
      }
    }

    return { clone, health, recentLogs };
  }

  /**
   * List all mount clones
   */
  async listMountClones(targetDeviceId?: string): Promise<Array<MountClone & { target_device_name: string }>> {
    let query = `
      SELECT mc.*, d.name as target_device_name
      FROM mount_clones mc
      JOIN devices d ON mc.target_device_id = d.id
    `;
    const params: any[] = [];

    if (targetDeviceId) {
      query += ' WHERE mc.target_device_id = ?';
      params.push(targetDeviceId);
    }

    query += ' ORDER BY mc.created_at DESC';

    return dbAll<MountClone & { target_device_name: string }>(query, params);
  }

  /**
   * Remove a mount clone
   */
  async removeMountClone(cloneId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const clone = await dbGet<MountClone>('SELECT * FROM mount_clones WHERE id = ?', [cloneId]);
      if (!clone) {
        return { success: false, error: 'Mount clone not found' };
      }

      this.addLog(cloneId, 'info', 'Starting mount clone removal...');

      // If active, remove from Windows server
      if (clone.status === 'active' && clone.mount_point && clone.share_name) {
        const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [clone.target_device_id]);
        if (targetDevice) {
          try {
            const targetPassword = decryptPassword(targetDevice.password_encrypted);
            const windowsClient = new WindowsFileServerClient(
              targetDevice.hostname,
              targetDevice.port,
              targetDevice.username,
              targetPassword
            );

            const removeResult = await windowsClient.removeClonedMount(
              clone.mount_point,
              clone.share_name,
              (clone.share_type as 'nfs' | 'smb' | 'both') || 'smb'
            );

            for (const log of removeResult.logs) {
              await this.addLog(cloneId, log.level, log.message, log.details);
            }

          } catch (error: any) {
            this.addLog(cloneId, 'warn', `Failed to remove from Windows: ${error.message}`);
          }
        }
      }

      // Update status to removed
      await this.updateStatus(cloneId, 'removed');

      broadcastMessage({
        type: 'mount_clone_removed',
        cloneId
      });

      this.addLog(cloneId, 'info', 'Mount clone removed');
      return { success: true };

    } catch (error: any) {
      logger.error(`Failed to remove mount clone ${cloneId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retry a failed mount clone
   */
  async retryMountClone(cloneId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const clone = await dbGet<MountClone>('SELECT * FROM mount_clones WHERE id = ?', [cloneId]);
      if (!clone) {
        return { success: false, error: 'Mount clone not found' };
      }

      if (clone.status !== 'failed' && clone.status !== 'disconnected') {
        return { success: false, error: `Cannot retry clone with status: ${clone.status}` };
      }

      // Reset status and retry
      await dbRun(`
        UPDATE mount_clones
        SET status = 'pending',
            error_message = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [cloneId]);

      this.addLog(cloneId, 'info', 'Retrying mount clone...');

      // Execute again
      this.executeMountClone(cloneId).catch(error => {
        logger.error(`Mount clone retry ${cloneId} failed:`, error);
      });

      return { success: true };

    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Perform health check on all active mount clones
   */
  async healthCheckAll(): Promise<{ checked: number; healthy: number; unhealthy: number }> {
    const activeClones = await dbAll<MountClone>(`
      SELECT * FROM mount_clones WHERE status = 'active'
    `, []);

    let healthy = 0;
    let unhealthy = 0;

    for (const clone of activeClones) {
      const status = await this.getMountCloneStatus(clone.id);
      if (status?.health?.accessible && status?.health?.shareActive) {
        healthy++;
      } else {
        unhealthy++;
      }
    }

    return { checked: activeClones.length, healthy, unhealthy };
  }

  /**
   * Clone from existing exports (from discovered devices)
   */
  async cloneFromExport(
    exportId: string,
    targetDeviceId: string,
    options?: {
      shareName?: string;
      shareType?: 'nfs' | 'smb' | 'both';
      persistent?: boolean;
    }
  ): Promise<{ cloneId: string; success: boolean; error?: string }> {
    try {
      // Get export info
      const exportInfo = await dbGet<{
        id: string;
        device_id: string;
        export_path: string;
        export_type: string;
        description: string;
      }>('SELECT * FROM exports WHERE id = ?', [exportId]);

      if (!exportInfo) {
        return { cloneId: '', success: false, error: 'Export not found' };
      }

      // Get source device info
      const sourceDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [exportInfo.device_id]);
      if (!sourceDevice) {
        return { cloneId: '', success: false, error: 'Source device not found' };
      }

      // Determine source type
      let sourceType: MountSourceType;
      const exportType = exportInfo.export_type;

      switch (sourceDevice.type) {
        case 'powerscale':
          sourceType = exportType === 'nfs' ? 'powerscale_nfs' : 'powerscale_smb';
          break;
        case 'isilon':
          sourceType = exportType === 'nfs' ? 'isilon_nfs' : 'isilon_smb';
          break;
        case 'windows':
          sourceType = 'windows_smb';
          break;
        default:
          // Assume Linux
          sourceType = exportType === 'nfs' ? 'linux_nfs' : 'linux_smb';
      }

      // Create the clone request
      const request: CreateMountCloneRequest = {
        name: `Clone: ${exportInfo.export_path} from ${sourceDevice.name}`,
        sourceType,
        sourceHostname: sourceDevice.hostname,
        sourcePath: exportInfo.export_path,
        sourceUsername: sourceDevice.username,
        sourcePassword: decryptPassword(sourceDevice.password_encrypted),
        targetDeviceId,
        shareName: options?.shareName,
        shareType: options?.shareType || (exportInfo.export_type as 'nfs' | 'smb'),
        persistent: options?.persistent
      };

      return this.createMountClone(request);

    } catch (error: any) {
      return { cloneId: '', success: false, error: error.message };
    }
  }

  /**
   * Bulk clone multiple exports
   */
  async cloneExportsBatch(
    exportIds: string[],
    targetDeviceId: string,
    options?: {
      shareType?: 'nfs' | 'smb' | 'both';
      persistent?: boolean;
    }
  ): Promise<{ results: Array<{ exportId: string; cloneId: string; success: boolean; error?: string }>; summary: { total: number; succeeded: number; failed: number } }> {
    const results: Array<{ exportId: string; cloneId: string; success: boolean; error?: string }> = [];
    let succeeded = 0;
    let failed = 0;

    for (const exportId of exportIds) {
      const result = await this.cloneFromExport(exportId, targetDeviceId, options);
      results.push({ exportId, ...result });
      if (result.success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    return {
      results,
      summary: { total: exportIds.length, succeeded, failed }
    };
  }

  /**
   * Get clone logs
   */
  async getCloneLogs(cloneId: string, limit: number = 100): Promise<Array<{
    id: string;
    level: string;
    message: string;
    details: string | null;
    created_at: string;
  }>> {
    return dbAll(`
      SELECT id, level, message, details, created_at
      FROM mount_clone_logs
      WHERE clone_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [cloneId, limit]);
  }

  /**
   * Update clone status
   */
  private async updateStatus(cloneId: string, status: MountClone['status'], errorMessage?: string): Promise<void> {
    await dbRun(`
      UPDATE mount_clones
      SET status = ?,
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [status, errorMessage || null, cloneId]);

    broadcastMessage({
      type: 'mount_clone_status',
      cloneId,
      status,
      error: errorMessage
    });
  }

  /**
   * Add log entry
   */
  private async addLog(cloneId: string, level: MountCloneLog['level'], message: string, details?: string): Promise<void> {
    const logId = uuidv4();
    await dbRun(`
      INSERT INTO mount_clone_logs (id, clone_id, level, message, details)
      VALUES (?, ?, ?, ?, ?)
    `, [logId, cloneId, level, message, details || null]);
  }
}

// Singleton instance
export const mountCloningService = new MountCloningService();
