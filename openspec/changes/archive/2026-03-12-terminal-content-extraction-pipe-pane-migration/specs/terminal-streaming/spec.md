## MODIFIED Requirements

### Requirement: Daemon terminal capture with line-level diff
The daemon SHALL use `tmux pipe-pane -O` as the primary live terminal source for subscribed sessions. It SHALL stream raw PTY bytes to subscribers and keep `capture-pane` for snapshot/full-frame recovery only. Snapshot messages SHALL still be sent as `{ type: "terminal_update", diff: { sessionName, timestamp, lines, cols, rows, fullFrame: true } }`, while live bytes SHALL be sent as binary raw frames.

#### Scenario: Subscribe starts snapshot then raw stream
- **WHEN** browser sends `terminal.subscribe` for a session
- **THEN** daemon sends a full-frame snapshot via `terminal_update` first
- **THEN** daemon starts/attaches `pipe-pane` live stream for that session

#### Scenario: Unsubscribe stops live stream when last subscriber leaves
- **WHEN** browser sends `terminal.unsubscribe` or disconnects
- **THEN** daemon removes the subscriber
- **THEN** daemon stops `pipe-pane` for the session if no subscribers remain

#### Scenario: Reconnect recovers with snapshot
- **WHEN** a browser reconnects and subscribes again
- **THEN** daemon sends a new full-frame snapshot before forwarding live raw bytes

## ADDED Requirements

### Requirement: Snapshot/raw delivery barrier per subscriber
The system SHALL guarantee per-subscriber ordering such that each subscriber receives snapshot state before live raw PTY bytes for a session. For subscribers joining an already-running stream, raw bytes SHALL be buffered while snapshot is pending.

#### Scenario: New subscriber joins active stream
- **WHEN** a subscriber joins a session with active `pipe-pane` output
- **THEN** subscriber SHALL be marked snapshot-pending
- **THEN** raw bytes for that subscriber SHALL be buffered until snapshot delivery completes
- **THEN** buffered bytes SHALL be flushed in original order

### Requirement: Raw buffer overflow reset behavior
The daemon SHALL enforce a bounded per-subscriber raw buffer (256KB) during snapshot-pending. On overflow it SHALL fail subscriber stream bootstrap with an explicit reset message.

#### Scenario: Snapshot-pending buffer overflow
- **WHEN** buffered raw bytes exceed 256KB for a snapshot-pending subscriber
- **THEN** daemon SHALL emit `{ type: "terminal.stream_reset", session, reason: "raw_buffer_overflow" }`
- **THEN** daemon SHALL discard buffered bytes for that subscriber
- **THEN** daemon SHALL remove the subscriber from the session's active subscriber list

#### Scenario: Client recovery after stream reset
- **WHEN** client receives `terminal.stream_reset`
- **THEN** client SHALL reset local terminal state
- **THEN** client SHALL resubscribe with exponential backoff (1s → 2s → 4s → 8s → 16s, max 5 attempts)
- **WHEN** client exceeds max retry attempts
- **THEN** client SHALL stop automatic recovery and display user-facing prompt
- **WHEN** client receives 3 or more resets within 60 seconds
- **THEN** client SHALL enter a 30-second cooldown period during which no resubscribe attempts are made

### Requirement: Dual-layer idle detection from raw stream
The daemon SHALL use raw PTY byte activity for session running/idle state, independent of line classification used for text extraction.

#### Scenario: Raw byte activity resets idle timer
- **WHEN** any raw PTY bytes arrive for a session
- **THEN** daemon SHALL consider the session active and reset idle timer
- **THEN** if session was previously idle, daemon SHALL emit `session.state(running)`

#### Scenario: Idle timeout with no raw bytes
- **WHEN** no raw PTY bytes arrive within idle threshold
- **THEN** daemon SHALL emit `session.state(idle)`

### Requirement: Binary raw frame protocol
Live PTY stream bytes SHALL be transported as binary frames with protocol version header.

#### Scenario: Binary frame layout
- **WHEN** daemon emits a raw frame
- **THEN** byte 0 SHALL be protocol version `0x01`
- **THEN** bytes 1-2 SHALL be big-endian `sessionName` length
- **THEN** bytes 3..3+N-1 SHALL contain UTF-8 `sessionName`
- **THEN** remaining bytes SHALL contain raw PTY payload
