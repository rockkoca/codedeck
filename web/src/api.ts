/**
 * Fetch wrapper with cookie-based auth for the Codedeck API.
 * Credentials (rcc_session) are sent automatically via HttpOnly cookie.
 * CSRF token is read from the rcc_csrf cookie and sent as X-CSRF-Token.
 */

let _baseUrl = '';
let _onAuthExpired: (() => void) | null = null;

export function configure(baseUrl: string): void {
  _baseUrl = baseUrl.replace(/\/$/, '');
}

/** Register a callback invoked when the session expires and refresh fails. */
export function onAuthExpired(cb: () => void): void {
  _onAuthExpired = cb;
}

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)rcc_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Single-flight lock: at most one refresh in progress at a time.
let refreshPromise: Promise<boolean> | null = null;

// Track the last successful refresh timestamp to rate-limit proactive refreshes.
// This prevents the double-refresh on startup (auth state changes twice) and
// excessive token rotation from frequent visibility-change events.
let _lastRefreshAt = 0;

async function doRefresh(): Promise<boolean> {
  const hasCsrf = !!getCsrfToken();
  const hasSession = document.cookie.includes('rcc_session');
  const hasRefresh = document.cookie.includes('rcc_refresh');
  console.warn(`[auth] doRefresh: cookies present: session=${hasSession} refresh=${hasRefresh} csrf=${hasCsrf}`);

  // Use rawFetch so the CSRF token is automatically attached
  const res = await rawFetch('/api/auth/refresh', { method: 'POST' });
  // 5xx means server is temporarily unavailable, not that the session expired.
  // Throw so callers can distinguish "no session" (false) from "server down" (throws).
  if (res.status >= 500) {
    const body = await res.text().catch(() => '');
    console.warn(`[auth] doRefresh: server error ${res.status}: ${body}`);
    throw new ApiError(res.status, body);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[auth] doRefresh FAILED: ${res.status}: ${body}`);
  } else {
    _lastRefreshAt = Date.now();
    console.warn(`[auth] doRefresh OK — token refreshed`);
  }
  return res.ok;
}

/** Attempt a token refresh. Returns true if successful. Exported for use by WsClient. */
export async function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/**
 * Refresh the session only if the last refresh was more than minAgeMs ago.
 * Returns true if the session is (or was already) fresh.
 * Use this for proactive/voluntary refreshes (startup, visibility-change) to avoid
 * unnecessary token rotation. For forced refreshes (401 responses) use refreshSession().
 */
export async function refreshSessionIfStale(minAgeMs = 2 * 60 * 1000): Promise<boolean> {
  if (Date.now() - _lastRefreshAt < minAgeMs) return true; // recently refreshed, skip
  return refreshSession();
}

// ── Proactive refresh ─────────────────────────────────────────────────────

let _refreshTimerId: ReturnType<typeof setInterval> | null = null;
let _retryTimerId: ReturnType<typeof setTimeout> | null = null;
const PROACTIVE_REFRESH_MS = 15 * 60 * 1000; // refresh every 15 min (well before 4-hour expiry)
const RETRY_REFRESH_MS = 30 * 1000; // retry failed refresh after 30s

/** Start proactive token refresh timer. Call when user logs in. */
export function startProactiveRefresh(): void {
  stopProactiveRefresh();
  // Refresh immediately, but only if we haven't refreshed recently.
  // This prevents the double-refresh when auth state updates twice on startup
  // (once from localStorage, again after /api/auth/user/me verification).
  void refreshSessionIfStale().then((ok) => {
    if (!ok) scheduleRetry();
  });
  _refreshTimerId = setInterval(() => {
    void refreshSession().then((ok) => {
      if (!ok) scheduleRetry();
    });
  }, PROACTIVE_REFRESH_MS);
}

/** Schedule a quick retry when proactive refresh fails (not from 401 handler). */
function scheduleRetry(): void {
  if (_retryTimerId !== null) return; // already scheduled
  _retryTimerId = setTimeout(() => {
    _retryTimerId = null;
    void refreshSession(); // single retry, no cascade
  }, RETRY_REFRESH_MS);
}

/** Stop proactive token refresh timer. Call when user logs out. */
export function stopProactiveRefresh(): void {
  if (_refreshTimerId !== null) {
    clearInterval(_refreshTimerId);
    _refreshTimerId = null;
  }
  if (_retryTimerId !== null) {
    clearTimeout(_retryTimerId);
    _retryTimerId = null;
  }
}

async function rawFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!headers.has('Content-Type') && opts.body) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (opts.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = getCsrfToken();
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  return fetch(`${_baseUrl}${path}`, { ...opts, headers, credentials: 'include' });
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await rawFetch(path, opts);

  if (res.status === 401 && path !== '/api/auth/refresh') {
    console.warn(`[auth] 401 on ${path} — attempting refresh`);
    // Try to refresh the token (with one retry on failure).
    // A single failure might be transient (e.g., CSRF mismatch after cookie rotation).
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!refreshPromise) {
        refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
      }
      let ok: boolean;
      try {
        ok = await refreshPromise;
      } catch {
        // Refresh threw (5xx or network error) — server unavailable, not session expired.
        throw new ApiError(503, 'server_unavailable');
      }
      if (ok) {
        const retryRes = await rawFetch(path, opts);
        if (!retryRes.ok) {
          const body = await retryRes.text().catch(() => '');
          throw new ApiError(retryRes.status, body);
        }
        return retryRes.json() as Promise<T>;
      }
      // First attempt failed — wait briefly and retry once (cookies may have been updated)
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // Both attempts failed — session truly expired
    console.warn(`[auth] LOGOUT: refresh failed twice for ${path}, triggering onAuthExpired`);
    _onAuthExpired?.();
    throw new ApiError(401, 'session_expired');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

// ── Sub-session API ───────────────────────────────────────────────────────

export interface SubSessionData {
  id: string;
  serverId: string;
  type: string;
  shellBin?: string | null;
  cwd?: string | null;
  label?: string | null;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  ccSessionId?: string | null;
  geminiSessionId?: string | null;
}

export async function listSubSessions(serverId: string): Promise<SubSessionData[]> {
  const res = await apiFetch<{ subSessions: Array<{
    id: string; server_id: string; type: string; shell_bin: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
    gemini_session_id: string | null;
  }> }>(`/api/server/${serverId}/sub-sessions`);
  return res.subSessions.map((s) => ({
    id: s.id, serverId: s.server_id, type: s.type,
    shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
    closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
    ccSessionId: s.cc_session_id,
    geminiSessionId: s.gemini_session_id,
  }));
}

export async function createSubSession(
  serverId: string,
  body: { type: string; shellBin?: string; cwd?: string; label?: string; ccSessionId?: string },
): Promise<{ id: string; sessionName: string; subSession: SubSessionData }> {
  const res = await apiFetch<{ id: string; sessionName: string; subSession: {
    id: string; server_id: string; type: string; shell_bin: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
  } }>(`/api/server/${serverId}/sub-sessions`, {
    method: 'POST',
    body: JSON.stringify({ ...body, cc_session_id: body.ccSessionId ?? null }),
  });
  const s = res.subSession;
  return {
    id: res.id,
    sessionName: res.sessionName,
    subSession: {
      id: s.id, serverId: s.server_id, type: s.type,
      shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
      closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
      ccSessionId: s.cc_session_id,
    },
  };
}

export async function patchSubSession(
  serverId: string,
  subId: string,
  body: { label?: string | null; closedAt?: number | null },
): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sub-sessions/${subId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteSubSession(serverId: string, subId: string): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sub-sessions/${subId}`, { method: 'DELETE' });
}

// ── User preferences ───────────────────────────────────────────────────────

export async function getUserPref(key: string): Promise<unknown | null> {
  try {
    const res = await apiFetch<{ value: unknown }>(`/api/preferences/${key}`);
    return res.value ?? null;
  } catch {
    return null;
  }
}

export async function saveUserPref(key: string, value: unknown): Promise<void> {
  await apiFetch(`/api/preferences/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}
