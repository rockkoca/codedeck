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

/** Return the last 30 days of session dirs (newest first). */
function recentSessionDirs(): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    dirs.push(codexSessionDir(d));
  }
  return dirs;
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
    // The session_meta first line can be very large (includes full conversation context).
    // Read only the first 4KB — enough to find the "cwd" field which appears early.
    // We extract cwd via regex instead of full JSON.parse to avoid truncation issues.
    const buf = Buffer.allocUnsafe(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    if (bytesRead === 0) return null;

    const snippet = buf.subarray(0, bytesRead).toString('utf8');

    // Verify this is a session_meta line
    if (!snippet.includes('"session_meta"')) return null;

    // Extract "cwd":"..." value — cwd paths don't contain quotes or backslashes
    const m = /"cwd"\s*:\s*"([^"]+)"/.exec(snippet);
    return m ? m[1] : null;
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

// Debounce buffers for streaming final_answer events.
// Codex emits a new final_answer snapshot on every token; we only want the last one.
const finalAnswerBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
const FINAL_ANSWER_DEBOUNCE_MS = 600;

function flushFinalAnswer(sessionName: string): void {
  const buf = finalAnswerBuffers.get(sessionName);
  if (!buf) return;
  finalAnswerBuffers.delete(sessionName);
  timelineEmitter.emit(sessionName, 'assistant.text',
    { text: buf.text, streaming: false },
    { source: 'daemon', confidence: 'high' });
}

/** Exported for testing. */
export function parseLine(sessionName: string, line: string, model?: string): void {
  if (!line.trim()) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // Handle Codex function/tool calls: type=response_item, payload.type=function_call|function_call_output
  if (raw['type'] === 'response_item') {
    const pl = raw['payload'] as Record<string, unknown> | undefined;
    if (!pl) return;

    if (pl['type'] === 'function_call') {
      const name = String(pl['name'] ?? 'tool');
      const argsStr = pl['arguments'] as string | undefined;
      let input = argsStr ?? '';
      try {
        const args = JSON.parse(argsStr ?? '{}') as Record<string, unknown>;
        // Surface the most meaningful field as the summary
        const summary = args['cmd'] ?? args['command'] ?? args['path'] ?? args['query'] ?? args['input'];
        if (summary !== undefined) input = String(summary);
      } catch { /* keep raw args */ }
      timelineEmitter.emit(sessionName, 'tool.call', {
        tool: name, ...(input ? { input } : {}),
      }, { source: 'daemon', confidence: 'high' });
    } else if (pl['type'] === 'function_call_output') {
      const errMsg = pl['error'] as string | undefined;
      timelineEmitter.emit(sessionName, 'tool.result',
        { ...(errMsg ? { error: errMsg } : {}) },
        { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (raw['type'] !== 'event_msg') return;

  const payload = raw['payload'] as Record<string, unknown> | undefined;
  if (!payload) return;

  const evtType = payload['type'] as string | undefined;

  if (evtType === 'token_count') {
    const info = payload['info'] as Record<string, unknown> | undefined;
    const last = info?.['last_token_usage'] as Record<string, unknown> | undefined;
    const ctxWin = (info?.['model_context_window'] as number | undefined) ?? 1_000_000;
    if (last && typeof last['input_tokens'] === 'number') {
      timelineEmitter.emit(sessionName, 'usage.update', {
        inputTokens: last['input_tokens'] as number,
        cacheTokens: (last['cached_input_tokens'] as number | undefined) ?? 0,
        contextWindow: ctxWin,
        ...(model ? { model } : {}),
      }, { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (evtType === 'user_message') {
    // Flush any pending assistant text before a new user message
    flushFinalAnswer(sessionName);
    const text = payload['message'] as string | undefined;
    if (text?.trim()) {
      timelineEmitter.emit(sessionName, 'user.message', { text },
        { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (evtType === 'agent_message' && payload['phase'] === 'commentary') {
    // Tool-call interstitial commentary — emit immediately as streaming indicator
    const text = payload['message'] as string | undefined;
    if (!text?.trim()) return;
    timelineEmitter.emit(sessionName, 'assistant.text',
      { text: `_${text}_`, streaming: true },
      { source: 'daemon', confidence: 'high' });
    return;
  }

  if (evtType === 'agent_reasoning') {
    // Model reasoning/thinking — emit as streaming indicator
    const text = payload['message'] as string | undefined;
    if (!text?.trim()) return;
    timelineEmitter.emit(sessionName, 'assistant.text',
      { text: `_${text}_`, streaming: true },
      { source: 'daemon', confidence: 'high' });
    return;
  }

  if (evtType === 'agent_message' && payload['phase'] === 'final_answer') {
    const text = payload['message'] as string | undefined;
    if (!text?.trim()) return;
    // Emit immediately as streaming update, debounce the final non-streaming emit
    timelineEmitter.emit(sessionName, 'assistant.text',
      { text, streaming: true },
      { source: 'daemon', confidence: 'high' });
    // Debounce: buffer the latest snapshot and reset the timer
    const existing = finalAnswerBuffers.get(sessionName);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => flushFinalAnswer(sessionName), FINAL_ANSWER_DEBOUNCE_MS);
    finalAnswerBuffers.set(sessionName, { text, timer });
  }
}

// ── History replay ─────────────────────────────────────────────────────────────

const HISTORY_LINES = 200;

async function emitRecentHistory(sessionName: string, filePath: string, model?: string): Promise<void> {
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

    // Pre-pass: deduplicate streaming final_answer snapshots and find last token_count.
    // bytePos tracks absolute file offset of each source line for stable eventId generation.
    type HistoryEvent =
      | { type: 'user'; text: string; stableId: string }
      | { type: 'assistant'; text: string; stableId: string }
      | { type: 'tool_call'; name: string; input: string; callId: string; stableId: string }
      | { type: 'tool_result'; output: string; callId: string; stableId: string; error?: string };
    const historyEvents: HistoryEvent[] = [];
    let lastTokenPayload: Record<string, unknown> | null = null;
    let bytePos = size - readSize;
    for (let i = 0; i < startIdx; i++) bytePos += Buffer.byteLength(lines[i], 'utf8') + 1;
    for (let i = startIdx; i < lines.length; i++) {
      const lineBytePos = bytePos;
      bytePos += Buffer.byteLength(lines[i], 'utf8') + 1;
      const line = lines[i];
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      // Tool calls (response_item)
      if (raw['type'] === 'response_item') {
        const pl = raw['payload'] as Record<string, unknown> | undefined;
        if (!pl) continue;
        if (pl['type'] === 'function_call') {
          const name = String(pl['name'] ?? 'tool');
          const argsStr = pl['arguments'] as string | undefined;
          let input = argsStr ?? '';
          try {
            const args = JSON.parse(argsStr ?? '{}') as Record<string, unknown>;
            const summary = args['cmd'] ?? args['command'] ?? args['path'] ?? args['query'] ?? args['input'];
            if (summary !== undefined) input = String(summary);
          } catch { /* keep raw */ }
          historyEvents.push({ type: 'tool_call', name, input, callId: String(pl['call_id'] ?? ''), stableId: `cx:${sessionName}:${lineBytePos}:tc` });
        } else if (pl['type'] === 'function_call_output') {
          const output = String(pl['output'] ?? '');
          const errMsg = pl['error'] as string | undefined;
          historyEvents.push({ type: 'tool_result', output: output.length > 400 ? output.slice(0, 400) + '…' : output, callId: String(pl['call_id'] ?? ''), stableId: `cx:${sessionName}:${lineBytePos}:tr`, ...(errMsg ? { error: errMsg } : {}) });
        }
        continue;
      }

      if (raw['type'] !== 'event_msg') continue;
      const payload = raw['payload'] as Record<string, unknown> | undefined;
      if (!payload) continue;
      const evtType = payload['type'] as string | undefined;
      if (evtType === 'user_message') {
        const text = payload['message'] as string | undefined;
        if (text?.trim()) historyEvents.push({ type: 'user', text, stableId: `cx:${sessionName}:${lineBytePos}:um` });
      } else if (evtType === 'agent_message' && payload['phase'] === 'final_answer') {
        const text = payload['message'] as string | undefined;
        if (!text?.trim()) continue;
        const last = historyEvents[historyEvents.length - 1];
        if (last?.type === 'assistant') {
          last.text = text;
          last.stableId = `cx:${sessionName}:${lineBytePos}:at`; // update to last final_answer position
        } else {
          historyEvents.push({ type: 'assistant', text, stableId: `cx:${sessionName}:${lineBytePos}:at` });
        }
      } else if (evtType === 'token_count') {
        const info = payload['info'] as Record<string, unknown> | undefined;
        const last = info?.['last_token_usage'] as Record<string, unknown> | undefined;
        const ctxWin = (info?.['model_context_window'] as number | undefined) ?? 1_000_000;
        if (last && typeof last['input_tokens'] === 'number') {
          lastTokenPayload = {
            inputTokens: last['input_tokens'] as number,
            cacheTokens: (last['cached_input_tokens'] as number | undefined) ?? 0,
            contextWindow: ctxWin,
          };
        }
      }
    }

    // Emit deduplicated history (most recent HISTORY_LINES events)
    // Stable eventIds ensure duplicate re-emissions across daemon restarts are
    // deduplicated by the browser's mergeEvents.
    const slice = historyEvents.slice(-HISTORY_LINES);
    for (const ev of slice) {
      if (ev.type === 'user') {
        timelineEmitter.emit(sessionName, 'user.message', { text: ev.text },
          { source: 'daemon', confidence: 'high', eventId: ev.stableId });
      } else if (ev.type === 'assistant') {
        timelineEmitter.emit(sessionName, 'assistant.text',
          { text: ev.text, streaming: false },
          { source: 'daemon', confidence: 'high', eventId: ev.stableId });
      } else if (ev.type === 'tool_call') {
        timelineEmitter.emit(sessionName, 'tool.call',
          { tool: ev.name, ...(ev.input ? { input: ev.input } : {}) },
          { source: 'daemon', confidence: 'high', eventId: ev.stableId });
      } else if (ev.type === 'tool_result') {
        timelineEmitter.emit(sessionName, 'tool.result',
          { ...(ev.error ? { error: ev.error } : {}) },
          { source: 'daemon', confidence: 'high', eventId: ev.stableId });
      }
    }

    // Emit last usage snapshot so the context bar populates on load
    if (lastTokenPayload) {
      timelineEmitter.emit(sessionName, 'usage.update',
        { ...lastTokenPayload, ...(model ? { model } : {}) },
        { source: 'daemon', confidence: 'high' });
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
  model?: string;
}

const watchers = new Map<string, WatcherState>();

// ── UUID extraction helpers ────────────────────────────────────────────────────

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/**
 * Scan the last 30 days of session dirs for a rollout file whose session_meta.cwd matches
 * workDir and whose mtime is > since. Returns the UUID from the filename, or null if not found.
 * Polls every 1s for up to 60s.
 */
export async function extractNewRolloutUuid(workDir: string, since: number): Promise<string | null> {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const dir of recentSessionDirs()) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      const rollouts = entries.filter((e) => e.startsWith('rollout-') && e.endsWith('.jsonl'));
      for (const filename of rollouts) {
        const uuidMatch = UUID_RE.exec(filename);
        if (!uuidMatch) continue;

        const fpath = join(dir, filename);
        try {
          const s = await stat(fpath);
          if (s.mtimeMs <= since) continue;
        } catch {
          continue;
        }

        const cwd = await readCwd(fpath);
        if (cwd && normalizePath(cwd) === normalizePath(workDir)) {
          return uuidMatch[1];
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return null;
}

/**
 * Find the full path of a rollout file by UUID, scanning the last 30 days.
 * Returns null if not found.
 */
export async function findRolloutPathByUuid(uuid: string): Promise<string | null> {
  for (const dir of recentSessionDirs()) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const filename of entries) {
      if (!filename.startsWith('rollout-') || !filename.endsWith('.jsonl')) continue;
      const uuidMatch = UUID_RE.exec(filename);
      if (uuidMatch && uuidMatch[1] === uuid) {
        return join(dir, filename);
      }
    }
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function startWatching(sessionName: string, workDir: string, model?: string): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  const state: WatcherState = {
    workDir,
    activeFile: null,
    fileOffset: 0,
    abort: new AbortController(),
    stopped: false,
    ...(model ? { model } : {}),
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
        await emitRecentHistory(sessionName, found, state.model);
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

  // Watch all recent dirs for new/modified rollout files.
  // Only start a watcher for dirs that exist (or today's dir which Codex may create soon).
  const todayDir = codexSessionDir(new Date());
  for (const dir of recentSessionDirs()) {
    const isToday = dir === todayDir;
    if (!isToday) {
      // Skip non-existent historical dirs to avoid WARN spam
      try { await stat(dir); } catch { continue; }
    }
    void watchDir(sessionName, state, dir);
  }
}

export function isWatching(sessionName: string): boolean {
  return watchers.has(sessionName);
}

/**
 * Watch a specific rollout file directly (used when UUID is already known).
 * The file is expected to already exist.
 */
export async function startWatchingSpecificFile(sessionName: string, filePath: string, model?: string): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  let fileSize = 0;
  try {
    const s = await stat(filePath);
    fileSize = s.size;
  } catch {
    // file may not exist yet — start from 0
  }

  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  const state: WatcherState = {
    workDir: dir,
    activeFile: filePath,
    fileOffset: fileSize,
    abort: new AbortController(),
    stopped: false,
    ...(model ? { model } : {}),
  };
  watchers.set(sessionName, state);

  await emitRecentHistory(sessionName, filePath, state.model);

  // Poll every 2s as fallback
  state.pollTimer = setInterval(() => {
    void drainNewLines(sessionName, state);
  }, 2000);

  // Watch the parent dir for changes to this specific file
  void watchDir(sessionName, state, dir);
}

export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  state.stopped = true;
  state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  watchers.delete(sessionName);
  // Flush any buffered final_answer on stop
  flushFinalAnswer(sessionName);
  const buf = finalAnswerBuffers.get(sessionName);
  if (buf) { clearTimeout(buf.timer); finalAnswerBuffers.delete(sessionName); }
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
      parseLine(sessionName, line, state.model);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.debug({ sessionName, err }, 'codex-watcher: drain error');
    }
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}
