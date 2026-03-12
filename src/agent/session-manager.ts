import { newSession, killSession, sessionExists, listSessions as tmuxListSessions, sendKeys, sendKey, capturePane, showBuffer, getPaneId, getPaneCwd, cleanupOrphanFifos } from './tmux.js';
import { ClaudeCodeDriver } from './drivers/claude-code.js';
import { CodexDriver } from './drivers/codex.js';
import { OpenCodeDriver } from './drivers/opencode.js';
import { ShellDriver } from './drivers/shell.js';
import type { AgentDriver } from './drivers/base.js';
import type { AgentType } from './detect.js';
import { setupCCStopHook } from './signal.js';
import { setupCodexNotify, setupOpenCodePlugin } from './notify-setup.js';
import {
  getSession,
  upsertSession,
  removeSession,
  listSessions as storeSessions,
  updateSessionState,
  type SessionRecord,
} from '../store/session-store.js';
import logger from '../util/logger.js';
import { timelineEmitter } from '../daemon/timeline-emitter.js';
import { startWatching, startWatchingFile, stopWatching, isWatching, claudeProjectDir } from '../daemon/jsonl-watcher.js';
import { startWatching as startCodexWatching, stopWatching as stopCodexWatching, isWatching as isCodexWatching } from '../daemon/codex-watcher.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Start JSONL watcher for a CC session — uses specific file if ccSessionId known, else directory scan. */
function startCCWatcher(sessionName: string, projectDir: string, ccSessionId?: string): void {
  if (ccSessionId) {
    const jsonlPath = join(claudeProjectDir(projectDir), `${ccSessionId}.jsonl`);
    startWatchingFile(sessionName, jsonlPath).catch((e) =>
      logger.warn({ err: e, session: sessionName }, 'jsonl-watcher startWatchingFile failed'),
    );
  } else {
    startWatching(sessionName, projectDir).catch((e) =>
      logger.warn({ err: e, session: sessionName }, 'jsonl-watcher start failed'),
    );
  }
}

// Restart loop prevention: max 3 restarts within 5 minutes
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;

type SessionEventCallback = (event: 'started' | 'stopped' | 'error', session: string, state: string) => void;
let _onSessionEvent: SessionEventCallback | null = null;

export function setSessionEventCallback(cb: SessionEventCallback): void {
  _onSessionEvent = cb;
}

function emitSessionEvent(event: 'started' | 'stopped' | 'error', session: string, state: string): void {
  try { _onSessionEvent?.(event, session, state); } catch { /* ignore */ }
  timelineEmitter.emit(session, 'session.state', { state: event });
}

/** Called after upsert (record provided) or remove (record=null, name provided). */
type SessionPersistCallback = (record: SessionRecord | null, name: string) => Promise<void>;
let _onSessionPersist: SessionPersistCallback | null = null;

export function setSessionPersistCallback(cb: SessionPersistCallback): void {
  _onSessionPersist = cb;
}

function emitSessionPersist(record: SessionRecord | null, name: string): void {
  _onSessionPersist?.(record, name).catch((e) => logger.warn({ err: e, name }, 'session persist callback failed'));
}

export interface ProjectConfig {
  name: string;
  dir: string;
  brainType: AgentType;
  workerTypes: AgentType[]; // one entry per worker slot
  /** When true, start fresh sessions without resuming last conversation. */
  fresh?: boolean;
}

export function getDriver(type: AgentType): AgentDriver {
  switch (type) {
    case 'claude-code': return new ClaudeCodeDriver();
    case 'codex': return new CodexDriver();
    case 'opencode': return new OpenCodeDriver();
    case 'shell': return new ShellDriver();
  }
}

export function sessionName(project: string, role: 'brain' | `w${number}`): string {
  return `deck_${project}_${role}`;
}

/** Start all sessions for a project (brain + workers). */
export async function startProject(config: ProjectConfig): Promise<void> {
  const { name, dir, brainType, workerTypes, fresh } = config;

  await launchSession({ name: sessionName(name, 'brain'), projectName: name, role: 'brain', agentType: brainType, projectDir: dir, fresh });

  for (let i = 0; i < workerTypes.length; i++) {
    const role = `w${i + 1}` as `w${number}`;
    await launchSession({ name: sessionName(name, role), projectName: name, role, agentType: workerTypes[i], projectDir: dir, fresh });
  }
}

/** Stop all sessions for a project. */
export async function stopProject(projectName: string): Promise<void> {
  const sessions = storeSessions(projectName);
  for (const s of sessions) {
    stopWatching(s.name);
    stopCodexWatching(s.name);
    await killSession(s.name).catch(() => {});
    removeSession(s.name);
    emitSessionPersist(null, s.name);
    emitSessionEvent('stopped', s.name, 'stopped');
  }
}

/** Clean up orphan FIFOs from previous daemon runs and reconcile session store on startup. */
export async function initOnStartup(): Promise<void> {
  await cleanupOrphanFifos();
}

// Pattern for valid codedeck session names: deck_{project}_{brain|wN}
const DECK_SESSION_RE = /^deck_(.+)_(brain|w\d+)$/;

/** Reconcile store with actual tmux on daemon start — restart missing sessions and discover orphans. */
export async function restoreFromStore(): Promise<void> {
  const all = storeSessions();
  const live = await tmuxListSessions();

  // 1. Restart store sessions missing from tmux; start jsonl-watcher for live ones
  for (const s of all) {
    if (s.state === 'stopped') continue;
    if (!live.includes(s.name)) {
      logger.info({ session: s.name }, 'Missing on restore, restarting');
      await restartSession(s);
    } else if (s.agentType === 'claude-code' && s.projectDir && !isWatching(s.name)) {
      startCCWatcher(s.name, s.projectDir, s.ccSessionId);
    } else if (s.agentType === 'codex' && s.projectDir && !isCodexWatching(s.name)) {
      startCodexWatching(s.name, s.projectDir).catch((e) =>
        logger.warn({ err: e, session: s.name }, 'codex-watcher start failed (restore)'),
      );
    }
  }

  // 2. Discover tmux sessions unknown to the store (e.g. created before daemon started)
  const knownNames = new Set(all.map((s) => s.name));
  for (const name of live) {
    if (knownNames.has(name)) continue;
    const match = DECK_SESSION_RE.exec(name);
    if (!match) continue; // not a codedeck session

    const projectName = match[1];
    const role = match[2] as 'brain' | `w${number}`;

    // Infer metadata from tmux pane
    const [projectDir, paneId] = await Promise.all([
      getPaneCwd(name).catch(() => ''),
      getPaneId(name).catch(() => undefined as string | undefined),
    ]);

    const record: SessionRecord = {
      name,
      projectName,
      role,
      agentType: 'claude-code', // default; most common
      projectDir,
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(paneId ? { paneId } : {}),
    };

    upsertSession(record);
    emitSessionPersist(record, name);
    emitSessionEvent('started', name, 'running');
    if (record.agentType === 'claude-code' && projectDir) {
      startCCWatcher(name, projectDir, record.ccSessionId);
    } else if (record.agentType === 'codex' && projectDir) {
      startCodexWatching(name, projectDir).catch((e) =>
        logger.warn({ err: e, session: name }, 'codex-watcher start failed (restore)'),
      );
    }
    logger.info({ session: name, projectDir }, 'Discovered unregistered tmux session, registered');
  }
}

/**
 * Auto-restart a crashed session.
 * Enforces max 3 restarts within 5 minutes; marks as error if exceeded.
 */
export async function restartSession(record: SessionRecord): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = record.restartTimestamps.filter((t) => t > windowStart);

  if (recentRestarts.length >= MAX_RESTARTS) {
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error');
    emitSessionEvent('error', record.name, 'error');
    return false;
  }

  const updated: SessionRecord = {
    ...record,
    restarts: record.restarts + 1,
    restartTimestamps: [...recentRestarts, now],
    state: 'running',
    updatedAt: now,
  };
  upsertSession(updated);

  await launchSession({
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: record.agentType as AgentType,
    projectDir: record.projectDir,
    skipStore: true,
    ccSessionId: record.ccSessionId,
  });

  return true;
}

interface LaunchOpts {
  name: string;
  projectName: string;
  role: 'brain' | `w${number}`;
  agentType: AgentType;
  projectDir: string;
  skipStore?: boolean;
  extraEnv?: Record<string, string>;
  /** When true, start fresh without resuming last conversation. */
  fresh?: boolean;
  /** CC session UUID for --session-id / --resume. Generated if absent for CC sessions. */
  ccSessionId?: string;
}

export async function launchSession(opts: LaunchOpts): Promise<void> {
  const { name, projectName, role, agentType, projectDir, skipStore, extraEnv, fresh } = opts;
  const driver = getDriver(agentType);

  // Configure agent-specific hooks/signals
  if (agentType === 'claude-code') {
    await setupCCStopHook().catch((e) => logger.warn({ err: e }, 'CC hook setup failed'));
  } else if (agentType === 'codex') {
    await setupCodexNotify(projectDir, name).catch((e) => logger.warn({ err: e }, 'Codex notify setup failed'));
  } else if (agentType === 'opencode') {
    const oc = driver as OpenCodeDriver;
    await oc.ensurePermissions(projectDir).catch((e) => logger.warn({ err: e }, 'OpenCode permissions failed'));
    await setupOpenCodePlugin(projectDir, name).catch((e) => logger.warn({ err: e }, 'OpenCode plugin setup failed'));
  }

  const exists = await sessionExists(name);

  // For CC sessions: resolve ccSessionId only when actually launching a new tmux session.
  // If the session already exists in tmux, use the stored UUID (if any) but don't generate
  // a fresh one — that would point startWatchingFile at a non-existent file.
  let ccSessionId = opts.ccSessionId;
  if (agentType === 'claude-code') {
    const stored = getSession(name)?.ccSessionId;
    if (stored) {
      ccSessionId = stored;
    } else if (!exists) {
      // Launching fresh — generate UUID now so JSONL path is deterministic
      ccSessionId = ccSessionId ?? randomUUID();
    }
    // If exists and no stored UUID: ccSessionId stays undefined → fall back to dir scan
  }

  if (!exists) {
    const launchCmd = driver.buildLaunchCommand(name, { cwd: projectDir, fresh, ccSessionId });
    await newSession(name, launchCmd, { cwd: projectDir, env: extraEnv });
    logger.info({ session: name, agentType, ccSessionId }, 'Launched session');
  }

  // Always record paneId — it changes on each session creation/restart
  const paneId = await getPaneId(name).catch(() => undefined);
  if (paneId) {
    const existing = getSession(name);
    if (existing) {
      upsertSession({ ...existing, paneId });
    }
  }

  if (!skipStore) {
    const existing = getSession(name);
    const record: SessionRecord = {
      name,
      projectName,
      role,
      agentType,
      projectDir,
      state: 'running',
      restarts: existing?.restarts ?? 0,
      restartTimestamps: existing?.restartTimestamps ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      paneId,
      ...(ccSessionId ? { ccSessionId } : {}),
    };
    upsertSession(record);
    emitSessionPersist(record, name);
  }

  emitSessionEvent('started', name, 'running');

  // Start structured-event watchers for supported agent types
  if (agentType === 'claude-code') {
    startCCWatcher(name, projectDir, ccSessionId);
  } else if (agentType === 'codex') {
    startCodexWatching(name, projectDir).catch((e) =>
      logger.warn({ err: e, session: name }, 'codex-watcher start failed'),
    );
  }

  // Auto-dismiss startup prompts (trust folder, settings errors, update dialogs)
  if (driver.postLaunch) {
    driver.postLaunch(
      () => capturePane(name),
      (key) => sendKey(name, key),
    ).catch((e) => logger.warn({ err: e, session: name }, 'postLaunch failed'));
  }
}

/** Bound ops for a session (used by status poller / response collector). */
export function getSessionOps(name: string) {
  return {
    capturePane: () => capturePane(name),
    sendKeys: (keys: string) => sendKeys(name, keys),
    showBuffer: () => showBuffer(),
  };
}

export interface AutoFixProjectConfig {
  projectName: string;
  projectDir: string;
  coderType: AgentType;
  auditorType: AgentType;
  /** Feature branch already checked out in projectDir. */
  featureBranch: string;
}

/**
 * Start sessions for auto-fix mode:
 * - w1 (coder) session: launched in projectDir (feature branch already checked out)
 * - brain session: launched with audit-enhanced system prompt env var so the brain dispatcher
 *   can call registerAutoFixExtensions() on startup
 */
export async function startAutoFixProject(config: AutoFixProjectConfig): Promise<{
  coderSession: string;
  auditorSession: string;
}> {
  const { projectName, projectDir, coderType, auditorType, featureBranch } = config;

  const coderSession = sessionName(projectName, 'w1');
  const auditorSession = sessionName(projectName, 'brain');

  // Worker (coder) session — regular launch in feature branch dir
  await launchSession({
    name: coderSession,
    projectName,
    role: 'w1',
    agentType: coderType,
    projectDir,
  });

  // Brain (auditor) session — set RCC_AUTOFIX_MODE=1 so brain dispatcher enables audit commands
  await launchSession({
    name: auditorSession,
    projectName,
    role: 'brain',
    agentType: auditorType,
    projectDir,
    extraEnv: { RCC_AUTOFIX_MODE: '1', RCC_AUTOFIX_BRANCH: featureBranch },
  });

  logger.info({ projectName, coderSession, auditorSession, featureBranch }, 'Auto-fix sessions started');

  return { coderSession, auditorSession };
}

