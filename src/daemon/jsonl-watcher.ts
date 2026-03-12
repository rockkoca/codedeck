/**
 * Watches Claude Code JSONL transcript files for structured events.
 *
 * Claude Code writes every conversation turn to:
 *   ~/.claude/projects/{projectKey}/{sessionId}.jsonl
 *
 * Each line is a JSON object with type "assistant", "user", "result", or "system".
 * This watcher tails the active JSONL file and emits structured timeline events —
 * far more reliable than parsing raw PTY terminal output.
 *
 * Integration:
 *   - startWatching(sessionName, projectDir) when a claude-code session starts
 *   - stopWatching(sessionName) when it stops
 */

import { watch, readdir, stat, open } from 'fs/promises';
import type { FileChangeInfo } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { timelineEmitter } from './timeline-emitter.js';
import logger from '../util/logger.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Compute Claude Code project key: replace path separators with '-'. */
function claudeProjectKey(absPath: string): string {
  return absPath.replace(/\/+$/, '').replace(/[/\\]/g, '-');
}

/** Return the ~/.claude/projects/{key} directory for a given work dir. */
export function claudeProjectDir(workDir: string): string {
  const key = claudeProjectKey(workDir);
  return join(homedir(), '.claude', 'projects', key);
}

/** Find the most recently modified .jsonl file in a directory. */
async function findLatestJsonl(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;

  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      try {
        const s = await stat(join(dir, f));
        return { f, mtime: s.mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return join(dir, withStats[0].f);
}

// ── JSONL parsing ─────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Parse one JSONL line and emit timeline events.
 * - assistant: emit assistant.text (tool.call/result come from hooks, no duplication needed)
 * - user: emit user.message so tmux-direct input appears in chat timeline
 */
function parseLine(sessionName: string, line: string): void {
  if (!line.trim()) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const msg = raw['message'] as Record<string, unknown> | undefined;
  if (!msg) return;
  const content = msg['content'];
  if (!Array.isArray(content)) return;

  if (raw['type'] === 'assistant') {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: block.text,
          streaming: false,
        }, { source: 'daemon', confidence: 'high' });
      }
    }
    return;
  }

  if (raw['type'] === 'user') {
    for (const block of content as ContentBlock[]) {
      // Only plain text blocks — skip tool_result / image blocks
      if (block.type === 'text' && block.text?.trim()) {
        timelineEmitter.emit(sessionName, 'user.message', {
          text: block.text,
        }, { source: 'daemon', confidence: 'high' });
      }
    }
  }
}

// ── Per-session watcher state ─────────────────────────────────────────────────

interface WatcherState {
  projectDir: string;
  activeFile: string | null;
  fileOffset: number; // byte offset — only read lines written after watch start
  abort: AbortController;
  stopped: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, WatcherState>();

// ── Public API ────────────────────────────────────────────────────────────────

const HISTORY_LINES = 500; // max lines to scan for recent assistant.text history

/**
 * Read the tail of a JSONL file and emit only assistant.text events.
 * Hooks already provide tool.call/tool.result — we only backfill the text.
 */
async function emitRecentHistory(sessionName: string, filePath: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    if (size === 0) return;

    // Read up to 256KB from the end of the file to cover recent history
    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, size - readSize);
    if (bytesRead === 0) return;

    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    // Drop the first (possibly partial) line when reading mid-file
    const lines = chunk.split('\n');
    const startIdx = size > readSize ? 1 : 0; // skip partial first line

    let count = 0;
    for (let i = startIdx; i < lines.length && count < HISTORY_LINES; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const msg = raw['message'] as Record<string, unknown> | undefined;
      const content = msg?.['content'];
      if (!Array.isArray(content)) continue;

      if (raw['type'] === 'assistant') {
        for (const block of content as ContentBlock[]) {
          if (block.type === 'text' && block.text) {
            timelineEmitter.emit(sessionName, 'assistant.text', {
              text: block.text, streaming: false,
            }, { source: 'daemon', confidence: 'high' });
            count++;
          }
        }
      } else if (raw['type'] === 'user') {
        for (const block of content as ContentBlock[]) {
          if (block.type === 'text' && block.text?.trim()) {
            timelineEmitter.emit(sessionName, 'user.message', {
              text: block.text,
            }, { source: 'daemon', confidence: 'high' });
            count++;
          }
        }
      }
    }
  } catch {
    // best-effort
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}

/**
 * Start watching Claude Code's JSONL transcript for a session.
 * Only new lines written after this call are emitted — no history replay.
 *
 * @param sessionName  tmux session name (e.g. "deck_myapp_brain")
 * @param workDir      absolute path to the project working directory
 */
export async function startWatching(sessionName: string, workDir: string): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  const projectDir = claudeProjectDir(workDir);
  const state: WatcherState = {
    projectDir,
    activeFile: null,
    fileOffset: 0,
    abort: new AbortController(),
    stopped: false,
  };
  watchers.set(sessionName, state);

  // Find the current active JSONL file, emit recent history, then tail from EOF
  const latest = await findLatestJsonl(projectDir);
  if (latest) {
    try {
      const s = await stat(latest);
      state.activeFile = latest;
      state.fileOffset = s.size;
      // Emit recent assistant.text events from history so chat view populates immediately
      await emitRecentHistory(sessionName, latest);
    } catch {
      state.activeFile = latest;
      state.fileOffset = 0;
    }
  }

  // Poll every 2s as a reliable fallback (fs.watch on macOS misses file appends)
  state.pollTimer = setInterval(() => {
    void drainNewLines(sessionName, state);
  }, 2000);

  // Watch the project directory for new/modified JSONL files (best-effort, faster than poll)
  void watchDir(sessionName, state);
}

/** Returns true if a JSONL watcher is active for this session. */
export function isWatching(sessionName: string): boolean {
  return watchers.has(sessionName);
}

/** Stop watching and release all file handles for a session. */
export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  state.stopped = true;
  state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  watchers.delete(sessionName);
}

// ── Internal watcher logic ────────────────────────────────────────────────────

async function watchDir(sessionName: string, state: WatcherState): Promise<void> {
  // Ensure the directory exists (Claude Code may not have created it yet)
  try {
    await stat(state.projectDir);
  } catch {
    // Dir doesn't exist yet — poll until it appears, up to 60s
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (state.stopped) return;
      try {
        await stat(state.projectDir);
        break;
      } catch {
        // keep waiting
      }
    }
    if (state.stopped) return;
  }

  try {
    const watcher = watch(state.projectDir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (typeof event.filename !== 'string' || !event.filename.endsWith('.jsonl')) continue;

      const changedFile = join(state.projectDir, event.filename);

      // If a new file appeared that is newer than our active file, switch to it
      if (changedFile !== state.activeFile) {
        const isNewer = await checkNewer(changedFile, state.activeFile);
        if (isNewer) {
          logger.debug({ sessionName, file: event.filename }, 'jsonl-watcher: switching to new JSONL file');
          state.activeFile = changedFile;
          state.fileOffset = 0;
        } else if (!state.activeFile) {
          state.activeFile = changedFile;
          state.fileOffset = 0;
        } else {
          continue; // older file, ignore
        }
      }

      await drainNewLines(sessionName, state);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.warn({ sessionName, err }, 'jsonl-watcher: dir watch error');
    }
  }
}

/** Returns true if candidate is newer than current (or current is null). */
async function checkNewer(candidate: string, current: string | null): Promise<boolean> {
  if (!current) return true;
  try {
    const [cs, curS] = await Promise.all([stat(candidate), stat(current)]);
    return cs.mtimeMs > curS.mtimeMs;
  } catch {
    return false;
  }
}

/** Read any new lines from the active JSONL file since the last offset. */
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
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (state.stopped) break;
      parseLine(sessionName, line);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.debug({ sessionName, err }, 'jsonl-watcher: drain error');
    }
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}
