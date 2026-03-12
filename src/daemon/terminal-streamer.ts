/**
 * Capture tmux pane at ~10 FPS, compute line-level diffs, stream to WebSocket.
 * Used by the web terminal viewer for real-time session display.
 * Features idle detection: drops to 1 FPS after 2s of no changes.
 */
import { capturePaneVisible, capturePaneHistory } from '../agent/tmux.js';
import { getPaneSize } from '../agent/tmux.js';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';
import { processTerminalDiff, stripAnsi } from './terminal-parser.js';

const ACTIVE_INTERVAL_MS = 100; // 10 FPS
const IDLE_INTERVAL_MS = 1000; // 1 FPS
const IDLE_THRESHOLD_MS = 2000; // 2s without changes → idle

export interface TerminalDiff {
  sessionName: string;
  timestamp: number;
  /** Changed line ranges: [lineIndex, content][] */
  lines: Array<[number, string]>;
  /** Full frame width/height (cols x rows) */
  cols: number;
  rows: number;
  /** Per-session monotonic frame counter */
  frameSeq: number;
  /** True when first frame after subscribe or snapshot_request */
  fullFrame: boolean;
  /** True only when fullFrame was triggered by terminal.snapshot_request (not subscribe) */
  snapshotRequested: boolean;
  /** True when screen scrolled up by k lines */
  scrolled: boolean;
  /** Number of new lines at the bottom when scrolled (0 when not scrolled) */
  newLineCount: number;
}

export interface TerminalHistory {
  sessionName: string;
  /** Scrollback lines above visible area, with ANSI codes */
  content: string;
}

export interface StreamSubscriber {
  sessionName: string;
  send: (diff: TerminalDiff) => void;
  sendHistory?: (history: TerminalHistory) => void;
  onError?: (err: Error) => void;
}

// ── TerminalStreamer ───────────────────────────────────────────────────────────

export class TerminalStreamer {
  private subscribers = new Map<string, Set<StreamSubscriber>>();
  private lastFrames = new Map<string, string[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastChangeAt = new Map<string, number>();
  private isIdle = new Map<string, boolean>();
  private errorCounts = new Map<string, number>();
  private sizeCache = new Map<string, { cols: number; rows: number; ts: number }>();
  private frameSeqs = new Map<string, number>();
  private pendingSnapshot = new Set<string>();
  private static readonly SIZE_CACHE_MS = 5_000;

  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  subscribe(subscriber: StreamSubscriber): () => void {
    const { sessionName } = subscriber;
    if (!this.subscribers.has(sessionName)) {
      this.subscribers.set(sessionName, new Set());
      this.startCapture(sessionName);
    }
    this.subscribers.get(sessionName)!.add(subscriber);

    // Send scrollback history snapshot once on subscribe
    if (subscriber.sendHistory) {
      void capturePaneHistory(sessionName, 2000).then((content) => {
        // Trim empty trailing lines from history
        const trimmed = content.replace(/\n+$/, '');
        if (trimmed) {
          try {
            subscriber.sendHistory!({ sessionName, content: trimmed });
          } catch { /* ignore */ }
        }
      }).catch(() => { /* ignore — history is best-effort */ });
    }

    return () => this.unsubscribe(subscriber);
  }

  unsubscribe(subscriber: StreamSubscriber): void {
    const { sessionName } = subscriber;
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;

    subs.delete(subscriber);
    if (subs.size === 0) {
      this.stopCapture(sessionName);
      this.subscribers.delete(sessionName);
      this.lastFrames.delete(sessionName);
      this.lastChangeAt.delete(sessionName);
      this.isIdle.delete(sessionName);
      this.errorCounts.delete(sessionName);
      this.frameSeqs.delete(sessionName);
    }
  }

  /** Wake up the capture loop immediately (e.g. after keyboard input). */
  nudge(sessionName: string): void {
    if (!this.subscribers.has(sessionName)) return;
    this.stopCapture(sessionName);
    this.isIdle.set(sessionName, false);
    this.lastChangeAt.set(sessionName, Date.now());
    this.scheduleNextCapture(sessionName, 50);
  }

  /** Invalidate size cache after a resize event. */
  invalidateSize(sessionName: string): void {
    this.sizeCache.delete(sessionName);
  }

  /** Clear lastFrames cache so next capture produces fullFrame + terminal.snapshot event. */
  requestSnapshot(sessionName: string): void {
    this.lastFrames.delete(sessionName);
    this.pendingSnapshot.add(sessionName);
    // Nudge to produce the frame quickly
    if (this.subscribers.has(sessionName)) {
      this.nudge(sessionName);
    }
  }

  private startCapture(sessionName: string): void {
    // Clear lastFrames so first capture is a fullFrame
    this.lastFrames.delete(sessionName);
    this.lastChangeAt.set(sessionName, Date.now());
    this.isIdle.set(sessionName, false);
    this.errorCounts.set(sessionName, 0);
    this.scheduleNextCapture(sessionName, ACTIVE_INTERVAL_MS);
    logger.debug({ sessionName }, 'Terminal capture started');
  }

  private nextFrameSeq(sessionName: string): number {
    const seq = (this.frameSeqs.get(sessionName) ?? 0) + 1;
    this.frameSeqs.set(sessionName, seq);
    return seq;
  }

  private scheduleNextCapture(sessionName: string, delayMs: number): void {
    const timer = setTimeout(() => {
      void this.captureAndBroadcast(sessionName);
    }, delayMs);
    this.timers.set(sessionName, timer);
  }

  private stopCapture(sessionName: string): void {
    const timer = this.timers.get(sessionName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionName);
    }
    logger.debug({ sessionName }, 'Terminal capture stopped');
  }

  private async captureAndBroadcast(sessionName: string): Promise<void> {
    if (!this.subscribers.has(sessionName)) return;

    let currentLines: string[];
    let cols = 80;
    let rows = 24;
    try {
      // Get size from cache (refreshed every 5s) to avoid extra tmux call each frame
      const cached = this.sizeCache.get(sessionName);
      if (!cached || Date.now() - cached.ts > TerminalStreamer.SIZE_CACHE_MS) {
        const size = await getPaneSize(sessionName);
        this.sizeCache.set(sessionName, { ...size, ts: Date.now() });
        cols = size.cols;
        rows = size.rows;
      } else {
        cols = cached.cols;
        rows = cached.rows;
      }

      // Capture ONLY the visible pane with ANSI colors — no scrollback
      const raw = await capturePaneVisible(sessionName);
      // Split into lines, trim to exact visible rows
      currentLines = raw.split('\n').slice(0, rows);
      // Pad to rows if shorter
      while (currentLines.length < rows) currentLines.push('');
      this.errorCounts.set(sessionName, 0);
    } catch {
      const errors = (this.errorCounts.get(sessionName) ?? 0) + 1;
      this.errorCounts.set(sessionName, errors);
      if (errors >= TerminalStreamer.MAX_CONSECUTIVE_ERRORS) {
        logger.warn({ sessionName, errors }, 'Terminal capture: too many errors, stopping');
        this.stopCapture(sessionName);
        // Notify and remove all subscribers so they know to re-subscribe when ready
        const subs = this.subscribers.get(sessionName);
        if (subs) {
          const err = new Error('Terminal capture failed after too many errors');
          for (const sub of [...subs]) {
            try { sub.onError?.(err); } catch { /* ignore */ }
          }
          this.subscribers.delete(sessionName);
        }
        this.lastFrames.delete(sessionName);
        this.lastChangeAt.delete(sessionName);
        this.isIdle.delete(sessionName);
        this.errorCounts.delete(sessionName);
        this.frameSeqs.delete(sessionName);
      } else {
        this.scheduleNextCapture(sessionName, ACTIVE_INTERVAL_MS * errors);
      }
      return;
    }

    const previousLines = this.lastFrames.get(sessionName) ?? [];
    const isFullFrame = previousLines.length === 0;
    const snapshotRequested = isFullFrame && this.pendingSnapshot.has(sessionName);
    if (snapshotRequested) this.pendingSnapshot.delete(sessionName);

    const diff = isFullFrame
      ? currentLines.map((line, i) => [i, line] as [number, string])
      : computeLineDiff(previousLines, currentLines);

    // Detect scroll: find max k where current[0..rows-k-1] === previous[k..rows-1]
    let scrolled = false;
    let newLineCount = 0;
    if (!isFullFrame && diff.length > 0) {
      const scrollInfo = detectScroll(previousLines, currentLines);
      scrolled = scrollInfo.scrolled;
      newLineCount = scrollInfo.newLineCount;
    }

    // Determine if the diff is a "real" content change (not just cursor blink / ANSI escape changes).
    // Compare stripped content to detect meaningful changes for idle state tracking.
    const hasRealChange = isFullFrame || diff.some(([i, line]) => {
      const prev = previousLines[i] ?? '';
      return stripAnsi(prev).trimEnd() !== stripAnsi(line).trimEnd();
    });

    if (diff.length > 0 || isFullFrame) {
      this.lastFrames.set(sessionName, currentLines);
      // Only reset idle timer for real content changes, not cursor blink
      if (hasRealChange) {
        this.lastChangeAt.set(sessionName, Date.now());
        this.isIdle.set(sessionName, false);
      }

      const payload: TerminalDiff = {
        sessionName,
        timestamp: Date.now(),
        lines: diff,
        cols,
        rows,
        frameSeq: this.nextFrameSeq(sessionName),
        fullFrame: isFullFrame,
        snapshotRequested,
        scrolled,
        newLineCount,
      };

      const subs = this.subscribers.get(sessionName);
      if (subs) {
        for (const sub of subs) {
          try {
            sub.send(payload);
          } catch (err) {
            logger.error({ sessionName, err }, 'Subscriber send failed');
            sub.onError?.(err instanceof Error ? err : new Error(String(err)));
            this.unsubscribe(sub);
          }
        }
      }

      // Emit terminal.snapshot timeline event only when triggered by snapshot_request
      if (isFullFrame && snapshotRequested) {
        timelineEmitter.emit(sessionName, 'terminal.snapshot', {
          lines: currentLines,
          cols,
          rows,
        });
      }

      // Extract assistant.text from terminal changes (streaming + scrolled)
      processTerminalDiff(sessionName, currentLines, rows, scrolled, newLineCount, diff, isFullFrame);
    }

    if (!this.subscribers.has(sessionName)) return;

    const lastChange = this.lastChangeAt.get(sessionName) ?? Date.now();
    const wasIdle = this.isIdle.get(sessionName) ?? false;
    const nowIdle = Date.now() - lastChange > IDLE_THRESHOLD_MS;

    if (nowIdle && !wasIdle) {
      this.isIdle.set(sessionName, true);
      // Fallback idle detection for agents without hooks (Codex, OpenCode).
      // For Claude Code, the hook-server emits idle first and the emitter deduplicates.
      timelineEmitter.emit(sessionName, 'session.state', { state: 'idle' });
    } else if (!nowIdle && wasIdle) {
      this.isIdle.set(sessionName, false);
    }

    const nextInterval = nowIdle ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS;
    this.scheduleNextCapture(sessionName, nextInterval);
  }

  destroy(): void {
    for (const sessionName of this.timers.keys()) {
      this.stopCapture(sessionName);
    }
    this.subscribers.clear();
    this.lastFrames.clear();
    this.lastChangeAt.clear();
    this.isIdle.clear();
    this.frameSeqs.clear();
    this.pendingSnapshot.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const terminalStreamer = new TerminalStreamer();

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeLineDiff(prev: string[], curr: string[]): Array<[number, string]> {
  const maxLen = Math.max(prev.length, curr.length);
  const changed: Array<[number, string]> = [];

  for (let i = 0; i < maxLen; i++) {
    const prevLine = prev[i] ?? '';
    const currLine = curr[i] ?? '';
    if (prevLine !== currLine) {
      changed.push([i, currLine]);
    }
  }

  return changed;
}

/**
 * Deterministic scroll detection.
 * Find max k where current[0..rows-k-1] === previous[k..rows-1].
 * If k > 0: screen scrolled up by k lines, new content is bottom k lines.
 */
export function detectScroll(prev: string[], curr: string[]): { scrolled: boolean; newLineCount: number } {
  const rows = Math.min(prev.length, curr.length);
  if (rows === 0) return { scrolled: false, newLineCount: 0 };

  // Try shift values from largest down to 1 (rows-1 means all but one line scrolled off)
  const maxShift = rows - 1;
  for (let k = maxShift; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < rows - k; i++) {
      if (curr[i] !== prev[i + k]) {
        match = false;
        break;
      }
    }
    if (match) {
      return { scrolled: true, newLineCount: k };
    }
  }

  return { scrolled: false, newLineCount: 0 };
}
