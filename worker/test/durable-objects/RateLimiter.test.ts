import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../durable-objects/RateLimiter.js';

describe('RateLimiter', () => {
  it('is exported as a class', () => {
    expect(typeof RateLimiter).toBe('function');
    expect(RateLimiter.prototype).toBeDefined();
  });

  it('has a fetch method', () => {
    expect(typeof RateLimiter.prototype.fetch).toBe('function');
  });

  it('can be instantiated with a mock state and env', () => {
    const mockStorage = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    };
    const mockState = { storage: mockStorage } as any;
    const mockEnv = {} as any;
    const limiter = new RateLimiter(mockState, mockEnv);
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it('returns 400 for unknown type param', async () => {
    const mockStorage = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    };
    const mockState = { storage: mockStorage } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=unknown&key=test');
    const res = await limiter.fetch(req);
    expect(res.status).toBe(400);
  });

  it('allows msg request when under limit', async () => {
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=msg&key=user1');
    const res = await limiter.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { allowed: boolean; retryAfter: number };
    expect(body.allowed).toBe(true);
    expect(body.retryAfter).toBe(0);
  });

  it('allows bind request when under limit', async () => {
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=bind&key=user1');
    const res = await limiter.fetch(req);
    const body = await res.json() as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('returns allowed:false when msg limit is exhausted', async () => {
    // Pre-fill 30 timestamps within the window to hit MSG_LIMIT
    const now = Date.now();
    const timestamps = Array.from({ length: 30 }, () => now - 1000);
    const store = new Map<string, unknown>([['user-x', { timestamps }]]);
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=msg&key=user-x');
    const res = await limiter.fetch(req);
    const body = await res.json() as { allowed: boolean; retryAfter: number };
    expect(body.allowed).toBe(false);
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('records auth_fail and returns locked state after threshold', async () => {
    // Pre-fill 4 attempts so the 5th triggers lockout
    const storeKey = 'auth:ip-1';
    const store = new Map<string, unknown>([[storeKey, { attempts: 4 }]]);
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=auth_fail&key=ip-1');
    const res = await limiter.fetch(req);
    const body = await res.json() as { locked: boolean; lockedUntil?: number };
    expect(body.locked).toBe(true);
    expect(body.lockedUntil).toBeGreaterThan(Date.now());
  });
});
