/**
 * NativeAuthBridge — rendered inside ASWebAuthenticationSession for passkey auth.
 *
 * URL: https://<server>/?native_callback=codedeck%3A%2F%2Fauth
 *
 * Flow:
 *   1. User taps passkey button → WebAuthn runs in Safari at server origin
 *   2. On success, form-POSTs to /login/complete?native_callback=codedeck://auth
 *   3. Server verifies, issues API key, responds with HTTP 302 → codedeck://auth?key=...
 *   4. ASWebAuthenticationSession detects custom-scheme redirect and closes
 *   5. Native app receives the callback URL with the API key
 */
import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { passkeyLoginBegin, passkeyRegisterBegin } from '../api.js';

interface Props {
  callbackUrl: string; // e.g. "codedeck://auth"
}

export function NativeAuthBridge({ callbackUrl }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<'buttons' | 'register'>('buttons');
  const [displayName, setDisplayName] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [autoTriggered, setAutoTriggered] = useState(false);

  /**
   * Submit via hidden form POST. The browser navigates to the endpoint,
   * server responds with 302 to codedeck://auth?key=..., and
   * ASWebAuthenticationSession detects the custom scheme redirect.
   * (fetch() cannot follow redirects to custom URL schemes — "Load failed")
   */
  const submitViaForm = (endpoint: string, data: Record<string, unknown>) => {
    setStatus('Redirecting...');
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = endpoint;
    form.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'json';
    input.value = JSON.stringify(data);
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  };

  const doLogin = async (source: string) => {
    setLoading(true);
    setError(null);
    setStatus('Getting challenge...');
    try {
      const beginRes = await passkeyLoginBegin();
      const { challengeId, ...options } = beginRes;
      setStatus('Authenticating...');
      const authResponse = await startAuthentication(options as never);
      // Form POST → server 302 redirects to codedeck://auth?key=...
      const cb = encodeURIComponent(callbackUrl);
      submitViaForm(
        `/api/auth/passkey/login/complete?native_callback=${cb}`,
        { challengeId, response: authResponse },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotAllowedError') || msg.toLowerCase().includes('not allowed')) {
        if (source === 'auto') {
          setStatus(null);
        } else {
          setError(t('login.passkey_not_found'));
        }
      } else if (!msg.toLowerCase().includes('cancel')) {
        setError(`[DEBUG ${source}] ${msg}`);
      }
      setLoading(false);
    }
    // No finally setLoading(false) — form submission navigates away
  };

  useEffect(() => {
    if (autoTriggered) return;
    setAutoTriggered(true);
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'register') {
      setMode('register');
      return;
    }
    doLogin('auto');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRegister = async () => {
    if (!displayName.trim()) return;
    setLoading(true);
    setError(null);
    setStatus('Creating passkey...');
    try {
      const beginRes = await passkeyRegisterBegin(displayName.trim());
      const { challengeId, ...options } = beginRes;
      setStatus('Registering...');
      const regResponse = await startRegistration(options as never);
      // Form POST → server issues API key + 302 redirects
      const cb = encodeURIComponent(callbackUrl);
      submitViaForm(
        `/api/auth/passkey/register/complete?native_callback=${cb}`,
        { challengeId, response: regResponse, deviceName: deviceName.trim() || undefined },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('cancel')) {
        setError(`[DEBUG reg] ${msg}`);
      }
      setLoading(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <h1>Codedeck</h1>
        <p style={{ color: '#94a3b8', marginBottom: 24, textAlign: 'center' }}>
          {t('login.subtitle')}
        </p>

        {status && (
          <div style={{ color: '#60a5fa', marginBottom: 12, textAlign: 'center', fontSize: 12, fontFamily: 'monospace' }}>
            {status}
          </div>
        )}

        {error && (
          <div style={{ color: '#f87171', marginBottom: 16, textAlign: 'center', fontSize: 14, wordBreak: 'break-all' }}>
            {error}
          </div>
        )}

        {mode === 'buttons' && (
          <>
            <button
              class="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}
              onClick={() => doLogin('tap')}
              disabled={loading}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2C9.24 2 7 4.24 7 7c0 2.08 1.26 3.86 3.08 4.63L9 22h6l-1.08-10.37C15.74 10.86 17 9.08 17 7c0-2.76-2.24-5-5-5z"/>
                <circle cx="12" cy="7" r="2"/>
              </svg>
              {loading ? t('common.loading') : t('login.passkey_signin')}
            </button>
            <button
              class="btn btn-secondary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              onClick={() => { setMode('register'); setError(null); setStatus(null); }}
              disabled={loading}
            >
              {t('login.passkey_create')}
            </button>
          </>
        )}

        {mode === 'register' && (
          <>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>
              {t('login.passkey_register_hint')}
            </p>
            <input
              class="input"
              style={{ width: '100%', marginBottom: 10, boxSizing: 'border-box' }}
              type="text"
              placeholder={t('login.display_name_placeholder')}
              value={displayName}
              onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              maxLength={100}
              autoFocus
            />
            <input
              class="input"
              style={{ width: '100%', marginBottom: 16, boxSizing: 'border-box' }}
              type="text"
              placeholder={t('login.device_name_placeholder')}
              value={deviceName}
              onInput={(e) => setDeviceName((e.target as HTMLInputElement).value)}
              maxLength={100}
            />
            <button
              class="btn btn-primary"
              style={{ width: '100%', marginBottom: 10 }}
              onClick={handleRegister}
              disabled={loading || !displayName.trim()}
            >
              {loading ? t('common.loading') : t('login.passkey_register_btn')}
            </button>
            <button
              class="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => { setMode('buttons'); setError(null); setStatus(null); }}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
