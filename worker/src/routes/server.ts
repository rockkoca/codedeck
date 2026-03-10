import { Hono } from 'hono';
import type { Env } from '../types.js';
import { getServerById, updateServerHeartbeat } from '../db/queries.js';

export const serverRoutes = new Hono<{ Bindings: Env }>();

// GET /api/server/:id/ws — upgrade to WebSocket, proxy to DaemonBridge DO
serverRoutes.get('/:id/ws', async (c) => {
  const serverId = c.req.param('id');
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const id = c.env.DAEMON_BRIDGE.idFromName(serverId);
  const stub = c.env.DAEMON_BRIDGE.get(id);
  const url = new URL(c.req.url);
  url.pathname = '/daemon';
  return stub.fetch(new Request(url, c.req.raw));
});

// POST /api/server/:id/heartbeat
serverRoutes.post('/:id/heartbeat', async (c) => {
  const serverId = c.req.param('id');
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);
  await updateServerHeartbeat(c.env.DB, serverId);
  return c.json({ ok: true });
});
