## Why

The current `capture-pane` polling model cannot reliably distinguish new terminal output from redraws, causing repeated assistant text and unnecessary tmux process overhead. We need a deterministic streaming path that improves reliability for remote terminal subscription and control workflows.

## What Changes

- Replace high-frequency `capture-pane` diff polling with `tmux pipe-pane -O` raw PTY streaming for live updates.
- Keep `capture-pane` only for snapshot/full-frame recovery (initial subscribe, reconnect, on-demand snapshot).
- Introduce binary raw-frame transport (versioned header + session routing) from daemon to browser.
- Add strict per-subscriber ordering and buffering semantics to prevent snapshot/raw overlap and out-of-order delivery.
- Add resilient recovery behavior for buffer overflow and backpressure (`terminal.stream_reset` + client resubscribe flow).
- Add stream-based terminal parsing to emit assistant text from true new lines and reduce redraw duplicates.
- Add minimal control-plane reliability contract: per-session stdin serialization, `commandId` for `session.send`, accepted ack event, and short-window dedup.

## Capabilities

### New Capabilities
- `terminal-parser`: Parse raw PTY chunks with streaming state (ANSI/UTF-8/CRLF handling) and emit clean assistant text lines.
- `terminal-control-contract`: Define minimal control-plane reliability contract for `session.send` (`commandId`, accepted ack, dedup, serialization constraints).

### Modified Capabilities
- `terminal-streaming`: Change live streaming source from polling diffs to `pipe-pane` raw output, including snapshot barrier and binary frame protocol.
- `web-command-handler`: Update subscription routing, bridge queue/ordering/backpressure semantics, and stream reset handling.

## Impact

- **Daemon**: `src/agent/tmux.ts`, `src/agent/session-manager.ts`, `src/daemon/terminal-streamer.ts`, `src/daemon/terminal-parser.ts`, `src/daemon/command-handler.ts`, `src/daemon/server-link.ts`, `src/daemon/timeline-event.ts`.
- **Server**: `server/src/ws/bridge.ts` for binary passthrough, per-session per-subscriber queueing, and backpressure/reset behavior.
- **Web**: `web/src/ws-client.ts`, `web/src/components/TerminalView.tsx` for binary frame parsing, raw feed rendering, and reset/recovery behavior.
- **Ops/Runtime**: Introduce `scripts/pipe-writer.sh`; tmux version requirement for `pipe-pane -O`; no fallback to old polling path.
