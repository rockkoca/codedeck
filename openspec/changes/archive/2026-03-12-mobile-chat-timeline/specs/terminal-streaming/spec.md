## MODIFIED Requirements

### Requirement: Daemon terminal capture with line-level diff
The daemon SHALL capture tmux pane content at a configurable FPS rate (default 10). It SHALL compute line-level diffs against the last-sent state and send only changed lines as `{ type: "terminal_update", diff: { sessionName, timestamp, lines: [[lineIndex, content]], cols, rows, frameSeq, fullFrame, snapshotRequested, scrolled, newLineCount } }`. After 2 seconds of no changes, the capture rate SHALL drop to idle FPS (default 1). Each diff SHALL include:
- `frameSeq`: per-session monotonic frame counter (increments on every diff)
- `fullFrame`: `true` when this is the first frame after subscribe or after `terminal.snapshot_request`
- `snapshotRequested`: `true` only when this fullFrame was triggered by `terminal.snapshot_request` (not by subscribe). Used to decide whether to emit a `terminal.snapshot` timeline event.
- `scrolled`: `true` when deterministic scroll detection finds the screen shifted up by `k > 0` lines
- `newLineCount`: number of new lines at the bottom when scrolled (0 when not scrolled)

#### Scenario: Active terminal output
- **WHEN** terminal content changes between captures
- **THEN** daemon sends only the changed lines with their indices, frameSeq, and scroll metadata

#### Scenario: Idle terminal
- **WHEN** no terminal changes for 2 seconds
- **THEN** capture rate drops from 10 FPS to 1 FPS

#### Scenario: Subscribe and unsubscribe
- **WHEN** browser sends `terminal.subscribe` for a session
- **THEN** daemon starts capture loop for that session and first diff SHALL have `fullFrame: true` and `snapshotRequested: false`
- **THEN** no `terminal.snapshot` TimelineEvent SHALL be emitted (subscribe fullFrame is for terminal rendering, not timeline)
- **WHEN** browser sends `terminal.unsubscribe` or disconnects
- **THEN** daemon stops capture loop if no other subscribers remain

#### Scenario: Frame seq incrementing
- **WHEN** multiple diffs are sent for a session
- **THEN** `frameSeq` SHALL increment monotonically across diffs

#### Scenario: Scroll detected
- **WHEN** screen content shifts up by 3 lines between consecutive frames
- **THEN** diff SHALL have `scrolled: true` and `newLineCount: 3`

#### Scenario: Local repaint without scroll
- **WHEN** only specific lines change without screen shift
- **THEN** diff SHALL have `scrolled: false` and `newLineCount: 0`

## ADDED Requirements

### Requirement: Request snapshot command via WS
The daemon SHALL handle `{ type: "terminal.snapshot_request", sessionName }` WS messages from the browser. Upon receipt, it SHALL clear the `lastFrames` cache for the specified session. The next capture cycle SHALL produce a `fullFrame: true` diff containing all lines. The daemon SHALL also emit a `terminal.snapshot` TimelineEvent with the full screen content when that fullFrame diff is produced.

#### Scenario: Snapshot requested via WS
- **WHEN** daemon receives `{ type: "terminal.snapshot_request", sessionName: "deck_app_brain" }`
- **THEN** the lastFrames cache for that session SHALL be cleared
- **THEN** the next capture SHALL produce a diff with `fullFrame: true`, `snapshotRequested: true`, and all lines included
- **THEN** daemon SHALL emit a `terminal.snapshot` TimelineEvent with full screen content (because `snapshotRequested: true`)

#### Scenario: Snapshot not requested — no snapshot event
- **WHEN** a regular (non-fullFrame) diff is produced
- **THEN** no `terminal.snapshot` TimelineEvent SHALL be emitted
