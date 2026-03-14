## 1. Tmux Pipe Stream Foundation

- [x] 1.1 Add `startPipePaneStream(session, paneId)` and `stopPipePaneStream(session)` in `src/agent/tmux.ts`
- [x] 1.2 Implement secure FIFO lifecycle (PID-scoped temp dir, `mkfifo 0600`, `O_RDWR|O_NONBLOCK`, rollback cleanup)
- [x] 1.3 Add pipe command hardening (`shellQuote`, fixed helper script path, path validation) and `pipe-pane -O` capability gating
- [x] 1.4 Create `scripts/pipe-writer.sh` and wire invocation from tmux integration

## 2. Session/Pipe Lifecycle Reliability

- [x] 2.1 Persist paneId at session creation time in `src/agent/session-manager.ts`
- [x] 2.2 Update stream startup to require paneId and fail fast when missing (no pane guessing fallback)
- [x] 2.3 Implement pipe stream close handling with bounded exponential rebind retry and terminal session state updates
- [x] 2.4 Add startup orphan cleanup scoped to current daemon PID temp namespace

## 3. Terminal Streamer Migration

- [x] 3.1 Refactor `src/daemon/terminal-streamer.ts` to remove polling capture loop and consume `pipe-pane` raw stream
- [x] 3.2 Keep snapshot path via `capturePaneVisible()` for subscribe/bootstrap and on-demand snapshot
- [x] 3.3 Implement per-subscriber snapshot barrier (`snapshotPending`) and ordered flush of buffered raw bytes
- [x] 3.4 Add overflow path emitting `terminal.stream_reset { reason: 'raw_buffer_overflow' }` with subscriber buffer reset
- [x] 3.5 Implement dual-layer idle detection: any raw bytes → running/idle state (independent of KEEP line extraction); verify running/idle transitions are decoupled from line classification

## 4. Bridge and Transport Protocol

- [x] 4.1 Add binary raw frame packing in daemon (`version + sessionName length + sessionName + payload`) and `serverLink.sendBinary()`
- [x] 4.2 Update `server/src/ws/bridge.ts` to route binary frames by browser session subscription
- [x] 4.3 Implement per-(session,browser) single forwarding queue shared by snapshot text and raw binary
- [x] 4.4 Add bridge backpressure handling (512KB queue cap, reset notice, unsubscribe on overflow, metrics)

## 5. Web Client and Terminal Rendering

- [x] 5.1 Update `web/src/ws-client.ts` for binary frame receive/parsing and raw callback dispatch
- [x] 5.2 Add `terminal.stream_reset` handling with client auto-recover flow (reset terminal, backoff resubscribe, cooldown)
- [x] 5.3 Update `web/src/components/TerminalView.tsx` to render raw `Uint8Array` data directly into xterm.js
- [x] 5.4 Ensure snapshot + raw startup order is respected in client wiring and no duplicate rendering occurs

## 6. Parser and Timeline Extraction

- [x] 6.1 Replace diff-based parsing with `RawStreamParser` state machine in `src/daemon/terminal-parser.ts`
- [x] 6.2 Implement CR/LF semantics, ANSI fragment handling, UTF-8 fragment buffering, and per-session parser state
- [x] 6.3 Keep line classification integration and throttled assistant text emission from completed lines only
- [x] 6.4 Remove obsolete diff parsing helpers (`processTerminalDiff`, scroll/screen heuristics)

## 7. Minimal Control-Plane Contract

- [x] 7.1 Add per-session `AsyncMutex` (or equivalent queue lock) for serialized stdin writes in command handler
- [x] 7.2 Require `commandId` on `session.send` in web client send path and daemon validation path
- [x] 7.3 Implement per-session short-window dedup cache for `commandId` (`100 entries / 5 min`)
- [x] 7.4 Register `command.ack` event type and emit minimal `accepted` ack when `session.send` is accepted into queue

## 8. Validation and Regression Coverage

- [x] 8.1 Add daemon tests for pipe stream startup/rebind/cleanup and per-session write serialization
- [x] 8.2 Add protocol tests for binary frame encode/decode, queue ordering, and bridge backpressure reset behavior
- [x] 8.3 Add web tests for reset recovery backoff/cooldown and snapshot-before-raw rendering order
- [x] 8.4 Add parser tests for UTF-8/ANSI chunk boundaries, CRLF, and carriage-return overwrite cases
- [x] 8.5 Run end-to-end checks: terminal live output, reconnect recovery, multi-session isolation, and duplicate-text regression
- [x] 8.6 Add tests for per-session write ordering: concurrent `session.send` calls execute in enqueue order
- [x] 8.7 Add tests for `commandId` dedup: duplicate `commandId` is silently ignored, distinct IDs both execute
- [x] 8.8 Add tests for `command.ack { status: 'accepted' }` emission on `session.send` acceptance
