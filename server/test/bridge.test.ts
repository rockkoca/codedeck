import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string) {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }
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
      expect(daemonWs.sent.some((s) => s.includes('terminal.subscribe'))).toBe(true);
    });

    it('drops non-whitelisted type', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'admin.shutdown' }));
      expect(daemonWs.sent).toHaveLength(0);
    });

    it('drops oversized payload', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'session.send', text: 'x'.repeat(5000) }));
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

      expect(daemonWs.sent.some((s) => s.includes('get_sessions'))).toBe(true);
    });
  });
});
