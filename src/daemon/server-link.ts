import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';

const HEARTBEAT_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const WATCHDOG_MS = 15_000;           // check connection health every 15s
const PONG_TIMEOUT_MS = 10_000;       // if no pong within 10s, connection is dead

export interface ServerLinkOpts {
  workerUrl: string;
  serverId: string;
  token: string;
}

export type MessageHandler = (msg: unknown) => void;

export class ServerLink {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopping = false;
  private reconnecting = false;
  private lastPong = 0;               // timestamp of last received message (any message counts as proof of life)
  private seq = 0;
  private readonly workerUrl: string;
  private readonly serverId: string;
  private readonly token: string;

  constructor(opts: ServerLinkOpts) {
    this.workerUrl = opts.workerUrl;
    this.serverId = opts.serverId;
    this.token = opts.token;
  }

  connect(): void {
    // Clean up previous connection if any
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = undefined; }

    const wsUrl = this.workerUrl.replace(/^http/, 'ws') + `/api/server/${this.serverId}/ws`;
    logger.info({ url: wsUrl }, 'ServerLink: connecting');
    this.reconnecting = false;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      logger.info('ServerLink: connected');
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastPong = Date.now();
      // Send auth handshake immediately — DaemonBridge closes the socket if this is not
      // the first message or if credentials are invalid (5s timeout enforced server-side).
      this.ws!.send(JSON.stringify({ type: 'auth', serverId: this.serverId, token: this.token }));
      this.startHeartbeat();
      this.startWatchdog();
    });

    this.ws.addEventListener('error', (event) => {
      logger.warn({ error: (event as ErrorEvent).message ?? 'unknown' }, 'ServerLink: error');
      // Close event *should* fire after error, but in edge cases (non-101 response,
      // DNS failure) it may not. Schedule reconnect as a safety net — scheduleReconnect()
      // is idempotent (guards with `this.reconnecting`), so no double-reconnect risk
      // when close does fire.
      if (!this.stopping) this.scheduleReconnect();
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      this.lastPong = Date.now();
      const raw = typeof event.data === 'string' ? event.data : event.data.toString();
      try {
        const msg = JSON.parse(raw);
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      logger.info({ code: event.code, reason: event.reason }, 'ServerLink: closed');
      this.stopHeartbeat();
      this.stopWatchdog();
      if (!this.stopping) this.scheduleReconnect();
    });
  }

  send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('ServerLink: not connected');
    }
    this.seq++;
    this.ws.send(JSON.stringify({ ...((msg as object) ?? {}), seq: this.seq }));
  }

  /** Send a timeline event to connected browsers via the server relay. */
  sendTimelineEvent(event: TimelineEvent): void {
    try {
      this.send({ type: 'timeline.event', event });
    } catch {
      // Not connected — timeline events are best-effort
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  disconnect(): void {
    this.stopping = true;
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'heartbeat' });
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  }

  /** Watchdog: periodically verifies the connection is truly alive.
   *  If no message received within PONG_TIMEOUT after a heartbeat ping,
   *  the connection is considered dead and forcibly recycled. */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      if (this.stopping) return;

      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Not connected — force reconnect if not already scheduled
        logger.warn('ServerLink watchdog: not connected, forcing reconnect');
        this.forceReconnect();
        return;
      }

      const silenceMs = Date.now() - this.lastPong;
      if (silenceMs > HEARTBEAT_MS + PONG_TIMEOUT_MS) {
        // Haven't received anything for heartbeat interval + timeout — dead connection
        logger.warn({ silenceMs }, 'ServerLink watchdog: connection silent, forcing reconnect');
        this.forceReconnect();
        return;
      }
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
  }

  /** Kill current connection and force immediate reconnect */
  private forceReconnect(): void {
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.reconnecting = false;
    // Force-close existing socket (will trigger close event, but we handle reconnect ourselves)
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    // Reset backoff for forced reconnects — we want to come back fast
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // Prevent double scheduling from error+close firing in sequence
    if (this.reconnecting) return;
    this.reconnecting = true;
    logger.info({ backoffMs: this.backoffMs }, 'ServerLink: scheduling reconnect');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }, this.backoffMs);
  }
}
