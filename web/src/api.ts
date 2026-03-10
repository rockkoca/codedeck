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
