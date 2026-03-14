## ADDED Requirements

### Requirement: Per-server WebSocket bridge
The system SHALL maintain one `WsBridge` instance per serverId in an in-memory Map. Each instance manages one daemon WebSocket and zero or more browser WebSockets.

#### Scenario: Daemon connects
- **WHEN** a WebSocket upgrade arrives at `/api/server/:id/ws`
- **THEN** a `WsBridge` is created (or existing instance reused) and the daemon WS is stored

#### Scenario: Browser connects
- **WHEN** a WebSocket upgrade arrives at `/api/server/:id/terminal?ticket=...`
- **THEN** the browser WS is added to the bridge's `browserSockets` set

#### Scenario: Instance cleanup
- **WHEN** the daemon disconnects AND all browser sockets are closed
- **THEN** the `WsBridge` instance is removed from the Map

### Requirement: Daemon authentication handshake with connection-level protection
The system SHALL require the daemon to send `{ type: 'auth', serverId, token }` as its first message within 5 seconds. Token is verified against `token_hash` in the `servers` table. The daemon WebSocket upgrade endpoint SHALL enforce per-IP connection rate limiting (max 5 upgrade requests per 10 seconds, using `TRUSTED_PROXIES`-aware IP extraction consistent with `MemoryRateLimiter`) and a global concurrent connection limit (max 1000 unauthenticated connections). Per-IP violations SHALL be rejected with 429; global capacity violations SHALL be rejected with 503.

#### Scenario: Auth success
- **WHEN** daemon sends valid auth within 5s
- **THEN** bridge is marked authenticated, queued messages are drained, `daemon.reconnected` is broadcast to all browser sockets

#### Scenario: Auth timeout
- **WHEN** daemon does not send auth within 5s
- **THEN** WebSocket is closed with code 4001

#### Scenario: Auth failure
- **WHEN** daemon sends invalid token
- **THEN** WebSocket is closed with code 4001

#### Scenario: Connection flood (per-IP)
- **WHEN** a single IP (extracted via `TRUSTED_PROXIES` rules) sends more than 5 upgrade requests in 10 seconds to `/api/server/:id/ws`
- **THEN** additional upgrade requests are rejected with 429

#### Scenario: Global connection capacity
- **WHEN** the total number of unauthenticated daemon connections reaches 1000
- **THEN** new upgrade requests are rejected with 503 until existing connections authenticate or close

### Requirement: Message relay daemon→browser
The system SHALL forward specified daemon message types to all connected browser sockets, with type translation where needed.

#### Scenario: Terminal update relay
- **WHEN** daemon sends `{ type: 'terminal_update', diff }` (authenticated)
- **THEN** browsers receive `{ type: 'terminal.diff', diff }`

#### Scenario: Session event relay
- **WHEN** daemon sends `{ type: 'session_event', ... }`
- **THEN** browsers receive `{ type: 'session.event', ... }`

#### Scenario: Pass-through types
- **WHEN** daemon sends `session.idle`, `session.notification`, `session.tool`, `session.error`, `session_list`, `terminal.history`
- **THEN** browsers receive the message as-is

### Requirement: Message relay browser→daemon with whitelist and limits
The system SHALL forward browser messages to the daemon WebSocket only if the message type is in the allowed whitelist. Messages exceeding 4KB SHALL be rejected. Per-browser message rate SHALL be limited to 30 messages per 10 seconds.

Allowed message types: `terminal.subscribe`, `terminal.unsubscribe`, `session.start`, `session.stop`, `session.restart`, `session.send`, `session.input`, `session.resize`, `get_sessions`.

#### Scenario: Allowed message type
- **WHEN** browser sends `{ type: 'terminal.subscribe', session: 'deck_foo_brain' }` (under rate limit, under 4KB)
- **THEN** the message is forwarded to the daemon's WebSocket

#### Scenario: Unknown message type
- **WHEN** browser sends `{ type: 'admin.shutdown' }`
- **THEN** the message is dropped and a warning is logged

#### Scenario: Message too large
- **WHEN** browser sends a message exceeding 4KB
- **THEN** the message is dropped and the socket receives an error

#### Scenario: Rate limit exceeded
- **WHEN** browser sends more than 30 messages in 10 seconds
- **THEN** excess messages are dropped until the window slides

#### Scenario: Daemon not connected
- **WHEN** browser sends an allowed message but daemon is not connected
- **THEN** the message is queued (up to 100 messages)

### Requirement: Push notification on session.idle
The system SHALL dispatch a push notification when the daemon sends `session.idle`, looking up the `user_id` from the `servers` table.

#### Scenario: Idle notification
- **WHEN** daemon sends `{ type: 'session.idle', session, project }`
- **THEN** a push notification is dispatched to the server owner's registered devices

### Requirement: Browser ticket authentication with access control and Origin validation
The system SHALL verify browser WebSocket connections using a short-lived JWT ticket passed as a query parameter. The endpoint SHALL:
1. Validate the `Origin` header against `ALLOWED_ORIGINS` env var (comma-separated list); reject with 403 if Origin is not in the list. If `ALLOWED_ORIGINS` is not set, reject all browser WebSocket connections with 403 unless `NODE_ENV=development` is set (in which case all origins are allowed with a startup warning).
2. Verify the ticket signature and TTL (15s)
3. Verify the ticket's `sid` claim matches the requested `:id`
4. Verify the ticket's `sub` (userId) has access to the server via `resolveServerRole()`
5. Check the ticket's `jti` against consumed-JTI set; reject if already consumed
6. Mark the `jti` as consumed (entries auto-expire after 30 seconds)

#### Scenario: Valid ticket with active access
- **WHEN** browser connects with `?ticket=<valid-jwt>` (type=ws-ticket, not expired, JTI not consumed, sub has server access)
- **THEN** connection is accepted and JTI is consumed (single-use)

#### Scenario: Valid ticket but access revoked
- **WHEN** browser connects with a valid ticket but the user's server access has been revoked since issuance
- **THEN** connection is rejected with 403

#### Scenario: Replayed ticket
- **WHEN** browser connects reusing a previously consumed ticket
- **THEN** connection is rejected with 401 (jti already consumed)

#### Scenario: Invalid or expired ticket
- **WHEN** browser connects with an invalid or expired ticket
- **THEN** connection is rejected with 401

#### Scenario: Disallowed Origin
- **WHEN** browser connects with `Origin: https://evil.com` and `ALLOWED_ORIGINS=https://codedeck.example.com`
- **THEN** connection is rejected with 403 before ticket verification

#### Scenario: No ALLOWED_ORIGINS in production
- **WHEN** `ALLOWED_ORIGINS` env var is not set and `NODE_ENV` is not `development`
- **THEN** all browser WebSocket connections are rejected with 403; server logs an ERROR on startup

#### Scenario: No ALLOWED_ORIGINS in development
- **WHEN** `ALLOWED_ORIGINS` is not set and `NODE_ENV=development`
- **THEN** Origin check is skipped (any origin accepted), server logs a startup warning
