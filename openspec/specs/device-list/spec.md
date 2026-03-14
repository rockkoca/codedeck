## ADDED Requirements

### Requirement: List user devices endpoint
The system SHALL provide `GET /api/server` returning all servers owned by the authenticated user. The response SHALL include id, name, status, last_heartbeat_at, and created_at. For users with team membership, the response SHALL also include servers belonging to their teams, deduplicated.

#### Scenario: User with devices
- **WHEN** authenticated user with bound devices sends `GET /api/server`
- **THEN** system returns `{ servers: [{ id, name, status, lastHeartbeatAt, createdAt }] }`

#### Scenario: User with no devices
- **WHEN** authenticated user with no devices sends `GET /api/server`
- **THEN** system returns `{ servers: [] }`

#### Scenario: Team devices included
- **WHEN** authenticated user belongs to a team that owns servers
- **THEN** those servers are included in the response, deduplicated with user-owned servers

### Requirement: Web ServerList component
The web frontend SHALL render a ServerList component on the dashboard showing device cards with name, online/offline status, and creation time. A device SHALL be considered online if its last_heartbeat_at is within 2 minutes and status is not "offline". Online devices SHALL show a "Connect" button.

#### Scenario: Online device connect
- **WHEN** user clicks "Connect" on an online device
- **THEN** the app switches to terminal view for that device

#### Scenario: No devices empty state
- **WHEN** user has no devices
- **THEN** the component shows "No devices yet. Run `codedeck bind <name>` to add one."

### Requirement: Dashboard view switching
The web app SHALL support `dashboard` and `terminal` view states. Selecting a server from the device list SHALL switch to terminal view with that server's ID. A back button in terminal view SHALL return to dashboard.

#### Scenario: Navigate to terminal
- **WHEN** user selects a server from the device list
- **THEN** app sets selectedServerId and switches to terminal view, establishing WebSocket connection

#### Scenario: Navigate back to dashboard
- **WHEN** user clicks back button in terminal view
- **THEN** app disconnects WebSocket and returns to dashboard view
