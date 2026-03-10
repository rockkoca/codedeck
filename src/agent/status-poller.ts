import { capturePane } from './tmux.js';
import { detectStatusMulti } from './detect.js';
import { checkIdleSignal } from './signal.js';
import { getDriver } from './session-manager.js';
import type { AgentStatus, AgentType } from './detect.js';
import type { SessionRecord } from '../store/session-store.js';
import logger from '../util/logger.js';

export type IdleCallback = (session: SessionRecord) => Promise<void>;

export interface StatusPollerOptions {
  pollIntervalMs?: number;        // default 2000ms
  signalCheckIntervalMs?: number; // default 100ms
}

/**
 * StatusPoller monitors sessions for idle transitions.
 *
 * Strategy:
 * 1. Every 100ms: check signal files (instant idle detection, <100ms latency)
 * 2. Every 2s: multi-sample polling fallback for sessions without signal files
 *
 * On worker idle: calls the idle callback (feeds screen to brain for dispatch).
 */
export class StatusPoller {
  private sessions: Map<string, SessionRecord> = new Map();
  private idleCallbacks: IdleCallback[] = [];
  private lastStatus: Map<string, AgentStatus> = new Map();
  private pollTimer?: NodeJS.Timeout;
  private signalTimer?: NodeJS.Timeout;
  private opts: Required<StatusPollerOptions>;

  constructor(opts?: StatusPollerOptions) {
    this.opts = {
      pollIntervalMs: opts?.pollIntervalMs ?? 2000,
      signalCheckIntervalMs: opts?.signalCheckIntervalMs ?? 100,
    };
  }

  addSession(session: SessionRecord): void {
    this.sessions.set(session.name, session);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    this.lastStatus.delete(name);
  }

  onIdle(cb: IdleCallback): void {
    this.idleCallbacks.push(cb);
  }

  start(): void {
    this.signalTimer = setInterval(() => this.checkSignalFiles(), this.opts.signalCheckIntervalMs);
    this.pollTimer = setInterval(() => this.pollSessions(), this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.signalTimer) clearInterval(this.signalTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async checkSignalFiles(): Promise<void> {
    for (const session of this.sessions.values()) {
      const signal = await checkIdleSignal(session.name);
      if (signal) {
        logger.debug({ session: session.name }, 'Idle signal received');
        await this.triggerIdle(session);
      }
    }
  }

  private async pollSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        const driver = getDriver(session.agentType as AgentType);
        const lines = await capturePane(session.name);
        const status = await detectStatusMulti(
          () => capturePane(session.name),
          session.agentType as AgentType,
        );

        const prev = this.lastStatus.get(session.name);
        this.lastStatus.set(session.name, status);

        // Transition to idle: trigger callback
        if (status === 'idle' && prev !== 'idle') {
          logger.debug({ session: session.name }, 'Polling detected idle');
          await this.triggerIdle(session);
        }

        // Overlay detection: log for debugging
        if (driver.isOverlay(lines)) {
          logger.debug({ session: session.name }, 'Overlay detected');
        }
      } catch (e) {
        logger.warn({ session: session.name, err: e }, 'Status poll error');
      }
    }
  }

  private async triggerIdle(session: SessionRecord): Promise<void> {
    for (const cb of this.idleCallbacks) {
      try {
        await cb(session);
      } catch (e) {
        logger.error({ session: session.name, err: e }, 'Idle callback error');
      }
    }
  }
}
