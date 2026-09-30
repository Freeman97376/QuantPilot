import type { NextApiRequest, NextApiResponse } from 'next';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server as HTTPServer } from 'http';
import type { Socket } from 'net';
import { ensureHeartbeat, websocketManager } from '@/lib/server/websocket-manager';
import { APP_BASE_PATH } from '@/lib/config/public-paths';

import { isSafeProjectId } from '@/lib/services/project';
type NextApiResponseWithSocket = NextApiResponse & {
  socket: Socket & {
    server: HTTPServer & {
      wss?: WebSocketServer;
      __ws_initialized__?: boolean;
    };
  };
};

export const config = {
  api: {
    bodyParser: false,
  },
};

const DESKTOP_COOKIE_NAME = 'quantpilot_launch';

function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  for (const part of cookieHeader?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function isAuthorizedDesktopUpgrade(request: IncomingMessage): boolean {
  const runtimeMode = (
    process.env.QUANTPILOT_RUNTIME_MODE || process.env.QUANTPILOT_DEPLOYMENT || 'server'
  ).trim().toLowerCase();
  if (runtimeMode !== 'desktop') return true;

  const expectedToken = process.env.QUANTPILOT_LAUNCH_TOKEN?.trim();
  const actualToken = cookieValue(request.headers.cookie, DESKTOP_COOKIE_NAME);
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!expectedToken || !host || !origin || !tokensEqual(actualToken, expectedToken)) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host && ['127.0.0.1', 'localhost'].includes(originUrl.hostname);
  } catch {
    return false;
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponseWithSocket) {
  // Initialize a shared WebSocket server on the underlying HTTP server once.
  const baseSocket = res.socket as any;
  if (!baseSocket?.server) {
    res.status(500).send('Socket server unavailable');
    return;
  }

  const server = baseSocket.server as typeof baseSocket.server & {
    wss?: WebSocketServer;
    __ws_initialized__?: boolean;
  };

  if (!server.__ws_initialized__) {
    const wss = new WebSocketServer({ noServer: true });

    const handleConnection = (websocket: WebSocket, request: IncomingMessage) => {
      const requestUrl = new URL(request.url ?? '', 'http://localhost');
      const segment = requestUrl.pathname.split('/').filter(Boolean).pop();
      const projectId = segment ? decodeURIComponent(segment) : null;

      if (!isSafeProjectId(projectId)) {
        websocket.close(1008, 'Project ID required');
        return;
      }

      websocketManager.addConnection(projectId, websocket as any);
    };

    wss.on('connection', handleConnection);

    // Attach a single upgrade listener to the HTTP server
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      try {
        const upgradeUrl = new URL(request.url ?? '', 'http://localhost');

        // Raw upgrade URLs retain Next.js basePath. Accept the root form too so
        // local development and already-open clients keep working.
        const websocketPrefixes = [`${APP_BASE_PATH}/api/ws/`, '/api/ws/'];
        if (!websocketPrefixes.some((prefix) => upgradeUrl.pathname.startsWith(prefix))) {
          return; // Let Next.js handle other upgrades (HMR, etc.)
        }

        if (!isAuthorizedDesktopUpgrade(request)) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          );
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
          wss.emit('connection', websocket, request);
        });
      } catch {
        try {
          socket.destroy();
        } catch {
          // Ignore socket destroy failures
        }
      }
    });

    server.wss = wss;
    server.__ws_initialized__ = true;
    ensureHeartbeat();
  }

  // When the browser initiates the WebSocket handshake it sends an Upgrade request.
  // The actual upgrade is handled in the server.on('upgrade') listener above,
  // so we must not attempt to write a normal HTTP response here.
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    return;
  }

  // This API route is only used to ensure the server is initialized.
  // Respond with a simple 200 so the client knows the endpoint exists.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({ ok: true });
}
