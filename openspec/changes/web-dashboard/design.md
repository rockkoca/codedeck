## Context

Codedeck's web frontend has GitHub OAuth login and basic terminal UI components, but cannot function end-to-end. The AuthState stores userId as serverId (breaking WebSocket connections), there's no API key management (required for daemon binding), no device list, and the daemon doesn't handle web-originated commands. The DaemonBridge Durable Object exists but only relays specific message types. The bind endpoint lacks authentication.

The system is three-tier: Chat Platforms → CF Worker (Hono + D1 + DO) → Daemon (Node.js + tmux). The web dashboard adds a parallel browser path alongside chat platforms.

## Goals / Non-Goals

**Goals:**
- Users can log in, generate API keys, see their devices, and view live terminal output via the web
- Fix all identified bugs blocking the web flow (AuthState, bind auth, daemon onMessage, DaemonBridge relay)
- Onboard new users with a step-by-step wizard
- Proper permission model using server ownership and team membership

**Non-Goals:**
- HTTP-only cookie auth (future improvement over query-param JWT)
- Mobile app integration (existing mobile/ code is separate)
- Multi-user real-time collaboration on the same terminal
- Chat platform webhook changes

## Decisions

### 1. Dashboard + Terminal as view states, not routes
AuthState gains a `view: 'dashboard' | 'terminal'` discriminator with `selectedServerId`. WebSocket connection only established in terminal view. This avoids adding a client-side router dependency (Preact app is currently single-page with no router).

**Alternative**: Add preact-router. Rejected — adds dependency for only two views. Simple state switching suffices.

### 2. Browser WebSocket on separate path with short-lived ticket
Browsers connect to `/api/server/:id/terminal?ticket=<15s-jwt>` rather than the daemon path `/api/server/:id/ws`. The ticket is obtained via `POST /api/auth/ws-ticket` using the session JWT, ensuring the long-lived 24h JWT never appears in query strings. Each ticket includes a `jti` claim; the RateLimiter DO tracks consumed `jti` values (30s TTL) to enforce single-use. The DaemonBridge DO handles both connection types internally (daemon socket vs browser sockets set).

**Alternative**: Pass session JWT directly as `?token=`. Rejected — 24h JWT in query strings is visible in server logs and browser history. Short-lived ticket limits exposure to 15s.
**Alternative**: Multiplex on same path with a role header. Rejected — WebSocket upgrade can't carry custom headers reliably, and conflating daemon/browser connections adds complexity.

### 3. Line-level diff for terminal streaming
The daemon captures pane content at 10 FPS (configurable), diffs against last-sent state, and sends only changed `[lineIndex, content]` pairs. Idle detection drops to 1 FPS after 2 seconds of no changes.

**Alternative**: Full pane snapshot every tick. Rejected — bandwidth would be excessive for 200+ row terminals at 10 FPS.

### 4. API key format: `deck_` prefix + 32 hex bytes
Keys are `deck_${crypto.randomBytes(32).toString('hex')}`. Only the SHA-256 hash is stored in D1. The raw key is shown once at creation time.

**Alternative**: UUIDs. Rejected — prefix makes keys visually identifiable and greppable in configs.

### 5. Phased rollout: Auth → Devices → Bind Fix → Terminal
Each phase is independently deployable and testable. Phase 1 (auth + keys) unblocks phases 2 and 3. Phase 4 (terminal streaming) requires both 2 and 3.

## Risks / Trade-offs

- **JWT in query param** → The 24h session JWT is never passed via query string. Instead, `POST /api/auth/ws-ticket` issues a 15-second single-use ticket JWT that is passed as `?ticket=` for WebSocket upgrade. This limits exposure to a 15s window. Future: upgrade to HTTP-only cookie for session management.
- **10 FPS capture load** → `tmux capture-pane` subprocess per tick per subscribed session. Mitigated: idle detection (drop to 1 FPS), unsubscribe stops capture entirely.
- **Bind auth gap** → Until Phase 3 deploys, `/api/bind/initiate` remains unauthenticated. Mitigated: prioritize Phase 3 if security concern is urgent.
- **No offline queue for browser commands** → If daemon disconnects while user sends a command, it's lost. Acceptable for MVP; DaemonBridge already queues inbound messages when daemon is offline.
