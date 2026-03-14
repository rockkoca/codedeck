## Why

The Codedeck web frontend exists but cannot function end-to-end. Users can log in via GitHub OAuth, but there is no dashboard, no API key management, no device list, and several critical bugs prevent WebSocket terminal streaming from working. Without these pieces, the web app is a dead end after login — users cannot generate the API key needed to bind a daemon, cannot see their devices, and cannot view live terminal output.

## What Changes

- Add API Key CRUD endpoints (create, list, revoke) to the worker auth routes
- Fix `app.tsx` AuthState bug (userId stored as serverId) and restructure into dashboard/terminal views
- Create Dashboard page with API Key Manager and Server List components
- Add `GET /api/server` endpoint returning user-owned devices
- Fix `/api/bind/initiate` security vulnerability (add auth, stop reading userId from body)
- Fix daemon bind flow (remove hardcoded `userId: 'me'`)
- Add Getting Started onboarding wizard for new users with zero devices
- Implement daemon command handler and terminal streaming (capture + line-level diff)
- Add browser WebSocket route (`/api/server/:id/terminal`) separate from daemon WebSocket
- Fix DaemonBridge to relay all daemon messages to browser sockets
- Add `resolveServerRole` for proper owner/team permission checks
- Register `serverLink.onMessage()` in daemon lifecycle to handle web commands

## Capabilities

### New Capabilities
- `api-key-management`: CRUD for user API keys (deck_xxx) — worker endpoints + web UI component
- `device-list`: Server/device listing endpoint and web component with online/offline status
- `onboarding-wizard`: Getting Started step-by-step guide for new users (key generation, CLI setup, bind, start)
- `terminal-streaming`: Daemon-side terminal capture with line-level diff, browser WebSocket route, and DaemonBridge relay
- `web-command-handler`: Daemon command handler for web-originated session and terminal commands

### Modified Capabilities

## Impact

- **Worker routes**: `auth.ts` (new key endpoints), `server.ts` (new GET /api/server, new terminal WebSocket), `bind.ts` (add auth), `session-mgmt.ts` (use resolveServerRole)
- **Worker security**: `authorization.ts` (new resolveServerRole function)
- **Worker DO**: `DaemonBridge.ts` (relay all messages to browsers)
- **Web frontend**: `app.tsx` (fix AuthState, add dashboard/terminal view switching), new pages and components
- **Daemon**: `lifecycle.ts` (register onMessage), new `command-handler.ts`, new `terminal-streamer.ts`
- **Daemon bind**: `bind-flow.ts` (remove userId: 'me', send only serverName)
- **Agent**: `tmux.ts` (add getPaneSize)
