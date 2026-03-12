/**
 * Sub-session manager — creates/stops/rebuilds tmux sessions for sub-sessions.
 * Sub-sessions are named deck_sub_{id} and can run claude-code, codex, opencode, or shell.
 */

import { newSession, killSession, sessionExists } from '../agent/tmux.js';
import { getDriver } from '../agent/session-manager.js';
import type { AgentType } from '../agent/detect.js';
import { timelineStore } from './timeline-store.js';
import { existsSync } from 'node:fs';
import logger from '../util/logger.js';

export interface SubSessionRecord {
  id: string;
  type: string;
  shellBin?: string | null;
  cwd?: string | null;
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
  } as Parameters<typeof driver.buildLaunchCommand>[1]);

  await newSession(sessionName, launchCmd, { cwd: sub.cwd ?? undefined });
  logger.info({ sessionName, type: sub.type }, 'Sub-session started');

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
  logger.info({ sessionName }, 'Sub-session stopped');
}

/** Rebuild all active sub-sessions that are not currently running. */
export async function rebuildSubSessions(subSessions: SubSessionRecord[]): Promise<void> {
  for (const sub of subSessions) {
    const sessionName = subSessionName(sub.id);
    const exists = await sessionExists(sessionName);
    if (!exists) {
      await startSubSession(sub).catch((e: unknown) =>
        logger.warn({ err: e, sessionName }, 'Sub-session rebuild failed'),
      );
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

  // Detect session type from session name (deck_sub_{id})
  // For status check, we use a simple approach: check if the last line looks idle
  const lines = await capturePane(sessionName).catch(() => [] as string[]);

  // Check status with a generic approach (take the most conservative check)
  // We detect using 'shell' type as a fallback for all sub-session types
  const exists = await sessionExists(sessionName);
  if (!exists) return { status: 'idle', response: '' };

  const status = detectStatus(lines, 'shell');
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
