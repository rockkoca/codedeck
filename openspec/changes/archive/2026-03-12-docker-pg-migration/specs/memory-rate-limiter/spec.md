## ADDED Requirements

### Requirement: Sliding window rate limiting
The system SHALL provide in-memory sliding window rate limiting with configurable limits and window durations.

#### Scenario: Under limit
- **WHEN** a key has fewer than `limit` entries in the past `windowMs` milliseconds
- **THEN** the check passes and the timestamp is recorded

#### Scenario: Over limit
- **WHEN** a key has reached `limit` entries in the past `windowMs`
- **THEN** the check fails and the request is rejected with 429

#### Scenario: Window expiry
- **WHEN** old entries fall outside the sliding window
- **THEN** they are pruned and no longer count toward the limit

### Requirement: JTI single-use token consumption
The system SHALL track consumed JTIs (JWT token IDs) to prevent replay attacks on WebSocket tickets.

#### Scenario: First use
- **WHEN** `consumeJti(jti, 30000)` is called for a new JTI
- **THEN** returns `true` and the JTI is recorded

#### Scenario: Replay attempt
- **WHEN** `consumeJti(jti, 30000)` is called for an already-consumed JTI within TTL
- **THEN** returns `false`

#### Scenario: TTL expiry
- **WHEN** TTL has elapsed since JTI consumption
- **THEN** the JTI entry is cleaned up by periodic pruning

### Requirement: Auth failure lockout with trusted proxy IP extraction
The system SHALL lock out keys (client IP addresses) after 5 failed authentication attempts for 15 minutes. Client IPs SHALL be extracted from `X-Forwarded-For` header using a configurable trusted proxy list (env `TRUSTED_PROXIES`, comma-separated CIDRs). If the request does not pass through a trusted proxy, the socket remote address is used directly.

#### Scenario: Below threshold
- **WHEN** a key has fewer than 5 failed attempts
- **THEN** `checkLockout()` returns `{ locked: false }`

#### Scenario: Lockout triggered
- **WHEN** a key records its 5th failed attempt
- **THEN** `checkLockout()` returns `{ locked: true, lockedUntil: <timestamp> }` for the next 15 minutes

#### Scenario: Lockout expired
- **WHEN** 15 minutes have passed since lockout
- **THEN** the key is unlocked and counter resets

#### Scenario: IP behind trusted proxy
- **WHEN** a request arrives from a trusted proxy with `X-Forwarded-For: 1.2.3.4, 10.0.0.1`
- **THEN** `1.2.3.4` is used as the rate limit key (rightmost untrusted IP)

#### Scenario: Direct connection (no proxy)
- **WHEN** a request arrives without `X-Forwarded-For` or from an untrusted proxy
- **THEN** the socket remote address is used as the rate limit key

### Requirement: Periodic cleanup
The system SHALL run a cleanup interval (every 60 seconds) to prune expired entries from all maps, preventing unbounded memory growth.

#### Scenario: Stale entries
- **WHEN** the cleanup timer fires
- **THEN** rate limit entries older than their window, consumed JTIs past TTL, and expired lockouts are removed

### Requirement: Restart resilience acknowledgment
The system SHALL accept that all in-memory rate limiting state (sliding windows, consumed JTIs, lockouts) is lost on server restart. This is acceptable because:
- WS tickets have a 15s TTL, so replay windows are inherently short
- Daemon reconnects require re-authentication, resetting state naturally
- Auth lockout reset on restart is an acceptable trade-off for single-process deployment
