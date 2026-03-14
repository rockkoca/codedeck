/**
 * Sub-session manager — creates/stops/rebuilds tmux sessions for sub-sessions.
 * Sub-sessions are named deck_sub_{id} and can run claude-code, codex, opencode, or shell.
 */

import { newSession, killSession, sessionExists } from '../agent/tmux.js';
import { getDriver } from '../agent/session-manager.js';
import type { AgentType } from '../agent/detect.js';
import { timelineStore } from './timeline-store.js';
import { upsertSession } from '../store/session-store.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from '../util/logger.js';

export interface SubSessionRecord {
  id: string;
  type: string;
  shellBin?: string | null;
  cwd?: string | null;
  ccSessionId?: string | null;
  codexModel?: string | null;
}

export function subSessionName(id: string): string {
  return `deck_sub_${id}`;
}

/** Launch a sub-session tmux session. */
export async function startSubSession(sub: SubSessionRecord): Promise<void> {
  const sessionName = subSessionName(sub.id);
  const agentType = sub.type as AgentType;
  const driver = getDriver(agentType);

  const exists = await sessionExists(sessionName);
  if (exists) {
    logger.info({ sessionName }, 'Sub-session already running');
    return;
  }

  const launchCmd = driver.buildLaunchCommand(sessionName, {
    cwd: sub.cwd ?? undefined,
    ...(sub.shellBin ? { shellBin: sub.shellBin } : {}),
    ...(sub.ccSessionId ? { ccSessionId: sub.ccSessionId } : {}),
    ...(sub.codexModel ? { codexModel: sub.codexModel } : {}),
  } as Parameters<typeof driver.buildLaunchCommand>[1]);

  await newSession(sessionName, launchCmd, { cwd: sub.cwd ?? undefined });
  // Register in session-store so command-handler can look up agentType (e.g. for Codex delayed-Enter)
  // ccSessionId is stored so that restoreFromStore can use startWatchingFile (not directory scan) if needed.
  upsertSession({ name: sessionName, projectName: sessionName, agentType: sub.type, role: 'w1', state: 'running', projectDir: sub.cwd ?? '', ccSessionId: sub.ccSessionId ?? undefined, restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now() });
  logger.info({ sessionName, type: sub.type }, 'Sub-session started');

  // Kick off pipe-pane for any browsers that subscribed before the tmux session existed
  const { terminalStreamer } = await import('./terminal-streamer.js');
  terminalStreamer.retryPipeIfSubscribers(sessionName);

  // Start JSONL watcher for CC sub-sessions pointing at specific file
  if (agentType === 'claude-code' && sub.ccSessionId && sub.cwd) {
    const { startWatchingFile, claudeProjectDir } = await import('./jsonl-watcher.js');
    const projectDir = claudeProjectDir(sub.cwd);
    const jsonlPath = path.join(projectDir, `${sub.ccSessionId}.jsonl`);
    startWatchingFile(sessionName, jsonlPath).catch((e: unknown) =>
      logger.warn({ err: e, sessionName }, 'jsonl-watcher startWatchingFile failed'),
    );
  }

  // Start gemini watcher for gemini sub-sessions
  if (agentType === 'gemini') {
    const { startWatchingLatest } = await import('./gemini-watcher.js');
    startWatchingLatest(sessionName).catch((e: unknown) =>
      logger.warn({ err: e, sessionName }, 'gemini-watcher startWatchingLatest failed'),
    );
  }

  // Start codex JSONL watcher for codex sub-sessions
  if (agentType === 'codex' && sub.cwd) {
    const { startWatching: startCodexWatching } = await import('./codex-watcher.js');
    startCodexWatching(sessionName, sub.cwd).catch((e: unknown) =>
      logger.warn({ err: e, sessionName }, 'codex-watcher startWatching failed'),
    );
  }

  if (driver.postLaunch) {
    const { capturePane, sendKey } = await import('../agent/tmux.js');
    driver.postLaunch(
      () => capturePane(sessionName),
      (key) => sendKey(sessionName, key),
    ).catch((e: unknown) => logger.warn({ err: e, sessionName }, 'Sub-session postLaunch failed'));
  }
}

/** Kill a sub-session tmux session. */
export async function stopSubSession(sessionName: string): Promise<void> {
  await killSession(sessionName).catch(() => {});
  const { stopWatching } = await import('./jsonl-watcher.js');
  stopWatching(sessionName);
  const { stopWatching: stopCodexWatching } = await import('./codex-watcher.js');
  stopCodexWatching(sessionName);
  const { stopWatching: stopGeminiWatching } = await import('./gemini-watcher.js');
  stopGeminiWatching(sessionName);
  logger.info({ sessionName }, 'Sub-session stopped');
}

/** Rebuild all active sub-sessions that are not currently running.
 *  For already-running CC/Codex sub-sessions, ensure the JSONL watcher is active. */
export async function rebuildSubSessions(subSessions: SubSessionRecord[]): Promise<void> {
  const { startWatchingFile, claudeProjectDir, isWatching } = await import('./jsonl-watcher.js');
  const { startWatching: startCodexWatching, isWatching: isCodexWatching } = await import('./codex-watcher.js');
  const { startWatchingLatest: startGeminiWatchingLatest, isWatching: isGeminiWatching } = await import('./gemini-watcher.js');

  for (const sub of subSessions) {
    const sessionName = subSessionName(sub.id);
    const exists = await sessionExists(sessionName);
    if (!exists) {
      await startSubSession(sub).catch((e: unknown) =>
        logger.warn({ err: e, sessionName }, 'Sub-session rebuild failed'),
      );
    } else if (sub.type === 'claude-code' && sub.ccSessionId && sub.cwd && !isWatching(sessionName)) {
      // Already running — restore the JSONL watcher (lost on daemon restart)
      const projectDir = claudeProjectDir(sub.cwd);
      const jsonlPath = path.join(projectDir, `${sub.ccSessionId}.jsonl`);
      startWatchingFile(sessionName, jsonlPath).catch((e: unknown) =>
        logger.warn({ err: e, sessionName }, 'Sub-session watcher restore failed'),
      );
      logger.info({ sessionName, jsonlPath }, 'Restored JSONL watcher for running sub-session');
    } else if (sub.type === 'codex' && sub.cwd && !isCodexWatching(sessionName)) {
      // Already running — restore the codex JSONL watcher (lost on daemon restart)
      startCodexWatching(sessionName, sub.cwd).catch((e: unknown) =>
        logger.warn({ err: e, sessionName }, 'Codex watcher restore failed'),
      );
      logger.info({ sessionName }, 'Restored codex JSONL watcher for running sub-session');
    } else if (sub.type === 'gemini' && !isGeminiWatching(sessionName)) {
      // Already running — restore the gemini watcher (lost on daemon restart)
      startGeminiWatchingLatest(sessionName).catch((e: unknown) =>
        logger.warn({ err: e, sessionName }, 'Gemini watcher restore failed'),
      );
      logger.info({ sessionName }, 'Restored gemini watcher for running sub-session');
    }
    // Ensure agentType is in session-store for all running sub-sessions (needed by command-handler)
    if (exists) {
      upsertSession({ name: sessionName, projectName: sessionName, agentType: sub.type, role: 'w1', state: 'running', projectDir: sub.cwd ?? '', ccSessionId: sub.ccSessionId ?? undefined, restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now() });
    }
  }
}

/** Detect available shell binaries. */
export async function detectShells(): Promise<string[]> {
  const CANDIDATES = ['fish', 'zsh', 'bash', 'sh'];
  const SEARCH_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

  const shells: string[] = [];

  // Include process.env.SHELL first if it exists
  const envShell = process.env.SHELL;
  if (envShell && existsSync(envShell) && !shells.includes(envShell)) {
    shells.push(envShell);
  }

  for (const dir of SEARCH_PATHS) {
    for (const candidate of CANDIDATES) {
      const full = `${dir}/${candidate}`;
      if (existsSync(full) && !shells.includes(full)) {
        shells.push(full);
      }
    }
  }

  return shells;
}

/**
 * Read the last response from a sub-session after idle.
 * Returns { status: 'working' } if not idle, or { status: 'idle', response: string } if idle.
 */
export async function readSubSessionResponse(
  sessionName: string,
): Promise<{ status: 'working' | 'idle'; response?: string }> {
  const { capturePane } = await import('../agent/tmux.js');
  const { detectStatus } = await import('../agent/detect.js');

  const lines = await capturePane(sessionName).catch(() => [] as string[]);

  const exists = await sessionExists(sessionName);
  if (!exists) return { status: 'idle', response: '' };

  // Look up actual agent type from session store (set by startSubSession/rebuildSubSessions)
  const { getSession } = await import('../store/session-store.js');
  const sessionRecord = getSession(sessionName);
  const agentType = (sessionRecord?.agentType ?? 'shell') as import('../agent/detect.js').AgentType;
  const status = detectStatus(lines, agentType);
  if (status !== 'idle') return { status: 'working' };

  // Read from timeline store: find events after last user.message
  const events = timelineStore.read(sessionName);
  const lastUserMsgIdx = events.map((e) => e.type).lastIndexOf('user.message');
  const responseEvents = lastUserMsgIdx >= 0 ? events.slice(lastUserMsgIdx + 1) : events;
  const textParts = responseEvents
    .filter((e) => e.type === 'assistant.text')
    .map((e) => String(e.payload.text ?? ''));

  const response = textParts.length > 0 ? textParts.join('\n') : lines.join('\n');

  return { status: 'idle', response };
}
