## Context

CodeDeck's mobile web UI currently shows a raw terminal view — the same xterm.js rendering as desktop. On small screens this is nearly unusable: text is tiny, scrolling is awkward, and agent chrome (spinners, box-drawing, status bars) wastes precious space. Users want a chat-app-like experience on mobile.

The daemon already has partial event infrastructure: hook-server receives Claude Code lifecycle hooks (tool_start, tool_end), session-manager emits session events, terminal-streamer produces line-level diffs. But none of these produce structured, typed events with sequencing — they're ad-hoc messages relayed through ServerLink → WsBridge → browser.

The server layer is a Node.js Express + PostgreSQL backend (`server/`). CF Workers have been abandoned.

## Goals / Non-Goals

**Goals:**
- Structured event timeline as the authoritative data source for chat mode
- Per-session monotonic seq with daemon epoch for reconnection continuity
- Daemon as single authority for all event types (including `user.message`)
- Deterministic scroll detection in TerminalStreamer (not heuristic)
- IndexedDB persistence for offline history and cross-page continuity
- Conservative terminal content extraction — never hide legitimate text
- Support all three agent types: Claude Code, Codex, OpenCode
- View mode toggle (terminal/chat), default chat on mobile

**Non-Goals:**
- Markdown rendering in chat bubbles (plain text with pre-wrap is sufficient for v1)
- Server-side persistent storage of timeline events (ring buffer is memory-only)
- Real-time collaboration features (multiple users editing same session)
- SQLite for mobile persistence (IndexedDB in WKWebView is sufficient; SQLite deferred)
- Replacing terminal mode — it remains fully functional

## Decisions

### D1: Daemon as sole authority for `user.message`
**Decision**: Frontend never emits timeline events. It sends `session.send` via WS, daemon emits `user.message` and broadcasts back.
**Rationale**: Prevents double-display. Single source of truth means no reconciliation needed. Chat platform messages (Discord etc.) go through same path.
**Alternative rejected**: Frontend optimistic insert + dedup — adds complexity, race conditions with reconnection.

### D2: Epoch-based seq continuity
**Decision**: `epoch = Date.now()` set once on daemon startup. Each session has independent monotonic seq counter. Client stores `{lastSeq, epoch}` per session. On reconnect, if epoch mismatch → clear local data and restart.
**Rationale**: Avoids seq confusion across daemon restarts without requiring persistent server-side seq storage.
**Alternative rejected**: UUID-only events without seq — loses ordering guarantee and makes gap detection impossible.

### D3: Deterministic scroll detection over heuristic offset
**Decision**: Compare consecutive terminal frames. Find max `k` where `currentLines[0..rows-k-1] === previousLines[k..rows-1]`. If `k > 0`: scrolled, new content is bottom `k` lines. If `k = 0`: local repaint, no content extraction.
**Rationale**: Only triggers on true "screen scrolled up by k lines" — immune to cursor movement, status bar updates, partial redraws.
**Alternative rejected**: Line-hash-based offset tracking — breaks on identical lines, wrap changes.

### D4: Conservative line classification
**Decision**: Only HIDE exact-match chrome (braille spinners, "How is Claude doing this session"). KEEP everything else including all languages, box-drawing, markdown.
**Rationale**: False negatives (showing some chrome) are acceptable. False positives (hiding real content) are not.

### D5: IndexedDB over localStorage
**Decision**: IndexedDB with `[sessionId, epoch, seq]` compound index.
**Rationale**: localStorage has 5-10MB limit and no indexing. IndexedDB supports structured queries, larger storage (50MB+), and works in WKWebView for Capacitor iOS builds.

### D6: Memory ring buffer for replay (no DB persistence)
**Decision**: Daemon keeps last 500 events per session in memory. On reconnect, client requests replay by `{afterSeq, epoch}`.
**Rationale**: Simple, no external dependencies. 500 events covers typical browsing gaps. For longer disconnections, client falls back to `terminal.snapshot_request` for a full-frame snapshot.

**truncated 判定规则**:
```
let bufMinSeq = buffer[0]?.seq ?? Infinity
let truncated = (afterSeq + 1) < bufMinSeq  // 请求的下一条事件比 buffer 最小 seq 还小，说明有丢失
```
即：若客户端期望的第一条事件 `afterSeq + 1` 在 buffer 之前，则 `truncated = true`。epoch 不匹配时直接 `truncated = true`，不查 buffer。

### D7: Daemon 统一发射 terminal.snapshot
**Decision**: `terminal.snapshot` 事件由 daemon 生成（在 TerminalStreamer 产生 fullFrame diff 时），通过 timelineEmitter 发射。前端只消费，不生成任何 timeline 事件。
**Rationale**: 多客户端一致性——所有浏览器看到相同的事件序列。如果由前端生成 snapshot，不同客户端可能在不同时间生成，导致 IndexedDB 中事件集合不一致。

### D8: 统一 snapshot 触发机制
**Decision**: 只使用一种机制触发 snapshot：客户端发送 `{ type: "terminal.snapshot_request", sessionName }` WS 消息。daemon 收到后清除该 session 的 lastFrames 缓存，下次捕获产生 fullFrame diff，并由 daemon 发射 `terminal.snapshot` timeline 事件。不再复用 `terminal.subscribe` 来隐式触发 snapshot。
**Rationale**: 语义清晰，单一触发路径。`terminal.subscribe` 的职责是开启终端流，`terminal.snapshot_request` 的职责是请求一次性全屏快照。分离关注点避免实现分叉。

## Risks / Trade-offs

- **[Ring buffer overflow]** → If client disconnects longer than ~500 events, replay is incomplete. Mitigation: `truncated: true` flag triggers client to send `terminal.snapshot_request`, daemon responds with fullFrame diff + `terminal.snapshot` timeline event.
- **[Terminal parser accuracy]** → Low-confidence `assistant.text` from terminal parsing may include some UI chrome. Mitigation: Conservative KEEP-by-default policy; only hide known patterns. Users can toggle to terminal mode for full fidelity.
- **[Memory usage]** → 500 events × N sessions in daemon memory. Mitigation: At ~1KB/event average, 500 × 10 sessions = 5MB — acceptable for a daemon process.
- **[IndexedDB on iOS Safari]** → WKWebView IndexedDB has had historical bugs. Mitigation: Capacitor WKWebView is modern; add error handling with graceful degradation to memory-only mode.
- **[Hook-server dependency]** → `tool.call`/`tool.result`/`mode.state` events rely on Claude Code hooks being configured. Mitigation: These are high-confidence bonus events. Chat mode works without them via terminal-parsed fallback.
