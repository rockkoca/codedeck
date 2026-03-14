import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { createUser, getUserByPlatformId, upsertPlatformIdentity } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';

export const githubAuthRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// GET /api/auth/github — redirect to GitHub OAuth
// ?reauth=1 → forces GitHub login page (prevents auto-login after logout)
githubAuthRoutes.get('/', async (c): Promise<Response> => {
  // Enhanced origin detection:
  // 1. X-Forwarded-Host (set by your HK proxy)
  // 2. Host header (direct or standard proxy)
  // 3. Referer (if this is a navigation from the login page)
  const forwardedHost = c.req.header('x-forwarded-host');
  const currentHost = c.req.header('host');
  const referer = c.req.header('referer');
  
  let detectedHost = forwardedHost ?? currentHost;
  
  // If we suspect we are being proxied to the main domain (Cloudflare setup),
  // check if referer gives us a hint of the original domain.
  if (referer && detectedHost === new URL(c.env.SERVER_URL).host) {
    try {
      const refUrl = new URL(referer);
      // Only trust the referer if it's an allowed origin
      const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim());
      const refOrigin = `${refUrl.protocol}//${refUrl.host}`;
      if (allowed.includes(refOrigin)) {
        detectedHost = refUrl.host;
      }
    } catch { /* ignore invalid referer */ }
  }

  const protocol = c.env.NODE_ENV === 'production' ? 'https' : (c.req.header('x-forwarded-proto') ?? 'http');
  const origin = detectedHost ? `${protocol}://${detectedHost}` : c.env.SERVER_URL;

  // Task 3: state = JWT containing nonce; nonce also stored in HttpOnly cookie for binding
  const stateValue = randomHex(32);
  const stateJwt = signJwt({ nonce: stateValue, origin }, c.env.JWT_SIGNING_KEY, 600);

  const isSecure = c.env.NODE_ENV === 'production' || protocol === 'https';
  setCookie(c, 'oauth_state', stateValue, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/api/auth/github/callback',
    maxAge: 600,
  });

  const oauthParams = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID ?? '',
    redirect_uri: `${c.env.SERVER_URL}/api/auth/github/callback`,
    scope: 'read:user',
    state: stateJwt,
  });

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (c.req.query('reauth') === '1') {
    const returnTo = `/login/oauth/authorize?${oauthParams.toString()}`;
    return c.redirect(`https://github.com/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  return c.redirect(`https://github.com/login/oauth/authorize?${oauthParams.toString()}`);
});

// GET /api/auth/github/callback — handle OAuth callback
githubAuthRoutes.get('/callback', async (c): Promise<Response> => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const relayToken = c.req.query('relay_token');

  let userId: string;
  let targetOrigin: string | null = null;

  if (relayToken) {
    // --- Relay Flow: We are on the target domain, finishing auth started elsewhere ---
    const payload = verifyJwt(relayToken, c.env.JWT_SIGNING_KEY);
    if (!payload || payload.type !== 'auth-relay' || !payload.sub) {
      return c.json({ error: 'invalid_relay_token' }, 401);
    }
    userId = payload.sub as string;
  } else {
    // --- Standard Flow: Handling code/state from GitHub ---
    if (!code || !state) {
      return c.json({ error: 'missing_params' }, 400);
    }

    // Task 3: verify state JWT + cookie binding (one-time use)
    const cookieState = getCookie(c, 'oauth_state');
    const statePayload = verifyJwt(state, c.env.JWT_SIGNING_KEY) as { nonce: string; origin?: string } | null;
    if (!cookieState || !statePayload || statePayload.nonce !== cookieState) {
      return c.json({ error: 'state_mismatch' }, 400);
    }
    // Consume the state cookie immediately (one-time use)
    deleteCookie(c, 'oauth_state', { path: '/api/auth/github/callback' });

    targetOrigin = statePayload.origin ?? null;

    // Exchange code for GitHub access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      return c.json({ error: 'token_exchange_failed' }, 502);
    }

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return c.json({ error: 'no_access_token' }, 502);
    }

    // Fetch GitHub user
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'codedeck',
        Accept: 'application/vnd.github+json',
      },
    });

    if (!userRes.ok) {
      return c.json({ error: 'github_user_fetch_failed' }, 502);
    }

    const githubUser = await userRes.json() as { id: number; login: string };

    // Find or create user
    let user = await getUserByPlatformId(c.env.DB, 'github', String(githubUser.id));
    if (!user) {
      user = await createUser(c.env.DB, randomHex(16));
      await upsertPlatformIdentity(c.env.DB, randomHex(16), user.id, 'github', String(githubUser.id));
    }
    userId = user.id;

    // If targetOrigin is different from current domain, relay back to it
    const currentHost = c.req.header('host');
    if (targetOrigin && new URL(targetOrigin).host !== currentHost) {
      const relay = signJwt({ sub: userId, type: 'auth-relay' }, c.env.JWT_SIGNING_KEY, 30);
      return c.redirect(`${targetOrigin}/api/auth/github/callback?relay_token=${relay}`);
    }
  }

  const protocol = c.env.NODE_ENV === 'production' ? 'https' : (c.req.header('x-forwarded-proto') ?? 'http');
  const isSecure = c.env.NODE_ENV === 'production' || protocol === 'https';

  // Task 5: Issue 15-minute access token
  const accessToken = signJwt({ sub: userId, type: 'web' }, c.env.JWT_SIGNING_KEY, 15 * 60);

  // Task 5: Issue refresh token and persist to DB
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = randomHex(16);
  const refreshId = randomHex(16);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(refreshId, userId, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()).run();

  // Task 1: Deliver tokens via HttpOnly cookies
  setCookie(c, 'rcc_session', accessToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 900,
  });
  setCookie(c, 'rcc_refresh', refreshRaw, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/api/auth/refresh',
    maxAge: 30 * 86400,
  });
  setCookie(c, 'rcc_csrf', randomHex(32), {
    httpOnly: false,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  // Final redirect back to origin
  return c.redirect(targetOrigin ?? c.env.SERVER_URL);
});
