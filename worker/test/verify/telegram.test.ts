import { describe, it, expect, beforeEach } from 'vitest';
import { TelegramHandler } from '../../src/platform/handlers/telegram/index.js';

function makeRequest(secretHeader: string | null, body = '{}'): Request {
  const headers: Record<string, string> = {};
  if (secretHeader !== null) {
    headers['X-Telegram-Bot-Api-Secret-Token'] = secretHeader;
  }
  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('TelegramHandler.verifyInbound', () => {
  let handler: TelegramHandler;

  beforeEach(() => {
    handler = new TelegramHandler();
  });

  it('returns true when secret matches env secret', async () => {
    const req = makeRequest('my-secret');
    const env = { TELEGRAM_SECRET_TOKEN: 'my-secret' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(true);
  });

  it('returns false when secret does not match', async () => {
    const req = makeRequest('wrong-secret');
    const env = { TELEGRAM_SECRET_TOKEN: 'correct-secret' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false when header is missing', async () => {
    const req = makeRequest(null);
    const env = { TELEGRAM_SECRET_TOKEN: 'my-secret' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false when env secret is not configured', async () => {
    const req = makeRequest('some-secret');
    const env = { TELEGRAM_SECRET_TOKEN: undefined } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false when secrets differ in length', async () => {
    const req = makeRequest('short');
    const env = { TELEGRAM_SECRET_TOKEN: 'much-longer-secret' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false for empty string secret when env has value', async () => {
    const req = makeRequest('');
    const env = { TELEGRAM_SECRET_TOKEN: 'my-secret' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('uses timing-safe comparison (same length, different content → false)', async () => {
    const req = makeRequest('aaaaaaaaa');
    const env = { TELEGRAM_SECRET_TOKEN: 'bbbbbbbbb' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('getCapabilities returns expected Telegram config', () => {
    const caps = handler.getCapabilities();
    expect(caps.maxMessageLength).toBe(4096);
    expect(caps.requiredEnvVars).toContain('TELEGRAM_BOT_TOKEN');
    expect(caps.requiredEnvVars).toContain('TELEGRAM_SECRET_TOKEN');
  });
});
