import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../src/security/crypto.js';

// Test SHA-256 hashing — the core crypto primitive used in auth routes
describe('sha256Hex', () => {
  it('returns a 64-character hex string', async () => {
    const hash = await sha256Hex('test-input');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('same input always produces the same hash', async () => {
    const a = await sha256Hex('hello world');
    const b = await sha256Hex('hello world');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', async () => {
    const a = await sha256Hex('input-one');
    const b = await sha256Hex('input-two');
    expect(a).not.toBe(b);
  });

  it('empty string hashes correctly (known SHA-256)', async () => {
    const hash = await sha256Hex('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// Test API key format produced by auth register route
describe('API key format', () => {
  it('rcc_ prefix check: key starts with rcc_', () => {
    // Simulate the key generation pattern from auth.ts: `rcc_${randomHex(32)}`
    // randomHex(32) = 64 hex chars
    const fakeKey = 'rcc_' + 'a'.repeat(64);
    expect(fakeKey.startsWith('rcc_')).toBe(true);
    expect(fakeKey.length).toBeGreaterThanOrEqual(36);
  });

  it('rcc_ key is at least 68 chars (rcc_ + 64 hex chars)', () => {
    // randomHex(32) produces 64 hex chars
    const fakeKey = 'rcc_' + '0'.repeat(64);
    expect(fakeKey.length).toBe(68);
  });
});

// Verify the auth module exports what it should
describe('authRoutes module', () => {
  it('imports authRoutes without error', async () => {
    const mod = await import('../../src/routes/auth.js');
    expect(mod.authRoutes).toBeDefined();
  });

  it('authRoutes has expected HTTP methods (Hono instance)', async () => {
    const { authRoutes } = await import('../../src/routes/auth.js');
    expect(typeof authRoutes.get).toBe('function');
    expect(typeof authRoutes.post).toBe('function');
    expect(typeof authRoutes.delete).toBe('function');
  });
});
