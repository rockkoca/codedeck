## ADDED Requirements

### Requirement: Per-session serialized stdin writes
The daemon SHALL serialize stdin writes per session for both `session.send` and `session.input` using a per-session mutual exclusion/queue mechanism.

#### Scenario: Concurrent writes keep order
- **WHEN** two input commands arrive concurrently for the same session
- **THEN** daemon SHALL execute writes in queue order without interleaving

### Requirement: Command identity for `session.send`
Client `session.send` messages SHALL include `commandId`, and daemon SHALL deduplicate recently seen command IDs per session.

#### Scenario: Duplicate command ignored
- **WHEN** daemon receives `session.send` with a `commandId` already seen in the dedup window
- **THEN** daemon SHALL ignore duplicate execution for that command

### Requirement: Minimal accepted acknowledgement
The daemon SHALL emit a `command.ack` timeline event with status `accepted` after a valid `session.send` is accepted into the per-session queue.

#### Scenario: Command accepted acknowledgement
- **WHEN** daemon accepts a `session.send` with `commandId`
- **THEN** daemon SHALL emit `command.ack` with `{ commandId, status: "accepted" }`

### Requirement: Input-stream non-retry rule
`session.input` SHALL be treated as a real-time key stream and SHALL NOT use automatic retry semantics.

#### Scenario: Lost key stream frame is not retried
- **WHEN** client transport drops a `session.input` frame
- **THEN** system SHALL NOT auto-replay that frame with application-layer retry
