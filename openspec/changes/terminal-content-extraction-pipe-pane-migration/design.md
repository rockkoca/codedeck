## Context

The current terminal pipeline relies on polling `tmux capture-pane` and line-diff heuristics. This approach cannot reliably separate real new output from redraws, and it creates unnecessary subprocess overhead at scale.

The change introduces a hybrid architecture:
- Live updates from `tmux pipe-pane -O` raw PTY stream.
- Snapshot recovery still uses `capture-pane`.
- Browser terminal rendering consumes raw bytes directly.

This is a cross-cutting change across daemon, server bridge, and web client, with explicit reliability constraints for ordering, buffering, and recovery.

## Goals / Non-Goals

**Goals:**
- Eliminate redraw-driven duplicate assistant text in chat timelines.
- Replace high-frequency polling with deterministic raw PTY streaming.
- Preserve reliable snapshot-first UX for subscribe/reconnect flows.
- Ensure per-subscriber ordered delivery of snapshot + raw stream.
- Add minimal control-plane safety rails for remote command dispatch (`session.send`).

**Non-Goals:**
- Full command lifecycle semantics (`done/error`) in this change.
- Automatic replay of in-flight commands after reconnect.
- Fallback to old polling mode when `pipe-pane -O` is unavailable.

## Decisions

### D1: Use `pipe-pane -O` for live stream and keep `capture-pane` for snapshots
- **Decision**: live stream source is raw PTY bytes via `pipe-pane`; snapshots remain `capture-pane` full-frame.
- **Rationale**: raw stream provides deterministic event order and avoids redraw ambiguity; snapshots still needed for state bootstrap/recovery.
- **Alternative rejected**: continue diff polling with stronger heuristics; remains fundamentally lossy and expensive.

### D2: FIFO safety + command hardening in tmux integration
- **Decision**: create FIFO in PID-scoped temp dir, open with `O_RDWR|O_NONBLOCK`, and launch `pipe-pane` using fixed helper script path plus shell quoting.
- **Rationale**: `O_RDWR` keeps a writer reference in the daemon process, preventing premature EOF when no external writer is attached yet. PID-scoped temp dir and shell quoting reduce command injection/path hijack risk.
- **Alternative rejected**: direct shell command concatenation; too fragile and security-sensitive.

### D3: Enforce snapshot/raw ordering with subscriber-local barrier
- **Decision**: each subscriber must receive snapshot before raw stream. Existing stream + new subscriber uses `snapshotPending` and bounded buffer.
- **Rationale**: prevents overlapping bootstrap/live bytes from corrupting terminal state.
- **Alternative rejected**: allow concurrent snapshot and raw delivery; causes nondeterministic rendering and races.

### D4: Bridge guarantees order with per-(session,browser) single queue
- **Decision**: bridge forwards snapshot text and raw binary through a shared serialized queue per session/browser.
- **Rationale**: WS guarantees order per link, but bridge async fanout can reorder without explicit queueing.
- **Alternative rejected**: independent text/binary forwarding paths; risks out-of-order arrival.

### D5: Bounded buffering with explicit reset protocol
- **Decision**: overflow triggers `terminal.stream_reset` and client resubscribe with backoff/cooldown.
- **Rationale**: partial raw drop can desynchronize ANSI/UTF-8 state; hard reset is safer. Reset message SHALL be sent before subscription removal; if send fails, socket SHALL be closed with `backpressure_notify_failed` reason.
- **Alternative rejected**: drop-oldest/drop-newest bytes; can silently corrupt terminal rendering.

### D6: Streaming parser state machine for extraction
- **Decision**: parser tracks CR/LF, ANSI fragments, UTF-8 fragments per session; emits only completed lines.
- **Rationale**: chunk boundaries are arbitrary; state is required for correctness.
- **Alternative rejected**: per-chunk stateless splitting; loses data and misclassifies redraw output.

### D7: Minimal control-plane reliability contract in this change
- **Decision**: implement per-session write mutex, `commandId` for `session.send`, accepted ack event, and short-window dedup.
- **Rationale**: enables safer remote-control semantics without blocking stream migration on full command lifecycle design.
- **Alternative rejected**: postpone all control-plane constraints; leaves remote-control goals under-specified.

## Risks / Trade-offs

- **[Pipe stream silent but healthy]** → Startup success must not depend on data arrival; treat command success + no stream error as healthy, monitor activity separately.
- **[Slow clients/backpressure]** → Per-subscriber and bridge queue limits with reset/recover protocol and metrics.
- **[Session restarts/pane drift]** → Store paneId per session lifecycle; rebind with bounded exponential retry.
- **[Protocol drift between components]** → Versioned binary frame header and explicit reset reasons.
- **[Control-plane partial scope]** → Only `accepted` ack in this change; document deferred `done/error` and inflight recovery for follow-up change.
