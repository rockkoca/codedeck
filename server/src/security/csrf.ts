/**
 * CSRF protection middleware.
 * Required after switching browser auth from Bearer to HttpOnly cookie.
 *
 * Protection strategy (double-submit cookie):
 * - On login: server sets rcc_csrf cookie (non-HttpOnly, readable by JS)
 * - Frontend: attaches X-CSRF-Token header on every non-GET request
 * - Middleware: verifies header == cookie and Origin is trusted
 *
 * Skip conditions (no CSRF check):
 * - Safe methods: GET, HEAD, OPTIONS
 * - Bearer auth: Authorization header present → API key / daemon / CLI path
 */

import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const method = c.req.method.toUpperCase();

    // Safe methods pass through
    if (SAFE_METHODS.has(method)) return next();

    // Bearer auth (API key, daemon, CLI) skips CSRF — not a browser session
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) return next();

    const sessionCookie = getCookie(c, 'rcc_session');
    const rawOrigin = c.req.header('Origin') ?? c.req.header('Referer');

    if (sessionCookie) {
      // Cookie-authenticated browser request:
      // 1. Require origin presence (missing origin → 403 in production)
      // 2. Exact origin match (no prefix matching — prevents subdomain bypass)
      // 3. Double-submit CSRF token must match
      if (!rawOrigin) {
        if (c.env.NODE_ENV !== 'development') {
          return c.json({ error: 'csrf_rejected', reason: 'missing_origin' }, 403);
        }
      } else if (!validateOrigin(rawOrigin, c.env)) {
        return c.json({ error: 'csrf_rejected', reason: 'invalid_origin' }, 403);
      }

      const csrfCookie = getCookie(c, 'rcc_csrf');
      const csrfHeader = c.req.header('X-CSRF-Token');
      if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        return c.json({ error: 'csrf_rejected', reason: 'token_mismatch' }, 403);
      }
    } else if (rawOrigin) {
      // No cookie session but Origin present — still validate it
      if (!validateOrigin(rawOrigin, c.env)) {
        return c.json({ error: 'csrf_rejected', reason: 'invalid_origin' }, 403);
      }
    }

    return next();
  };
}

function validateOrigin(rawOrigin: string, env: Env): boolean {
  // Normalize to protocol+host to handle Referer (which includes path) and
  // prevent prefix-bypass attacks (e.g. https://app.example.com.evil.tld).
  let normalized: string;
  try {
    const url = new URL(rawOrigin);
    normalized = `${url.protocol}//${url.host}`;
  } catch {
    return false;
  }

  if (!env.ALLOWED_ORIGINS) {
    // Development: allow all when ALLOWED_ORIGINS is unset
    return env.NODE_ENV === 'development';
  }

  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  // Exact match only — no startsWith to prevent subdomain prefix bypass
  return allowed.some((a) => normalized === a);
}
