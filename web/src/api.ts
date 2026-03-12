/**
 * Fetch wrapper with Bearer token auth for the Codedeck API.
 */

let _token: string | null = null;
let _baseUrl = '';

export function configure(baseUrl: string, token: string): void {
  _baseUrl = baseUrl.replace(/\/$/, '');
  _token = token;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const headers = new Headers(opts.headers);
  if (_token) headers.set('Authorization', `Bearer ${_token}`);
  if (!headers.has('Content-Type') && opts.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${_baseUrl}${path}`, { ...opts, headers });

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
