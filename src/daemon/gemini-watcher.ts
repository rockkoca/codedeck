/**
 * Watches Gemini CLI conversation JSON files for structured events.
 *
 * Gemini writes per-session JSON files (overwritten, not appended) to:
 *   ~/.gemini/tmp/<project-slug>/chats/session-<YYYY-MM-DD>T<HH>-<MM>-<uuid[:8]>.json
 *
 * Message types:
 *   - "user"   → content: [{ text }]           → user.message
 *   - "gemini" → content: string                → assistant.text
 *               thoughts: [{ description }]     → assistant.thinking
 *               toolCalls: [{ name, args }]      → tool.call + tool.result
 *
 * Because the file is overwritten on each update (not appended), we track
 * the seen message count and only process newly appended messages.
 */

import { watch, readdir, stat } from 'fs/promises';
import type { FileChangeInfo } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { timelineEmitter } from './timeline-emitter.js';
import logger from '../util/logger.js';

// ── Path helpers ───────────────────────────────────────────────────────────────

const GEMINI_TMP_DIR = join(homedir(), '.gemini', 'tmp');

/**
 * Find the conversation JSON file for a given session UUID.
 * Filename format: session-<timestamp>-<uuid[:8]>.json
 * Scans all project-slug subdirectories under ~/.gemini/tmp/.
 */
async function findSessionFile(sessionUuid: string): Promise<string | null> {
  const prefix = sessionUuid.slice(0, 8);
  let slugs: string[];
  try {
    slugs = await readdir(GEMINI_TMP_DIR);
  } catch {
    return null;
  }

  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try {
      entries = await readdir(chatsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith(`-${prefix}.json`)) {
        return join(chatsDir, entry);
      }
    }
  }
  return null;
}

/**
 * Find the most recently modified Gemini session file across all project slugs.
 * Used when no UUID is known (e.g. sub-sessions launched with `--resume latest`).
 * Excludes files already claimed by other watchers.
 */
async function findLatestSessionFile(excludeClaimed = true): Promise<string | null> {
  let slugs: string[];
  try {
    slugs = await readdir(GEMINI_TMP_DIR);
  } catch {
    return null;
  }

  let bestPath: string | null = null;
  let bestMtime = 0;

  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try {
      entries = await readdir(chatsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue;
      const fullPath = join(chatsDir, entry);
      if (excludeClaimed && claimedFiles.has(fullPath)) continue;
      try {
        const s = await stat(fullPath);
        if (s.mtimeMs > bestMtime) {
          bestMtime = s.mtimeMs;
          bestPath = fullPath;
        }
      } catch {
        // ignore
      }
    }
  }
  return bestPath;
}

/**
 * Snapshot all existing Gemini session files.
 * Used before launching a new session so the watcher can detect which file is NEW.
 */
export async function snapshotSessionFiles(): Promise<Set<string>> {
  const files = new Set<string>();
  let slugs: string[];
  try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return files; }
  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try { entries = await readdir(chatsDir); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith('.json')) {
        files.add(join(chatsDir, entry));
      }
    }
  }
  return files;
}

// ── Message parsing ────────────────────────────────────────────────────────────

interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiToolCallResult {
  functionResponse?: {
    response?: { output?: string };
  };
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: GeminiToolCallResult[];
  status?: 'success' | 'error';
  resultDisplay?: string;
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini' | 'info' | 'error' | 'warning';
  content: string | Array<{ text?: string }>;
  thoughts?: GeminiThought[];
  toolCalls?: GeminiToolCall[];
}

interface GeminiConversation {
  sessionId: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

function parseMessage(sessionName: string, msg: GeminiMessage): void {
  if (msg.type === 'user') {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.text?.trim()) {
        timelineEmitter.emit(sessionName, 'user.message',
          { text: block.text },
          { source: 'daemon', confidence: 'high' });
      }
    }
    return;
  }

  if (msg.type === 'gemini') {
    // Emit thinking blocks first
    if (msg.thoughts) {
      for (const t of msg.thoughts) {
        const text = t.description ?? t.subject;
        if (text?.trim()) {
          timelineEmitter.emit(sessionName, 'assistant.thinking',
            { text },
            { source: 'daemon', confidence: 'high' });
        }
      }
    }

    // Emit tool calls
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!tc.name) continue;

        // Extract a short input summary
        const input = extractToolInput(tc.name, tc.args);
        timelineEmitter.emit(sessionName, 'tool.call',
          { tool: tc.name, ...(input ? { input } : {}) },
          { source: 'daemon', confidence: 'high' });

        // Emit tool result
        const isError = tc.status === 'error';
        const output = tc.result?.[0]?.functionResponse?.response?.output;
        timelineEmitter.emit(sessionName, 'tool.result',
          { ...(isError ? { error: output ?? 'error' } : {}) },
          { source: 'daemon', confidence: 'high' });
      }
    }

    // Emit assistant text (final response string)
    if (typeof msg.content === 'string' && msg.content.trim()) {
      timelineEmitter.emit(sessionName, 'assistant.text',
        { text: msg.content, streaming: false },
        { source: 'daemon', confidence: 'high' });
    }
  }
}

function extractToolInput(name: string, args?: Record<string, unknown>): string {
  if (!args) return '';
  // Common Gemini built-in tools
  switch (name) {
    case 'read_file': return String(args['path'] ?? args['file_path'] ?? '');
    case 'write_file': return String(args['path'] ?? args['file_path'] ?? '');
    case 'run_shell_command': return String(args['command'] ?? '').split('\n')[0] ?? '';
    case 'search_files': return String(args['pattern'] ?? args['query'] ?? '');
    case 'list_directory': return String(args['path'] ?? '');
    default: {
      // Try common keys
      const val = args['command'] ?? args['path'] ?? args['query'] ?? args['objective'] ?? '';
      return String(val).split('\n')[0] ?? '';
    }
  }
}

// ── Per-session watcher state ──────────────────────────────────────────────────

interface WatcherState {
  sessionUuid: string;
  activeFile: string | null;
  seenCount: number;      // number of messages already emitted
  lastUpdated: string;    // ISO string of last processed lastUpdated field
  abort: AbortController;
  stopped: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, WatcherState>();
/** Files already claimed by a watcher — prevents two watchers from tracking the same file */
const claimedFiles = new Set<string>();

// ── Core poll logic ────────────────────────────────────────────────────────────

async function readConversation(filePath: string): Promise<GeminiConversation | null> {
  try {
    const { readFile } = await import('fs/promises');
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as GeminiConversation;
  } catch {
    return null;
  }
}

async function pollTick(sessionName: string, state: WatcherState): Promise<void> {
  // Try to find the file if we don't have it yet
  if (!state.activeFile) {
    const found = state.sessionUuid
      ? await findSessionFile(state.sessionUuid)
      : await findLatestSessionFile();
    if (found) {
      state.activeFile = found;
      claimedFiles.add(found);
      logger.debug({ sessionName, file: found }, 'gemini-watcher: found session file');
    } else {
      return;
    }
  }

  const conv = await readConversation(state.activeFile);
  if (!conv) return;

  // No new messages
  if (conv.messages.length <= state.seenCount) return;
  // No change in lastUpdated for same count (shouldn't happen but be safe)
  if (conv.lastUpdated === state.lastUpdated && conv.messages.length === state.seenCount) return;

  const newMessages = conv.messages.slice(state.seenCount);
  state.seenCount = conv.messages.length;
  state.lastUpdated = conv.lastUpdated;

  for (const msg of newMessages) {
    if (state.stopped) break;
    parseMessage(sessionName, msg);
  }
}

// ── History replay ─────────────────────────────────────────────────────────────

async function emitRecentHistory(sessionName: string, filePath: string): Promise<void> {
  const conv = await readConversation(filePath);
  if (!conv) return;

  const HISTORY_MAX = 100;
  const slice = conv.messages.slice(-HISTORY_MAX);
  for (const msg of slice) {
    parseMessage(sessionName, msg);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start watching a Gemini session by UUID.
 * Polls for the session file to appear, then tails new messages.
 */
export async function startWatching(sessionName: string, sessionUuid: string): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  const state: WatcherState = {
    sessionUuid,
    activeFile: null,
    seenCount: 0,
    lastUpdated: '',
    abort: new AbortController(),
    stopped: false,
  };
  watchers.set(sessionName, state);

  // Try to find the file immediately
  const found = await findSessionFile(sessionUuid);
  if (found) {
    state.activeFile = found;
    claimedFiles.add(found);
    const conv = await readConversation(found);
    if (conv) {
      // Start from end so we only emit new messages going forward
      state.seenCount = conv.messages.length;
      state.lastUpdated = conv.lastUpdated;
      await emitRecentHistory(sessionName, found);
    }
  }

  // Poll every 2s as reliable fallback
  state.pollTimer = setInterval(() => {
    void pollTick(sessionName, state);
  }, 2000);

  // Also watch the gemini tmp dir for faster notification
  void watchGeminiDir(sessionName, state);
}

/**
 * Start watching for the most recently modified Gemini session file.
 * Used for sub-sessions launched without a pre-known UUID (e.g. `--resume latest`).
 */
export async function startWatchingLatest(sessionName: string): Promise<void> {
  return startWatching(sessionName, '');
}

/**
 * Start watching for a NEW Gemini session file that wasn't in the pre-launch snapshot.
 * Used when resolveSessionId() failed and we launched fresh — detects the file by diffing
 * against the snapshot taken before launch.
 *
 * @param onDiscovered  Called with (sessionId, filePath) when the new file is found.
 *                      Callers can persist the sessionId for future daemon restarts.
 */
export async function startWatchingNew(
  sessionName: string,
  existingFiles: Set<string>,
  onDiscovered?: (sessionId: string, filePath: string) => void,
): Promise<void> {
  if (watchers.has(sessionName)) {
    stopWatching(sessionName);
  }

  const state: WatcherState = {
    sessionUuid: '',
    activeFile: null,
    seenCount: 0,
    lastUpdated: '',
    abort: new AbortController(),
    stopped: false,
  };
  watchers.set(sessionName, state);

  // Poll for a new file that wasn't in the snapshot
  const findNewFile = async (): Promise<string | null> => {
    let slugs: string[];
    try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return null; }
    let bestPath: string | null = null;
    let bestMtime = 0;
    for (const slug of slugs) {
      const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
      let entries: string[];
      try { entries = await readdir(chatsDir); } catch { continue; }
      for (const entry of entries) {
        if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue;
        const fullPath = join(chatsDir, entry);
        if (existingFiles.has(fullPath)) continue; // existed before launch
        if (claimedFiles.has(fullPath)) continue;  // claimed by another watcher
        try {
          const s = await stat(fullPath);
          if (s.mtimeMs > bestMtime) {
            bestMtime = s.mtimeMs;
            bestPath = fullPath;
          }
        } catch { /* ignore */ }
      }
    }
    return bestPath;
  };

  // Try to find the new file (may take a few seconds for Gemini to create it)
  for (let i = 0; i < 60 && !state.stopped; i++) {
    const found = await findNewFile();
    if (found) {
      state.activeFile = found;
      claimedFiles.add(found);
      logger.info({ sessionName, file: found }, 'gemini-watcher: found new session file via snapshot diff');

      // Read sessionId from JSON and notify caller
      const conv = await readConversation(found);
      if (conv) {
        state.seenCount = conv.messages.length;
        state.lastUpdated = conv.lastUpdated;
        await emitRecentHistory(sessionName, found);
        if (conv.sessionId && onDiscovered) {
          onDiscovered(conv.sessionId, found);
        }
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Start polling
  state.pollTimer = setInterval(() => {
    void pollTick(sessionName, state);
  }, 2000);

  if (state.activeFile) {
    void watchGeminiDir(sessionName, state);
  }
}

export function isWatching(sessionName: string): boolean {
  return watchers.has(sessionName);
}

export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  if (state.activeFile) claimedFiles.delete(state.activeFile);
  state.stopped = true;
  state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  watchers.delete(sessionName);
}

// ── fs.watch for faster updates ────────────────────────────────────────────────

async function watchGeminiDir(sessionName: string, state: WatcherState): Promise<void> {
  // Watch ~/.gemini/tmp for new slug directories / file changes
  // When activeFile is known, watch its parent dir directly
  const waitForFile = async (): Promise<string | null> => {
    for (let i = 0; i < 60 && !state.stopped; i++) {
      const found = state.sessionUuid
        ? await findSessionFile(state.sessionUuid)
        : await findLatestSessionFile();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  };

  if (!state.activeFile) {
    const found = await waitForFile();
    if (!found || state.stopped) return;
    state.activeFile = found;
  }

  const dir = state.activeFile.substring(0, state.activeFile.lastIndexOf('/'));
  const filename = state.activeFile.substring(state.activeFile.lastIndexOf('/') + 1);

  try {
    const watcher = watch(dir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (event.filename !== filename) continue;
      await pollTick(sessionName, state);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.debug({ sessionName, err }, 'gemini-watcher: dir watch error');
    }
  }
}
