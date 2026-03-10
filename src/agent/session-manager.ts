import { newSession, killSession, sessionExists, listSessions as tmuxListSessions, sendKeys, sendKey, capturePane, showBuffer } from './tmux.js';
import { ClaudeCodeDriver } from './drivers/claude-code.js';
import { CodexDriver } from './drivers/codex.js';
import { OpenCodeDriver } from './drivers/opencode.js';
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
}

export interface ProjectConfig {
  name: string;
  dir: string;
  brainType: AgentType;
  workerTypes: AgentType[]; // one entry per worker slot
}

export function getDriver(type: AgentType): AgentDriver {
  switch (type) {
    case 'claude-code': return new ClaudeCodeDriver();
    case 'codex': return new CodexDriver();
    case 'opencode': return new OpenCodeDriver();
  }
}

export function sessionName(project: string, role: 'brain' | `w${number}`): string {
  return `deck_${project}_${role}`;
}

/** Start all sessions for a project (brain + workers). */
export async function startProject(config: ProjectConfig): Promise<void> {
  const { name, dir, brainType, workerTypes } = config;

  await launchSession({ name: sessionName(name, 'brain'), projectName: name, role: 'brain', agentType: brainType, projectDir: dir });

  for (let i = 0; i < workerTypes.length; i++) {
    const role = `w${i + 1}` as `w${number}`;
    await launchSession({ name: sessionName(name, role), projectName: name, role, agentType: workerTypes[i], projectDir: dir });
  }
}

/** Stop all sessions for a project. */
export async function stopProject(projectName: string): Promise<void> {
  const sessions = storeSessions(projectName);
  for (const s of sessions) {
    await killSession(s.name).catch(() => {});
    removeSession(s.name);
    emitSessionEvent('stopped', s.name, 'stopped');
  }
}

/** Reconcile store with actual tmux on daemon start — restart missing sessions. */
export async function restoreFromStore(): Promise<void> {
  const all = storeSessions();
  const live = await tmuxListSessions();
  for (const s of all) {
    if (s.state === 'stopped') continue;
    if (!live.includes(s.name)) {
      logger.info({ session: s.name }, 'Missing on restore, restarting');
      await restartSession(s);
    }
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
}

export async function launchSession(opts: LaunchOpts): Promise<void> {
  const { name, projectName, role, agentType, projectDir, skipStore, extraEnv } = opts;
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
  if (!exists) {
    // On restart (skipStore=true), try resume first so agents can continue their conversation.
    // On first launch, go straight to buildLaunchCommand — resume commands may hang waiting
    // for interactive input when there is no prior conversation.
    let launched = false;

    if (skipStore) {
      const resumeCmd = driver.buildResumeCommand(name, { cwd: projectDir, resumeFirst: true });
      if (resumeCmd) {
        try {
          await newSession(name, resumeCmd, { cwd: projectDir, env: extraEnv });
          launched = true;
          logger.info({ session: name, agentType }, 'Resumed session');
        } catch {
          await killSession(name).catch(() => {});
        }
      }
    }

    if (!launched) {
      const launchCmd = driver.buildLaunchCommand(name, { cwd: projectDir });
      await newSession(name, launchCmd, { cwd: projectDir, env: extraEnv });
      logger.info({ session: name, agentType }, 'Started fresh session');
    }
  }

  if (!skipStore) {
    upsertSession({
      name,
      projectName,
      role,
      agentType,
      projectDir,
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  emitSessionEvent('started', name, 'running');

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

