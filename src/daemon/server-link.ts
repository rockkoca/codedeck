const HEARTBEAT_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

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
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopping = false;
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
    const wsUrl = this.workerUrl.replace(/^http/, 'ws') + `/api/server/${this.serverId}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      // Send auth handshake immediately — DaemonBridge closes the socket if this is not
      // the first message or if credentials are invalid (5s timeout enforced server-side).
      this.ws!.send(JSON.stringify({ type: 'auth', serverId: this.serverId, token: this.token }));
      this.startHeartbeat();
    });

    this.ws.addEventListener('error', () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString();
      try {
        const msg = JSON.parse(raw);
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.addEventListener('close', () => {
      this.stopHeartbeat();
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

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  disconnect(): void {
    this.stopping = true;
    this.stopHeartbeat();
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }, this.backoffMs);
  }
}
