## MODIFIED Requirements

### Requirement: Command handler processes web commands
The daemon SHALL implement a command handler that processes the following command types from the web: `session.start` (start a project), `session.stop` (stop a project), `session.send` (send text to a tmux session), `session.input` (send raw keyboard input), `terminal.subscribe` (start terminal streaming for a session), `terminal.unsubscribe` (stop terminal streaming for a session).

#### Scenario: Start session from web
- **WHEN** daemon receives `{ type: "session.start", project, agentType }`
- **THEN** daemon starts the project via session manager

#### Scenario: Send text to session from web
- **WHEN** daemon receives `{ type: "session.send", sessionName, text, commandId }`
- **THEN** daemon enqueues the write in the per-session input queue
- **THEN** daemon writes the text to the specified tmux session in queue order

#### Scenario: Send raw input to session from web
- **WHEN** daemon receives `{ type: "session.input", sessionName, data }`
- **THEN** daemon enqueues the write in the same per-session input queue
- **THEN** daemon writes input bytes without auto-retry
- **THEN** daemon SHALL NOT require or process `commandId` for `session.input`

#### Scenario: Unknown command type
- **WHEN** daemon receives a message with an unrecognized type
- **THEN** daemon logs a warning and ignores the message

## ADDED Requirements

### Requirement: Bridge routes binary stream by session subscription
The bridge SHALL maintain per-browser session subscriptions and route daemon binary raw frames only to browsers subscribed to the target session.

#### Scenario: Binary frame to subscribed browsers only
- **WHEN** daemon sends a binary raw frame for session `deck_x_w1`
- **THEN** bridge forwards it only to browser sockets subscribed to `deck_x_w1`

### Requirement: Bridge preserves cross-frame ordering per session/browser
For each `(session, browser)` pair, bridge SHALL use a single serialized forwarding queue shared by text snapshot frames and binary raw frames.

#### Scenario: Snapshot text and raw binary ordering
- **WHEN** bridge receives snapshot text frame before raw binary for the same session/browser
- **THEN** browser SHALL receive the snapshot frame before raw binary

### Requirement: Bridge backpressure reset behavior
Bridge SHALL enforce a bounded forwarding queue (512KB) per `(session, browser)` and trigger reset on overflow.

#### Scenario: Queue overflow
- **WHEN** queue bytes exceed 512KB for a session/browser pair
- **THEN** bridge SHALL send `{ type: "terminal.stream_reset", reason: "backpressure", session }` to that browser
- **THEN** bridge SHALL remove that browser's subscription for the session
- **WHEN** the `terminal.stream_reset` send fails (socket not writable)
- **THEN** bridge SHALL close the socket with reason `backpressure_notify_failed`
