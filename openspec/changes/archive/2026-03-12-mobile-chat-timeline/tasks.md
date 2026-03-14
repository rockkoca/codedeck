## 1. Protocol Layer

- [x] 1.1 Create `src/daemon/timeline-event.ts` — TimelineEvent interface, TimelineEventType union, payload type helpers
- [x] 1.2 Create `src/daemon/timeline-emitter.ts` — TimelineEmitter class with per-session seq counter, epoch field, ring buffer (500 events), replay method, on/off handler registration. Export singleton `timelineEmitter`

## 2. Daemon Event Emission

- [x] 2.1 Hook `src/daemon/hook-server.ts` — emit `tool.call` on tool_start, `tool.result` on tool_end, `mode.state` on mode changes via `timelineEmitter`
- [x] 2.2 Hook `src/router/message-router.ts` — emit `user.message` in `forwardTextToBrain()` for chat platform messages
- [x] 2.3 Hook `src/agent/session-manager.ts` — emit `session.state` (started/stopped/error) in `emitSessionEvent()`
- [x] 2.4 Hook daemon WS command handler (`src/daemon/command-handler.ts`) — emit `user.message` when receiving `session.send` from browser

## 3. TerminalStreamer Enhancements

- [x] 3.1 Add `frameSeq` (per-session monotonic counter) to TerminalDiff in `src/daemon/terminal-streamer.ts`
- [x] 3.2 Add `fullFrame` flag — true on first capture after subscribe or `terminal.snapshot_request`
- [x] 3.2b Add `snapshotRequested` flag to TerminalDiff — `true` only when fullFrame was triggered by `terminal.snapshot_request` (subscribe firstFrame → `false`). This flag determines whether daemon emits `terminal.snapshot` timeline event.
- [x] 3.3 Implement deterministic scroll detection — find max `k` shift, set `scrolled` and `newLineCount` fields on TerminalDiff
- [x] 3.4 Add `terminal.snapshot_request` WS command handler — clears lastFrames cache for target session
- [x] 3.6 Emit `terminal.snapshot` TimelineEvent from daemon only when `fullFrame && snapshotRequested` (not on subscribe firstFrame, not from frontend)
- [x] 3.5 Emit `session.state(idle)` via timelineEmitter on active→idle transition

## 4. Terminal Parser

- [x] 4.1 Create `src/daemon/terminal-parser.ts` — ANSI stripping, line classification (HIDE/MUTED/KEEP), text assembly
- [x] 4.2 Integrate parser into terminal-streamer — when `scrolled=true && newLineCount > 0`, extract lines and emit `assistant.text` via timelineEmitter with `source: 'terminal-parse'`, `confidence: 'low'`

## 5. WS Channel

- [x] 5.1 Modify `src/daemon/server-link.ts` — add `sendTimelineEvent(event)` method
- [x] 5.2 Modify `src/daemon/lifecycle.ts` — register timelineEmitter handler to forward events via ServerLink; handle `timeline.replay_request` by querying ring buffer and responding with `timeline.replay`
- [x] 5.3 Modify `server/src/ws/bridge.ts` — add `timeline.replay_request` and `terminal.snapshot_request` to BROWSER_WHITELIST; relay `timeline.event` and `timeline.replay` from daemon to browsers
- [x] 5.4 Modify `web/src/ws-client.ts` — extend ServerMessage union with `timeline.event` and `timeline.replay` types; add `onTimelineEvent` and `onTimelineReplay` callbacks; add `sendTimelineReplayRequest(sessionName, afterSeq, epoch)` and `sendSnapshotRequest(sessionName)` methods

## 6. Frontend Persistence

- [x] 6.1 Create `web/src/timeline-db.ts` — TimelineDB class with IndexedDB `codedeck-timeline` database, `events` store, `[sessionId, epoch, seq]` and `[sessionId, ts]` indexes
- [x] 6.2 Implement `putEvent`, `putEvents`, `getEvents` (epoch-aware, ordered by seq), `getLastSeqAndEpoch`, `clearSessionEpoch`, `pruneOldEvents`
- [x] 6.3 Add graceful degradation — catch IndexedDB errors, fall back to memory-only mode

## 7. Frontend Rendering

- [x] 7.1 Create `web/src/hooks/useTimeline.ts` — load from IndexedDB on mount, listen for WS timeline events, handle reconnection replay with epoch checking
- [x] 7.2 Rewrite `web/src/components/ChatView.tsx` — render TimelineEvent[] with per-type styling (user bubbles, assistant text, tool indicators, mode badges, session state, collapsible snapshots)
- [x] 7.3 Implement user echo deduplication — normalize and compare assistant.text vs recent user.message within 2s window, mark hidden

## 8. App Integration

- [x] 8.1 Add `viewMode` state to `web/src/app.tsx` — default `isMobile ? 'chat' : 'terminal'`, persist localStorage, toggle button in mobile-server-bar
- [x] 8.2 Wire `useTimeline` hook in app.tsx — pass events/loading to ChatView when viewMode='chat'
- [x] 8.3 Add optional `onSend` prop to SessionControls — call in handleSend for local UX only
- [x] 8.4 Chat mode layout — render ChatView instead of terminal, hide shortcuts-row in chat mode

## 9. Styles

- [x] 9.1 Add chat CSS to `web/src/styles.css` — .chat-view, .chat-event, .chat-user, .chat-assistant, .chat-tool, .chat-mode, .chat-system, .chat-loading, .chat-scroll-btn, .view-toggle

## 10. Dependencies & Build

- [x] 10.1 Add `strip-ansi` v7 (ESM) to `web/package.json` — not needed, daemon uses custom stripAnsi, frontend doesn't strip ANSI
- [x] 10.2 Verify `nanoid` is available in daemon deps (already present) — using crypto.randomUUID() instead
- [x] 10.3 Build and typecheck both daemon (`npm run build`) and web (`cd web && npm run build`)

## 11. Tests

- [x] 11.1 Create `test/daemon/timeline-emitter.test.ts` — seq monotonicity, cross-session isolation, ring buffer overflow, replay
- [x] 11.2 Create `test/daemon/terminal-parser.test.ts` — ANSI stripping, scroll detection, line classification (HIDE/MUTED/KEEP), CJK/emoji/RTL edge cases
- [x] 11.2b Create `test/daemon/terminal-streamer-snapshot.test.ts` — regression: subscribe firstFrame has `snapshotRequested: false` and does NOT emit `terminal.snapshot` event; `terminal.snapshot_request` firstFrame has `snapshotRequested: true` and DOES emit `terminal.snapshot` event
- [x] 11.3 Create `web/test/chat-classify.test.ts` — echo dedup, normalize function, event rendering logic
- [x] 11.4 Create `web/test/timeline-db.test.ts` — IndexedDB CRUD, epoch-aware queries, pruning, graceful degradation
- [x] 11.5 Create `web/test/use-timeline-reconnect.test.ts` — client truncated/epoch handling: epoch mismatch clears old data, truncated=true sends snapshot_request, duplicate eventId dedup on replay merge, snapshot event stored after truncated replay
- [x] 11.6 Create `test/daemon/timeline-replay.test.ts` — replay truncated calculation: `afterSeq+1 < bufMinSeq` → true, exact match → false, empty buffer → false, epoch mismatch → truncated+new epoch
