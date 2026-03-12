## ADDED Requirements

### Requirement: useTimeline hook
The system SHALL provide a `useTimeline(sessionId, ws)` hook in `web/src/hooks/useTimeline.ts` that returns `{ events: TimelineEvent[], loading: boolean }`. It SHALL load historical events from IndexedDB on mount, listen for realtime `timeline.event` WS messages, and handle reconnection replay.

#### Scenario: Initial load from IndexedDB
- **WHEN** hook mounts with a sessionId
- **THEN** it SHALL load the most recent 200 events from IndexedDB and set `loading: false`

#### Scenario: Realtime event received
- **WHEN** a `timeline.event` WS message arrives
- **THEN** the event SHALL be appended to the in-memory list and stored in IndexedDB

#### Scenario: Session switch
- **WHEN** sessionId changes
- **THEN** in-memory events SHALL be cleared and new session's history loaded from IndexedDB

#### Scenario: Reconnection replay
- **WHEN** WS reconnects
- **THEN** hook SHALL send `timeline.replay_request` with last known `{ seq, epoch }` and merge returned events

#### Scenario: Epoch mismatch on reconnect
- **WHEN** replay response has different epoch than stored
- **THEN** old epoch data for that session SHALL be cleared from IndexedDB and events restarted from new epoch

#### Scenario: Truncated replay triggers snapshot request
- **WHEN** replay response has `truncated: true` (regardless of epoch match)
- **THEN** hook SHALL send `{ type: "terminal.snapshot_request", sessionName }` to request full-frame snapshot from daemon

#### Scenario: Snapshot event received after truncated replay
- **WHEN** `terminal.snapshot` timeline event arrives after a snapshot request
- **THEN** event SHALL be stored in IndexedDB and rendered as a collapsible snapshot in ChatView

#### Scenario: Duplicate events on replay
- **WHEN** replay returns events that already exist in IndexedDB (same eventId)
- **THEN** they SHALL be overwritten idempotently without creating duplicates

### Requirement: ChatView component
The system SHALL provide a `ChatView` component in `web/src/components/ChatView.tsx` that renders `TimelineEvent[]` with role-based styling. Props SHALL be `{ events: TimelineEvent[], loading: boolean }`.

#### Scenario: User message rendering
- **WHEN** a `user.message` event is in the list
- **THEN** it SHALL render as a right-aligned bubble with blue background

#### Scenario: Assistant text rendering
- **WHEN** an `assistant.text` event is in the list
- **THEN** it SHALL render as a left-aligned text block with `pre-wrap` white-space

#### Scenario: Tool call rendering
- **WHEN** a `tool.call` event is in the list
- **THEN** it SHALL render as a compact indicator showing tool name and parameter summary

#### Scenario: Tool result rendering
- **WHEN** a `tool.result` event is in the list
- **THEN** it SHALL render as a collapsible result area

#### Scenario: Mode state rendering
- **WHEN** a `mode.state` event is in the list
- **THEN** it SHALL render as a centered badge (e.g., "Plan mode", "Auto-accept")

#### Scenario: Session state rendering
- **WHEN** a `session.state` event is in the list
- **THEN** it SHALL render as a centered system message

#### Scenario: Hidden events
- **WHEN** an event has `hidden: true`
- **THEN** it SHALL NOT be rendered

#### Scenario: Loading state
- **WHEN** `loading` is true
- **THEN** a loading indicator SHALL be shown

### Requirement: Auto-scroll with manual override
The `ChatView` SHALL auto-scroll to the bottom when new events arrive, unless the user has manually scrolled up. A floating "scroll to bottom" button SHALL appear when not at the bottom.

#### Scenario: Auto-scroll on new event
- **WHEN** user is at the bottom and a new event arrives
- **THEN** the view SHALL scroll to show the new event

#### Scenario: Manual scroll disables auto-scroll
- **WHEN** user scrolls up more than 40px from bottom
- **THEN** auto-scroll SHALL be disabled and the scroll button SHALL appear

#### Scenario: Scroll button restores auto-scroll
- **WHEN** user clicks the scroll-to-bottom button
- **THEN** view SHALL scroll to bottom and auto-scroll SHALL be re-enabled

### Requirement: User echo deduplication
The `ChatView` SHALL detect terminal echo of user messages. If an `assistant.text` event's normalized content matches a `user.message` sent within the last 2 seconds, the `assistant.text` event SHALL be marked `hidden: true`. Normalization: strip ANSI, trim, remove prompt prefixes (`❯`, `>`, `λ`, `›`), collapse whitespace.

#### Scenario: Echo detected and hidden
- **WHEN** user sends "fix the bug" and within 2s an `assistant.text` arrives with "❯ fix the bug"
- **THEN** the `assistant.text` event SHALL be marked hidden

#### Scenario: Non-echo content preserved
- **WHEN** an `assistant.text` arrives that doesn't match any recent user message
- **THEN** it SHALL NOT be marked hidden

### Requirement: View mode toggle
The app SHALL support `viewMode: 'terminal' | 'chat'` state, defaulting to `'chat'` on mobile and `'terminal'` on desktop. The mode SHALL be persisted in localStorage. A toggle button SHALL appear in the mobile server bar.

#### Scenario: Mobile default
- **WHEN** app loads on a mobile device
- **THEN** viewMode SHALL default to `'chat'`

#### Scenario: Desktop default
- **WHEN** app loads on a desktop device
- **THEN** viewMode SHALL default to `'terminal'`

#### Scenario: Toggle persists
- **WHEN** user toggles viewMode
- **THEN** the new mode SHALL be saved to localStorage and used on next load

#### Scenario: Chat mode layout
- **WHEN** viewMode is `'chat'`
- **THEN** ChatView SHALL be rendered and shortcuts-row SHALL be hidden

#### Scenario: Terminal mode layout
- **WHEN** viewMode is `'terminal'`
- **THEN** TerminalView SHALL be rendered as before (no change)

### Requirement: SessionControls onSend callback
SessionControls SHALL accept an optional `onSend(sessionName, text)` prop. When present, it SHALL be called in `handleSend()` for local UX purposes (e.g., clearing input). It SHALL NOT emit timeline events — daemon is the authority.

#### Scenario: onSend called on send
- **WHEN** user sends a message via SessionControls
- **THEN** `onSend` callback SHALL be called with sessionName and text
- **THEN** no `user.message` timeline event SHALL be emitted by the frontend
