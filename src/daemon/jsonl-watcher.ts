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
import { join, dirname, basename } from 'path';
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
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Parse one JSONL line and emit timeline events.
 * - assistant: emit assistant.text, assistant.thinking, tool.call
 * - user: emit user.message, tool.result
 */
function parseLine(sessionName: string, line: string): void {
  if (!line.trim()) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // Progress events — transient status for status bar display (no message.content)
  if (raw['type'] === 'progress') {
    const data = raw['data'] as Record<string, unknown> | undefined;
    if (!data) return;
    const progressType = String(data['type'] ?? '');
    switch (progressType) {
      case 'bash_progress': {
        const elapsed = data['elapsedTimeSeconds'] as number | undefined;
        timelineEmitter.emit(sessionName, 'agent.status', {
          status: 'bash_running',
          label: `Bash running${elapsed ? ` (${Math.round(elapsed)}s)` : ''}...`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
      case 'agent_progress': {
        const msg = String(data['message'] ?? 'working');
        timelineEmitter.emit(sessionName, 'agent.status', {
          status: 'agent_working',
          label: `Sub-agent: ${msg}`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
      case 'mcp_progress': {
        const toolName = String(data['toolName'] ?? 'tool');
        const server = String(data['serverName'] ?? '');
        const mStatus = String(data['status'] ?? 'started');
        if (mStatus === 'started') {
          timelineEmitter.emit(sessionName, 'agent.status', {
            status: 'mcp_running',
            label: `MCP: ${server ? server + '/' : ''}${toolName}...`,
          }, { source: 'daemon', confidence: 'high' });
        }
        break;
      }
      case 'waiting_for_task': {
        const desc = String(data['taskDescription'] ?? 'task');
        timelineEmitter.emit(sessionName, 'agent.status', {
          status: 'waiting',
          label: `Waiting: ${desc}`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
    }
    return;
  }

  // System events — compact_boundary etc. (no message.content)
  if (raw['type'] === 'system') {
    const subtype = String(raw['subtype'] ?? '');
    if (subtype === 'compact_boundary') {
      timelineEmitter.emit(sessionName, 'agent.status', {
        status: 'compacting',
        label: 'Compacting conversation...',
      }, { source: 'daemon', confidence: 'high' });
    }
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
      } else if (block.type === 'thinking' && block.thinking) {
        timelineEmitter.emit(sessionName, 'assistant.thinking', {
          text: block.thinking,
        }, { source: 'daemon', confidence: 'high' });
      } else if (block.type === 'tool_use' && block.name) {
        const input = extractToolInput(block.name, block.input);
        timelineEmitter.emit(sessionName, 'tool.call', {
          tool: block.name,
          ...(input ? { input } : {}),
        }, { source: 'daemon', confidence: 'high' });
      }
    }
    return;
  }

  if (raw['type'] === 'user') {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text?.trim()) {
        timelineEmitter.emit(sessionName, 'user.message', {
          text: block.text,
        }, { source: 'daemon', confidence: 'high' });
      } else if (block.type === 'tool_result') {
        const error = block.is_error ? String(block.content ?? 'error') : undefined;
        timelineEmitter.emit(sessionName, 'tool.result', {
          ...(error ? { error } : {}),
        }, { source: 'daemon', confidence: 'high' });
      }
    }
  }
}

/** Extract a short summary of tool input for display. */
function extractToolInput(tool: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (tool) {
    case 'Bash': return String(input['command'] ?? '').split('\n').find((l) => l.trim()) ?? '';
    case 'Read': case 'Write': case 'Edit': return String(input['file_path'] ?? '');
    case 'Glob': return String(input['pattern'] ?? '');
    case 'Grep': return `${input['pattern'] ?? ''}${input['path'] ? ` in ${input['path']}` : ''}`;
    case 'Agent': return String(input['description'] ?? '');
    default: return '';
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

/** Which session has claimed each JSONL file path (prevents cross-session stealing). */
const claimedFiles = new Map<string, string>(); // filePath → sessionName

function claimFile(sessionName: string, filePath: string): void {
  // Release any previous file claimed by this session
  for (const [fp, sn] of claimedFiles) {
    if (sn === sessionName) { claimedFiles.delete(fp); break; }
  }
  claimedFiles.set(filePath, sessionName);
}

function releaseFiles(sessionName: string): void {
  for (const [fp, sn] of claimedFiles) {
    if (sn === sessionName) claimedFiles.delete(fp);
  }
}

/** Returns true if filePath is unclaimed or already claimed by sessionName. */
function canClaim(sessionName: string, filePath: string): boolean {
  const owner = claimedFiles.get(filePath);
  return !owner || owner === sessionName;
}

// ── Public API ────────────────────────────────────────────────────────────────

const HISTORY_LINES = 500; // max lines to scan for recent assistant.text history

/**
 * Read the tail of a JSONL file and emit history events (text, thinking, tool.call, tool.result).
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
          } else if (block.type === 'thinking' && block.thinking) {
            timelineEmitter.emit(sessionName, 'assistant.thinking', {
              text: block.thinking,
            }, { source: 'daemon', confidence: 'high' });
            count++;
          } else if (block.type === 'tool_use' && block.name) {
            const input = extractToolInput(block.name, block.input);
            timelineEmitter.emit(sessionName, 'tool.call', {
              tool: block.name, ...(input ? { input } : {}),
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
          } else if (block.type === 'tool_result') {
            const error = block.is_error ? String(block.content ?? 'error') : undefined;
            timelineEmitter.emit(sessionName, 'tool.result', {
              ...(error ? { error } : {}),
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

  // Find the current active JSONL file, emit recent history, then tail from EOF.
  // Only claim an unclaimed file; if the latest is already claimed by another session,
  // start with no active file and wait for a new one to appear.
  const latest = await findLatestJsonl(projectDir);
  if (latest && canClaim(sessionName, latest)) {
    claimFile(sessionName, latest);
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

  // Poll every 2s as a reliable fallback (fs.watch on macOS misses file appends).
  // Uses pollTick (not drainNewLines) so it can re-acquire a file if the claim was stolen.
  state.pollTimer = setInterval(() => {
    void pollTick(sessionName, state);
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
  releaseFiles(sessionName);
}

/**
 * Start watching a specific JSONL file for a session.
 * Polls until the file appears (CC creates it on first conversation), then tails it.
 * Used for CC sub-sessions where the file path is known from --session-id.
 */
export async function startWatchingFile(sessionName: string, filePath: string): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  // Pre-claim the file path immediately — before the file even exists — so that
  // the main session's watchDir cannot steal it when CC creates the file.
  claimFile(sessionName, filePath);

  // Derive projectDir from filePath (parent directory)
  const projectDir = dirname(filePath);
  const state: WatcherState = {
    projectDir,
    activeFile: null,
    fileOffset: 0,
    abort: new AbortController(),
    stopped: false,
  };
  watchers.set(sessionName, state);

  // Poll until the specific file appears (up to 120s — CC needs first conversation)
  let appeared = false;
  for (let i = 0; i < 120 && !state.stopped; i++) {
    try {
      const s = await stat(filePath);
      state.activeFile = filePath;
      state.fileOffset = s.size; // start from end (only new content)
      claimFile(sessionName, filePath);
      appeared = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!appeared || state.stopped) return;

  // Poll every 2s for new content
  state.pollTimer = setInterval(() => {
    void drainNewLines(sessionName, state);
  }, 2000);

  // Also use fs.watch on the specific file for faster updates
  void watchFile(sessionName, state, filePath);
}

async function watchFile(sessionName: string, state: WatcherState, filePath: string): Promise<void> {
  try {
    const watcher = watch(dirname(filePath), { persistent: false, signal: state.abort.signal });
    const fileName = basename(filePath);
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (event.filename !== fileName) continue;
      await drainNewLines(sessionName, state);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.warn({ sessionName, err }, 'jsonl-watcher: file watch error');
    }
  }
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

      // If a new file appeared that is newer than our active file, switch to it.
      // Skip if another session has already claimed it.
      if (changedFile !== state.activeFile) {
        if (!canClaim(sessionName, changedFile)) continue; // claimed by another session
        const isNewer = await checkNewer(changedFile, state.activeFile);
        if (isNewer) {
          logger.debug({ sessionName, file: event.filename }, 'jsonl-watcher: switching to new JSONL file');
          claimFile(sessionName, changedFile);
          state.activeFile = changedFile;
          state.fileOffset = 0;
        } else if (!state.activeFile) {
          claimFile(sessionName, changedFile);
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

/**
 * Poll tick for startWatching — drains new lines and re-acquires a file if activeFile was released.
 * Separate from drainNewLines so startWatchingFile's poll timer stays simple.
 */
async function pollTick(sessionName: string, state: WatcherState): Promise<void> {
  // If active file was stolen by another session, try to find a claimable replacement
  if (!state.activeFile) {
    try {
      const entries = await readdir(state.projectDir);
      const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
      const withStats = await Promise.all(
        jsonls.map(async (f) => {
          const fp = join(state.projectDir, f);
          if (!canClaim(sessionName, fp)) return null;
          try { return { fp, mtime: (await stat(fp)).mtimeMs }; } catch { return null; }
        }),
      );
      const best = withStats
        .filter((x): x is { fp: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (best) {
        claimFile(sessionName, best.fp);
        state.activeFile = best.fp;
        try {
          state.fileOffset = (await stat(best.fp)).size;
          await emitRecentHistory(sessionName, best.fp);
        } catch { state.fileOffset = 0; }
      }
    } catch { /* ignore */ }
  }
  await drainNewLines(sessionName, state);
}

/** Read any new lines from the active JSONL file since the last offset. */
async function drainNewLines(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) return;

  // If another session has claimed our active file, release it so we can re-acquire our own
  if (!canClaim(sessionName, state.activeFile)) {
    state.activeFile = null;
    return;
  }

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
