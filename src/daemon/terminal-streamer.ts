/**
 * Capture tmux pane at ~10 FPS, compute line-level diffs, stream to WebSocket.
 * Used by the web terminal viewer for real-time session display.
 */
import { capturePane } from '../agent/tmux.js';
import logger from '../util/logger.js';

const CAPTURE_INTERVAL_MS = 100; // 10 FPS

export interface TerminalDiff {
  sessionName: string;
  timestamp: number;
  /** Changed line ranges: [lineIndex, content][] */
  lines: Array<[number, string]>;
  /** Full frame width/height (cols x rows) */
  cols: number;
  rows: number;
}

export interface StreamSubscriber {
  sessionName: string;
  send: (diff: TerminalDiff) => void;
  onError?: (err: Error) => void;
}

// ── TerminalStreamer ───────────────────────────────────────────────────────────

export class TerminalStreamer {
  private subscribers = new Map<string, Set<StreamSubscriber>>();
  private lastFrames = new Map<string, string[]>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  subscribe(subscriber: StreamSubscriber): () => void {
    const { sessionName } = subscriber;
    if (!this.subscribers.has(sessionName)) {
      this.subscribers.set(sessionName, new Set());
      this.startCapture(sessionName);
    }
    this.subscribers.get(sessionName)!.add(subscriber);

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
    }
  }

  private startCapture(sessionName: string): void {
    const timer = setInterval(() => {
      void this.captureAndBroadcast(sessionName);
    }, CAPTURE_INTERVAL_MS);
    this.timers.set(sessionName, timer);
    logger.debug({ sessionName }, 'Terminal capture started');
  }

  private stopCapture(sessionName: string): void {
    const timer = this.timers.get(sessionName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(sessionName);
    }
    logger.debug({ sessionName }, 'Terminal capture stopped');
  }

  private async captureAndBroadcast(sessionName: string): Promise<void> {
    let frame: string;
    try {
      frame = await capturePane(sessionName);
    } catch {
      // Session may have ended — stop capturing
      this.stopCapture(sessionName);
      return;
    }

    const currentLines = frame.split('\n');
    const previousLines = this.lastFrames.get(sessionName) ?? [];

    const diff = computeLineDiff(previousLines, currentLines);
    if (diff.length === 0) return; // No change

    this.lastFrames.set(sessionName, currentLines);

    const payload: TerminalDiff = {
      sessionName,
      timestamp: Date.now(),
      lines: diff,
      cols: Math.max(...currentLines.map((l) => l.length), 80),
      rows: currentLines.length,
    };

    const subs = this.subscribers.get(sessionName);
    if (!subs) return;

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

  destroy(): void {
    for (const sessionName of this.timers.keys()) {
      this.stopCapture(sessionName);
    }
    this.subscribers.clear();
    this.lastFrames.clear();
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
