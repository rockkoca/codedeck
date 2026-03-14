## ADDED Requirements

### Requirement: Docker Compose deployment
The system SHALL provide a `docker-compose.yml` that runs the server and PostgreSQL with a single `docker compose up`.

#### Scenario: First launch
- **WHEN** `docker compose up` is run with a `.env` file containing secrets
- **THEN** PostgreSQL starts, migrations run, server starts on port 3000

#### Scenario: Restart
- **WHEN** the server container is restarted
- **THEN** it reconnects to the existing PostgreSQL data volume without data loss

#### Scenario: PostgreSQL not exposed to public network
- **WHEN** using the default `docker-compose.yml`
- **THEN** PostgreSQL is on an internal Docker network only, with no host port mapping (no `ports:` directive for the postgres service), accessible only by the server container via Docker DNS

### Requirement: Dockerfile
The system SHALL provide a multi-stage Dockerfile that builds the TypeScript server and bundles the web frontend.

#### Scenario: Build
- **WHEN** `docker build -t codedeck-server ./server` is run
- **THEN** a production image is produced containing compiled JS and web/dist static files

#### Scenario: Image size
- **WHEN** the image is built
- **THEN** it uses `node:22-alpine` as the runtime base, keeping the image under 200MB

### Requirement: Environment variable configuration
The system SHALL read all secrets and configuration from environment variables, not from config files.

#### Scenario: Required variables
- **WHEN** the server starts without `DATABASE_URL`, `JWT_SIGNING_KEY`, or `BOT_ENCRYPTION_KEY`
- **THEN** it exits with a clear error message naming the missing variable

#### Scenario: Optional variables
- **WHEN** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are not set
- **THEN** GitHub OAuth is disabled but the server starts normally

#### Scenario: External PostgreSQL
- **WHEN** `DATABASE_URL` points to an external PostgreSQL instance (e.g., managed cloud DB)
- **THEN** the server connects to it directly; the `docker-compose.yml` postgres service can be removed or commented out

### Requirement: Static file serving
The system SHALL serve the web frontend (`web/dist/`) from the same HTTP server, with SPA fallback (all non-API paths return `index.html`).

#### Scenario: Static asset
- **WHEN** GET `/assets/index-abc.js`
- **THEN** the file is served from `web/dist/assets/`

#### Scenario: SPA route
- **WHEN** GET `/dashboard`
- **THEN** `web/dist/index.html` is returned

#### Scenario: API route takes precedence
- **WHEN** GET `/api/auth/user/me`
- **THEN** the API handler runs, not the SPA fallback

### Requirement: Transport security minimum constraint
The server SHALL NOT be exposed directly to the public internet without TLS termination. The deployment documentation and `.env.example` SHALL require one of:
1. A reverse proxy (Caddy, nginx, Traefik) providing TLS in front of the server
2. The server bound to `127.0.0.1` or a private network interface

The server SHALL accept a `BIND_HOST` env var (default `0.0.0.0`). The `.env.example` SHALL document setting `BIND_HOST=127.0.0.1` for deployments behind a local reverse proxy, with a warning that running on `0.0.0.0` without TLS termination exposes JWT tokens, API keys, and WebSocket traffic in plaintext.

#### Scenario: Default bind with proxy
- **WHEN** `BIND_HOST=127.0.0.1` and a reverse proxy terminates TLS on port 443
- **THEN** the server listens on `127.0.0.1:3000`, only reachable via the proxy

#### Scenario: Direct exposure warning
- **WHEN** `BIND_HOST` is not set (defaults to `0.0.0.0`)
- **THEN** the server logs a startup warning: "Server is listening on 0.0.0.0 — ensure TLS is terminated by a reverse proxy"

#### Scenario: ALLOWED_ORIGINS not set in production
- **WHEN** `ALLOWED_ORIGINS` env var is not set and `NODE_ENV` is not `development`
- **THEN** the server logs an ERROR on startup: "ALLOWED_ORIGINS not set — all browser WebSocket connections will be rejected. Set ALLOWED_ORIGINS for production use."
- **AND** all browser WebSocket upgrade requests are rejected with 403

#### Scenario: ALLOWED_ORIGINS not set in development
- **WHEN** `ALLOWED_ORIGINS` is not set and `NODE_ENV=development`
- **THEN** the server logs a WARNING: "ALLOWED_ORIGINS not set — Origin check disabled (dev mode)"
- **AND** all origins are accepted

The `.env.example` SHALL list `ALLOWED_ORIGINS` in the **required for production** section (not optional), with example: `ALLOWED_ORIGINS=https://codedeck.example.com`

### Requirement: Cron jobs via node-cron
The system SHALL schedule internal cron jobs using `node-cron` instead of CF scheduled().

#### Scenario: Health check cron
- **WHEN** the server is running
- **THEN** a health-check job runs every 5 minutes, marking stale servers offline

#### Scenario: Job dispatch cron
- **WHEN** the server is running
- **THEN** a job-dispatch job runs every minute, executing due cron_jobs entries
