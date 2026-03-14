## MODIFIED Requirements

### Requirement: Command handler processes web commands
The daemon SHALL implement a command handler that processes the following command types from the web: `session.start`, `session.stop`, `session.restart`, `session.send`, `session.input`, `session.resize`, `get_sessions`, `terminal.subscribe`, `terminal.unsubscribe`. The handler logic is unchanged — only the server-side relay changes from DaemonBridge DO to WsBridge.

#### Scenario: Start session from web
- **WHEN** daemon receives `{ type: "session.start", project, agentType }`
- **THEN** daemon starts the project via session manager

#### Scenario: Send text to session from web
- **WHEN** daemon receives `{ type: "session.send", sessionName, text }`
- **THEN** daemon sends the text to the specified tmux session via sendKeys

#### Scenario: Unknown command type
- **WHEN** daemon receives a message with an unrecognized type
- **THEN** daemon logs a warning and ignores the message

### Requirement: Session event reporting
The daemon SHALL report session state changes to the server via ServerLink using `type: "session_event"`. The WsBridge SHALL normalize this to `type: "session.event"` before forwarding to browser sockets. Events SHALL include started, stopped, and error with the session name and current state.

#### Scenario: Session starts
- **WHEN** a tmux session starts successfully
- **THEN** daemon sends `{ type: "session_event", event: "started", session: "deck_xxx_w1", state: "running" }` via ServerLink

#### Scenario: Session crashes
- **WHEN** a tmux session exits unexpectedly
- **THEN** daemon sends `{ type: "session_event", event: "error", session: "deck_xxx_w1", state: "crashed" }` via ServerLink
