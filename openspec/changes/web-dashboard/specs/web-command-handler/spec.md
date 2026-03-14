## ADDED Requirements

### Requirement: Daemon registers message handler on ServerLink
The daemon SHALL register a `serverLink.onMessage()` callback in lifecycle.ts after calling `serverLink.connect()`. All messages from the worker SHALL be routed through this handler.

#### Scenario: Web command reaches daemon
- **WHEN** a browser sends a command through DaemonBridge
- **THEN** the daemon's onMessage handler receives and processes it

### Requirement: Command handler processes web commands
The daemon SHALL implement a command handler that processes the following command types from the web: `session.start` (start a project), `session.stop` (stop a project), `session.send` (send text to a tmux session), `terminal.subscribe` (start terminal streaming for a session), `terminal.unsubscribe` (stop terminal streaming for a session).

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
The daemon SHALL report session state changes to the worker via ServerLink using `type: "session_event"`. The DaemonBridge SHALL normalize this to `type: "session.event"` before forwarding to browser sockets (see terminal-streaming spec). Events SHALL include started, stopped, and error with the session name and current state.

#### Scenario: Session starts
- **WHEN** a tmux session starts successfully
- **THEN** daemon sends `{ type: "session_event", event: "started", session: "deck_xxx_w1", state: "running" }` via ServerLink

#### Scenario: Session crashes
- **WHEN** a tmux session exits unexpectedly
- **THEN** daemon sends `{ type: "session_event", event: "error", session: "deck_xxx_w1", state: "crashed" }` via ServerLink

### Requirement: Fix bind flow authentication
The daemon bind flow SHALL send only `{ serverName }` in the request body to `/api/bind/initiate`, with the API key as `Authorization: Bearer ${apiKey}`. The worker SHALL extract userId from the authenticated API key, not from the request body. The `userId: 'me'` hardcode SHALL be removed.

#### Scenario: Bind with API key auth
- **WHEN** user runs `codedeck bind my-laptop` with a valid API key configured
- **THEN** daemon sends `POST /api/bind/initiate` with `Authorization: Bearer deck_xxx` and body `{ serverName: "my-laptop" }`
- **THEN** worker resolves userId from the API key and creates the bind

#### Scenario: Bind without API key
- **WHEN** user runs `codedeck bind` without an API key configured
- **THEN** daemon shows an error directing user to configure an API key first
