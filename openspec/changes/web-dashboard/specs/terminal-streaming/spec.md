## ADDED Requirements

### Requirement: WebSocket ticket endpoint
The worker SHALL provide `POST /api/auth/ws-ticket` that accepts a valid session JWT (Bearer) and a `serverId` in the request body. It SHALL return a short-lived, single-use ticket JWT (15 seconds TTL, claims: `{ sub: userId, type: "ws-ticket", sid: serverId, jti: randomHex(16) }`). The `jti` (JWT ID) SHALL be used for replay prevention. This prevents the long-lived 24h session JWT from appearing in WebSocket query strings.

#### Scenario: Issue ws-ticket
- **WHEN** authenticated user sends `POST /api/auth/ws-ticket` with `{ "serverId": "abc123" }`
- **THEN** system returns `{ ticket: "<15s-jwt-with-jti>" }` with status 200

#### Scenario: Unauthenticated request
- **WHEN** request has no valid session JWT
- **THEN** system returns 401

### Requirement: Browser WebSocket endpoint with replay prevention
The worker SHALL provide `GET /api/server/:id/terminal` as a WebSocket upgrade endpoint for browser viewers. Authentication SHALL be via `?ticket=` query parameter containing a valid ws-ticket JWT (15s TTL, single-use). The endpoint SHALL:
1. Verify the ticket signature and TTL
2. Verify the ticket's `sid` claim matches the requested `:id`
3. Check the ticket's `jti` against a consumed-tickets set in a RateLimiter Durable Object instance keyed by `jti:${jti}` (using `idFromName("jti:" + jti)`); reject if already consumed
4. Mark the `jti` as consumed (entries auto-expire after 30 seconds)
5. Proxy the connection to the DaemonBridge Durable Object's browser socket set

The RateLimiter DO SHALL store consumed `jti` values with a 30-second TTL (sufficient to cover the 15s ticket lifetime plus clock skew).

#### Scenario: Authenticated browser connects
- **WHEN** browser sends WebSocket upgrade to `/api/server/:id/terminal?ticket=VALID_WS_TICKET`
- **THEN** ticket jti is marked consumed, connection is established and added to DaemonBridge's browser socket set

#### Scenario: Replayed ticket
- **WHEN** browser sends WebSocket upgrade reusing a previously consumed ticket
- **THEN** connection is rejected with 401 (jti already consumed)

#### Scenario: Invalid or expired ticket
- **WHEN** browser sends WebSocket upgrade with invalid, expired, or mismatched-sid ticket
- **THEN** connection is rejected with 401

### Requirement: DaemonBridge normalizes and relays daemon messages to browsers
The DaemonBridge Durable Object SHALL normalize daemon messages before forwarding to browser sockets. Daemon `terminal_update` messages SHALL be re-typed as `terminal.diff` before sending to browsers. Daemon `session_event` messages SHALL be re-typed as `session.event`. This ensures the web client only handles `terminal.diff` and `session.event` types. Failed sends SHALL remove the browser socket from the set.

#### Scenario: Terminal update normalized and forwarded
- **WHEN** daemon sends a `{ type: "terminal_update", diff: {...} }` message
- **THEN** DaemonBridge sends `{ type: "terminal.diff", diff: {...} }` to all connected browser sockets

#### Scenario: Session event normalized and forwarded
- **WHEN** daemon sends a `{ type: "session_event", ... }` message
- **THEN** DaemonBridge sends `{ type: "session.event", ... }` to all connected browser sockets

#### Scenario: Browser socket error on send
- **WHEN** sending to a browser socket throws an error
- **THEN** that socket is removed from the browser set without affecting other sockets

### Requirement: Daemon terminal capture with line-level diff
The daemon SHALL capture tmux pane content at a configurable FPS rate (default 10). It SHALL compute line-level diffs against the last-sent state and send only changed lines as `{ type: "terminal_update", diff: { sessionName, timestamp, lines: [[lineIndex, content]], cols, rows } }`. After 2 seconds of no changes, the capture rate SHALL drop to idle FPS (default 1).

#### Scenario: Active terminal output
- **WHEN** terminal content changes between captures
- **THEN** daemon sends only the changed lines with their indices

#### Scenario: Idle terminal
- **WHEN** no terminal changes for 2 seconds
- **THEN** capture rate drops from 10 FPS to 1 FPS

#### Scenario: Subscribe and unsubscribe
- **WHEN** browser sends `terminal.subscribe` for a session
- **THEN** daemon starts capture loop for that session
- **WHEN** browser sends `terminal.unsubscribe` or disconnects
- **THEN** daemon stops capture loop if no other subscribers remain

### Requirement: Web WebSocket client path and auth update
The web frontend's WsClient SHALL first request a ws-ticket via `POST /api/auth/ws-ticket` with the session JWT, then connect to `/api/server/${serverId}/terminal?ticket=${ticket}` using the short-lived ticket. This ensures the 24h session JWT never appears in query strings.

#### Scenario: Browser connects to correct endpoint
- **WHEN** terminal view opens for a selected server
- **THEN** WsClient calls `POST /api/auth/ws-ticket`, receives a 15s ticket, and connects to `/api/server/${serverId}/terminal?ticket=${ticket}`

### Requirement: Server role-based authorization
The worker SHALL implement `resolveServerRole(db, serverId, userId)` returning one of `owner | admin | member | none`. It SHALL check server ownership first, then team membership. The following permission matrix SHALL apply:

| Operation | owner | team:admin | team:member | none |
|-----------|-------|------------|-------------|------|
| View terminal (WebSocket connect) | allow | allow | allow | deny |
| Send message to session | allow | allow | allow | deny |
| Start/stop session | allow | allow | deny | deny |
| Bind/unbind device | allow | deny | deny | deny |

#### Scenario: Server owner accesses terminal
- **WHEN** server owner connects to terminal WebSocket
- **THEN** access is granted with owner role

#### Scenario: Team admin starts session
- **WHEN** team admin sends `session.start` command
- **THEN** command is executed (admin has start/stop permission)

#### Scenario: Team member sends message
- **WHEN** team member sends `session.send` command
- **THEN** command is executed (member has send permission)

#### Scenario: Team member attempts to stop session
- **WHEN** team member sends `session.stop` command
- **THEN** command is rejected with 403 (member lacks start/stop permission)

#### Scenario: Non-owner non-team-member attempts access
- **WHEN** user who is neither owner nor team member attempts to connect
- **THEN** access is denied with 403
