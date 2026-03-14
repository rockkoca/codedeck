## ADDED Requirements

### Requirement: sessionId naming convention
Throughout all timeline-related code, `sessionId` and `sessionName` SHALL refer to the same value: the tmux session name (e.g., `deck_myapp_brain`). The event model uses `sessionId` as the field name. WS command payloads use `sessionName` for backward compatibility with existing protocol. Implementations SHALL treat them as interchangeable: when constructing a TimelineEvent from a WS command, copy `msg.sessionName` into `event.sessionId`.

#### Scenario: sessionId equals sessionName
- **WHEN** a `session.send` WS command arrives with `sessionName: "deck_app_brain"`
- **THEN** the resulting `user.message` TimelineEvent SHALL have `sessionId: "deck_app_brain"`

### Requirement: TimelineEvent type definition
The system SHALL define a `TimelineEvent` interface in `src/daemon/timeline-event.ts` with fields: `eventId` (nanoid string), `sessionId` (tmux session name — same value as `sessionName` in WS commands), `ts` (Date.now() timestamp), `seq` (per-session monotonic counter), `epoch` (daemon startup timestamp), `source` ('daemon' | 'hook' | 'terminal-parse'), `confidence` ('high' | 'medium' | 'low'), `type` (TimelineEventType union), `payload` (Record<string, unknown>), and optional `hidden` (boolean).

#### Scenario: Event type completeness
- **WHEN** a TimelineEvent is created
- **THEN** it SHALL contain all required fields with correct types

### Requirement: TimelineEventType union
The system SHALL define `TimelineEventType` as a union of: `user.message`, `assistant.text`, `tool.call`, `tool.result`, `mode.state`, `session.state`, `terminal.snapshot`.

#### Scenario: All event types representable
- **WHEN** any supported event occurs in the system
- **THEN** it SHALL be representable as one of the 7 TimelineEventType values

### Requirement: TimelineEmitter singleton
The system SHALL provide a `TimelineEmitter` class exported as a singleton `timelineEmitter` in `src/daemon/timeline-emitter.ts`. It SHALL maintain a per-session monotonic seq counter (Map<string, number>) and a readonly `epoch` field set to `Date.now()` at construction time.

#### Scenario: Seq monotonicity
- **WHEN** multiple events are emitted for the same session
- **THEN** each event's seq SHALL be strictly greater than the previous

#### Scenario: Cross-session seq isolation
- **WHEN** events are emitted for session A and session B
- **THEN** each session SHALL have its own independent seq counter starting from 1

#### Scenario: Epoch stability
- **WHEN** the daemon process starts
- **THEN** the emitter's epoch SHALL be set once and remain constant for the process lifetime

### Requirement: Ring buffer per session
The `TimelineEmitter` SHALL maintain a per-session ring buffer of the most recent 500 events. It SHALL provide a `replay(sessionId, afterSeq)` method that returns events with `seq > afterSeq` from the buffer.

#### Scenario: Buffer stores events
- **WHEN** 600 events are emitted for a session
- **THEN** only the most recent 500 events SHALL be retained in the buffer

#### Scenario: Replay returns gap events
- **WHEN** `replay("session1", 450)` is called and buffer contains events with seq 101-600
- **THEN** events with seq 451-600 SHALL be returned

#### Scenario: Replay detects gap
- **WHEN** `replay("session1", 50)` is called but buffer starts at seq 101
- **THEN** the caller SHALL be able to detect the gap (events before seq 101 are missing)

### Requirement: Event handler registration
The `TimelineEmitter` SHALL provide `on(handler)` and return an unsubscribe function. All registered handlers SHALL be called synchronously when an event is emitted.

#### Scenario: Handler receives events
- **WHEN** a handler is registered and an event is emitted
- **THEN** the handler SHALL be called with the complete TimelineEvent

#### Scenario: Unsubscribe stops delivery
- **WHEN** the returned unsubscribe function is called
- **THEN** the handler SHALL no longer receive events

### Requirement: user.message emission from daemon WS handler
The daemon SHALL emit a `user.message` TimelineEvent when it receives a `session.send` WS command from the browser. The payload SHALL include `{ text: string }`. Source SHALL be `'daemon'`, confidence `'high'`.

#### Scenario: Browser sends text
- **WHEN** daemon receives `{ type: "session.send", sessionName: "deck_app_brain", text: "fix the bug" }`
- **THEN** a `user.message` event with `{ text: "fix the bug" }` SHALL be emitted for session `deck_app_brain`

### Requirement: user.message emission from chat platform
The daemon SHALL emit a `user.message` TimelineEvent when `forwardTextToBrain()` in message-router.ts sends text to a tmux session. Source SHALL be `'daemon'`, confidence `'high'`.

#### Scenario: Discord message routed
- **WHEN** a Discord message is routed to a brain session
- **THEN** a `user.message` event SHALL be emitted with the message text

### Requirement: session.state emission
The daemon SHALL emit `session.state` TimelineEvents from session-manager.ts when sessions start, stop, or encounter errors. It SHALL also emit `session.state(idle)` from terminal-streamer.ts when a session transitions from active to idle. Source SHALL be `'daemon'`, confidence `'high'`.

#### Scenario: Session started
- **WHEN** session-manager starts a session
- **THEN** a `session.state` event with `{ state: "started" }` SHALL be emitted

#### Scenario: Session idle
- **WHEN** terminal-streamer detects idle transition
- **THEN** a `session.state` event with `{ state: "idle" }` SHALL be emitted

### Requirement: tool.call and tool.result emission from hooks
The daemon SHALL emit `tool.call` and `tool.result` TimelineEvents from hook-server.ts when Claude Code hooks fire `tool_start` and `tool_end`. Source SHALL be `'hook'`, confidence `'high'`. Payload SHALL include tool name and relevant parameters.

#### Scenario: Tool start hook
- **WHEN** hook-server receives a `tool_start` event for tool "Read"
- **THEN** a `tool.call` event with `{ tool: "Read", ... }` SHALL be emitted

#### Scenario: Tool end hook
- **WHEN** hook-server receives a `tool_end` event for tool "Read"
- **THEN** a `tool.result` event with `{ tool: "Read", ... }` SHALL be emitted

### Requirement: mode.state emission from hooks
The daemon SHALL emit `mode.state` TimelineEvents when plan mode, bypass permissions, or auto-accept mode changes are detected via hooks. Source SHALL be `'hook'`, confidence `'high'`.

#### Scenario: Plan mode enabled
- **WHEN** hook-server detects plan mode activation
- **THEN** a `mode.state` event with `{ mode: "plan", active: true }` SHALL be emitted

### Requirement: WS timeline.event relay
The daemon SHALL send `{ type: "timeline.event", event: TimelineEvent }` via ServerLink whenever a TimelineEvent is emitted. The lifecycle.ts module SHALL register a timelineEmitter handler that forwards events to ServerLink. WsBridge SHALL relay these to all connected browser sockets.

#### Scenario: Event reaches browser
- **WHEN** a TimelineEvent is emitted in the daemon
- **THEN** all connected browsers SHALL receive `{ type: "timeline.event", event: {...} }`

### Requirement: timeline.replay_request handling
The daemon SHALL handle `{ type: "timeline.replay_request", sessionName, afterSeq, epoch }` from the browser. If `request.epoch !== emitter.epoch`, it SHALL return `{ type: "timeline.replay", events: [], truncated: true, epoch: emitter.epoch }`. If epoch matches, it SHALL query the ring buffer for events with `seq > afterSeq`. The `truncated` flag SHALL be `true` when `afterSeq + 1 < buffer[0].seq` (the client's expected next event is before the buffer's oldest event, indicating loss). Otherwise `truncated: false`.

#### Scenario: Epoch mismatch (daemon restarted)
- **WHEN** browser sends replay_request with epoch 1000 but daemon epoch is 2000
- **THEN** daemon returns `{ events: [], truncated: true, epoch: 2000 }`

#### Scenario: Successful incremental replay (no gap)
- **WHEN** browser sends replay_request with matching epoch and afterSeq=100, buffer has seq 50-200
- **THEN** daemon returns events with seq 101-200 and `truncated: false` (because `101 >= 50`, no gap)

#### Scenario: Buffer gap (overflow)
- **WHEN** browser sends replay_request with afterSeq=10 but buffer starts at seq 101
- **THEN** daemon returns events from seq 101 onward with `truncated: true` (because `11 < 101`)

#### Scenario: Empty buffer
- **WHEN** browser sends replay_request for a session with no buffered events
- **THEN** daemon returns `{ events: [], truncated: false, epoch }` (no events, no gap)

### Requirement: terminal.snapshot emission by daemon
The daemon SHALL emit a `terminal.snapshot` TimelineEvent ONLY when TerminalStreamer produces a diff with `fullFrame: true` AND `snapshotRequested: true` (i.e., triggered by `terminal.snapshot_request`, NOT by `terminal.subscribe`). Source SHALL be `'daemon'`, confidence `'high'`. Payload SHALL include the full screen content (all lines). Frontend clients SHALL NOT generate timeline events — daemon is the sole emitter.

#### Scenario: Snapshot on snapshot_request fullFrame
- **WHEN** TerminalStreamer produces a fullFrame diff with `snapshotRequested: true` for session "deck_app_brain"
- **THEN** daemon SHALL emit `terminal.snapshot` with all screen lines in payload

#### Scenario: No snapshot on subscribe fullFrame
- **WHEN** TerminalStreamer produces a fullFrame diff with `snapshotRequested: false` (from terminal.subscribe)
- **THEN** daemon SHALL NOT emit a `terminal.snapshot` event

#### Scenario: Multi-client consistency
- **WHEN** two browsers are connected and a fullFrame diff with `snapshotRequested: true` occurs
- **THEN** both browsers SHALL receive the same `terminal.snapshot` event with the same eventId and seq
