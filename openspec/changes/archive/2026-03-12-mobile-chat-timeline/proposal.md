## Why

Mobile users currently see a raw terminal view that's too small and noisy for effective agent interaction. The terminal stream mixes agent output, UI chrome, spinners, and tool calls into an undifferentiated character stream. We need a structured chat timeline that presents agent interactions as discrete, typed events — giving mobile users a clean, chat-app-like experience while preserving full terminal access as a toggle.

## What Changes

- **New event protocol**: `TimelineEvent` type system with 7 event types (`user.message`, `assistant.text`, `tool.call`, `tool.result`, `mode.state`, `session.state`, `terminal.snapshot`) carrying per-session monotonic seq + daemon epoch for continuity tracking.
- **Daemon event bus**: `TimelineEmitter` singleton emits structured events from hook-server (tool calls, mode changes), session-manager (state changes), message-router (chat platform messages), WS handler (browser sends), and terminal-streamer (parsed output as fallback).
- **TerminalStreamer enhancements**: Deterministic scroll detection (`scrolled`, `newLineCount`, `fullFrame`, `snapshotRequested`, `frameSeq`) to reliably extract new content from terminal diffs without heuristic offset tracking.
- **Terminal parser**: Extracts `assistant.text` from scrolled terminal diffs as low-confidence fallback. Conservative classification: only HIDE known chrome (braille spinners, "How is Claude doing"), KEEP everything else including all languages.
- **WS timeline channel**: `timeline.event` (realtime), `timeline.replay` (reconnection), `timeline.replay_request` (client → daemon) messages through existing ServerLink → WsBridge → browser path.
- **Daemon ring buffer**: Per-session 500-event memory buffer with epoch-aware replay for reconnection resilience.
- **IndexedDB persistence**: Browser-side `TimelineDB` with `[sessionId, epoch, seq]` index for offline history and cross-page continuity. Epoch-aware queries prevent cross-restart data mixing.
- **ChatView component**: Renders `TimelineEvent[]` with role-based styling (user bubbles, assistant text blocks, tool indicators, mode badges, system messages).
- **View mode toggle**: `terminal | chat` mode in app.tsx, defaulting to `chat` on mobile. Persisted in localStorage.
- **Daemon as authority**: `user.message` events are emitted exclusively by the daemon (on receiving `session.send` or chat platform messages), never by the frontend, preventing double-display.

## Capabilities

### New Capabilities
- `timeline-events`: Structured event protocol, daemon emitter, per-session seq/epoch tracking, ring buffer replay
- `terminal-parser`: Deterministic scroll detection, terminal diff → assistant.text extraction, line classification
- `timeline-persistence`: IndexedDB persistence layer with epoch-aware queries, reconnection replay
- `chat-view`: Mobile chat UI rendering TimelineEvent[], view mode toggle, auto-scroll

### Modified Capabilities
- `terminal-streaming`: TerminalDiff gains `frameSeq`, `scrolled`, `newLineCount`, `fullFrame`, `snapshotRequested` fields; new `terminal.snapshot_request` WS command; daemon emits `terminal.snapshot` timeline event only when `fullFrame && snapshotRequested` (not on subscribe firstFrame)
- `web-command-handler`: WsBridge whitelist adds `timeline.replay_request` + `terminal.snapshot_request`; relays `timeline.event` and `timeline.replay`

## Impact

- **Daemon** (`src/daemon/`): New files `timeline-event.ts`, `timeline-emitter.ts`, `terminal-parser.ts`. Modified: `terminal-streamer.ts`, `hook-server.ts`, `lifecycle.ts`, `server-link.ts`.
- **Router** (`src/router/`): `message-router.ts` emits `user.message` events.
- **Agent** (`src/agent/`): `session-manager.ts` emits `session.state` events.
- **Server** (`server/src/ws/`): `bridge.ts` whitelist + relay additions.
- **Web** (`web/src/`): New files `timeline-db.ts`, `hooks/useTimeline.ts`. Rewritten `ChatView.tsx`. Modified `ws-client.ts`, `app.tsx`, `SessionControls.tsx`, `styles.css`.
- **Dependencies**: `strip-ansi` v7 (ESM) added to `web/package.json`. `nanoid` for event IDs (already in daemon deps).
- **Backward compatible**: Terminal mode unchanged. Chat mode is additive. No breaking changes to existing WS protocol.
