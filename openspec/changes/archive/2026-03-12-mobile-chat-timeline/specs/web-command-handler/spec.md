## MODIFIED Requirements

### Requirement: Command handler processes web commands
The daemon SHALL implement a command handler that processes the following command types from the web: `session.start` (start a project), `session.stop` (stop a project), `session.restart` (restart a project), `session.send` (send text to a tmux session), `session.input` (send raw input bytes), `session.resize` (resize terminal), `terminal.subscribe` (start terminal streaming for a session), `terminal.unsubscribe` (stop terminal streaming for a session), `terminal.snapshot_request` (clear lastFrames cache and produce fullFrame + snapshot event on next capture), `get_sessions` (list active sessions), `timeline.replay_request` (request timeline event replay).

#### Scenario: Start session from web
- **WHEN** daemon receives `{ type: "session.start", project, agentType }`
- **THEN** daemon starts the project via session manager

#### Scenario: Send text to session from web
- **WHEN** daemon receives `{ type: "session.send", sessionName, text }`
- **THEN** daemon sends the text to the specified tmux session via sendKeys
- **THEN** daemon emits a `user.message` TimelineEvent for the session

#### Scenario: Timeline replay request
- **WHEN** daemon receives `{ type: "timeline.replay_request", sessionName, afterSeq, epoch }`
- **THEN** daemon queries the TimelineEmitter ring buffer and responds with `{ type: "timeline.replay", events, truncated, epoch }`

#### Scenario: Terminal snapshot request
- **WHEN** daemon receives `{ type: "terminal.snapshot_request", sessionName }`
- **THEN** daemon clears the lastFrames cache for that session
- **THEN** next capture cycle produces a fullFrame diff with `snapshotRequested: true`
- **THEN** daemon emits a `terminal.snapshot` TimelineEvent

#### Scenario: Unknown command type
- **WHEN** daemon receives a message with an unrecognized type
- **THEN** daemon logs a warning and ignores the message

## ADDED Requirements

### Requirement: WsBridge whitelist includes timeline messages
The WsBridge browser message whitelist SHALL include `timeline.replay_request` and `terminal.snapshot_request` in addition to existing whitelisted types. The bridge SHALL relay `timeline.event` and `timeline.replay` messages from daemon to browser sockets.

#### Scenario: Browser sends replay request
- **WHEN** browser sends `{ type: "timeline.replay_request", sessionName, afterSeq, epoch }`
- **THEN** WsBridge SHALL forward the message to the daemon

#### Scenario: Browser sends snapshot request
- **WHEN** browser sends `{ type: "terminal.snapshot_request", sessionName }`
- **THEN** WsBridge SHALL forward the message to the daemon

#### Scenario: Timeline event relayed to browsers
- **WHEN** daemon sends `{ type: "timeline.event", event: {...} }`
- **THEN** WsBridge SHALL forward it to all connected browser sockets
