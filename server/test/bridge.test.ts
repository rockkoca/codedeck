import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1; // WebSocket.OPEN
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  /** Sent strings only (excludes binary frames) */
  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

// ── Build v1 binary frame ─────────────────────────────────────────────────────

function packFrame(sessionName: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(sessionName, 'utf8');
  const header = Buffer.allocUnsafe(3 + nameBytes.length);
  header[0] = 0x01;
  header.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(header, 3);
  return Buffer.concat([header, payload]);
}

// ── Mock DB ────────────────────────────────────────────────────────────────────

function makeDb(tokenHash: string) {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => ({ token_hash: tokenHash }),
        all: async () => ({ results: [] }),
        run: async () => ({ changes: 1 }),
      }),
    }),
  } as unknown as import('../src/db/client.js').PgDatabase;
}

// ── Mock crypto + push ─────────────────────────────────────────────────────────

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

// Flush all pending microtasks/promises
async function flushAsync() {
  // Multiple rounds to handle promise chains inside async message handlers
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WsBridge', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `test-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  describe('daemon auth', () => {
    it('authenticates with valid token', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(true);
    });

    it('closes on auth timeout', async () => {
      vi.useFakeTimers();
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('hash') as never, {} as never);

      vi.advanceTimersByTime(5001);
      await flushAsync();
      vi.useRealTimers();
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(4001);
    });

    it('closes on invalid token', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('different-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'bad-token' }));
      await flushAsync();
      expect(ws.closed).toBe(true);
    });
  });

  describe('message relay daemon→browser', () => {
    async function setupAuthenticatedBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never);
      return { bridge, daemonWs, browserWs };
    }

    it('translates terminal_update → terminal.diff', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({ type: 'terminal_update', diff: { a: 1 } }));
      await flushAsync();
      expect(JSON.parse(browserWs.sent[0]).type).toBe('terminal.diff');
    });

    it('translates session_event → session.event', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({ type: 'session_event', session: 'x' }));
      await flushAsync();
      expect(JSON.parse(browserWs.sent[0]).type).toBe('session.event');
    });

    it('passes through session.idle unchanged', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({ type: 'session.idle' }));
      await flushAsync();
      expect(JSON.parse(browserWs.sent[0]).type).toBe('session.idle');
    });

    it('removes erroring browser socket on send failure', async () => {
      const { bridge, daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.closed = true; // next send throws
      daemonWs.emit('message', JSON.stringify({ type: 'session.idle' }));
      await flushAsync();
      expect(bridge.browserCount).toBe(0);
    });
  });

  describe('browser→daemon whitelist', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never);
      return { daemonWs, browserWs };
    }

    it('forwards whitelisted type', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'x' }));
      expect(daemonWs.sentStrings.some((s) => s.includes('terminal.subscribe'))).toBe(true);
    });

    it('drops non-whitelisted type', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'admin.shutdown' }));
      expect(daemonWs.sent).toHaveLength(0);
    });

    it('drops oversized payload', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'session.send', text: 'x'.repeat(70000) }));
      expect(daemonWs.sent).toHaveLength(0);
    });

    it('drops after rate limit exceeded', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      for (let i = 0; i < 30; i++) {
        browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));
      }
      const countBefore = daemonWs.sent.length;
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));
      expect(daemonWs.sent.length).toBe(countBefore);
    });
  });

  describe('queue drain on reconnect', () => {
    it('drains queued browser messages when daemon authenticates', async () => {
      const bridge = WsBridge.get(serverId);

      // Browser sends message before daemon connects (goes to queue)
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never);
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));

      // Daemon connects and authenticates
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes('get_sessions'))).toBe(true);
    });
  });

  // ── Helpers shared by subscription / binary tests ─────────────────────────

  async function setupAuth() {
    const bridge = WsBridge.get(serverId);
    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
    daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    return { bridge, daemonWs };
  }

  // ── Multi-browser ref counting ─────────────────────────────────────────────

  describe('per-session daemon subscription ref counting', () => {
    it('sends terminal.subscribe to daemon only on 0→1', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never);
      bridge.handleBrowserConnection(b2 as never);

      // First browser subscribes → 0→1, should forward to daemon
      const sentBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      b1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
      await flushAsync();
      const afterFirst = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      expect(afterFirst).toBe(sentBefore + 1);

      // Second browser subscribes same session → 1→2, must NOT forward again
      b2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
      await flushAsync();
      const afterSecond = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      expect(afterSecond).toBe(sentBefore + 1); // no additional forward
    });

    it('sends terminal.unsubscribe to daemon only on 1→0', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never);
      bridge.handleBrowserConnection(b2 as never);

      b1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess2' }));
      b2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess2' }));
      await flushAsync();

      const unsubBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length;

      // First unsubscribe → 2→1, must NOT forward
      b1.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess2' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore);

      // Second unsubscribe → 1→0, must forward
      b2.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess2' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore + 1);
    });

    it('browser disconnect drives 1→0 and sends terminal.unsubscribe', async () => {
      const { daemonWs } = await setupAuth();
      const bridge = WsBridge.get(serverId);

      const b = new MockWs();
      bridge.handleBrowserConnection(b as never);
      b.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess3' }));
      await flushAsync();

      const unsubBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length;

      // Simulate browser disconnect
      b.emit('close');
      await flushAsync();

      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore + 1);
    });
  });

  // ── bufferedBytes balance ──────────────────────────────────────────────────

  describe('TerminalForwardQueue bufferedBytes balance', () => {
    it('reclaims bytes after each successful send — no overflow after many frames', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never);
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess4' }));
      await flushAsync();

      // Send 600 frames × 1 KB each = 600 KB total dispatched.
      // QUEUE_MAX_BYTES = 512 KB. If bufferedBytes weren't reclaimed, this would overflow.
      // Since MockWs invokes the send callback synchronously (success), bytes are reclaimed immediately.
      const payload = Buffer.alloc(1024, 0x41); // 1 KB
      const frame = packFrame('sess4', payload);

      for (let i = 0; i < 600; i++) {
        daemonWs.emit('message', frame, true);
      }
      await flushAsync();

      // No stream_reset should have been sent to the browser
      const resets = browserWs.sentStrings.filter((s) => s.includes('stream_reset'));
      expect(resets).toHaveLength(0);

      // All 600 frames should have been forwarded as binary
      const binaryFrames = browserWs.sent.filter((s) => Buffer.isBuffer(s));
      expect(binaryFrames).toHaveLength(600);
    });
  });

  // ── Daemon reconnect subscription replay ──────────────────────────────────

  describe('daemon reconnect subscription replay', () => {
    it('replays active subscriptions to daemon after reconnect', async () => {
      const bridge = WsBridge.get(serverId);

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never);
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessR' }));
      await flushAsync();

      // Daemon disconnects
      daemonWs1.emit('close');
      await flushAsync();

      // New daemon connects and authenticates
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Bridge should have re-sent terminal.subscribe for sessR to the new daemon
      expect(daemonWs2.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string; session: string }).session === 'sessR'; } catch { return false; }
      })).toBe(true);
    });

    it('does not replay terminal.subscribe from offline queue (prevents duplicates)', async () => {
      const bridge = WsBridge.get(serverId);

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never);

      // Browser subscribes while daemon is offline → goes to queue
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessD' }));
      await flushAsync();

      // Daemon connects and authenticates
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Should send exactly ONE terminal.subscribe (from refs replay, not from queue replay)
      const subscribes = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.subscribe'; } catch { return false; }
      });
      expect(subscribes).toHaveLength(1);
    });
  });
});
