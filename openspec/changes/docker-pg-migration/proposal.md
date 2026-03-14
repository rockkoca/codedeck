## Why

Cloudflare Workers + Durable Objects pricing makes WebSocket relay expensive at scale — DO bills by memory×time, and every active daemon/browser connection keeps the DO alive. A self-hosted Docker + PostgreSQL deployment eliminates this cost entirely, gives full control over infrastructure, and removes the two-hop WS relay (browser→DO→daemon becomes browser→server←daemon in one process).

## What Changes

- **New `server/` directory** replacing `worker/` — standard Node.js + Hono + ws library
- **PostgreSQL** replaces D1 (SQLite) — parameterized queries, connection pooling
- **In-memory WsBridge** replaces DaemonBridge Durable Object — same logic, no CF dependency
- **In-memory RateLimiter** replaces RateLimiter Durable Object — sliding window in Map
- **Node.js `crypto`** replaces Web Crypto API — JWT signing, AES-256-GCM encryption
- **node-cron** replaces CF scheduled() handler — health-check (5min), job-dispatch (1min)
- **Docker Compose** deployment with PostgreSQL container
- **BREAKING**: CF Worker deployment no longer supported; existing D1 data requires export/import migration
- **BREAKING**: `wrangler.toml` and CF-specific config removed

## Capabilities

### New Capabilities
- `pg-database`: PostgreSQL connection pool with D1-compatible query API wrapper, schema migrations converted from SQLite
- `ws-bridge`: In-process WebSocket bridge replacing DaemonBridge DO — manages daemon/browser connections, auth handshake, message relay, queue
- `memory-rate-limiter`: In-memory sliding window rate limiter replacing RateLimiter DO — request throttling, JTI consumption, auth lockout
- `node-crypto`: Node.js native crypto implementations for JWT (HMAC-SHA256), AES-256-GCM bot credential encryption, SHA-256 hashing
- `docker-deployment`: Dockerfile, docker-compose.yml, environment variable configuration, PostgreSQL container setup

### Modified Capabilities
- `terminal-streaming`: WebSocket upgrade path changes from CF DO routing to Node.js `ws` library upgrade event
- `web-command-handler`: Server routes lose CF env bindings, use injected Hono context instead

## Impact

- **Code**: `worker/` directory replaced by `server/`; all 8 route modules adapted; crypto.ts rewritten; 2 DOs replaced
- **APIs**: All HTTP endpoints unchanged (same paths, same payloads); WebSocket protocol unchanged
- **Dependencies**: Add `pg`, `ws`, `node-cron`, `@hono/node-server`; Remove `wrangler`, `@cloudflare/workers-types`
- **Deployment**: CF dashboard → Docker Compose on any VPS/server
- **Data**: One-time D1→PG migration needed for existing users
- **Daemon/Web**: No changes to daemon code or frontend code (same WS protocol, same API endpoints)
