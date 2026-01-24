import { NodeSSH } from 'node-ssh';
import { dbGet, dbAll, dbRun } from '../database/init';
import { logger } from '../utils/logger';
import { decryptPassword } from '../utils/crypto';
import { broadcastMessage } from '../websocket/handler';
import { WindowsFileServerClient, MountSourceType } from './windows';
import { mountCloningService } from './mountCloning';

interface Device {
  id: string;
  name: string;
  type: string;
  hostname: string;
  port: number;
  username: string;
  password_encrypted: string;
}

interface MigrationItem {
  id: string;
  migration_id: string;
  export_id: string;
  target_path: string;
  status: string;
  export_path: string;
}

export class MigrationService {
  private activeMigrations: Map<string, boolean> = new Map();

  async startMigration(migrationId: string): Promise<void> {
    if (this.activeMigrations.get(migrationId)) {
      logger.warn(`Migration ${migrationId} is already running`);
      return;
    }

    this.activeMigrations.set(migrationId, true);

    try {
      const migration = await dbGet<any>('SELECT * FROM migrations WHERE id = ?', [migrationId]);
      if (!migration) {
        throw new Error('Migration not found');
      }

      const sourceDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [migration.source_device_id]);
      const targetDevice = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [migration.target_device_id]);

      if (!sourceDevice || !targetDevice) {
        throw new Error('Source or target device not found');
      }

      const items = await dbAll<MigrationItem>(`
        SELECT mi.*, e.export_path
        FROM migration_items mi
        JOIN exports e ON mi.export_id = e.id
        WHERE mi.migration_id = ? AND mi.status != 'completed'
      `, [migrationId]);

      let completedItems = 0;
      let totalBytesTransferred = 0;

      for (const item of items) {
        // Check if migration was cancelled or paused
        const currentMigration = await dbGet<any>('SELECT status FROM migrations WHERE id = ?', [migrationId]);
        if (currentMigration?.status !== 'running') {
          logger.info(`Migration ${migrationId} was stopped`);
          break;
        }

        try {
          await dbRun('UPDATE migration_items SET status = ? WHERE id = ?', ['running', item.id]);

          // Perform the data transfer
          const bytesTransferred = await this.transferExport(
            sourceDevice,
            targetDevice,
            item.export_path,
            item.target_path,
            migrationId
          );

          totalBytesTransferred += bytesTransferred;
          completedItems++;

          await dbRun(`
            UPDATE migration_items
            SET status = 'completed', bytes_transferred = ?
            WHERE id = ?
          `, [bytesTransferred, item.id]);

          // Update migration progress
          const progress = Math.round((completedItems / items.length) * 100);
          await dbRun(`
            UPDATE migrations
            SET progress = ?, bytes_transferred = ?, files_transferred = ?
            WHERE id = ?
          `, [progress, totalBytesTransferred, completedItems, migrationId]);

          broadcastMessage({
            type: 'migration_progress',
            migrationId,
            progress,
            bytesTransferred: totalBytesTransferred,
            filesTransferred: completedItems,
            currentItem: item.export_path
          });

        } catch (error) {
          logger.error(`Failed to migrate item ${item.export_path}:`, error);
          await dbRun(`
            UPDATE migration_items
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `, [(error as Error).message, item.id]);
        }
      }

      // Check final status
      const failedItems = await dbGet<{ count: number }>(
        "SELECT COUNT(*) as count FROM migration_items WHERE migration_id = ? AND status = 'failed'",
        [migrationId]
      );

      const finalStatus = failedItems && failedItems.count > 0 ? 'completed_with_errors' : 'completed';

      await dbRun(`
        UPDATE migrations
        SET status = ?, completed_at = CURRENT_TIMESTAMP, progress = 100
        WHERE id = ?
      `, [finalStatus, migrationId]);

      broadcastMessage({
        type: 'migration_completed',
        migrationId,
        status: finalStatus,
        bytesTransferred: totalBytesTransferred,
        filesTransferred: completedItems
      });

      logger.info(`Migration ${migrationId} completed with status: ${finalStatus}`);

    } catch (error) {
      logger.error(`Migration ${migrationId} failed:`, error);

      await dbRun(`
        UPDATE migrations
        SET status = 'failed', error_message = ?
        WHERE id = ?
      `, [(error as Error).message, migrationId]);

      broadcastMessage({
        type: 'migration_failed',
        migrationId,
        error: (error as Error).message
      });
    } finally {
      this.activeMigrations.delete(migrationId);
    }
  }

  private async transferExport(
    sourceDevice: Device,
    targetDevice: Device,
    sourcePath: string,
    targetPath: string,
    migrationId: string
  ): Promise<number> {
    // Route to appropriate transfer method based on target device type
    if (targetDevice.type === 'windows') {
      return this.transferToWindows(sourceDevice, targetDevice, sourcePath, targetPath, migrationId);
    } else {
      return this.transferBetweenStorageDevices(sourceDevice, targetDevice, sourcePath, targetPath, migrationId);
    }
  }

  private async transferBetweenStorageDevices(
    sourceDevice: Device,
    targetDevice: Device,
    sourcePath: string,
    targetPath: string,
    migrationId: string
  ): Promise<number> {
    const sourcePassword = decryptPassword(sourceDevice.password_encrypted);
    const targetPassword = decryptPassword(targetDevice.password_encrypted);

    // For Isilon/PowerScale transfers, use rsync over SSH
    const ssh = new NodeSSH();

    try {
      // Connect to target device
      await ssh.connect({
        host: targetDevice.hostname,
        username: targetDevice.username,
        password: targetPassword,
        tryKeyboard: true,
        readyTimeout: 30000
      });

      logger.info(`Connected to target device: ${targetDevice.hostname}`);

      // Create target directory
      await ssh.execCommand(`mkdir -p "${targetPath}"`);

      // Use rsync to transfer data from source to target
      // This assumes the target can reach the source via SSH
      const rsyncCommand = `rsync -avz --progress -e "sshpass -p '${sourcePassword}' ssh -o StrictHostKeyChecking=no" ${sourceDevice.username}@${sourceDevice.hostname}:"${sourcePath}/" "${targetPath}/"`;

      const result = await ssh.execCommand(rsyncCommand, {
        onStdout: (chunk) => {
          const output = chunk.toString();
          // Parse rsync progress if available
          const progressMatch = output.match(/(\d+)%/);
          if (progressMatch) {
            broadcastMessage({
              type: 'transfer_progress',
              migrationId,
              path: sourcePath,
              progress: parseInt(progressMatch[1])
            });
          }
        },
        onStderr: (chunk) => {
          logger.warn(`rsync stderr: ${chunk.toString()}`);
        }
      });

      if (result.code !== 0 && result.code !== null) {
        // If rsync failed, try alternative method with SCP
        logger.warn(`rsync failed, trying alternative method: ${result.stderr}`);

        // Alternative: Use NFS mount and cp
        const mountPoint = `/tmp/storagemover_${Date.now()}`;
        await ssh.execCommand(`mkdir -p ${mountPoint}`);
        await ssh.execCommand(`mount -t nfs ${sourceDevice.hostname}:${sourcePath} ${mountPoint}`);
        await ssh.execCommand(`cp -r ${mountPoint}/* ${targetPath}/`);
        await ssh.execCommand(`umount ${mountPoint} && rmdir ${mountPoint}`);
      }

      // Get transferred size
      const sizeResult = await ssh.execCommand(`du -sb "${targetPath}" | cut -f1`);
      const bytesTransferred = parseInt(sizeResult.stdout.trim()) || 0;

      logger.info(`Transferred ${bytesTransferred} bytes from ${sourcePath} to ${targetPath}`);

      return bytesTransferred;

    } finally {
      ssh.dispose();
    }
  }

  private async transferToWindows(
    sourceDevice: Device,
    targetDevice: Device,
    sourcePath: string,
    targetPath: string,
    migrationId: string
  ): Promise<number> {
    const sourcePassword = decryptPassword(sourceDevice.password_encrypted);
    const targetPassword = decryptPassword(targetDevice.password_encrypted);
    const windowsClient = new WindowsFileServerClient(
      targetDevice.hostname,
      targetDevice.port,
      targetDevice.username,
      targetPassword
    );

    try {
      logger.info(`Setting up Windows gateway for ${sourceDevice.name}:${sourcePath} on ${targetDevice.name}`);

      // Get export info to determine type
      const exportInfo = await dbGet<{ export_type: string }>(`
        SELECT export_type FROM exports WHERE export_path = ? AND device_id = ?
      `, [sourcePath, sourceDevice.id]);

      const exportType = (exportInfo?.export_type || 'smb') as 'nfs' | 'smb' | 'both';

      // Step 1: Mount source share on Windows server
      // This makes Windows act as a proxy/gateway - no data is copied
      let mountType: 'nfs' | 'smb' = 'smb';

      // Prefer NFS for Isilon/PowerScale, SMB for PowerStore
      if (sourceDevice.type === 'isilon' || sourceDevice.type === 'powerscale') {
        mountType = 'nfs';
      }

      const mountConfig = {
        sourceHostname: sourceDevice.hostname,
        sourcePath: sourcePath,
        sourceType: mountType,
        sourceUsername: mountType === 'smb' ? sourceDevice.username : undefined,
        sourcePassword: mountType === 'smb' ? sourcePassword : undefined,
        persistent: true // Persist mount across reboots
      };

      logger.info(`Mounting ${mountType.toUpperCase()} share from ${sourceDevice.hostname}:${sourcePath}`);
      const mountResult = await windowsClient.mountRemoteShare(mountConfig);

      if (!mountResult.success) {
        throw new Error(`Failed to mount source share`);
      }

      logger.info(`Successfully mounted to ${mountResult.mountPoint}`);

      // Step 2: Create proxy share on Windows that re-exports the mounted path
      // Clients will connect to Windows, which transparently serves data from source
      const shareName = sourcePath.split('/').filter(Boolean).pop() || 'share';
      const description = `Gateway share for ${sourceDevice.name}:${sourcePath}`;

      logger.info(`Creating proxy share: ${shareName} pointing to ${mountResult.mountPoint}`);

      const proxyResult = await windowsClient.createProxyShare(
        shareName,
        mountResult.mountPoint,
        exportType,
        description,
        {
          fullAccess: ['Everyone'], // Can be customized
          encryptData: false
        }
      );

      if (!proxyResult.success) {
        logger.warn(`Some proxy shares failed to create`);
      }

      // Step 3: Report completion
      // No bytes transferred since we're proxying, not copying
      // Return a nominal value to indicate success
      logger.info(`Successfully configured Windows gateway for ${sourcePath}`);

      broadcastMessage({
        type: 'migration_progress',
        migrationId,
        message: `Windows gateway configured: ${shareName} -> ${sourceDevice.name}:${sourcePath}`,
        progress: 100
      });

      // Return 0 bytes since no data was actually transferred
      return 0;

    } catch (error) {
      logger.error(`Failed to configure Windows gateway: ${error}`);
      throw error;
    }
  }

  private async transferFromNFS(
    sourceDevice: Device,
    sourcePath: string,
    windowsClient: WindowsFileServerClient,
    targetPath: string,
    migrationId: string
  ): Promise<number> {
    // Use PowerShell to mount NFS share and copy data with robocopy
    const mountPath = `\\\\${sourceDevice.hostname}${sourcePath.replace(/\//g, '\\')}`;

    const script = `
      # Mount source as NFS if needed or access via UNC path
      $sourcePath = "${mountPath}"
      $targetPath = "${targetPath}"

      # Try to access source directly (if accessible via SMB/NFS client)
      if (Test-Path $sourcePath) {
        Write-Output "Source accessible at $sourcePath"
      } else {
        # Mount NFS share
        $nfsPath = "${sourceDevice.hostname}:${sourcePath}"
        Write-Output "Mounting NFS: $nfsPath"
        Mount-NfsShare -Path $nfsPath -LocalPath "Z:" -Persist $false
        $sourcePath = "Z:\\"
      }

      # Use robocopy for data transfer with progress
      $robocopyArgs = @(
        $sourcePath,
        $targetPath,
        "/E",           # Copy subdirectories, including empty ones
        "/COPY:DAT",    # Copy data, attributes, timestamps
        "/R:3",         # Retry 3 times on failed copies
        "/W:5",         # Wait 5 seconds between retries
        "/MT:8",        # Multi-threaded (8 threads)
        "/NP",          # No progress percentage in log
        "/BYTES"        # Show sizes in bytes
      )

      $result = robocopy @robocopyArgs

      # Unmount if we mounted
      if (Test-Path "Z:\\") {
        Dismount-NfsShare -Path "Z:" -Force
      }

      # Calculate total size transferred
      $size = (Get-ChildItem -Path $targetPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
      if ($null -eq $size) { $size = 0 }

      Write-Output "BYTES_TRANSFERRED:$size"
    `;

    try {
      // Execute via PowerShell remoting (will be implemented in WindowsFileServerClient)
      const result = await (windowsClient as any).executePowerShell(script);

      // Parse bytes transferred from output
      const match = result.match(/BYTES_TRANSFERRED:(\d+)/);
      const bytes = match ? parseInt(match[1]) : 0;

      broadcastMessage({
        type: 'transfer_progress',
        migrationId,
        path: sourcePath,
        progress: 100,
        bytesTransferred: bytes
      });

      return bytes;

    } catch (error) {
      logger.error(`NFS transfer failed: ${error}`);
      throw error;
    }
  }

  private async transferFromPowerStore(
    sourceDevice: Device,
    sourcePath: string,
    windowsClient: WindowsFileServerClient,
    targetPath: string,
    migrationId: string
  ): Promise<number> {
    // PowerStore exports can be accessed via SMB or NFS
    // Use similar approach to NFS transfer
    return this.transferFromNFS(sourceDevice, sourcePath, windowsClient, targetPath, migrationId);
  }

  async stopMigration(migrationId: string): Promise<void> {
    this.activeMigrations.set(migrationId, false);
  }

  /**
   * Clone exports to Windows gateway using the mount cloning service
   * This provides better status tracking and logging than direct transfer
   */
  async cloneToWindowsGateway(
    sourceDeviceId: string,
    targetDeviceId: string,
    exportIds: string[],
    options?: {
      shareType?: 'nfs' | 'smb' | 'both';
      persistent?: boolean;
    }
  ): Promise<{ success: boolean; results: any[]; summary: { total: number; succeeded: number; failed: number } }> {
    try {
      logger.info(`Starting clone operation: ${exportIds.length} exports to Windows gateway`);

      const result = await mountCloningService.cloneExportsBatch(exportIds, targetDeviceId, options);

      // Broadcast overall progress
      broadcastMessage({
        type: 'clone_batch_completed',
        sourceDeviceId,
        targetDeviceId,
        summary: result.summary
      });

      logger.info(`Clone operation completed: ${result.summary.succeeded}/${result.summary.total} succeeded`);

      return {
        success: result.summary.failed === 0,
        results: result.results,
        summary: result.summary
      };

    } catch (error: any) {
      logger.error('Clone to Windows gateway failed:', error);
      throw error;
    }
  }

  /**
   * Get source type for mount cloning based on device and export type
   */
  private getMountSourceType(deviceType: string, exportType: string): MountSourceType {
    switch (deviceType) {
      case 'powerscale':
        return exportType === 'nfs' ? 'powerscale_nfs' : 'powerscale_smb';
      case 'isilon':
        return exportType === 'nfs' ? 'isilon_nfs' : 'isilon_smb';
      case 'windows':
        return 'windows_smb';
      default:
        // Assume Linux server
        return exportType === 'nfs' ? 'linux_nfs' : 'linux_smb';
    }
  }

  /**
   * Clone a single export to Windows gateway with full status tracking
   */
  async cloneSingleExport(
    exportId: string,
    targetDeviceId: string,
    options?: {
      shareName?: string;
      shareType?: 'nfs' | 'smb' | 'both';
      persistent?: boolean;
    }
  ): Promise<{ cloneId: string; success: boolean; error?: string }> {
    return mountCloningService.cloneFromExport(exportId, targetDeviceId, options);
  }
}
