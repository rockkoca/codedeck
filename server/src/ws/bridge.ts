/**
 * WsBridge: per-server WebSocket bridge between daemon and browser clients.
 * Replaces the CF DaemonBridge Durable Object.
 *
 * Binary routing: daemon binary raw frames are routed only to browsers
 * subscribed to the target session (not broadcast). Subscription state is
 * tracked by intercepting terminal.subscribe/unsubscribe browser messages.
 *
 * Per-(session,browser) forwarding queue: text snapshot frames and binary raw
 * frames share a single queue for ordered delivery. Overflow (512KB) triggers
 * terminal.stream_reset and unsubscribes the browser from that session.
 */

import WebSocket from 'ws';
import type { PgDatabase } from '../db/client.js';
import type { Env } from '../env.js';
import { MemoryRateLimiter } from './rate-limiter.js';
import { sha256Hex } from '../security/crypto.js';
import { updateServerHeartbeat, updateServerStatus } from '../db/queries.js';
import logger from '../util/logger.js';

const AUTH_TIMEOUT_MS = 5000;
const MAX_QUEUE_SIZE = 100;
const MAX_BROWSER_PAYLOAD = 65536; // 64KB (subsession.rebuild_all can include many sessions)
const BROWSER_RATE_LIMIT = 30;    // messages
const BROWSER_RATE_WINDOW = 10_000; // 10s
const QUEUE_MAX_BYTES = 512 * 1024; // 512KB per (session, browser)

/**
 * Safe ws.send: checks readyState, wraps in try/catch.
 * Returns true if sent, false if socket not open or send threw.
 * Calls onFail() if the send could not be delivered.
 */
function safeSend(ws: WebSocket, data: string | Buffer, onComplete?: (err?: Error) => void): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    onComplete?.(new Error('not open'));
    return false;
  }
  try {
    ws.send(data, { binary: Buffer.isBuffer(data) }, (err) => {
      onComplete?.(err);
    });
    return true;
  } catch (e) {
    onComplete?.(e instanceof Error ? e : new Error(String(e)));
    return false;
  }
}

/** Message types allowed to be forwarded from browser → daemon */
const BROWSER_WHITELIST = new Set([
  'terminal.subscribe',
  'terminal.unsubscribe',
  'terminal.snapshot_request',
  'timeline.replay_request',
  'timeline.history_request',
  'session.start',
  'session.stop',
  'session.restart',
  'session.send',
  'session.input',
  'session.resize',
  'get_sessions',
  'subsession.start',
  'subsession.stop',
  'subsession.rebuild_all',
  'subsession.detect_shells',
  'subsession.read_response',
]);

// ── Terminal forwarding queue (per (session, browser)) ────────────────────────

/**
 * Per-(session, browser) forwarding queue.
 * Tracks in-flight bytes via ws.send() callbacks.
 * On overflow, triggers the provided overflow handler (send reset, unsubscribe).
 */
class TerminalForwardQueue {
  private bufferedBytes = 0;

  send(ws: WebSocket, data: string | Buffer, onOverflow: () => void): void {
    const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    this.bufferedBytes += size;

    if (this.bufferedBytes > QUEUE_MAX_BYTES) {
      this.bufferedBytes -= size;
      onOverflow();
      return;
    }

    safeSend(ws, data, (err) => {
      this.bufferedBytes -= size;
      if (err) {
        // Socket closed or errored — treat as overflow to trigger cleanup
        onOverflow();
      }
    });
  }
}

// ── Parse session name from binary frame header ───────────────────────────────

/**
 * Parse session name from binary frame v1 header.
 * Returns null if the frame is malformed.
 */
function parseRawFrameSession(data: Buffer): string | null {
  if (data.length < 3 || data[0] !== 0x01) return null;
  const nameLen = data.readUInt16BE(1);
  if (data.length < 3 + nameLen) return null;
  return data.subarray(3, 3 + nameLen).toString('utf8');
}

// ── WsBridge ─────────────────────────────────────────────────────────────────

export class WsBridge {
  private static instances = new Map<string, WsBridge>();

  private daemonWs: WebSocket | null = null;
  private authenticated = false;
  private browserSockets = new Set<WebSocket>();
  private queue: string[] = [];
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private browserRateLimiter = new MemoryRateLimiter();

  /** browser socket → set of subscribed session names */
  private browserSubscriptions = new Map<WebSocket, Set<string>>();

  /**
   * Per-session daemon subscription reference count.
   * Forward terminal.subscribe to daemon only on 0→1.
   * Forward terminal.unsubscribe to daemon only on 1→0 (including on browser disconnect).
   */
  private daemonSessionRefs = new Map<string, number>();

  /**
   * Per-(session, browser) forwarding queues.
   * Used for both terminal_update (snapshot JSON) and binary raw frames.
   * session → browser → queue
   */
  private terminalQueues = new Map<string, Map<WebSocket, TerminalForwardQueue>>();

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

    ws.on('message', async (data, isBinary) => {
      // Handle binary raw PTY frames
      if (isBinary) {
        this.routeBinaryFrame(data as Buffer);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!this.authenticated) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string' || typeof msg.serverId !== 'string') {
          ws.close(4001, 'auth_required');
          return;
        }
        if (this.authTimer) clearTimeout(this.authTimer);

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

        updateServerHeartbeat(db, this.serverId).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat on auth'),
        );

        // Replay queued messages, skipping terminal.subscribe — refs replay below is authoritative
        for (const queued of this.queue) {
          try {
            const parsed = JSON.parse(queued) as { type?: string };
            if (parsed.type === 'terminal.subscribe') continue;
            ws.send(queued);
          } catch { /* ignore */ }
        }
        this.queue = [];

        this.broadcastToBrowsers(JSON.stringify({ type: 'daemon.reconnected' }));

        // Re-subscribe daemon to all sessions that still have active browser subscribers
        for (const [sessionName, refs] of this.daemonSessionRefs) {
          if (refs > 0) {
            try { ws.send(JSON.stringify({ type: 'terminal.subscribe', session: sessionName })); } catch { /* ignore */ }
          }
        }

        return;
      }

      if (msg.type === 'heartbeat') {
        updateServerHeartbeat(db, this.serverId).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat'),
        );
        // Ack heartbeat so daemon watchdog doesn't consider the connection dead
        try { ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch { /* ignore */ }
      }

      this.relayToBrowsers(msg);

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
        updateServerStatus(db, this.serverId, 'offline').catch((err) =>
          logger.error({ err }, 'Failed to mark server offline'),
        );
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
    this.browserSubscriptions.set(ws, new Set());

    ws.on('message', (data) => {
      const raw = (data as Buffer).toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BROWSER_PAYLOAD) {
        logger.warn({ serverId: this.serverId }, 'Browser message too large — dropped');
        try { ws.send(JSON.stringify({ type: 'error', error: 'payload_too_large' })); } catch { /* ignore */ }
        return;
      }

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

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (typeof msg.type !== 'string' || !BROWSER_WHITELIST.has(msg.type)) {
        logger.warn({ serverId: this.serverId, type: msg.type }, 'Browser message type not whitelisted — dropped');
        return;
      }

      // Track terminal subscriptions for binary routing + ref-counted daemon forwarding
      if (msg.type === 'terminal.subscribe' && typeof msg.session === 'string') {
        this.addBrowserSessionSubscription(ws, msg.session, raw);
        return; // forwarding handled inside (only on 0→1)
      } else if (msg.type === 'terminal.unsubscribe' && typeof msg.session === 'string') {
        this.removeBrowserSessionSubscription(ws, msg.session);
        return; // forwarding handled inside (only on 1→0)
      }

      this.sendToDaemon(raw);
    });

    ws.on('close', () => {
      this.cleanupBrowserSocket(ws);
      this.maybeCleanup();
    });

    ws.on('error', () => {
      this.cleanupBrowserSocket(ws);
      this.maybeCleanup();
    });
  }

  // ── Relay helpers ──────────────────────────────────────────────────────────

  private relayToBrowsers(msg: Record<string, unknown>): void {
    if (msg.type === 'terminal_update') {
      // Route snapshot only to browsers subscribed to this session
      const sessionName = (msg.diff as Record<string, unknown> | undefined)?.sessionName as string | undefined;
      const outJson = JSON.stringify({ ...msg, type: 'terminal.diff' });
      if (sessionName) {
        this.sendToSessionSubscribers(sessionName, outJson);
      } else {
        this.broadcastToBrowsers(outJson);
      }
      return;
    }

    if (msg.type === 'session_event') {
      this.broadcastToBrowsers(JSON.stringify({ ...msg, type: 'session.event' }));
      return;
    }

    this.broadcastToBrowsers(JSON.stringify(msg));
  }

  private routeBinaryFrame(data: Buffer): void {
    const sessionName = parseRawFrameSession(data);
    if (!sessionName) {
      logger.warn({ serverId: this.serverId }, 'Binary frame: invalid v1 header');
      return;
    }
    this.sendToSessionSubscribers(sessionName, data);
  }

  private sendToSessionSubscribers(sessionName: string, data: string | Buffer): void {
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (!sessions.has(sessionName)) continue;
      const queue = this.getOrCreateQueue(sessionName, ws);
      queue.send(ws, data, () => this.handleQueueOverflow(sessionName, ws));
    }
  }

  private handleQueueOverflow(sessionName: string, ws: WebSocket): void {
    const resetMsg = JSON.stringify({
      type: 'terminal.stream_reset',
      session: sessionName,
      reason: 'backpressure',
    });

    const sent = safeSend(ws, resetMsg, (err) => {
      if (err) {
        // Send failed (socket CLOSING/CLOSED or threw) — force close
        try { ws.close(1011, 'backpressure_notify_failed'); } catch { /* ignore */ }
      }
    });

    // Always remove subscription regardless of send success
    this.removeBrowserSessionSubscription(ws, sessionName);

    if (!sent) {
      logger.warn({ serverId: this.serverId, sessionName }, 'Backpressure reset failed to send — socket closed');
    }
  }

  private getOrCreateQueue(sessionName: string, ws: WebSocket): TerminalForwardQueue {
    let sessionQueues = this.terminalQueues.get(sessionName);
    if (!sessionQueues) {
      sessionQueues = new Map();
      this.terminalQueues.set(sessionName, sessionQueues);
    }
    let queue = sessionQueues.get(ws);
    if (!queue) {
      queue = new TerminalForwardQueue();
      sessionQueues.set(ws, queue);
    }
    return queue;
  }

  /**
   * Add a browser subscription for sessionName.
   * Forwards terminal.subscribe to daemon only on 0→1 transition.
   * rawMsg is the original JSON string to forward on 0→1.
   */
  private addBrowserSessionSubscription(ws: WebSocket, sessionName: string, rawMsg: string): void {
    const subs = this.browserSubscriptions.get(ws);
    if (!subs || subs.has(sessionName)) return; // already subscribed
    subs.add(sessionName);

    const prev = this.daemonSessionRefs.get(sessionName) ?? 0;
    this.daemonSessionRefs.set(sessionName, prev + 1);

    if (prev === 0) {
      // First browser subscriber — tell daemon to start streaming
      this.sendToDaemon(rawMsg);
    }
  }

  /**
   * Remove a browser subscription for sessionName.
   * Forwards terminal.unsubscribe to daemon only on 1→0 transition.
   */
  private removeBrowserSessionSubscription(ws: WebSocket, sessionName: string): void {
    const subs = this.browserSubscriptions.get(ws);
    if (!subs?.has(sessionName)) return; // not subscribed
    subs.delete(sessionName);

    this.terminalQueues.get(sessionName)?.delete(ws);
    if (this.terminalQueues.get(sessionName)?.size === 0) {
      this.terminalQueues.delete(sessionName);
    }

    const prev = this.daemonSessionRefs.get(sessionName) ?? 0;
    const next = Math.max(0, prev - 1);
    if (next === 0) {
      this.daemonSessionRefs.delete(sessionName);
      // Last browser unsubscribed — tell daemon to stop streaming
      this.sendToDaemon(JSON.stringify({ type: 'terminal.unsubscribe', session: sessionName }));
    } else {
      this.daemonSessionRefs.set(sessionName, next);
    }
  }

  private cleanupBrowserSocket(ws: WebSocket): void {
    this.browserSockets.delete(ws);
    const sessions = this.browserSubscriptions.get(ws);
    if (sessions) {
      for (const sessionName of [...sessions]) {
        // Use removeBrowserSessionSubscription to correctly handle ref counting + daemon notify
        this.removeBrowserSessionSubscription(ws, sessionName);
      }
    }
    this.browserSubscriptions.delete(ws);
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

  get browserCount(): number {
    return this.browserSockets.size;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }
}
