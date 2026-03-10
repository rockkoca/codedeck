// ── Types ─────────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  created_at: number;
}

export interface DbPlatformIdentity {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  created_at: number;
}

export interface DbServer {
  id: string;
  user_id: string;
  team_id: string | null;
  name: string;
  token_hash: string;
  last_heartbeat_at: number | null;
  status: string;
  created_at: number;
}

export interface DbChannelBinding {
  id: string;
  server_id: string;
  platform: string;
  channel_id: string;
  binding_type: string;
  target: string;
  created_at: number;
}

export interface DbCronJob {
  id: string;
  server_id: string;
  user_id: string;
  name: string;
  cron_expr: string;
  action: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

// ── Users ─────────────────────────────────────────────────────────────────

export async function createUser(db: D1Database, id: string): Promise<DbUser> {
  const now = Date.now();
  await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, now).run();
  return { id, created_at: now };
}

export async function getUserById(db: D1Database, id: string): Promise<DbUser | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<DbUser>();
}

// ── Platform identities ───────────────────────────────────────────────────

export async function upsertPlatformIdentity(
  db: D1Database,
  id: string,
  userId: string,
  platform: string,
  platformUserId: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO platform_identities (id, user_id, platform, platform_user_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, platform_user_id) DO NOTHING',
    )
    .bind(id, userId, platform, platformUserId, Date.now())
    .run();
}

export async function getUserByPlatformId(
  db: D1Database,
  platform: string,
  platformUserId: string,
): Promise<DbUser | null> {
  const row = await db
    .prepare('SELECT u.* FROM users u JOIN platform_identities pi ON u.id = pi.user_id WHERE pi.platform = ? AND pi.platform_user_id = ?')
    .bind(platform, platformUserId)
    .first<DbUser>();
  return row ?? null;
}

// ── Servers ───────────────────────────────────────────────────────────────

export async function createServer(
  db: D1Database,
  id: string,
  userId: string,
  name: string,
  tokenHash: string,
): Promise<DbServer> {
  const now = Date.now();
  await db
    .prepare('INSERT INTO servers (id, user_id, name, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, name, tokenHash, 'offline', now)
    .run();
  return { id, user_id: userId, team_id: null, name, token_hash: tokenHash, last_heartbeat_at: null, status: 'offline', created_at: now };
}

export async function getServerById(db: D1Database, id: string): Promise<DbServer | null> {
  return db.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first<DbServer>();
}

export async function updateServerHeartbeat(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE servers SET last_heartbeat_at = ?, status = ? WHERE id = ?').bind(Date.now(), 'online', id).run();
}

export async function updateServerStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db.prepare('UPDATE servers SET status = ? WHERE id = ?').bind(status, id).run();
}

/**
 * Get all servers accessible to a user: owned servers + team servers, deduplicated.
 */
export async function getServersByUserId(db: D1Database, userId: string): Promise<DbServer[]> {
  // Own servers
  const ownResult = await db.prepare(
    'SELECT * FROM servers WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(userId).all<DbServer>();

  // Team servers: find teams the user belongs to, then servers belonging to those teams
  const teamResult = await db.prepare(
    `SELECT s.* FROM servers s
     JOIN team_members tm ON s.team_id = tm.team_id
     WHERE tm.user_id = ? AND s.user_id != ?
     ORDER BY s.created_at DESC`,
  ).bind(userId, userId).all<DbServer>();

  // Deduplicate by id
  const seen = new Set<string>();
  const servers: DbServer[] = [];
  for (const s of [...ownResult.results, ...teamResult.results]) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      servers.push(s);
    }
  }
  return servers;
}

// ── Channel bindings ──────────────────────────────────────────────────────

export async function upsertChannelBinding(
  db: D1Database,
  id: string,
  serverId: string,
  platform: string,
  channelId: string,
  bindingType: string,
  target: string,
  botId: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO channel_bindings (id, server_id, platform, channel_id, binding_type, target, bot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, channel_id, bot_id) DO UPDATE SET binding_type = excluded.binding_type, target = excluded.target, server_id = excluded.server_id',
    )
    .bind(id, serverId, platform, channelId, bindingType, target, botId, Date.now())
    .run();
}

export async function getChannelBinding(
  db: D1Database,
  platform: string,
  channelId: string,
  serverId: string,
): Promise<DbChannelBinding | null> {
  return db
    .prepare('SELECT * FROM channel_bindings WHERE platform = ? AND channel_id = ? AND server_id = ?')
    .bind(platform, channelId, serverId)
    .first<DbChannelBinding>();
}

/**
 * Find a channel binding by platform + channelId + botId.
 * botId makes the lookup deterministic: each bot maps to exactly one binding per channel,
 * eliminating ambiguity when a user has the same channel bound to multiple servers.
 * Cross-tenant isolation is guaranteed because botId is already authenticated in webhook.ts.
 */
export async function findChannelBindingByPlatformChannel(
  db: D1Database,
  platform: string,
  channelId: string,
  botId: string,
): Promise<DbChannelBinding | null> {
  return db
    .prepare(
      'SELECT * FROM channel_bindings WHERE platform = ? AND channel_id = ? AND bot_id = ?',
    )
    .bind(platform, channelId, botId)
    .first<DbChannelBinding>();
}

// ── Cron jobs ─────────────────────────────────────────────────────────────

export async function getDueCronJobs(db: D1Database): Promise<DbCronJob[]> {
  const now = Date.now();
  const result = await db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ?').bind(now).all<DbCronJob>();
  return result.results;
}

export async function updateCronJobRun(db: D1Database, id: string, lastRunAt: number, nextRunAt: number): Promise<void> {
  await db.prepare('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?').bind(lastRunAt, nextRunAt, id).run();
}

// ── Audit log ─────────────────────────────────────────────────────────────

export async function writeAuditLog(
  db: D1Database,
  id: string,
  userId: string,
  serverId: string | null,
  action: string,
  details: unknown,
  ipAddress: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (id, user_id, server_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, serverId, action, JSON.stringify(details), ipAddress, Date.now())
    .run();
}
