## MODIFIED Requirements

### Requirement: ws-ticket issuance with server access authorization
The `POST /api/auth/ws-ticket` endpoint SHALL verify the authenticated user has access to the requested `serverId` (via `resolveServerRole()`) BEFORE issuing a ticket. If the user has no role (`none`), the endpoint SHALL return 403. The ticket's `sub` claim SHALL encode the verified userId.

#### Scenario: Owner requests ticket
- **WHEN** server owner sends `POST /api/auth/ws-ticket` with `{ serverId }`
- **THEN** system issues a ticket with `{ sub: userId, sid: serverId, ... }`

#### Scenario: Team member requests ticket
- **WHEN** team member sends `POST /api/auth/ws-ticket` with `{ serverId }` for a server in their team
- **THEN** system issues a ticket (member has terminal view permission)

#### Scenario: Unauthorized user requests ticket
- **WHEN** user with no relationship to the server sends `POST /api/auth/ws-ticket`
- **THEN** system returns 403 Forbidden

### Requirement: Browser WebSocket endpoint with replay prevention and access control
The server SHALL provide `GET /api/server/:id/terminal` as a WebSocket upgrade endpoint for browser viewers. Authentication SHALL be via `?ticket=` query parameter containing a valid ws-ticket JWT (15s TTL, single-use). The endpoint SHALL:
1. Validate `Origin` header against `ALLOWED_ORIGINS` env var; reject with 403 if not in list. If `ALLOWED_ORIGINS` is not set, reject all connections unless `NODE_ENV=development`
2. Verify the ticket signature and TTL
3. Verify the ticket's `sid` claim matches the requested `:id`
4. Verify the ticket's `sub` (userId) has access to the server via `resolveServerRole()`
5. Check the ticket's `jti` against the in-memory rate limiter's consumed-JTI set; reject if already consumed
6. Mark the `jti` as consumed (entries auto-expire after 30 seconds)
7. Pass the connection to the WsBridge instance's browser socket set

**Note on `?ticket=` transport**: Browser WebSocket upgrade requests cannot carry custom headers (e.g., `Authorization`), so the ticket is passed as a query parameter. This creates a log-leakage surface. Risk is accepted **only under the following preconditions**: (1) TLS is terminated by a reverse proxy (plaintext ticket never traverses the network), (2) reverse proxy access logs exclude query parameters (e.g., nginx logs `$uri` not `$request_uri`). Without both preconditions met, this transport is NOT considered secure. Additional mitigations: 15s TTL, single-use JTI, access control re-check on connect.

The in-memory rate limiter SHALL store consumed `jti` values with a 30-second TTL.

#### Scenario: Authorized browser connects
- **WHEN** browser sends WebSocket upgrade to `/api/server/:id/terminal?ticket=VALID_WS_TICKET` where ticket sub has server access
- **THEN** ticket jti is marked consumed, connection is established and added to WsBridge's browser socket set

#### Scenario: Ticket issued to unauthorized user
- **WHEN** browser presents a valid ticket but the user's server access has been revoked since issuance
- **THEN** connection is rejected with 403

#### Scenario: Replayed ticket
- **WHEN** browser sends WebSocket upgrade reusing a previously consumed ticket
- **THEN** connection is rejected with 401 (jti already consumed)

#### Scenario: Invalid or expired ticket
- **WHEN** browser sends WebSocket upgrade with invalid, expired, or mismatched-sid ticket
- **THEN** connection is rejected with 401

### Requirement: DaemonBridge normalizes and relays daemon messages to browsers
The WsBridge SHALL normalize daemon messages before forwarding to browser sockets. Daemon `terminal_update` messages SHALL be re-typed as `terminal.diff` before sending to browsers. Daemon `session_event` messages SHALL be re-typed as `session.event`. Failed sends SHALL remove the browser socket from the set.

#### Scenario: Terminal update normalized and forwarded
- **WHEN** daemon sends a `{ type: "terminal_update", diff: {...} }` message
- **THEN** WsBridge sends `{ type: "terminal.diff", diff: {...} }` to all connected browser sockets

#### Scenario: Session event normalized and forwarded
- **WHEN** daemon sends a `{ type: "session_event", ... }` message
- **THEN** WsBridge sends `{ type: "session.event", ... }` to all connected browser sockets

#### Scenario: Browser socket error on send
- **WHEN** sending to a browser socket throws an error
- **THEN** that socket is removed from the browser set without affecting other sockets
