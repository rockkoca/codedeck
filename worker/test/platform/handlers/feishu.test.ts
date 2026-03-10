import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuHandler } from '../../../src/platform/handlers/feishu/index.js';
import type { Env } from '../../../src/types.js';

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  DB: {} as Env['DB'],
  DAEMON_BRIDGE: {} as Env['DAEMON_BRIDGE'],
  RATE_LIMITER: {} as Env['RATE_LIMITER'],
  JWT_SIGNING_KEY: 'key',
  DISCORD_PUBLIC_KEY: '',
  DISCORD_BOT_TOKEN: '',
  DISCORD_APP_ID: '',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_WEBHOOK_SECRET: '',
  FEISHU_APP_ID: 'app-id',
  FEISHU_APP_SECRET: 'app-secret',
  FEISHU_ENCRYPT_KEY: 'encrypt-key',
  FEISHU_VERIFICATION_TOKEN: 'verify-token',
  ...overrides,
});

describe('FeishuHandler', () => {
  let handler: FeishuHandler;

  beforeEach(() => {
    handler = new FeishuHandler();
  });

  describe('getCapabilities()', () => {
    it('returns valid capabilities', () => {
      const caps = handler.getCapabilities();
      expect(caps.maxMessageLength).toBe(4000);
      expect(caps.requiredEnvVars).toContain('FEISHU_APP_ID');
      expect(caps.requiredEnvVars).toContain('FEISHU_APP_SECRET');
      expect(caps.requiredEnvVars).toContain('FEISHU_ENCRYPT_KEY');
      expect(caps.requiredEnvVars).toContain('FEISHU_VERIFICATION_TOKEN');
    });
  });

  describe('verifyInbound()', () => {
    it('accepts url_verification challenge without signature', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(true);
    });

    it('rejects non-challenge request without signature headers', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ schema: '2.0', header: {}, event: {} }),
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(false);
    });
  });

  describe('normalizeInbound()', () => {
    it('returns challenge message for url_verification', async () => {
      const body = { type: 'url_verification', challenge: 'test-challenge' };
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.platform).toBe('feishu');
      expect(msg.content).toBe('__challenge__');
      expect(msg.channelId).toBe('challenge');
    });

    it('normalizes a text message event', async () => {
      const body = {
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            message_id: 'om_abc123',
            chat_id: 'oc_group1',
            message_type: 'text',
            content: JSON.stringify({ text: 'hello feishu' }),
          },
          sender: {
            sender_id: { open_id: 'ou_user1' },
          },
        },
      };
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.platform).toBe('feishu');
      expect(msg.channelId).toBe('oc_group1');
      expect(msg.userId).toBe('ou_user1');
      expect(msg.content).toBe('hello feishu');
      expect(msg.isCommand).toBe(false);
    });

    it('detects /commands in message text', async () => {
      const body = {
        schema: '2.0',
        event: {
          message: {
            message_id: 'om_cmd',
            chat_id: 'oc_group2',
            message_type: 'text',
            content: JSON.stringify({ text: '/send hello world' }),
          },
          sender: { sender_id: { open_id: 'ou_user2' } },
        },
      };
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('send');
      expect(msg.args).toEqual(['hello', 'world']);
    });
  });

  describe('sendOutbound()', () => {
    it('fetches tenant token then sends message', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: 'tok-123' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'feishu', channelId: 'oc_group1', content: 'hello' },
        makeEnv(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [authUrl] = fetchMock.mock.calls[0];
      expect(authUrl).toContain('tenant_access_token/internal');
      const [msgUrl, msgOpts] = fetchMock.mock.calls[1];
      expect(msgUrl).toContain('/im/v1/messages');
      expect(JSON.parse((msgOpts as RequestInit).body as string).receive_id).toBe('oc_group1');

      vi.unstubAllGlobals();
    });
  });
});
