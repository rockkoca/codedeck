## Context

Codedeck's server layer runs on Cloudflare Workers with D1 (SQLite), Durable Objects for WebSocket state (DaemonBridge, RateLimiter), and Web Crypto API. The daemon (Node.js) connects via ServerLink WS to the worker, browsers connect via WsClient WS — both terminate at the DaemonBridge DO which relays messages.

The migration moves this to a single Node.js process with PostgreSQL, serving the same HTTP API and WebSocket protocol. The daemon and web frontend are unchanged.

## Goals / Non-Goals

**Goals:**
- Identical HTTP API surface (all `/api/*` routes, same request/response shapes)
- Identical WebSocket protocol (same message types, same auth handshake)
- Docker Compose one-command deployment with PostgreSQL
- Zero changes to daemon code (`src/`) or web frontend (`web/`)
- D1-compatible query wrapper so `queries.ts` changes are minimal

**Non-Goals:**
- Horizontal scaling (single-process, in-memory state is fine)
- Redis dependency (in-memory rate limiting is sufficient)
- Backward compatibility with CF Workers deployment (clean break)
- Data migration tooling from D1 to PG (manual export/import)
- HTTPS termination (handled by reverse proxy / Caddy / nginx in front)

## Decisions

### D1: PgDatabase wrapper with auto `?` → `$N` conversion

**Decision:** Create a `PgDatabase` class that implements D1's `prepare().bind().first()/all()/run()` API, internally converting `?` placeholders to `$1, $2, ...`.

**Why:** The 50+ query functions in `queries.ts` all use D1's chained API. A compatible wrapper means changing ~5 lines in queries.ts (import path) instead of rewriting every query.

**Alternative:** Rewrite all queries to use `pg` directly. Rejected — high effort, high risk of bugs, no benefit since the wrapper is trivial (~60 lines).

### D2: WsBridge as singleton Map keyed by serverId

**Decision:** `WsBridge` is a plain class with a static `Map<string, WsBridge>`. Each instance holds `daemonWs`, `browserSockets Set`, `queue`, `authenticated`. Created on first connection, garbage-collected when both daemon and all browsers disconnect.

**Why:** DaemonBridge DO is essentially this already — the DO routing (`idFromName(serverId)`) is just a fancy Map lookup. Single-process deployment means no need for distributed state.

**Alternative:** Redis pub/sub for multi-process. Rejected — non-goal, adds complexity and a dependency.

### D3: Node.js `ws` library with `noServer` mode

**Decision:** Use `ws` package with `noServer: true`. Intercept `upgrade` events on the Node.js HTTP server, route by URL path (`/api/server/:id/ws` → daemon, `/api/server/:id/terminal` → browser), then call `wss.handleUpgrade()`.

**Why:** Hono's Node.js adapter doesn't support WebSocket upgrade natively. The `upgrade` event approach is standard, well-documented, and doesn't fight the framework.

**Alternative:** Use `@hono/node-ws`. Rejected — immature, doesn't handle the two-endpoint routing pattern well.

### D4: In-memory rate limiter with periodic cleanup

**Decision:** `MemoryRateLimiter` stores sliding window timestamps in `Map<string, number[]>`. A setInterval (every 60s) prunes expired entries. JTI tracking uses a separate `Map<string, number>` with TTL.

**Why:** RateLimiter DO stores the same data — timestamps and lockout state. In-memory is simpler, faster, and sufficient for single-process.

**Alternative:** Redis with ZRANGEBYSCORE. Rejected — unnecessary dependency for the expected load.

### D5: Node crypto as direct replacements

**Decision:** Replace Web Crypto API calls 1:1 with `node:crypto` equivalents. Keep the same function signatures in `crypto.ts`.

**Why:** Both APIs support the same algorithms (HMAC-SHA256, AES-256-GCM, SHA-256). The function signatures don't change — only the internal implementation. Existing encrypted bot credentials remain decryptable with the same key.

**Key compatibility note:** Web Crypto's AES-GCM appends the auth tag to ciphertext. Node's `createCipheriv` produces them separately. The wrapper must concatenate/split correctly to maintain compatibility with data encrypted by the old Web Crypto implementation.

### D6: Hono stays as the HTTP framework

**Decision:** Keep Hono, use `@hono/node-server` adapter. All route files keep their Hono handlers, middleware chain, and context typing.

**Why:** Hono is runtime-agnostic. Switching to Express/Fastify would mean rewriting all 12 route files for no benefit.

### D7: Single consolidated PostgreSQL migration file

**Decision:** Convert all 9 D1 migrations into one `001_init.sql` for PostgreSQL. SQLite-specific syntax (`INSERT OR REPLACE`, `INTEGER` for timestamps) converted to PG equivalents.

**Why:** Fresh deployment — no need to replay migration history. One file is easier to review and maintain.

**Key conversions:**
- `INSERT OR REPLACE INTO` → `INSERT INTO ... ON CONFLICT (pk) DO UPDATE SET ...`
- `INSERT OR IGNORE INTO` → `INSERT INTO ... ON CONFLICT DO NOTHING`
- `INTEGER` timestamps → `BIGINT`
- Remove `WITHOUT ROWID` hints (PG doesn't have them)

## Risks / Trade-offs

**[Risk] AES-GCM compatibility between Web Crypto and Node crypto**
→ Write a unit test that encrypts with the Web Crypto format (iv || ciphertext || tag) and decrypts with the Node implementation. Run against known test vectors before migration.

**[Risk] SQLite → PG query edge cases**
→ The PgDatabase wrapper handles `?` → `$N` conversion. But some queries use `INSERT OR REPLACE` which needs manual conversion to `ON CONFLICT ... DO UPDATE`. Grep all queries and convert explicitly.

**[Risk] In-memory state loss on server restart**
→ All WsBridge connections drop, rate limiter counters reset. This is acceptable: daemon reconnects automatically (ServerLink has backoff), browsers reconnect (WsClient has backoff), rate limit reset is harmless.

**[Risk] No HTTPS in the Node server**
→ Server supports `BIND_HOST` env var (default `0.0.0.0`). Docs require `BIND_HOST=127.0.0.1` behind a reverse proxy for TLS. Server logs a warning on startup if bound to `0.0.0.0`.

**[Risk] WS ticket in URL query parameter (`?ticket=`) may leak via logs**
→ Accepted **only when**: (1) TLS is terminated by a reverse proxy — ticket never travels in plaintext, and (2) reverse proxy access logs exclude query parameters (e.g., nginx `$uri` not `$request_uri`). Without both preconditions, the ticket transport is NOT considered secure. Additional mitigations: 15s TTL, single-use JTI, access control re-check on connect. Browser WebSocket `Upgrade` does not support custom headers, making query parameters the only viable channel.

**[Risk] Rate limiter state lost on restart**
→ JTIs have 15s TTL, so replay window from restart is negligible. Auth lockout reset allows max 5 more brute-force attempts before re-triggering — acceptable for self-hosted deployment. IP extraction uses configurable `TRUSTED_PROXIES` env var to correctly parse `X-Forwarded-For`.

**[Trade-off] Single process = single point of failure**
→ Acceptable for the target use case (self-hosted dev tool). Docker restart policy (`unless-stopped`) provides basic HA.

## Migration Plan

1. Create `server/` directory alongside existing `worker/`
2. Build and test `server/` independently (can run on different port)
3. Verify all API endpoints and WebSocket flows work with `server/`
4. Update daemon's `codedeck bind` to point at new server URL
5. Remove `worker/` directory and CF deployment

**Rollback:** Re-deploy CF Worker from git history. Daemon re-binds to CF URL.

## Open Questions

- Should we keep `worker/` around for users who prefer CF deployment, or clean-break?
  - Current decision: Clean break. CF code stays in git history.
