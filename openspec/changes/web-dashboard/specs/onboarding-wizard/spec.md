## ADDED Requirements

### Requirement: Getting Started wizard display condition
The web dashboard SHALL display a GettingStarted wizard when the authenticated user has zero devices AND zero API keys. Once the user has at least one device, the wizard SHALL be replaced by the normal dashboard.

#### Scenario: New user sees wizard
- **WHEN** user logs in with no devices and no API keys
- **THEN** the dashboard shows the Getting Started wizard instead of empty device/key lists

#### Scenario: User with existing device
- **WHEN** user logs in with at least one device
- **THEN** the dashboard shows the normal ServerList and ApiKeyManager

### Requirement: Step-by-step onboarding flow
The wizard SHALL guide users through 4 sequential steps: (1) Generate API Key with an inline button, (2) Configure CLI showing a copyable config snippet with the baseUrl and generated key pre-filled, (3) Install and bind with `npm i -g codedeck && codedeck bind <name>`, (4) Start daemon with `codedeck start`.

#### Scenario: Complete onboarding
- **WHEN** user follows all 4 steps and binds a device
- **THEN** the wizard detects the new device and transitions to the normal dashboard

### Requirement: Auto-detect device binding
The wizard SHALL poll `GET /api/server` every 5 seconds. When a device appears in the response, the wizard SHALL automatically dismiss and show the normal dashboard with the new device.

#### Scenario: Device appears during wizard
- **WHEN** user completes `codedeck bind` while wizard is active
- **THEN** within 5 seconds the wizard auto-dismisses and shows the device in ServerList
