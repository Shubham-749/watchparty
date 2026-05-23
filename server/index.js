/**
 * index.js — Entry point
 * Wires Express (HTTP) + ws.Server (WebSocket) on the same HTTP listener.
 * Loads env, initialises DB, then starts accepting connections.
 */
'use strict';

// Load .env if present (optional; real deployments use process env)
try { require('fs').readFileSync('.env', 'utf8').split('\n').forEach(l => {
  const [k, ...v] = l.split('=');
  if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
}); } catch { /* no .env file — that's fine */ }

const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { initDb }          = require('./db');
const { router, staticMiddleware } = require('./gateway');
const { validateInviteToken } = require('./roomService');
const { handleConnection }   = require('./syncService');

const PORT = parseInt(process.env.PORT ?? process.env.WP_PORT ?? '3000', 10);

async function main() {
  // 1. Initialise Postgres schema (idempotent)
  await initDb();

  // 2. Build Express app
  const app = express();
  app.set('trust proxy', 1);            // Correct IP behind reverse proxy
  app.use(staticMiddleware());          // Serve /public
  app.use('/api', router);              // API Gateway routes

  // 404 fallback
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // 3. Shared HTTP server (Express + ws share one port)
  const server = http.createServer(app);

  // 4. WebSocket server — upgrade only when path starts with /ws
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    console.log('[index.js upgrade] Request URL:', req.url);

    if (!url.pathname.startsWith('/ws')) {
      console.log('[index.js upgrade] URL does not start with /ws, destroying socket');
      socket.destroy();
      return;
    }

    // NFR-06: Security — Validate invite token on WebSocket upgrade
    const roomId = url.searchParams.get('roomId');
    const token  = url.searchParams.get('token');

    console.log('[index.js upgrade] Validating token for room:', roomId);
    const { valid, error } = await validateInviteToken(roomId, token);

    if (!valid) {
      console.log('[index.js upgrade] Security Bypass blocked:', error);
      socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${error}`);
      socket.destroy();
      return;
    }

    console.log('[index.js upgrade] Handling WebSocket upgrade');
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[index.js upgrade] WebSocket upgraded, emitting connection event');
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', handleConnection);

  // 5. Start listening
  server.listen(PORT, () => {
    console.log(`[WatchParty] Server ready → http://localhost:${PORT}`);
  });

  // 6. Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[WatchParty] Shutting down…');
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[WatchParty] Fatal startup error:', err);
  process.exit(1);
});
