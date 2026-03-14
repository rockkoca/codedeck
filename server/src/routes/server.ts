import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getServersByUserId, updateServerHeartbeat, upsertChannelBinding } from '../db/queries.js';
import { sha256Hex, randomHex } from '../security/crypto.js';
import { requireAuth } from '../security/authorization.js';
import { z } from 'zod';

export const serverRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// GET /api/server — list all servers accessible to the authenticated user
serverRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const dbServers = await getServersByUserId(c.env.DB, userId);

  const servers = dbServers.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    lastHeartbeatAt: s.last_heartbeat_at,
    createdAt: s.created_at,
  }));

  return c.json({ servers });
});

// POST /api/server/:id/heartbeat — authenticated via Bearer server token
serverRoutes.post('/:id/heartbeat', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);
  const tokenHash = sha256Hex(token);

  const serverId = c.req.param('id');
  const server = await c.env.DB.prepare(
    'SELECT id FROM servers WHERE id = ? AND token_hash = ?',
  ).bind(serverId, tokenHash).first<{ id: string }>();
  if (!server) return c.json({ error: 'unauthorized' }, 401);

  await updateServerHeartbeat(c.env.DB, serverId);
  return c.json({ ok: true });
});

/**
 * POST /api/server/:id/bindings — persist a channel binding from the daemon.
 * Authenticated via Bearer server token. The token identifies the server (and thus the owner user).
 * Body: { platform, channelId, botId, bindingType, target }
 *
 * This is the write path that makes inbound webhook routing deterministic.
 * The daemon calls this after processing a /bind command from a user in chat.
 */
serverRoutes.post('/:id/bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);

  const tokenHash = sha256Hex(token);
  const serverRow = await c.env.DB.prepare(
    'SELECT id, user_id FROM servers WHERE token_hash = ? AND id = ?',
  ).bind(tokenHash, c.req.param('id')).first<{ id: string; user_id: string }>();

  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    platform: z.string(),
    channelId: z.string(),
    botId: z.string(),
    bindingType: z.string(),
    target: z.string(),
  }).safeParse(body);

  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { platform, channelId, botId, bindingType, target } = parsed.data;
  const id = randomHex(16);
  await upsertChannelBinding(c.env.DB, id, serverRow.id, platform, channelId, bindingType, target, botId);

  return c.json({ ok: true });
});

/**
 * DELETE /api/server/:id/bindings — remove a channel binding.
 * Body: { platform, channelId, botId }
 */
serverRoutes.delete('/:id/bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);

  const tokenHash = sha256Hex(token);
  const serverRow = await c.env.DB.prepare(
    'SELECT id FROM servers WHERE token_hash = ? AND id = ?',
  ).bind(tokenHash, c.req.param('id')).first<{ id: string }>();

  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ platform: z.string(), channelId: z.string(), botId: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { platform, channelId, botId } = parsed.data;
  // Scope to server_id to prevent cross-server deletion races
  await c.env.DB.prepare(
    'DELETE FROM channel_bindings WHERE platform = ? AND channel_id = ? AND bot_id = ? AND server_id = ?',
  ).bind(platform, channelId, botId, serverRow.id).run();

  return c.json({ ok: true });
});
