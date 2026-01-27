import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../database/init';
import { logger } from '../utils/logger';
import { authenticateToken } from './auth';
import { MigrationService } from '../services/migration';
import { broadcastMessage } from '../websocket/handler';

export const migrationRouter = Router();

migrationRouter.use(authenticateToken);

interface Migration {
  id: string;
  name: string;
  source_device_id: string;
  target_device_id: string;
  status: string;
  progress: number;
  bytes_transferred: number;
  total_bytes: number;
  files_transferred: number;
  total_files: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface MigrationItem {
  id: string;
  migration_id: string;
  export_id: string;
  target_path: string;
  status: string;
  bytes_transferred: number;
  error_message: string | null;
}

// Get all migrations
migrationRouter.get('/', async (req: Request, res: Response) => {
  try {
    const migrations = await dbAll<Migration & { source_device_name: string; target_device_name: string }>(`
      SELECT m.*,
             sd.name as source_device_name,
             td.name as target_device_name
      FROM migrations m
      JOIN devices sd ON m.source_device_id = sd.id
      JOIN devices td ON m.target_device_id = td.id
      ORDER BY m.created_at DESC
    `, []);

    res.json(migrations);
  } catch (error) {
    logger.error('Failed to get migrations:', error);
    res.status(500).json({ error: 'Failed to get migrations' });
  }
});

// Get single migration with items
migrationRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const migration = await dbGet<Migration & { source_device_name: string; target_device_name: string }>(`
      SELECT m.*,
             sd.name as source_device_name,
             td.name as target_device_name
      FROM migrations m
      JOIN devices sd ON m.source_device_id = sd.id
      JOIN devices td ON m.target_device_id = td.id
      WHERE m.id = ?
    `, [req.params.id]);

    if (!migration) {
      return res.status(404).json({ error: 'Migration not found' });
    }

    const items = await dbAll<MigrationItem & { export_path: string }>(`
      SELECT mi.*, e.export_path
      FROM migration_items mi
      JOIN exports e ON mi.export_id = e.id
      WHERE mi.migration_id = ?
    `, [req.params.id]);

    res.json({ ...migration, items });
  } catch (error) {
    logger.error('Failed to get migration:', error);
    res.status(500).json({ error: 'Failed to get migration' });
  }
});

// Create new migration
migrationRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { name, sourceDeviceId, targetDeviceId, exportIds, targetBasePath } = req.body;

    if (!name || !sourceDeviceId || !targetDeviceId || !exportIds?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const migrationId = uuidv4();

    // Calculate total size
    const exports = await dbAll<{ id: string; size_bytes: number }>(`
      SELECT id, size_bytes FROM exports WHERE id IN (${exportIds.map(() => '?').join(',')})
    `, exportIds);

    const totalBytes = exports.reduce((sum, exp) => sum + (exp.size_bytes || 0), 0);

    await dbRun(`
      INSERT INTO migrations (id, name, source_device_id, target_device_id, status, total_bytes, total_files)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `, [migrationId, name, sourceDeviceId, targetDeviceId, totalBytes, exportIds.length]);

    // Create migration items
    for (const exportId of exportIds) {
      const exp = await dbGet<{ export_path: string }>('SELECT export_path FROM exports WHERE id = ?', [exportId]);
      const itemId = uuidv4();
      const targetPath = targetBasePath ? `${targetBasePath}${exp?.export_path}` : exp?.export_path;

      await dbRun(`
        INSERT INTO migration_items (id, migration_id, export_id, target_path, status)
        VALUES (?, ?, ?, ?, 'pending')
      `, [itemId, migrationId, exportId, targetPath]);
    }

    logger.info(`Migration created: ${name} (${migrationId})`);

    res.status(201).json({
      id: migrationId,
      name,
      sourceDeviceId,
      targetDeviceId,
      status: 'pending',
      totalBytes,
      itemCount: exportIds.length
    });
  } catch (error) {
    logger.error('Failed to create migration:', error);
    res.status(500).json({ error: 'Failed to create migration' });
  }
});

// Start migration
migrationRouter.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const migration = await dbGet<Migration>('SELECT * FROM migrations WHERE id = ?', [req.params.id]);

    if (!migration) {
      return res.status(404).json({ error: 'Migration not found' });
    }

    if (migration.status !== 'pending' && migration.status !== 'paused') {
      return res.status(400).json({ error: `Cannot start migration with status: ${migration.status}` });
    }

    await dbRun(`
      UPDATE migrations
      SET status = 'running', started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [req.params.id]);

    // Start migration in background
    const migrationService = new MigrationService();
    migrationService.startMigration(req.params.id).catch(error => {
      logger.error(`Migration ${req.params.id} failed:`, error);
    });

    broadcastMessage({ type: 'migration_started', migrationId: req.params.id });

    res.json({ message: 'Migration started', migrationId: req.params.id });
  } catch (error) {
    logger.error('Failed to start migration:', error);
    res.status(500).json({ error: 'Failed to start migration' });
  }
});

// Pause migration
migrationRouter.post('/:id/pause', async (req: Request, res: Response) => {
  try {
    const migration = await dbGet<Migration>('SELECT * FROM migrations WHERE id = ?', [req.params.id]);

    if (!migration) {
      return res.status(404).json({ error: 'Migration not found' });
    }

    if (migration.status !== 'running') {
      return res.status(400).json({ error: 'Migration is not running' });
    }

    await dbRun('UPDATE migrations SET status = ? WHERE id = ?', ['paused', req.params.id]);

    broadcastMessage({ type: 'migration_paused', migrationId: req.params.id });

    res.json({ message: 'Migration paused' });
  } catch (error) {
    logger.error('Failed to pause migration:', error);
    res.status(500).json({ error: 'Failed to pause migration' });
  }
});

// Cancel migration
migrationRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const migration = await dbGet<Migration>('SELECT * FROM migrations WHERE id = ?', [req.params.id]);

    if (!migration) {
      return res.status(404).json({ error: 'Migration not found' });
    }

    if (migration.status === 'completed' || migration.status === 'cancelled') {
      return res.status(400).json({ error: `Cannot cancel migration with status: ${migration.status}` });
    }

    await dbRun('UPDATE migrations SET status = ? WHERE id = ?', ['cancelled', req.params.id]);

    broadcastMessage({ type: 'migration_cancelled', migrationId: req.params.id });

    res.json({ message: 'Migration cancelled' });
  } catch (error) {
    logger.error('Failed to cancel migration:', error);
    res.status(500).json({ error: 'Failed to cancel migration' });
  }
});

// Delete migration
migrationRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const migration = await dbGet<Migration>('SELECT * FROM migrations WHERE id = ?', [req.params.id]);

    if (!migration) {
      return res.status(404).json({ error: 'Migration not found' });
    }

    if (migration.status === 'running') {
      return res.status(400).json({ error: 'Cannot delete running migration' });
    }

    await dbRun('DELETE FROM migrations WHERE id = ?', [req.params.id]);

    res.json({ message: 'Migration deleted' });
  } catch (error) {
    logger.error('Failed to delete migration:', error);
    res.status(500).json({ error: 'Failed to delete migration' });
  }
});

// Get migration statistics
migrationRouter.get('/stats/summary', async (req: Request, res: Response) => {
  try {
    const stats = await dbGet<{
      total: number;
      pending: number;
      running: number;
      completed: number;
      failed: number;
      total_bytes_transferred: number
    }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(bytes_transferred) as total_bytes_transferred
      FROM migrations
    `, []);

    res.json(stats);
  } catch (error) {
    logger.error('Failed to get migration statistics:', error);
    res.status(500).json({ error: 'Failed to get migration statistics' });
  }
});

// Clone exports to Windows gateway (alternative to data migration)
migrationRouter.post('/clone-to-gateway', async (req: Request, res: Response) => {
  try {
    const { sourceDeviceId, targetDeviceId, exportIds, shareType, persistent } = req.body;

    if (!sourceDeviceId || !targetDeviceId || !exportIds?.length) {
      return res.status(400).json({ error: 'Missing required fields: sourceDeviceId, targetDeviceId, exportIds' });
    }

    // Verify target is Windows
    const targetDevice = await dbGet<{ type: string }>('SELECT type FROM devices WHERE id = ?', [targetDeviceId]);
    if (!targetDevice) {
      return res.status(404).json({ error: 'Target device not found' });
    }
    if (targetDevice.type !== 'windows') {
      return res.status(400).json({ error: 'Target device must be a Windows file server for gateway cloning' });
    }

    const migrationService = new MigrationService();
    const result = await migrationService.cloneToWindowsGateway(
      sourceDeviceId,
      targetDeviceId,
      exportIds,
      { shareType, persistent }
    );

    logger.info(`Gateway clone completed: ${result.summary.succeeded}/${result.summary.total} succeeded`);

    res.json({
      success: result.success,
      summary: result.summary,
      results: result.results.map(r => ({
        exportId: r.exportId,
        cloneId: r.cloneId,
        success: r.success,
        error: r.error
      }))
    });
  } catch (error) {
    logger.error('Failed to clone to gateway:', error);
    res.status(500).json({ error: 'Failed to clone to gateway' });
  }
});
