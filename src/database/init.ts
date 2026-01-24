import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/storagemover.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new sqlite3.Database(DB_PATH);

// Promisify database methods
export const dbRun = promisify(db.run.bind(db)) as (sql: string, params?: any[]) => Promise<void>;
export const dbGet = promisify(db.get.bind(db)) as <T>(sql: string, params?: any[]) => Promise<T | undefined>;
export const dbAll = promisify(db.all.bind(db)) as <T>(sql: string, params?: any[]) => Promise<T[]>;

export async function initDatabase(): Promise<void> {
  const schema = `
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Storage devices table (Isilon, PowerScale, PowerStore, Windows)
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('isilon', 'powerscale', 'powerstore', 'windows')),
      hostname TEXT NOT NULL,
      port INTEGER DEFAULT 8080,
      username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      status TEXT DEFAULT 'disconnected',
      last_connected DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Network exports discovered from devices
    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      export_path TEXT NOT NULL,
      export_type TEXT NOT NULL CHECK (export_type IN ('nfs', 'smb', 'both')),
      clients TEXT,
      permissions TEXT,
      description TEXT,
      size_bytes INTEGER,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    -- Migration jobs
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      progress INTEGER DEFAULT 0,
      bytes_transferred INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0,
      files_transferred INTEGER DEFAULT 0,
      total_files INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_device_id) REFERENCES devices(id),
      FOREIGN KEY (target_device_id) REFERENCES devices(id)
    );

    -- Migration items (individual exports to migrate)
    CREATE TABLE IF NOT EXISTS migration_items (
      id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL,
      export_id TEXT NOT NULL,
      target_path TEXT,
      status TEXT DEFAULT 'pending',
      bytes_transferred INTEGER DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY (migration_id) REFERENCES migrations(id) ON DELETE CASCADE,
      FOREIGN KEY (export_id) REFERENCES exports(id)
    );

    -- Configuration exports (for PowerStore)
    CREATE TABLE IF NOT EXISTS config_exports (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      config_type TEXT NOT NULL,
      config_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    -- Activity log
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Mount clones table (for tracking cloned mounts on Windows gateway)
    CREATE TABLE IF NOT EXISTS mount_clones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('linux_nfs', 'linux_smb', 'windows_smb', 'powerscale_nfs', 'powerscale_smb', 'isilon_nfs', 'isilon_smb')),
      source_hostname TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_username TEXT,
      source_password_encrypted TEXT,
      target_device_id TEXT NOT NULL,
      mount_point TEXT,
      share_name TEXT,
      share_type TEXT CHECK (share_type IN ('nfs', 'smb', 'both')),
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'mounting', 'creating_share', 'active', 'failed', 'disconnected', 'removed')),
      error_message TEXT,
      persistent INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_health_check DATETIME,
      FOREIGN KEY (target_device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    -- Mount clone logs table (for detailed operation logging)
    CREATE TABLE IF NOT EXISTS mount_clone_logs (
      id TEXT PRIMARY KEY,
      clone_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'debug')),
      message TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clone_id) REFERENCES mount_clones(id) ON DELETE CASCADE
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_exports_device ON exports(device_id);
    CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status);
    CREATE INDEX IF NOT EXISTS idx_migration_items_migration ON migration_items(migration_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_mount_clones_target ON mount_clones(target_device_id);
    CREATE INDEX IF NOT EXISTS idx_mount_clones_status ON mount_clones(status);
    CREATE INDEX IF NOT EXISTS idx_mount_clone_logs_clone ON mount_clone_logs(clone_id);
  `;

  return new Promise((resolve, reject) => {
    db.exec(schema, (err) => {
      if (err) {
        logger.error('Failed to initialize database schema:', err);
        reject(err);
      } else {
        logger.info('Database schema initialized');
        resolve();
      }
    });
  });
}
