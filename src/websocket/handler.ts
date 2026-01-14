import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger';

let wss: WebSocketServer | null = null;
const clients: Set<WebSocket> = new Set();

export function setupWebSocket(webSocketServer: WebSocketServer): void {
  wss = webSocketServer;

  wss.on('connection', (ws: WebSocket, req) => {
    logger.info(`WebSocket client connected from ${req.socket.remoteAddress}`);
    clients.add(ws);

    ws.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        handleMessage(ws, data);
      } catch (error) {
        logger.error('Failed to parse WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
      clients.delete(ws);
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to StorageMover WebSocket server',
      timestamp: new Date().toISOString()
    }));
  });

  logger.info('WebSocket server initialized');
}

function handleMessage(ws: WebSocket, data: any): void {
  switch (data.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      break;

    case 'subscribe':
      // Client subscribing to specific migration updates
      logger.info(`Client subscribed to: ${data.topic}`);
      break;

    default:
      logger.warn(`Unknown WebSocket message type: ${data.type}`);
  }
}

export function broadcastMessage(message: any): void {
  const payload = JSON.stringify({
    ...message,
    timestamp: new Date().toISOString()
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

export function sendToClient(ws: WebSocket, message: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      ...message,
      timestamp: new Date().toISOString()
    }));
  }
}
