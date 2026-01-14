import { Router, Request, Response } from 'express';
import { dbGet, dbAll, dbRun } from '../database/init';
import { logger } from '../utils/logger';
import { authenticateToken } from './auth';

export const exportRouter = Router();

exportRouter.use(authenticateToken);

interface Export {
  id: string;
  device_id: string;
  export_path: string;
  export_type: string;
  clients: string;
  permissions: string;
  description: string;
  size_bytes: number;
  discovered_at: string;
}

// Get all exports
exportRouter.get('/', async (req: Request, res: Response) => {
  try {
    const deviceId = req.query.deviceId as string;
    let query = `
      SELECT e.*, d.name as device_name, d.type as device_type, d.hostname
      FROM exports e
      JOIN devices d ON e.device_id = d.id
    `;
    const params: any[] = [];

    if (deviceId) {
      query += ' WHERE e.device_id = ?';
      params.push(deviceId);
    }

    query += ' ORDER BY e.export_path';

    const exports = await dbAll<Export & { device_name: string; device_type: string; hostname: string }>(query, params);

    // Parse clients JSON
    const parsedExports = exports.map(exp => ({
      ...exp,
      clients: JSON.parse(exp.clients || '[]')
    }));

    res.json(parsedExports);
  } catch (error) {
    logger.error('Failed to get exports:', error);
    res.status(500).json({ error: 'Failed to get exports' });
  }
});

// Get single export
exportRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const exp = await dbGet<Export>(
      `SELECT e.*, d.name as device_name, d.type as device_type, d.hostname
       FROM exports e
       JOIN devices d ON e.device_id = d.id
       WHERE e.id = ?`,
      [req.params.id]
    );

    if (!exp) {
      return res.status(404).json({ error: 'Export not found' });
    }

    res.json({
      ...exp,
      clients: JSON.parse((exp as any).clients || '[]')
    });
  } catch (error) {
    logger.error('Failed to get export:', error);
    res.status(500).json({ error: 'Failed to get export' });
  }
});

// Get exports by device
exportRouter.get('/device/:deviceId', async (req: Request, res: Response) => {
  try {
    const exports = await dbAll<Export>(
      'SELECT * FROM exports WHERE device_id = ? ORDER BY export_path',
      [req.params.deviceId]
    );

    const parsedExports = exports.map(exp => ({
      ...exp,
      clients: JSON.parse(exp.clients || '[]')
    }));

    res.json(parsedExports);
  } catch (error) {
    logger.error('Failed to get device exports:', error);
    res.status(500).json({ error: 'Failed to get device exports' });
  }
});

// Delete export from database (not from device)
exportRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await dbRun('DELETE FROM exports WHERE id = ?', [req.params.id]);
    res.json({ message: 'Export deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete export:', error);
    res.status(500).json({ error: 'Failed to delete export' });
  }
});

// Clear all exports for a device
exportRouter.delete('/device/:deviceId', async (req: Request, res: Response) => {
  try {
    await dbRun('DELETE FROM exports WHERE device_id = ?', [req.params.deviceId]);
    res.json({ message: 'Device exports cleared successfully' });
  } catch (error) {
    logger.error('Failed to clear device exports:', error);
    res.status(500).json({ error: 'Failed to clear device exports' });
  }
});

// Get export statistics
exportRouter.get('/stats/summary', async (req: Request, res: Response) => {
  try {
    const stats = await dbGet<{ total: number; nfs: number; smb: number; both: number; total_size: number }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN export_type = 'nfs' THEN 1 ELSE 0 END) as nfs,
        SUM(CASE WHEN export_type = 'smb' THEN 1 ELSE 0 END) as smb,
        SUM(CASE WHEN export_type = 'both' THEN 1 ELSE 0 END) as both,
        SUM(size_bytes) as total_size
      FROM exports
    `, []);

    res.json(stats);
  } catch (error) {
    logger.error('Failed to get export statistics:', error);
    res.status(500).json({ error: 'Failed to get export statistics' });
  }
});
