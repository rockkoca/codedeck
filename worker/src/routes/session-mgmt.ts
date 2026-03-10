import { Hono, type Context } from 'hono';
import type { Env } from '../types.js';
import { getServerById } from '../db/queries.js';
import { requireAuth, checkServerTeamAccess } from '../security/authorization.js';
import logger from '../util/logger.js';

export const sessionMgmtRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/server/:id/session/start
 * POST /api/server/:id/session/stop
 * POST /api/server/:id/session/send
 *
 * All commands are relayed to the daemon via DaemonBridge (JSON over WebSocket send endpoint).
 * The daemon interprets and executes the session operation locally.
 *
 * Permission model (11.7):
 * - members: can view/send
 * - admins: can start/stop
 * - owners: can manage
 */

// Apply auth middleware globally to all session routes
sessionMgmtRoutes.use('/*', requireAuth());

sessionMgmtRoutes.post('/:id/session/start', async (c) => {
  // start requires admin or owner — no team-membership bypass
  const role = c.get('role' as never) as string;
  if (!['admin', 'owner'].includes(role)) {
    return c.json({ error: 'forbidden', reason: 'start requires admin or owner role' }, 403);
  }
  return relayToDaemon(c, 'session.start');
});

sessionMgmtRoutes.post('/:id/session/stop', async (c) => {
  // stop requires admin or owner — no team-membership bypass
  const role = c.get('role' as never) as string;
  if (!['admin', 'owner'].includes(role)) {
    return c.json({ error: 'forbidden', reason: 'stop requires admin or owner role' }, 403);
  }
  return relayToDaemon(c, 'session.stop');
});

sessionMgmtRoutes.post('/:id/session/send', async (c) => {
  // send allows any authenticated team member — verify server access
  const userId = c.get('userId' as never) as string;
  const hasAccess = await checkServerTeamAccess(c, c.req.param('id')!, userId);
  if (!hasAccess) return c.json({ error: 'forbidden', reason: 'not_authorized_for_server' }, 403);
  return relayToDaemon(c, 'session.send');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function relayToDaemon(
  c: Context<{ Bindings: Env }>,
  command: string,
) {
  const serverId = c.req.param('id')!;
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // body is optional
  }

  const payload = JSON.stringify({ type: command, ...body as object });

  const doId = c.env.DAEMON_BRIDGE.idFromName(serverId);
  const stub = c.env.DAEMON_BRIDGE.get(doId);

  const res = await stub.fetch(
    new Request('https://dummy/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
  );

  if (!res.ok) {
    const text = await res.text();
    logger.error({ serverId, command, status: res.status, text }, 'DaemonBridge relay failed');
    return c.json({ error: 'relay_failed', detail: text }, 502);
  }

  return c.json({ ok: true });
}
