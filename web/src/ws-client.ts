/**
 * WebSocket client for terminal stream + session commands.
 * Handles auth, reconnect, and message dispatch.
 */
import type { TerminalDiff } from './types.js';

export type MessageHandler = (msg: ServerMessage) => void;

export type ServerMessage =
  | { type: 'terminal.diff'; diff: TerminalDiff }
  | { type: 'session.event'; event: string; session: string; state: string }
  | { type: 'session.error'; project: string; message: string }
  | { type: 'session_list'; sessions: Array<{ name: string; project: string; role: string; agentType: string; state: string }> }
  | { type: 'outbound'; platform: string; channelId: string; content: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_MS = 25000;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private token: string;
  private baseUrl: string;
  private serverId: string;
  private _connected = false;
  private _connecting = false;

  constructor(baseUrl: string, serverId: string, token: string) {
    this.baseUrl = baseUrl;
    this.serverId = serverId;
    this.token = token;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws) return;
    void this.openSocket();
  }

  disconnect(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeTerminal(sessionName: string): void {
    this.send({ type: 'terminal.subscribe', session: sessionName });
  }

  unsubscribeTerminal(sessionName: string): void {
    this.send({ type: 'terminal.unsubscribe', session: sessionName });
  }

  sendSessionCommand(command: 'start' | 'stop' | 'send' | 'restart', payload: object = {}): void {
    this.send({ type: `session.${command}`, ...payload });
  }

  /** Send raw keyboard input (from xterm onData) to a tmux session. */
  sendInput(sessionName: string, data: string): void {
    this.send({ type: 'session.input', sessionName, data });
  }

  /** Notify the daemon that the terminal viewport has been resized. */
  sendResize(sessionName: string, cols: number, rows: number): void {
    this.send({ type: 'session.resize', sessionName, cols, rows });
  }

  /** Request the current session list from the daemon. */
  requestSessionList(): void {
    this.send({ type: 'get_sessions' });
  }

  private async openSocket(): Promise<void> {
    if (this._connecting) return;
    this._connecting = true;

    const wsUrl = this.baseUrl
      .replace(/^http/, 'ws')
      .replace(/\/$/, '');

    // Get a short-lived ws-ticket before connecting
    let ticket: string;
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/ws-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ serverId: this.serverId }),
      });
      if (!res.ok) {
        this._connecting = false;
        this.scheduleReconnect();
        return;
      }
      const data = await res.json() as { ticket: string };
      ticket = data.ticket;
    } catch {
      this._connecting = false;
      this.scheduleReconnect();
      return;
    }

    const url = `${wsUrl}/api/server/${this.serverId}/terminal?ticket=${encodeURIComponent(ticket)}`;

    this.ws = new WebSocket(url);
    this._connecting = false;

    this.ws.addEventListener('open', () => {
      this._connected = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.dispatch({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
    });

    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'pong') return;
        this.dispatch(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.addEventListener('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      this.ws = null;
      this.clearTimers();
      if (wasConnected) {
        this.dispatch({ type: 'session.event', event: 'disconnected', session: '', state: 'disconnected' });
      }
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      void this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        this.send({ type: 'ping' });
      } catch {
        // ignore
      }
    }, HEARTBEAT_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private dispatch(msg: ServerMessage): void {
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch {
        // ignore handler errors
      }
    }
  }
}
