## 1. Auth + API Key Management (Worker)

- [x] 1.1 Add `POST /api/auth/user/me/keys` endpoint — generate `deck_` + 32 hex bytes, SHA-256 hash stored in `api_keys`, return raw key once
- [x] 1.2 Add `GET /api/auth/user/me/keys` endpoint — return `{ keys: [{ id, label, createdAt, revokedAt }] }` (no raw key)
- [x] 1.3 Add `DELETE /api/auth/user/me/keys/:keyId` endpoint — set `revoked_at`, verify user_id ownership

## 2. Auth + API Key Management (Web)

- [x] 2.1 Create `web/src/api.ts` — fetch wrapper with Bearer token auth
- [x] 2.2 Fix `web/src/app.tsx` AuthState: change from `{ token, serverId, serverUrl }` to `{ token, userId, baseUrl }`, add `view: 'dashboard' | 'terminal'` + `selectedServerId`
- [x] 2.3 Create `web/src/pages/DashboardPage.tsx` — renders ApiKeyManager + ServerList stub, validates session on mount
- [x] 2.4 Create `web/src/components/ApiKeyManager.tsx` — list keys, generate with optional label, show raw key once with copy + warning, revoke button

## 3. Device List (Worker)

- [x] 3.1 Add `getServersByUserId(db, userId)` to `worker/src/db/queries.ts` — query own servers + team servers, deduplicate
- [x] 3.2 Add `GET /api/server` endpoint in `worker/src/routes/server.ts` — return `{ servers: [...] }` using `getServersByUserId`

## 4. Device List (Web)

- [x] 4.1 Create `web/src/components/ServerList.tsx` — device cards with name, online/offline status (heartbeat < 2min), "Connect" button, empty state message
- [x] 4.2 Wire ServerList into DashboardPage with `onSelectServer` callback
- [x] 4.3 Add view switching in `app.tsx` — `onSelectServer` sets `selectedServerId` and switches to terminal view; back button returns to dashboard

## 5. Fix Bind Flow

- [x] 5.1 Add `requireAuth()` middleware to `POST /api/bind/initiate` in `worker/src/routes/bind.ts`, read userId from `c.get('userId')` instead of body
- [x] 5.2 Update `src/bind/bind-flow.ts` — remove `userId: 'me'`, send only `{ serverName }` in body, pass API key as Bearer header
- [x] 5.3 Update bind zod schema to remove userId from body

## 6. Onboarding Wizard (Web)

- [x] 6.1 Create `web/src/components/GettingStarted.tsx` — 4-step wizard (generate key, configure CLI, install+bind, start daemon)
- [x] 6.2 Integrate GettingStarted into DashboardPage — show when user has zero devices AND zero keys
- [x] 6.3 Add 5-second polling of `GET /api/server` in wizard, auto-dismiss when device appears

## 7. Terminal Streaming (Daemon)

- [x] 7.1 Register `serverLink.onMessage()` in `src/daemon/lifecycle.ts` after `serverLink.connect()`
- [x] 7.2 Create `src/daemon/command-handler.ts` — handle `session.start`, `session.stop`, `session.send`, `terminal.subscribe`, `terminal.unsubscribe`
- [x] 7.3 Create/update `src/daemon/terminal-streamer.ts` — capture pane at 10 FPS, line-level diff, idle detection (drop to 1 FPS after 2s no changes), send `terminal_update` messages
- [x] 7.4 Add `getPaneSize(session)` to `src/agent/tmux.ts` — return cols/rows
- [x] 7.5 Add session event reporting in `src/daemon/lifecycle.ts` — send `session_event` messages (started/stopped/error) via ServerLink; DaemonBridge normalizes to `session.event` for browsers (task 8.3)

## 8. WebSocket Ticket + Terminal Streaming (Worker + Web)

- [x] 8.1 Add `POST /api/auth/ws-ticket` endpoint in `worker/src/routes/auth.ts` — accepts Bearer JWT + `{ serverId }`, returns 15s single-use ticket JWT with `{ sub, type: "ws-ticket", sid, jti: randomHex(16) }`
- [x] 8.2 Add jti consumption to `worker/durable-objects/RateLimiter.ts` — new `POST /jti-consume` handler: accepts `{ jti }`, checks if jti exists in SQLite storage, if yes returns `{ consumed: true }`, if no inserts jti with 30s expiry and returns `{ consumed: false }`; add cleanup of expired jti entries on each call
- [x] 8.3 Add `GET /api/server/:id/terminal` WebSocket endpoint in `worker/src/routes/server.ts` — auth via `?ticket=` (15s ws-ticket), verify ticket `sid` matches `:id`, call RateLimiter DO via `env.RATE_LIMITER.idFromName("jti:" + jti)` to enforce single-use (globally consistent per jti), proxy to DaemonBridge browser socket
- [x] 8.4 Update `worker/durable-objects/DaemonBridge.ts` — normalize daemon `terminal_update` → `terminal.diff` and `session_event` → `session.event` before forwarding to browser sockets
- [x] 8.5 Update `web/src/ws-client.ts` — before connecting, `POST /api/auth/ws-ticket` to get ticket, then connect to `/api/server/${serverId}/terminal?ticket=${ticket}`

## 9. Authorization Fix

- [x] 9.1 Implement `resolveServerRole(db, serverId, userId): ServerRole` in `worker/src/security/authorization.ts` — returns `owner | admin | member | none`
- [x] 9.2 Apply permission matrix in `worker/src/routes/session-mgmt.ts`: start/stop requires `owner | admin`, send requires `owner | admin | member`
- [x] 9.3 Apply permission check in terminal WebSocket endpoint: connect requires `owner | admin | member`

## 10. Security-Critical Tests

- [x] 10.1 Test `POST /api/auth/ws-ticket`: valid session → 200 + ticket, no auth → 401, expired session → 401
- [x] 10.2 Test terminal WebSocket: valid ticket → connect, expired ticket (>15s) → 401, wrong `sid` → 401, replayed ticket (same jti) → 401
- [x] 10.3 Test `POST /api/bind/initiate` auth: valid API key → 200, no auth → 401, verify userId extracted from key (not body)
- [x] 10.4 Test `resolveServerRole`: owner → `owner`, team admin → `admin`, team member → `member`, stranger → `none`
- [x] 10.5 Test session-mgmt permissions: member send → 200, member stop → 403, admin stop → 200, none send → 403
- [x] 10.6 Test API key endpoints: create → 201 + raw key, list → no raw key, revoke own → 200, revoke other user's → 404
