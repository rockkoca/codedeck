/**
 * Watches Codex JSONL rollout files for structured events.
 *
 * Codex writes per-session rollout files to:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
 *
 * The first line of each file is a "session_meta" record whose payload.cwd
 * identifies the project directory. We match files to codedeck sessions by
 * comparing payload.cwd to the session's workDir.
 *
 * Events emitted:
 *   - user.message   ← event_msg { type: "user_message", message: "..." }
 *   - assistant.text ← event_msg { type: "agent_message", phase: "final_answer", message: "..." }
 *
 * Integration:
 *   - startWatching(sessionName, workDir) when a codex session starts
 *   - stopWatching(sessionName) when it stops
 */

import { watch, readdir, stat, open } from 'fs/promises';
import type { FileChangeInfo } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { timelineEmitter } from './timeline-emitter.js';
import logger from '../util/logger.js';

// ── Path helpers ───────────────────────────────────────────────────────────────

/** Return ~/.codex/sessions/YYYY/MM/DD for a given Date. */
function codexSessionDir(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return join(homedir(), '.codex', 'sessions', String(yyyy), mm, dd);
}

/** Return today's and yesterday's session dirs (for midnight edge case). */
function recentSessionDirs(): string[] {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  return [codexSessionDir(now), codexSessionDir(yesterday)];
}

// ── JSONL matching ─────────────────────────────────────────────────────────────

/**
 * Read the first line of a rollout file and return payload.cwd if it's a
 * session_meta record, otherwise null.
 * Exported for testing.
 */
export async function readCwd(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.allocUnsafe(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    if (bytesRead === 0) return null;

    const firstLine = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    if (!firstLine) return null;

    const raw = JSON.parse(firstLine) as Record<string, unknown>;
    if (raw['type'] !== 'session_meta') return null;

    const payload = raw['payload'] as Record<string, unknown> | undefined;
    return (payload?.['cwd'] as string) ?? null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}

/**
 * Find the most recent rollout-*.jsonl in dir whose session_meta.cwd matches workDir.
 * Returns the file path, or null if none found.
 */
async function findLatestRollout(dir: string, workDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const rollouts = entries.filter((e) => e.startsWith('rollout-') && e.endsWith('.jsonl'));
  if (rollouts.length === 0) return null;

  // Sort newest first by filename (timestamps embedded in name)
  rollouts.sort((a, b) => b.localeCompare(a));

  for (const name of rollouts) {
    const fpath = join(dir, name);
    const cwd = await readCwd(fpath);
    if (cwd && normalizePath(cwd) === normalizePath(workDir)) {
      return fpath;
    }
  }
  return null;
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

// ── JSONL parsing ──────────────────────────────────────────────────────────────

/** Exported for testing. */
export function parseLine(sessionName: string, line: string): void {
  if (!line.trim()) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (raw['type'] !== 'event_msg') return;

  const payload = raw['payload'] as Record<string, unknown> | undefined;
  if (!payload) return;

  const evtType = payload['type'] as string | undefined;

  if (evtType === 'user_message') {
    const text = payload['message'] as string | undefined;
    if (text?.trim()) {
      timelineEmitter.emit(sessionName, 'user.message', { text },
        { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (evtType === 'agent_message' && payload['phase'] === 'final_answer') {
    const text = payload['message'] as string | undefined;
    if (text?.trim()) {
      timelineEmitter.emit(sessionName, 'assistant.text',
        { text, streaming: false },
        { source: 'daemon', confidence: 'high' });
    }
  }
}

// ── History replay ─────────────────────────────────────────────────────────────

const HISTORY_LINES = 200;

async function emitRecentHistory(sessionName: string, filePath: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    if (size === 0) return;

    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, size - readSize);
    if (bytesRead === 0) return;

    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const lines = chunk.split('\n');
    const startIdx = size > readSize ? 1 : 0; // skip possible partial first line

    let count = 0;
    for (let i = startIdx; i < lines.length && count < HISTORY_LINES; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      if (raw['type'] !== 'event_msg') continue;
      const payload = raw['payload'] as Record<string, unknown> | undefined;
      if (!payload) continue;

      const evtType = payload['type'] as string | undefined;

      if (evtType === 'user_message') {
        const text = payload['message'] as string | undefined;
        if (text?.trim()) {
          timelineEmitter.emit(sessionName, 'user.message', { text },
            { source: 'daemon', confidence: 'high' });
          count++;
        }
      } else if (evtType === 'agent_message' && payload['phase'] === 'final_answer') {
        const text = payload['message'] as string | undefined;
        if (text?.trim()) {
          timelineEmitter.emit(sessionName, 'assistant.text',
            { text, streaming: false },
            { source: 'daemon', confidence: 'high' });
          count++;
        }
      }
    }
  } catch {
    // best-effort
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}

// ── Per-session watcher state ──────────────────────────────────────────────────

interface WatcherState {
  workDir: string;
  activeFile: string | null;
  fileOffset: number;
  abort: AbortController;
  stopped: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, WatcherState>();

// ── Public API ─────────────────────────────────────────────────────────────────

export async function startWatching(sessionName: string, workDir: string): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  const state: WatcherState = {
    workDir,
    activeFile: null,
    fileOffset: 0,
    abort: new AbortController(),
    stopped: false,
  };
  watchers.set(sessionName, state);

  // Search recent dirs for existing rollout matching workDir
  for (const dir of recentSessionDirs()) {
    const found = await findLatestRollout(dir, workDir);
    if (found) {
      try {
        const s = await stat(found);
        state.activeFile = found;
        state.fileOffset = s.size;
        await emitRecentHistory(sessionName, found);
      } catch {
        state.activeFile = found;
        state.fileOffset = 0;
      }
      break;
    }
  }

  // Poll every 2s as fallback (fs.watch on macOS misses file appends)
  state.pollTimer = setInterval(() => {
    void drainNewLines(sessionName, state);
  }, 2000);

  // Watch all recent dirs for new/modified rollout files
  for (const dir of recentSessionDirs()) {
    void watchDir(sessionName, state, dir);
  }
}

export function isWatching(sessionName: string): boolean {
  return watchers.has(sessionName);
}

export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  state.stopped = true;
  state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  watchers.delete(sessionName);
}

// ── Internal watcher logic ─────────────────────────────────────────────────────

async function watchDir(sessionName: string, state: WatcherState, dir: string): Promise<void> {
  // Wait for dir to exist (Codex may not have created it yet)
  for (let i = 0; i < 60; i++) {
    if (state.stopped) return;
    try {
      await stat(dir);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (state.stopped) return;

  try {
    const watcher = watch(dir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (typeof event.filename !== 'string') continue;
      if (!event.filename.startsWith('rollout-') || !event.filename.endsWith('.jsonl')) continue;

      const changedFile = join(dir, event.filename);

      if (changedFile !== state.activeFile) {
        // New file — check if it matches our workDir and is newer
        const cwd = await readCwd(changedFile);
        if (!cwd || normalizePath(cwd) !== normalizePath(state.workDir)) continue;

        const isNewer = await checkNewer(changedFile, state.activeFile);
        if (isNewer || !state.activeFile) {
          logger.debug({ sessionName, file: event.filename }, 'codex-watcher: switching to new rollout file');
          state.activeFile = changedFile;
          state.fileOffset = 0;
        } else {
          continue;
        }
      }

      await drainNewLines(sessionName, state);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.warn({ sessionName, dir, err }, 'codex-watcher: dir watch error');
    }
  }
}

async function checkNewer(candidate: string, current: string | null): Promise<boolean> {
  if (!current) return true;
  try {
    const [cs, curS] = await Promise.all([stat(candidate), stat(current)]);
    return cs.mtimeMs > curS.mtimeMs;
  } catch {
    return false;
  }
}

async function drainNewLines(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) return;

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(state.activeFile, 'r');
    const fileStat = await fh.stat();
    if (fileStat.size <= state.fileOffset) return;

    const buf = Buffer.allocUnsafe(fileStat.size - state.fileOffset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, state.fileOffset);
    if (bytesRead === 0) return;

    state.fileOffset += bytesRead;

    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of chunk.split('\n')) {
      if (state.stopped) break;
      parseLine(sessionName, line);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.debug({ sessionName, err }, 'codex-watcher: drain error');
    }
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}
