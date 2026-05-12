import type http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export type WsHandler = (type: string, payload: Record<string, unknown>, ws: WebSocket) => void | Promise<void>;

const HEARTBEAT_MS = 30_000;

export function createWsBridge(
  httpServer: http.Server,
  onMessage: WsHandler,
  onConnect?: (ws: WebSocket) => void,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if ((ws as WebSocket & { alive?: boolean }).alive === false) {
        ws.terminate();
        continue;
      }
      (ws as WebSocket & { alive?: boolean }).alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage) => {
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true; });

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; [key: string]: unknown };
        const { type, ...payload } = msg;
        void onMessage(type, payload as Record<string, unknown>, ws);
      } catch {
        // ignore malformed JSON
      }
    });

    ws.on('error', () => { /* connection error, client will reconnect */ });

    onConnect?.(ws);
  });

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

/** Send a typed message to all connected clients. */
export function broadcast(wss: WebSocketServer, msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/** Send a typed message to a single client. */
export function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
