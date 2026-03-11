/**
 * Auth lockout: 5 failed attempts → 15 min lockout per user/IP.
 * Uses MemoryRateLimiter for in-process tracking (replaces CF RateLimiter DO).
 */
import { MemoryRateLimiter } from '../ws/rate-limiter.js';
import logger from '../util/logger.js';

export type { LockoutResult } from '../ws/rate-limiter.js';

/** Singleton rate limiter used across auth routes. */
export const rateLimiter = new MemoryRateLimiter();

/**
 * Record an auth failure for an identity (user_id or IP).
 * Returns whether the identity is now locked out.
 */
export function recordAuthFailure(
  identity: string,
): { locked: boolean; lockedUntil?: number } {
  const result = rateLimiter.recordAuthFailure(identity);

  if (result.locked) {
    logger.warn({ identity }, 'Auth identity locked out');
  }

  return result;
}

/**
 * Check if an identity is currently locked out.
 */
export function checkAuthLockout(
  identity: string,
): { locked: boolean; lockedUntil?: number } {
  return rateLimiter.checkLockout(identity);
}
