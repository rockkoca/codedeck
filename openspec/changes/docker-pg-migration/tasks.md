## 1. Project scaffold

- [x] 1.1 Create `server/` directory with `package.json` (deps: hono, @hono/node-server, pg, ws, node-cron) and `tsconfig.json`
- [x] 1.2 Create `server/src/env.ts` — Env interface with DB, secrets, config (replaces CF bindings type); include `ALLOWED_ORIGINS`, `TRUSTED_PROXIES`, `BIND_HOST`

## 2. PostgreSQL database layer

- [x] 2.1 Create `server/src/db/client.ts` — PgDatabase/PgStatement/BoundStatement classes wrapping `pg.Pool`, auto `?` → `$N` conversion (skip `?` inside quoted strings/identifiers), D1-compatible `.first()/.all()/.run()` API
- [x] 2.2 Convert `worker/migrations/0001-0009` → `server/src/db/migrations/001_init.sql` (single consolidated PG migration: BIGINT timestamps, ON CONFLICT syntax, remove SQLite-isms)
- [x] 2.3 Create `server/src/db/migrate.ts` — auto-apply migrations on startup (idempotent, tracks applied in a `_migrations` table)
- [x] 2.4 Port `worker/src/db/queries.ts` → `server/src/db/queries.ts` — change import of DB type, replace any remaining `INSERT OR REPLACE`/`INSERT OR IGNORE` with PG equivalents

## 3. Node.js crypto

- [x] 3.1 Rewrite `worker/src/security/crypto.ts` → `server/src/security/crypto.ts` — sha256Hex (createHash), randomHex (randomBytes), signJwt/verifyJwt (createHmac), encryptBotConfig/decryptBotConfig (createCipheriv/createDecipheriv with iv||ciphertext||tag format), timingSafeEqual
- [x] 3.2 Write unit tests for crypto: JWT roundtrip, AES-GCM roundtrip, AES-GCM cross-compat with Web Crypto format (known test vector)

## 4. In-memory rate limiter

- [x] 4.1 Create `server/src/ws/rate-limiter.ts` — MemoryRateLimiter class: sliding window check(), consumeJti(), recordAuthFailure()/checkLockout(), periodic cleanup (60s interval), trusted proxy IP extraction (`TRUSTED_PROXIES` env, parse `X-Forwarded-For` rightmost untrusted)
- [x] 4.2 Write unit tests for rate limiter: under/over limit, JTI single-use + expiry, lockout threshold + expiry, IP extraction with/without trusted proxy

## 5. WebSocket bridge

- [x] 5.1 Create `server/src/ws/bridge.ts` — WsBridge class: static instances Map, handleDaemonConnection (auth handshake, 5s timeout, queue drain, daemon.reconnected broadcast), handleBrowserConnection, message relay with type translation (terminal_update→terminal.diff, session_event→session.event), push dispatch on session.idle, browser→daemon message whitelist (`terminal.subscribe`, `terminal.unsubscribe`, `session.start/stop/restart/send/input/resize`, `get_sessions`), 4KB max payload, per-browser 30msg/10s rate limit
- [x] 5.2 Write unit tests for WsBridge: auth success/timeout/failure, message relay and type normalization, queue drain on reconnect, browser cleanup on error, browser→daemon whitelist rejection, payload size limit, per-browser rate limiting

## 6. Port routes and security middleware

- [x] 6.1 Copy `worker/src/security/authorization.ts` → `server/src/security/authorization.ts` — update imports (crypto, DB type), replace DO-based rate limit calls with MemoryRateLimiter method calls
- [x] 6.2 Copy `worker/src/security/audit.ts` → `server/src/security/audit.ts` — update DB import
- [x] 6.3 Copy `worker/src/security/replay.ts` → `server/src/security/replay.ts` — update DB import
- [x] 6.4 Port `worker/src/security/lockout.ts` → `server/src/security/lockout.ts` — replace DO fetch with MemoryRateLimiter.checkLockout()/recordAuthFailure()
- [x] 6.5 Port `worker/src/routes/auth.ts` → `server/src/routes/auth.ts` — update imports, replace DO-based JTI consumption with MemoryRateLimiter.consumeJti(), add `resolveServerRole()` check to `POST /api/auth/ws-ticket` (return 403 if user has no access to requested serverId)
- [x] 6.6 Port `worker/src/routes/github-auth.ts` → `server/src/routes/github-auth.ts` — update imports
- [x] 6.7 Port `worker/src/routes/bind.ts` → `server/src/routes/bind.ts` — update imports
- [x] 6.8 Port `worker/src/routes/server.ts` → `server/src/routes/server.ts` — replace DO routing (`env.DAEMON_BRIDGE.get(id).fetch()`) with `WsBridge.get(serverId).sendToDaemon()`; WS upgrade moved to server entry point
- [x] 6.9 Port `worker/src/routes/webhook.ts` → `server/src/routes/webhook.ts` — replace DO-based rate limiting with MemoryRateLimiter, replace DO-based daemon send with WsBridge
- [x] 6.10 Port `worker/src/routes/outbound.ts` → `server/src/routes/outbound.ts` — update imports
- [x] 6.11 Port remaining routes: `bot.ts`, `team.ts`, `cron.ts`, `push.ts`, `quick-data.ts`, `session-mgmt.ts` — update imports only
- [x] 6.12 Copy `worker/src/platform/` directory → `server/src/platform/` — no changes needed (pure HTTP handlers)

## 7. Server entry point

- [x] 7.1 Create `server/src/index.ts` — Hono app with @hono/node-server, mount all routes, inject env via middleware, static file serving with SPA fallback, node-cron scheduling (health-check 5min, job-dispatch 1min)
- [x] 7.2 Add WebSocket upgrade handler — parse URL path, route `/api/server/:id/ws` to daemon connection (per-IP rate limit via `TRUSTED_PROXIES`, global connection cap) + WsBridge.handleDaemonConnection, route `/api/server/:id/terminal` to Origin validation (`ALLOWED_ORIGINS`) + ticket verification (signature, TTL, sid match, `resolveServerRole()` access check, JTI consumption) + WsBridge.handleBrowserConnection
- [x] 7.3 Add startup sequence: validate required env vars, create PgDatabase pool, run migrations, start cron, start HTTP server with `BIND_HOST` (default `0.0.0.0`, log warning if not `127.0.0.1`)

## 8. Docker deployment

- [x] 8.1 Create `server/Dockerfile` — multi-stage build (build TypeScript + web, copy to alpine runtime)
- [x] 8.2 Create `docker-compose.yml` — server + postgres:16-alpine with health check, volume mount, .env file support; postgres on internal network only (no `ports:` mapping), not exposed to host
- [x] 8.3 Create `.env.example` with all required/optional variables documented (including `BIND_HOST`, `TRUSTED_PROXIES`, `ALLOWED_ORIGINS`, TLS reverse proxy warning, reverse proxy log stripping guidance for `?ticket=` parameter, external PG usage note)

## 9. Port cron handlers

- [x] 9.1 Port `worker/src/cron/health-check.ts` → `server/src/cron/health-check.ts` — update DB import
- [x] 9.2 Port `worker/src/cron/job-dispatch.ts` → `server/src/cron/job-dispatch.ts` — replace DO fetch with WsBridge.sendToDaemon()

## 10. Integration testing

- [x] 10.1 Port `worker/test/` tests → `server/test/` — replace D1 mock with PgDatabase mock, replace DO mocks with MemoryRateLimiter/WsBridge mocks
- [x] 10.2 Add integration test: full auth flow (register → get API key → bind → connect WS)
- [x] 10.3 Add integration test: terminal streaming (daemon connect → browser subscribe → receive diff)
- [x] 10.4 Verify `npm run build` compiles `server/` cleanly, `docker compose build` succeeds
