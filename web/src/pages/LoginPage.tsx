import { useState } from 'preact/hooks';

interface AuthState {
  token: string;
  serverId: string;
  serverUrl: string;
}

interface Props {
  onLogin: (state: AuthState) => void;
}

export function LoginPage({ onLogin }: Props) {
  const [serverUrl, setServerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e?: Event) => {
    e?.preventDefault();
    if (!serverUrl.trim() || !apiKey.trim()) {
      setError('Server URL and API key are required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const url = serverUrl.trim().replace(/\/$/, '');
      const res = await fetch(`${url}/api/auth/user/me`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });

      if (!res.ok) {
        setError(`Authentication failed (${res.status})`);
        return;
      }

      const data = await res.json<{ id: string }>();
      onLogin({ token: apiKey.trim(), serverId: data.id, serverUrl: url });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void handleSubmit();
  };

  return (
    <div class="login-page">
      <form class="login-card" onSubmit={handleSubmit}>
        <h1>Remote Chat CLI</h1>

        <div class="form-group">
          <label for="serverUrl">Worker URL</label>
          <input
            id="serverUrl"
            type="url"
            placeholder="https://rcc.example.workers.dev"
            value={serverUrl}
            onInput={(e) => setServerUrl((e.target as HTMLInputElement).value)}
            onKeyDown={handleKey}
            required
            autoFocus
          />
        </div>

        <div class="form-group">
          <label for="apiKey">API Key</label>
          <input
            id="apiKey"
            type="password"
            placeholder="rcc_..."
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            onKeyDown={handleKey}
            required
          />
        </div>

        {error && (
          <p style={{ color: '#f87171', fontSize: 13, margin: '0 0 16px' }} role="alert">
            {error}
          </p>
        )}

        <button class="btn btn-primary" type="submit" disabled={loading}>
          {loading ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
