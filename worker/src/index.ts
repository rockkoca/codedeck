import { Hono } from 'hono';
import type { Env } from './types.js';
import { authRoutes } from './routes/auth.js';
import { bindRoutes } from './routes/bind.js';
import { serverRoutes } from './routes/server.js';
import { webhookRoutes } from './routes/webhook.js';
import { teamRoutes } from './routes/team.js';
import { sessionMgmtRoutes } from './routes/session-mgmt.js';
import { terminalRoutes } from './routes/terminal.js';
import { outboundRoutes } from './routes/outbound.js';
import { cronApiRoutes } from './routes/cron-api.js';
import { projectRoutes } from './routes/projects.js';
import { pushRoutes } from './routes/push.js';
import { botRoutes } from './routes/bot.js';
import { healthCheckCron } from './cron/health-check.js';
import { jobDispatchCron } from './cron/job-dispatch.js';

export { DaemonBridge } from '../durable-objects/DaemonBridge.js';
export { RateLimiter } from '../durable-objects/RateLimiter.js';

const app = new Hono<{ Bindings: Env }>();

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/bind', bindRoutes);
app.route('/api/server', serverRoutes);
app.route('/api/server', terminalRoutes);
app.route('/api/server', sessionMgmtRoutes);
app.route('/api/team', teamRoutes);
app.route('/api/cron', cronApiRoutes);
app.route('/api/outbound', outboundRoutes);
app.route('/api/server', projectRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/bot', botRoutes);
app.route('/webhook', webhookRoutes);

// Health check
app.get('/api/health', (c) => c.json({ service: 'codedeck-worker', status: 'ok' }));

// Serve web UI static assets (built to ../web/dist, referenced via ASSETS binding in wrangler.toml)
// Any non-API route falls through to the SPA index.html
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  // Only serve SPA for non-API routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhook')) {
    return c.json({ error: 'not_found' }, 404);
  }
  // CF Pages / static assets — handled by wrangler assets binding
  // In dev, proxy to vite dev server; in prod, wrangler handles ASSETS
  return new Response('Remote Chat CLI — build web/ and deploy', { status: 200 });
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (event.cron === '*/5 * * * *') await healthCheckCron(env);
        if (event.cron === '* * * * *') await jobDispatchCron(env);
      })(),
    );
  },
};
