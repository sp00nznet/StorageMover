import { NodeSSH } from 'node-ssh';
import { dbGet, dbAll, dbRun } from '../database/init';
import { logger } from '../utils/logger';
import { decryptPassword } from '../utils/crypto';
import { broadcastMessage } from '../websocket/handler';

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

  async stopMigration(migrationId: string): Promise<void> {
    this.activeMigrations.set(migrationId, false);
  }
}
