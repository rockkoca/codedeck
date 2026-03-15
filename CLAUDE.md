# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build & typecheck (two separate TS projects)
npm run build                          # daemon (src/ → dist/)
npx tsc -p worker/tsconfig.json --noEmit  # worker (CF Workers, stricter: noUnusedLocals, noImplicitReturns)
npx tsc --noEmit                       # daemon typecheck only

# Tests (vitest workspace with 4 projects)
npm test                               # all projects
npm run test:unit                      # daemon only (src/**/*.test.ts, test/**/*.test.ts, excludes e2e)
npm run test:worker                    # worker only (worker/test/**/*.test.ts)
npm run test:web                       # web only (web/test/**/*.test.ts, jsdom environment)
npm run test:e2e                       # e2e only (test/e2e/**/*.test.ts, 30s timeout, requires tmux)
npx vitest run path/to/file.test.ts    # single file

# Worker
cd worker && npm run dev               # wrangler dev
cd worker && npm run migrate           # apply all D1 migrations (0001–0005)

# Dev
npm run dev                            # run daemon via tsx
```

## Architecture

Codedeck is a three-tier system for remote-controlling AI coding agents via chat platforms:

```
Chat Platforms (Discord/Telegram/Feishu)
        ↓ webhooks
CF Worker (Hono on Cloudflare Workers + D1 + Durable Objects)
        ↓ WebSocket
Daemon (Node.js CLI on user's machine)
        ↓ tmux
AI Agents (Claude Code / Codex / OpenCode in tmux sessions)
```

### Daemon (`src/`)

Node.js process that manages AI agent sessions via tmux. Entry point: `src/index.ts` (commander CLI).

- **Agent layer** (`src/agent/`): `tmux.ts` wraps tmux commands. `session-manager.ts` manages project sessions (brain + workers), auto-restart with loop prevention. Each agent type has a driver (`drivers/claude-code.ts`, `drivers/codex.ts`, `drivers/opencode.ts`) implementing `AgentDriver` — build launch/resume commands, detect status, capture output.
- **Routing** (`src/router/`): `message-router.ts` routes inbound messages from chat platforms to the correct tmux session based on channel bindings. Bindings are cached in-memory and persisted to D1 via `persistBinding()`. `command-parser.ts` handles `/bind`, `/status`, `/send`, etc.
- **Brain dispatcher** (`src/agent/brain-dispatcher.ts`): Parses `@w1`, `@status`, `@reply` commands from the brain session's output, dispatching to workers. Extended with `@audit`, `@approve`, `@reject` for auto-fix mode.
- **Server link** (`src/daemon/server-link.ts`): WebSocket client connecting to CF Worker at `/api/server/:id/ws`. Sends `{ type: 'auth', serverId, token }` on open. Credentials stored in `~/.codedeck/server.json` after `codedeck bind`.
- **Session store** (`src/store/session-store.ts`): JSON file at `~/.codedeck/sessions.json`, debounced writes.

### CF Worker (`worker/`)

Cloudflare Workers app (Hono). Separate `tsconfig.json` — uses `@cloudflare/workers-types`, bundler module resolution.

- **Routes** (`worker/src/routes/`): `webhook.ts` receives platform webhooks at `/webhook/:platform/:botId`, verifies signatures, normalizes to `InboundMessage`, rate-limits, then calls `routeInbound()`. `outbound.ts` handles daemon→platform message delivery. `server.ts` includes WebSocket upgrade + channel binding CRUD. `bot.ts` manages per-user bot registrations with encrypted credentials.
- **DaemonBridge** (`worker/durable-objects/DaemonBridge.ts`): Durable Object that holds the daemon WebSocket. Enforces auth handshake within 5s, queues messages when daemon is disconnected, relays between daemon and browser viewers.
- **Platform handlers** (`worker/src/platform/handlers/{discord,telegram,feishu}/`): Each implements `PlatformHandler` — `verifyInbound()` (signature + timestamp staleness), `normalizeInbound()`, `sendOutbound()`. Per-user bot credentials are AES-256-GCM encrypted in D1 (`platform_bots` table), decrypted at runtime with `BOT_ENCRYPTION_KEY`.
- **D1 schema**: 5 migrations in `worker/migrations/`. Key tables: `users`, `servers`, `channel_bindings` (includes `bot_id` for deterministic routing), `platform_bots` (encrypted credentials), `sessions`, `teams`. Channel binding lookup uses `(platform, channel_id, bot_id)` — not user-scoped LIMIT 1.

### Auto-fix Pipeline (`src/autofix/`)

Cross-agent audit system: one agent (coder) implements, another (auditor) reviews.

- **State machine** (`state-machine.ts`): `planning → design_review → implementing → code_review → approved → done | failed`. Max 3 discussion rounds before failure.
- **Audit engine** (`audit-engine.ts`): Orchestrates design review and code review by sending prompts to auditor session, parsing APPROVED/REJECTED responses.
- **Issue trackers** (`src/tracker/`): `IssueTracker` interface with GitHub (`github.ts`, octokit) and GitLab (`gitlab.ts`, REST API) implementations. Both support self-hosted instances.

### Web (`web/`) and Mobile (`mobile/`)

Web terminal viewer (`web/src/ws-client.ts` — WebSocket client with reconnect). Mobile app with biometric auth and push notifications.

### i18n Development (`web/`)

The web project uses `i18next` with `react-i18next` for internationalization.

- **Storage**: Locales are in `web/src/i18n/locales/*.json`.
- **Structure**: JSON files use nested namespaces (e.g., `common`, `chat`, `session`).
- **Usage**:
  - Hook: `const { t } = useTranslation();`
  - Translate: `t('namespace.key')` or `t('namespace.key_with_params', { name: 'value' })`
- **Interpolation**: Uses double curly braces: `{{variable}}`.
- **Supported**: `en`, `zh-CN`, `zh-TW`, `es`, `ru`, `ja`, `ko`. Default is auto-detected from browser or `localStorage`.
- **MANDATORY**: All user-visible strings in `web/` MUST use `t()`. Never hardcode display text in any language. When adding new strings, update ALL 7 locale files.

## Key Conventions

- Session names follow the pattern `deck_{project}_{role}` (e.g., `deck_myapp_brain`, `deck_myapp_w1`).
- Agent types: `'claude-code' | 'codex' | 'opencode'` — the `AgentType` union in `src/agent/detect.ts`.
- Worker secrets (`JWT_SIGNING_KEY`, `BOT_ENCRYPTION_KEY`) are set via `wrangler secret put`, never in `wrangler.toml`. The `wrangler.toml` file is in `.gitignore`; use `wrangler.toml.example` as template.
- Logger in worker (`worker/src/util/logger.ts`) recursively redacts keys matching `/_token$/i`, `/_key$/i`, `/_secret$/i` before output.
- E2E tests require tmux. They are auto-skipped when `SKIP_TMUX_TESTS=1` or inside a Claude Code session (`CLAUDECODE` env var set).
- The worker TypeScript project is stricter (`noUnusedLocals`, `noImplicitReturns`). Both projects must compile cleanly.
