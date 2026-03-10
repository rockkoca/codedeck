import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordHandler } from '../../../src/platform/handlers/discord/index.js';
import type { Env } from '../../../src/types.js';

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  DB: {} as Env['DB'],
  DAEMON_BRIDGE: {} as Env['DAEMON_BRIDGE'],
  RATE_LIMITER: {} as Env['RATE_LIMITER'],
  JWT_SIGNING_KEY: 'test-key',
  DISCORD_PUBLIC_KEY: '4b7d8ab2f1a3c6e509b1d0e2f3a4c7b8d5e6f9a0b1c2d3e4f5a6b7c8d9e0f1a2',
  DISCORD_BOT_TOKEN: 'Bot test-token',
  DISCORD_APP_ID: '123456789',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_WEBHOOK_SECRET: '',
  FEISHU_APP_ID: '',
  FEISHU_APP_SECRET: '',
  FEISHU_ENCRYPT_KEY: '',
  FEISHU_VERIFICATION_TOKEN: '',
  ...overrides,
});

describe('DiscordHandler', () => {
  let handler: DiscordHandler;

  beforeEach(() => {
    handler = new DiscordHandler();
  });

  describe('getCapabilities()', () => {
    it('returns valid capabilities', () => {
      const caps = handler.getCapabilities();
      expect(caps.maxMessageLength).toBe(2000);
      expect(caps.supportsMarkdown).toBe(true);
      expect(caps.supportsThreadedReplies).toBe(true);
      expect(caps.requiredEnvVars).toContain('DISCORD_PUBLIC_KEY');
      expect(caps.requiredEnvVars).toContain('DISCORD_BOT_TOKEN');
      expect(caps.requiredEnvVars).toContain('DISCORD_APP_ID');
    });
  });

  describe('verifyInbound()', () => {
    it('rejects request missing headers', async () => {
      const req = new Request('https://example.com/webhook/discord', {
        method: 'POST',
        body: '{}',
      });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(false);
    });

    it('rejects request with invalid signature format', async () => {
      const req = new Request('https://example.com/webhook/discord', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'not-hex',
          'X-Signature-Timestamp': '1234567890',
        },
        body: '{}',
      });
      const result = await handler.verifyInbound(req, makeEnv());
      expect(result).toBe(false);
    });
  });

  describe('normalizeInbound()', () => {
    it('returns ping message for PING type', async () => {
      const body = { type: 1, id: 'test-id' };
      const req = new Request('https://example.com', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.platform).toBe('discord');
      expect(msg.content).toBe('__ping__');
      expect(msg.isCommand).toBe(false);
    });

    it('normalizes slash command interaction', async () => {
      const body = {
        type: 2,
        id: 'interaction-123',
        guild_id: 'guild-456',
        channel_id: 'channel-789',
        member: { user: { id: 'user-111' } },
        data: {
          name: 'send',
          options: [{ name: 'message', value: 'hello world' }],
        },
      };
      const req = new Request('https://example.com', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.platform).toBe('discord');
      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('send');
      expect(msg.channelId).toBe('guild-456:channel-789');
      expect(msg.userId).toBe('user-111');
    });

    it('uses composite channelId when guild present', async () => {
      const body = {
        type: 2,
        id: 'x',
        guild_id: 'G1',
        channel_id: 'C1',
        member: { user: { id: 'U1' } },
        data: { name: 'status', options: [] },
      };
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req);
      expect(msg.channelId).toBe('G1:C1');
    });
  });

  describe('sendOutbound()', () => {
    it('calls Discord API with correct endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'discord', channelId: 'channel-789', content: 'Hello!', formatting: 'plain' },
        makeEnv(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('discord.com/api/v10/channels/channel-789/messages');
      expect(opts.method).toBe('POST');

      vi.unstubAllGlobals();
    });

    it('splits long messages into multiple API calls', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const longMsg = 'x'.repeat(4500);
      await handler.sendOutbound(
        { platform: 'discord', channelId: 'channel-789', content: longMsg },
        makeEnv(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(3); // 4500 / 2000 = 3 chunks

      vi.unstubAllGlobals();
    });

    it('throws on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })));

      await expect(
        handler.sendOutbound({ platform: 'discord', channelId: 'c', content: 'hi' }, makeEnv()),
      ).rejects.toThrow('Discord API error 403');

      vi.unstubAllGlobals();
    });
  });
});
