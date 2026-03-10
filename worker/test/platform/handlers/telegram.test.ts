import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramHandler } from '../../../src/platform/handlers/telegram/index.js';
import type { Env } from '../../../src/types.js';

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  DB: {} as Env['DB'],
  DAEMON_BRIDGE: {} as Env['DAEMON_BRIDGE'],
  RATE_LIMITER: {} as Env['RATE_LIMITER'],
  JWT_SIGNING_KEY: 'key',
  DISCORD_PUBLIC_KEY: '',
  DISCORD_BOT_TOKEN: '',
  DISCORD_APP_ID: '',
  TELEGRAM_BOT_TOKEN: 'tg-bot-token',
  TELEGRAM_SECRET_TOKEN: 'super-secret',
  FEISHU_APP_ID: '',
  FEISHU_APP_SECRET: '',
  FEISHU_ENCRYPT_KEY: '',
  FEISHU_VERIFICATION_TOKEN: '',
  ...overrides,
});

describe('TelegramHandler', () => {
  let handler: TelegramHandler;

  beforeEach(() => {
    handler = new TelegramHandler();
  });

  describe('getCapabilities()', () => {
    it('returns valid capabilities', () => {
      const caps = handler.getCapabilities();
      expect(caps.maxMessageLength).toBe(4096);
      expect(caps.requiredEnvVars).toContain('TELEGRAM_BOT_TOKEN');
      expect(caps.requiredEnvVars).toContain('TELEGRAM_SECRET_TOKEN');
    });
  });

  describe('verifyInbound()', () => {
    it('accepts request with correct secret', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'super-secret' },
        body: '{}',
      });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(true);
    });

    it('rejects request with wrong secret', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
        body: '{}',
      });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(false);
    });

    it('rejects request with no secret header', async () => {
      const req = new Request('https://x', { method: 'POST', body: '{}' });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(false);
    });
  });

  describe('normalizeInbound()', () => {
    it('normalizes a plain text message', async () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 42,
          from: { id: 111 },
          chat: { id: -100, type: 'group' },
          text: 'hello world',
        },
      };
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.platform).toBe('telegram');
      expect(msg.channelId).toBe('-100');
      expect(msg.userId).toBe('111');
      expect(msg.content).toBe('hello world');
      expect(msg.isCommand).toBe(false);
    });

    it('detects /commands', async () => {
      const update = {
        update_id: 2,
        message: {
          message_id: 43,
          from: { id: 222 },
          chat: { id: 999, type: 'private' },
          text: '/start my-project',
        },
      };
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('start');
      expect(msg.args).toEqual(['my-project']);
    });
  });

  describe('sendOutbound()', () => {
    it('calls Telegram Bot API', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'telegram', channelId: '-100', content: 'hi' },
        makeEnv(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('api.telegram.org/bot');
      expect(url).toContain('/sendMessage');

      vi.unstubAllGlobals();
    });
  });
});
