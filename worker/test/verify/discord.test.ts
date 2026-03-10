import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordHandler } from '../../src/platform/handlers/discord/index.js';

function makeRequest(headers: Record<string, string>, body = '{}'): Request {
  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('DiscordHandler.verifyInbound', () => {
  let handler: DiscordHandler;

  beforeEach(() => {
    handler = new DiscordHandler();
    vi.unstubAllGlobals();
  });

  it('returns false when both signature headers are missing', async () => {
    const req = makeRequest({});
    const env = { DISCORD_PUBLIC_KEY: 'aabbcc' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false when X-Signature-Ed25519 is missing', async () => {
    const req = makeRequest({ 'X-Signature-Timestamp': '12345' });
    const env = { DISCORD_PUBLIC_KEY: 'aabbcc' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false when X-Signature-Timestamp is missing', async () => {
    const req = makeRequest({ 'X-Signature-Ed25519': 'deadbeef' });
    const env = { DISCORD_PUBLIC_KEY: 'aabbcc' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns false for invalid/garbage signature values', async () => {
    // Both headers present but signature is invalid — crypto.subtle.verify will fail
    const mockSubtle = {
      importKey: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue(false),
    };
    vi.stubGlobal('crypto', { subtle: mockSubtle });

    const req = makeRequest({
      'X-Signature-Ed25519': 'deadbeef',
      'X-Signature-Timestamp': '12345',
    });
    const env = { DISCORD_PUBLIC_KEY: 'aabb' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('returns true when crypto.subtle.verify returns true', async () => {
    const mockSubtle = {
      importKey: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal('crypto', { subtle: mockSubtle });

    const req = makeRequest({
      'X-Signature-Ed25519': 'deadbeef',
      'X-Signature-Timestamp': '12345',
    });
    const env = { DISCORD_PUBLIC_KEY: 'aabb' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(true);
  });

  it('returns false if crypto.subtle.importKey throws', async () => {
    const mockSubtle = {
      importKey: vi.fn().mockRejectedValue(new Error('bad key')),
      verify: vi.fn(),
    };
    vi.stubGlobal('crypto', { subtle: mockSubtle });

    const req = makeRequest({
      'X-Signature-Ed25519': 'deadbeef',
      'X-Signature-Timestamp': '12345',
    });
    const env = { DISCORD_PUBLIC_KEY: 'aabb' } as any;
    const result = await handler.verifyInbound(req, env);
    expect(result).toBe(false);
  });

  it('getCapabilities returns expected Discord config', () => {
    const caps = handler.getCapabilities();
    expect(caps.maxMessageLength).toBe(2000);
    expect(caps.requiredEnvVars).toContain('DISCORD_PUBLIC_KEY');
    expect(caps.supportsMarkdown).toBe(true);
  });
});
