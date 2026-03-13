import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { createUser, getUserByPlatformId, upsertPlatformIdentity } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';

export const githubAuthRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// GET /api/auth/github — redirect to GitHub OAuth
// ?reauth=1 → forces GitHub login page (prevents auto-login after logout)
githubAuthRoutes.get('/', async (c): Promise<Response> => {
  // Task 3: state = JWT containing nonce; nonce also stored in HttpOnly cookie for binding
  const stateValue = randomHex(32);
  const stateJwt = signJwt({ nonce: stateValue }, c.env.JWT_SIGNING_KEY, 600);

  const isSecure = c.env.NODE_ENV === 'production';
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

  if (!code || !state) {
    return c.json({ error: 'missing_params' }, 400);
  }

  // Task 3: verify state JWT + cookie binding (one-time use)
  const cookieState = getCookie(c, 'oauth_state');
  const statePayload = verifyJwt(state, c.env.JWT_SIGNING_KEY);
  if (!cookieState || !statePayload || statePayload.nonce !== cookieState) {
    return c.json({ error: 'state_mismatch' }, 400);
  }
  // Consume the state cookie immediately (one-time use)
  deleteCookie(c, 'oauth_state', { path: '/api/auth/github/callback' });

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

  const isSecure = c.env.NODE_ENV === 'production';

  // Task 5: Issue 15-minute access token (aligns with auth.ts refresh mechanism)
  const accessToken = signJwt({ sub: user.id, type: 'web' }, c.env.JWT_SIGNING_KEY, 15 * 60);

  // Task 5: Issue refresh token and persist to DB
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = randomHex(16);
  const refreshId = randomHex(16);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(refreshId, user.id, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()).run();

  // Task 1: Deliver tokens via HttpOnly cookies (not URL params)
  setCookie(c, 'rcc_session', accessToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 900, // 15 minutes
  });
  setCookie(c, 'rcc_refresh', refreshRaw, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/api/auth/refresh',
    maxAge: 30 * 86400,
  });
  // Task 4: CSRF token — readable by JS (not HttpOnly)
  setCookie(c, 'rcc_csrf', randomHex(32), {
    httpOnly: false,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.redirect(c.env.SERVER_URL);
});
