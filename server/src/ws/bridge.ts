/**
 * WsBridge: per-server WebSocket bridge between daemon and browser clients.
 * Replaces the CF DaemonBridge Durable Object.
 */

import WebSocket from 'ws';
import type { PgDatabase } from '../db/client.js';
import type { Env } from '../env.js';
import { MemoryRateLimiter } from './rate-limiter.js';
import { sha256Hex } from '../security/crypto.js';
import logger from '../util/logger.js';

const AUTH_TIMEOUT_MS = 5000;
const MAX_QUEUE_SIZE = 100;
const MAX_BROWSER_PAYLOAD = 4096; // 4KB
const BROWSER_RATE_LIMIT = 30;    // messages
const BROWSER_RATE_WINDOW = 10_000; // 10s

/** Message types allowed to be forwarded from browser → daemon */
const BROWSER_WHITELIST = new Set([
  'terminal.subscribe',
  'terminal.unsubscribe',
  'session.start',
  'session.stop',
  'session.restart',
  'session.send',
  'session.input',
  'session.resize',
  'get_sessions',
]);

export class WsBridge {
  private static instances = new Map<string, WsBridge>();

  private daemonWs: WebSocket | null = null;
  private authenticated = false;
  private browserSockets = new Set<WebSocket>();
  private queue: string[] = [];
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private browserRateLimiter = new MemoryRateLimiter();

  private constructor(private serverId: string) {}

  static get(serverId: string): WsBridge {
    let bridge = WsBridge.instances.get(serverId);
    if (!bridge) {
      bridge = new WsBridge(serverId);
      WsBridge.instances.set(serverId, bridge);
    }
    return bridge;
  }

  static getAll(): Map<string, WsBridge> {
    return WsBridge.instances;
  }

  // ── Daemon connection ──────────────────────────────────────────────────────

  handleDaemonConnection(ws: WebSocket, db: PgDatabase, env: Env, onAuthenticated?: () => void): void {
    // Replace existing daemon connection
    if (this.daemonWs) {
      try { this.daemonWs.close(1001, 'replaced'); } catch { /* ignore */ }
    }
    this.daemonWs = ws;
    this.authenticated = false;

    // Auth timeout
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        logger.warn({ serverId: this.serverId }, 'Daemon auth timeout');
        ws.close(4001, 'auth_timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!this.authenticated) {
        // Expect auth message
        if (msg.type !== 'auth' || typeof msg.token !== 'string' || typeof msg.serverId !== 'string') {
          ws.close(4001, 'auth_required');
          return;
        }
        if (this.authTimer) clearTimeout(this.authTimer);

        // Verify token
        const tokenHash = sha256Hex(msg.token);
        const server = await db.prepare('SELECT token_hash FROM servers WHERE id = ?').bind(this.serverId).first<{ token_hash: string }>();

        if (!server || server.token_hash !== tokenHash) {
          logger.warn({ serverId: this.serverId }, 'Daemon auth failed');
          ws.close(4001, 'auth_failed');
          return;
        }

        this.authenticated = true;
        logger.info({ serverId: this.serverId }, 'Daemon authenticated');
        onAuthenticated?.();

        // Drain queued messages
        for (const queued of this.queue) {
          try { ws.send(queued); } catch { /* ignore */ }
        }
        this.queue = [];

        // Notify browsers daemon reconnected
        this.broadcastToBrowsers(JSON.stringify({ type: 'daemon.reconnected' }));
        return;
      }

      // Relay daemon → browsers with type translation
      this.relayToBrowsers(msg);

      // Dispatch push on session.idle
      if (msg.type === 'session.idle' && env) {
        this.dispatchIdlePush(db, env, msg).catch((err) =>
          logger.error({ err }, 'Push dispatch failed'),
        );
      }
    });

    ws.on('close', () => {
      if (this.daemonWs === ws) {
        this.daemonWs = null;
        this.authenticated = false;
      }
      this.maybeCleanup();
    });

    ws.on('error', (err) => {
      logger.error({ serverId: this.serverId, err }, 'Daemon WS error');
    });
  }

  // ── Browser connection ─────────────────────────────────────────────────────

  handleBrowserConnection(ws: WebSocket): void {
    this.browserSockets.add(ws);

    ws.on('message', (data) => {
      // Payload size limit
      const raw = data.toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BROWSER_PAYLOAD) {
        logger.warn({ serverId: this.serverId }, 'Browser message too large — dropped');
        try { ws.send(JSON.stringify({ type: 'error', error: 'payload_too_large' })); } catch { /* ignore */ }
        return;
      }

      // Per-browser rate limit
      const browserId = this.getBrowserId(ws);
      if (!this.browserRateLimiter.check(browserId, BROWSER_RATE_LIMIT, BROWSER_RATE_WINDOW)) {
        logger.warn({ serverId: this.serverId }, 'Browser rate limit exceeded — dropped');
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      // Whitelist check
      if (typeof msg.type !== 'string' || !BROWSER_WHITELIST.has(msg.type)) {
        logger.warn({ serverId: this.serverId, type: msg.type }, 'Browser message type not whitelisted — dropped');
        return;
      }

      this.sendToDaemon(raw);
    });

    ws.on('close', () => {
      this.browserSockets.delete(ws);
      this.maybeCleanup();
    });

    ws.on('error', () => {
      this.browserSockets.delete(ws);
      this.maybeCleanup();
    });
  }

  // ── Relay helpers ──────────────────────────────────────────────────────────

  private relayToBrowsers(msg: Record<string, unknown>): void {
    let outMsg: Record<string, unknown>;

    // Type translation
    if (msg.type === 'terminal_update') {
      outMsg = { ...msg, type: 'terminal.diff' };
    } else if (msg.type === 'session_event') {
      outMsg = { ...msg, type: 'session.event' };
    } else {
      outMsg = msg;
    }

    this.broadcastToBrowsers(JSON.stringify(outMsg));
  }

  private broadcastToBrowsers(json: string): void {
    for (const bs of this.browserSockets) {
      try {
        bs.send(json);
      } catch {
        this.browserSockets.delete(bs);
      }
    }
  }

  sendToDaemon(message: string): void {
    if (this.daemonWs && this.authenticated) {
      try {
        this.daemonWs.send(message);
      } catch (err) {
        logger.error({ serverId: this.serverId, err }, 'Failed to send to daemon');
      }
    } else {
      if (this.queue.length < MAX_QUEUE_SIZE) {
        this.queue.push(message);
      }
    }
  }

  // ── Push on session.idle ───────────────────────────────────────────────────

  private async dispatchIdlePush(db: PgDatabase, env: Env, msg: Record<string, unknown>): Promise<void> {
    const server = await db.prepare('SELECT user_id FROM servers WHERE id = ?').bind(this.serverId).first<{ user_id: string }>();
    if (!server) return;

    // Dynamic import to avoid circular dependency with routes/push.ts
    const { dispatchPush } = await import('../routes/push.js').catch(() => ({ dispatchPush: null }));
    if (!dispatchPush) return;
    await dispatchPush({
      userId: server.user_id,
      title: 'Agent idle',
      body: `Session ${String(msg.session ?? '')} is ready`,
      data: { serverId: this.serverId, session: String(msg.session ?? '') },
    }, env);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private getBrowserId(ws: WebSocket): string {
    // Use object identity as a stable key
    const id = (ws as WebSocket & { _bridgeId?: string })._bridgeId
      ?? ((ws as WebSocket & { _bridgeId?: string })._bridgeId = Math.random().toString(36).slice(2));
    return id;
  }

  private maybeCleanup(): void {
    if (!this.daemonWs && this.browserSockets.size === 0) {
      this.browserRateLimiter.stop();
      WsBridge.instances.delete(this.serverId);
    }
  }

  /** Number of connected browser sockets (for testing/monitoring) */
  get browserCount(): number {
    return this.browserSockets.size;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }
}
