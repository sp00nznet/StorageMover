import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { logger } from './utils/logger';
import { initDatabase } from './database/init';
import { authRouter } from './routes/auth';
import { deviceRouter } from './routes/devices';
import { exportRouter } from './routes/exports';
import { migrationRouter } from './routes/migrations';
import { configRouter } from './routes/config';
import { setupWebSocket } from './websocket/handler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/devices', deviceRouter);
app.use('/api/exports', exportRouter);
app.use('/api/migrations', migrationRouter);
app.use('/api/config', configRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

// Create HTTP server
const server = createServer(app);

// WebSocket setup for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Initialize database and start server
async function startServer() {
  try {
    await initDatabase();
    logger.info('Database initialized successfully');

    server.listen(PORT, () => {
      logger.info(`StorageMover server running on port ${PORT}`);
      logger.info(`WebSocket server running on ws://localhost:${PORT}/ws`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export { app, server };
