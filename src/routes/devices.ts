import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun, dbAll } from '../database/init';
import { logger } from '../utils/logger';
import { authenticateToken } from './auth';
import { IsilonClient } from '../services/isilon';
import { PowerScaleClient } from '../services/powerscale';
import { PowerStoreClient } from '../services/powerstore';
import { encryptPassword, decryptPassword } from '../utils/crypto';

export const deviceRouter = Router();

// Apply authentication to all device routes
deviceRouter.use(authenticateToken);

interface Device {
  id: string;
  name: string;
  type: 'isilon' | 'powerscale' | 'powerstore';
  hostname: string;
  port: number;
  username: string;
  password_encrypted: string;
  status: string;
  last_connected: string | null;
}

// Get all devices
deviceRouter.get('/', async (req: Request, res: Response) => {
  try {
    const devices = await dbAll<Device>('SELECT id, name, type, hostname, port, username, status, last_connected, created_at FROM devices', []);
    res.json(devices);
  } catch (error) {
    logger.error('Failed to get devices:', error);
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

// Get single device
deviceRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const device = await dbGet<Device>(
      'SELECT id, name, type, hostname, port, username, status, last_connected, created_at FROM devices WHERE id = ?',
      [req.params.id]
    );
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    logger.error('Failed to get device:', error);
    res.status(500).json({ error: 'Failed to get device' });
  }
});

// Add new device
deviceRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { name, type, hostname, port, username, password } = req.body;

    if (!name || !type || !hostname || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!['isilon', 'powerscale', 'powerstore'].includes(type)) {
      return res.status(400).json({ error: 'Invalid device type' });
    }

    const deviceId = uuidv4();
    const encryptedPassword = encryptPassword(password);

    await dbRun(
      `INSERT INTO devices (id, name, type, hostname, port, username, password_encrypted, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'disconnected')`,
      [deviceId, name, type, hostname, port || 8080, username, encryptedPassword]
    );

    logger.info(`Device added: ${name} (${type})`);

    res.status(201).json({
      id: deviceId,
      name,
      type,
      hostname,
      port: port || 8080,
      username,
      status: 'disconnected'
    });
  } catch (error) {
    logger.error('Failed to add device:', error);
    res.status(500).json({ error: 'Failed to add device' });
  }
});

// Update device
deviceRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, hostname, port, username, password } = req.body;
    const deviceId = req.params.id;

    const device = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    let updateQuery = 'UPDATE devices SET name = ?, hostname = ?, port = ?, username = ?, updated_at = CURRENT_TIMESTAMP';
    let params: any[] = [name || device.name, hostname || device.hostname, port || device.port, username || device.username];

    if (password) {
      updateQuery += ', password_encrypted = ?';
      params.push(encryptPassword(password));
    }

    updateQuery += ' WHERE id = ?';
    params.push(deviceId);

    await dbRun(updateQuery, params);

    logger.info(`Device updated: ${deviceId}`);
    res.json({ message: 'Device updated successfully' });
  } catch (error) {
    logger.error('Failed to update device:', error);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// Delete device
deviceRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await dbRun('DELETE FROM devices WHERE id = ?', [req.params.id]);
    logger.info(`Device deleted: ${req.params.id}`);
    res.json({ message: 'Device deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete device:', error);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// Test device connection
deviceRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const device = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const password = decryptPassword(device.password_encrypted);
    let client;

    switch (device.type) {
      case 'isilon':
        client = new IsilonClient(device.hostname, device.port, device.username, password);
        break;
      case 'powerscale':
        client = new PowerScaleClient(device.hostname, device.port, device.username, password);
        break;
      case 'powerstore':
        client = new PowerStoreClient(device.hostname, device.port, device.username, password);
        break;
    }

    const connected = await client.testConnection();

    if (connected) {
      await dbRun(
        'UPDATE devices SET status = ?, last_connected = CURRENT_TIMESTAMP WHERE id = ?',
        ['connected', device.id]
      );
      res.json({ success: true, message: 'Connection successful' });
    } else {
      await dbRun('UPDATE devices SET status = ? WHERE id = ?', ['failed', device.id]);
      res.json({ success: false, message: 'Connection failed' });
    }
  } catch (error) {
    logger.error('Failed to test connection:', error);
    await dbRun('UPDATE devices SET status = ? WHERE id = ?', ['failed', req.params.id]);
    res.status(500).json({ error: 'Connection test failed', details: (error as Error).message });
  }
});

// Discover exports from device
deviceRouter.post('/:id/discover', async (req: Request, res: Response) => {
  try {
    const device = await dbGet<Device>('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const password = decryptPassword(device.password_encrypted);
    let client;
    let exports: any[] = [];

    switch (device.type) {
      case 'isilon':
        client = new IsilonClient(device.hostname, device.port, device.username, password);
        exports = await client.discoverExports();
        break;
      case 'powerscale':
        client = new PowerScaleClient(device.hostname, device.port, device.username, password);
        exports = await client.discoverExports();
        break;
      case 'powerstore':
        client = new PowerStoreClient(device.hostname, device.port, device.username, password);
        exports = await client.discoverExports();
        break;
    }

    // Store discovered exports in database
    for (const exp of exports) {
      const exportId = uuidv4();
      await dbRun(
        `INSERT OR REPLACE INTO exports (id, device_id, export_path, export_type, clients, permissions, description, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [exportId, device.id, exp.path, exp.type, JSON.stringify(exp.clients), exp.permissions, exp.description, exp.size]
      );
    }

    logger.info(`Discovered ${exports.length} exports from ${device.name}`);
    res.json({ exports, count: exports.length });
  } catch (error) {
    logger.error('Failed to discover exports:', error);
    res.status(500).json({ error: 'Failed to discover exports', details: (error as Error).message });
  }
});
