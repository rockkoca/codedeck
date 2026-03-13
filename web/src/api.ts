/**
 * Fetch wrapper with cookie-based auth for the Codedeck API.
 * Credentials (rcc_session) are sent automatically via HttpOnly cookie.
 * CSRF token is read from the rcc_csrf cookie and sent as X-CSRF-Token.
 */

let _baseUrl = '';

export function configure(baseUrl: string): void {
  _baseUrl = baseUrl.replace(/\/$/, '');
}

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)rcc_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Single-flight lock: at most one refresh in progress at a time.
let refreshPromise: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  // Use rawFetch so the CSRF token is automatically attached
  const res = await rawFetch('/api/auth/refresh', { method: 'POST' });
  return res.ok;
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
    // Single-flight: multiple concurrent 401s share one refresh attempt
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
    }
    const ok = await refreshPromise;
    if (ok) {
      const retryRes = await rawFetch(path, opts);
      if (!retryRes.ok) {
        const body = await retryRes.text().catch(() => '');
        throw new ApiError(retryRes.status, body);
      }
      return retryRes.json() as Promise<T>;
    }
    // Refresh failed — session expired, redirect to login
    window.location.href = '/';
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
}

export async function listSubSessions(serverId: string): Promise<SubSessionData[]> {
  const res = await apiFetch<{ subSessions: Array<{
    id: string; server_id: string; type: string; shell_bin: string | null;
    cwd: string | null; label: string | null; closed_at: number | null;
    created_at: number; updated_at: number; cc_session_id: string | null;
  }> }>(`/api/server/${serverId}/sub-sessions`);
  return res.subSessions.map((s) => ({
    id: s.id, serverId: s.server_id, type: s.type,
    shellBin: s.shell_bin, cwd: s.cwd, label: s.label,
    closedAt: s.closed_at, createdAt: s.created_at, updatedAt: s.updated_at,
    ccSessionId: s.cc_session_id,
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
