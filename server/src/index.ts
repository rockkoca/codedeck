/**
 * Codedeck Node.js server entry point.
 * Replaces the Cloudflare Workers deployment.
 */

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import proxyAddr from 'proxy-addr';
import cron from 'node-cron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat, readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';

import { loadEnv, type Env } from './env.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { authRoutes } from './routes/auth.js';
import { githubAuthRoutes } from './routes/github-auth.js';
import { bindRoutes } from './routes/bind.js';
import { serverRoutes } from './routes/server.js';
import { webhookRoutes } from './routes/webhook.js';
import { outboundRoutes } from './routes/outbound.js';
import { botRoutes } from './routes/bot.js';
import { teamRoutes } from './routes/team.js';
import { cronApiRoutes } from './routes/cron-api.js';
import { pushRoutes } from './routes/push.js';
import { quickDataRoutes } from './routes/quick-data.js';
import { sessionMgmtRoutes } from './routes/session-mgmt.js';
import { subSessionRoutes } from './routes/sub-sessions.js';
import { healthCheckCron } from './cron/health-check.js';
import { jobDispatchCron } from './cron/job-dispatch.js';
import { WsBridge } from './ws/bridge.js';
import { MemoryRateLimiter } from './ws/rate-limiter.js';
import { rateLimiter } from './security/lockout.js';
import { verifyJwt } from './security/crypto.js';
import { resolveServerRole } from './security/authorization.js';
import logger from './util/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Docker: /app/dist/index.js → /app/web/dist
// Dev:    server/dist/index.js → web/dist (two levels up from server/dist)
const WEB_DIST = process.env.WEB_DIST_PATH ?? join(__dirname, '..', '..', 'web', 'dist');

// ── Daemon connection protection ──────────────────────────────────────────────
const daemonConnectLimiter = new MemoryRateLimiter();
let unauthenticatedDaemonCount = 0;
const MAX_UNAUTH_CONNECTIONS = 1000;

// ── Hono app ──────────────────────────────────────────────────────────────────

export function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Inject env into every request context
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env);
    await next();
  });

  // Extract real client IP using proxy-addr (same library as Express).
  // Runs once per request; routes read c.get('clientIp') — never raw XFF.
  const trust = proxyAddr.compile(
    env.TRUSTED_PROXIES
      ? env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  );
  app.use('*', async (c, next) => {
    let socketIp = '127.0.0.1';
    try { socketIp = getConnInfo(c).remote.address ?? '127.0.0.1'; } catch { /* test or non-node context */ }
    const xff = c.req.header('x-forwarded-for');
    const fakeReq = { socket: { remoteAddress: socketIp }, headers: { 'x-forwarded-for': xff } };
    const clientIp = proxyAddr(fakeReq as never, trust);
    c.set('clientIp' as never, clientIp);
    await next();
  });

  app.route('/api/auth', authRoutes);
  app.route('/api/auth/github', githubAuthRoutes);
  app.route('/api/bind', bindRoutes);
  app.route('/api/server', serverRoutes);
  app.route('/webhook', webhookRoutes);
  app.route('/api/outbound', outboundRoutes);
  app.route('/api/bot', botRoutes);
  app.route('/api/team', teamRoutes);
  app.route('/api/cron', cronApiRoutes);
  app.route('/api/push', pushRoutes);
  app.route('/api/quick-data', quickDataRoutes);
  app.route('/api/server', sessionMgmtRoutes);
  app.route('/api/server', subSessionRoutes);

  app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

  // Static file serving + SPA fallback
  app.get('*', async (c) => {
    const reqPath = new URL(c.req.url).pathname;
    if (reqPath.startsWith('/api/') || reqPath.startsWith('/webhook/')) {
      return c.json({ error: 'not_found' }, 404);
    }

    const filePath = join(WEB_DIST, reqPath === '/' ? 'index.html' : reqPath);
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const ext = filePath.split('.').pop() ?? '';
        const mime: Record<string, string> = {
          html: 'text/html', js: 'application/javascript', css: 'text/css',
          png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
          woff2: 'font/woff2', ico: 'image/x-icon', json: 'application/json',
        };
        const content = await readFile(filePath);
        return new Response(content, { headers: { 'Content-Type': mime[ext] ?? 'application/octet-stream' } });
      }
    } catch { /* fall through */ }

    // SPA fallback
    try {
      const html = await readFile(join(WEB_DIST, 'index.html'));
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    } catch {
      return c.text('Not found', 404);
    }
  });

  return app;
}

// ── WebSocket upgrade handler ─────────────────────────────────────────────────

function setupWebSocketUpgrade(server: import('node:http').Server, env: Env) {
  const wss = new WebSocketServer({ noServer: true });
  // Compile trust function once — same proxy-addr library used by HTTP middleware
  const wsTrust = proxyAddr.compile(
    env.TRUSTED_PROXIES
      ? env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  );

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/server\/([^/]+)\/(ws|terminal)$/);
    if (!match) { socket.destroy(); return; }

    const [, serverId, endpoint] = match;

    if (endpoint === 'ws') {
      // Daemon connection — per-IP rate limit + global cap
      const ip = proxyAddr(req as never, wsTrust);
      if (!daemonConnectLimiter.check(`daemon:${ip}`, 5, 10_000)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      if (unauthenticatedDaemonCount >= MAX_UNAUTH_CONNECTIONS) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      unauthenticatedDaemonCount++;
      wss.handleUpgrade(req, socket, head, (ws) => {
        let counted = true;
        const decrement = () => {
          if (counted) { counted = false; unauthenticatedDaemonCount = Math.max(0, unauthenticatedDaemonCount - 1); }
        };
        WsBridge.get(serverId).handleDaemonConnection(ws, env.DB, env, decrement);
        ws.once('close', decrement); // also decrement if auth never completes
      });

    } else {
      // Browser terminal connection — Origin + ticket + access control
      const origin = req.headers['origin'] ?? '';
      if (!validateOrigin(origin, env)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const ticket = url.searchParams.get('ticket');
      if (!ticket) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

      const payload = verifyJwt(ticket, env.JWT_SIGNING_KEY);
      if (!payload || payload.type !== 'ws-ticket' || payload.sid !== serverId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      const jti = payload.jti as string;
      if (!jti || !rateLimiter.consumeJti(jti, 30_000)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      try {
        const role = await resolveServerRole(env.DB, serverId, payload.sub as string);
        if (role === 'none') { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      } catch {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); socket.destroy(); return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        WsBridge.get(serverId).handleBrowserConnection(ws);
      });
    }
  });
}

function validateOrigin(origin: string, env: Env): boolean {
  if (!env.ALLOWED_ORIGINS) return env.NODE_ENV === 'development';
  return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
}

// ── Cron ──────────────────────────────────────────────────────────────────────

function scheduleCrons(env: Env) {
  cron.schedule('*/5 * * * *', () => {
    healthCheckCron(env).catch((err) => logger.error({ err }, 'Health check cron failed'));
  });
  cron.schedule('* * * * *', () => {
    jobDispatchCron(env).catch((err) => logger.error({ err }, 'Job dispatch cron failed'));
  });
  logger.info({}, 'Cron jobs scheduled');
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  const envConfig = loadEnv();
  const db = createDatabase(envConfig.DATABASE_URL);
  const env: Env = { ...envConfig, DB: db };

  const bindHost = env.BIND_HOST ?? '0.0.0.0';
  const port = parseInt(env.PORT ?? '3000', 10);

  if (bindHost === '0.0.0.0') {
    logger.warn({}, 'Server is listening on 0.0.0.0 — ensure TLS is terminated by a reverse proxy');
  }
  if (!env.ALLOWED_ORIGINS && env.NODE_ENV !== 'development') {
    logger.error({}, 'ALLOWED_ORIGINS not set — all browser WebSocket connections will be rejected. Set ALLOWED_ORIGINS for production use.');
  } else if (!env.ALLOWED_ORIGINS) {
    logger.warn({}, 'ALLOWED_ORIGINS not set — Origin check disabled (dev mode)');
  }

  await runMigrations(db);

  const app = buildApp(env);

  // serve() returns the http.Server — attach WS upgrade to same server
  const httpServer = serve({ fetch: app.fetch, port, hostname: bindHost }, (info) => {
    logger.info({ port: info.port, host: bindHost }, 'Codedeck server started');
    scheduleCrons(env);
  });

  setupWebSocketUpgrade(httpServer as unknown as import('node:http').Server, env);
}

// Only start the server when run directly (not when imported by tests)
const isMain = import.meta.url === new URL(process.argv[1], 'file://').href ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error('[startup] Fatal error:', err);
    process.exit(1);
  });
}
