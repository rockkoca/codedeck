/**
 * NativeAuthBridge — rendered when the web app is opened by the native iOS app
 * inside ASWebAuthenticationSession (Safari View Controller) for passkey login.
 *
 * URL: https://<server>/?native_callback=codedeck%3A%2F%2Fauth
 *
 * Flow:
 *   1. Native app opens this page in Safari with ?native_callback=codedeck://auth
 *   2. User taps "Sign in with Passkey" — Safari handles WebAuthn at correct origin
 *   3. On success, this page calls /login/complete?native=1 to get an API key
 *   4. Redirects to codedeck://auth?key=...&userId=...&keyId=...
 *   5. Safari closes, native app receives the URL via appUrlOpen listener
 */
import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { passkeyLoginBegin, passkeyLoginCompleteNative, passkeyRegisterBegin, passkeyRegisterComplete } from '../api.js';

interface Props {
  callbackUrl: string; // e.g. "codedeck://auth"
}

export function NativeAuthBridge({ callbackUrl }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'buttons' | 'register'>('buttons');
  const [displayName, setDisplayName] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const redirectWithKey = (apiKey: string, userId: string, keyId: string) => {
    const url = new URL(callbackUrl);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('userId', userId);
    url.searchParams.set('keyId', keyId);
    window.location.href = url.toString();
  };

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const beginRes = await passkeyLoginBegin();
      const { challengeId, ...options } = beginRes;
      const authResponse = await startAuthentication(options as never);
      const res = await passkeyLoginCompleteNative(challengeId, authResponse);
      redirectWithKey(res.apiKey, res.userId, res.keyId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotAllowedError') || msg.toLowerCase().includes('not allowed')) {
        setError(t('login.passkey_not_found'));
      } else if (!msg.toLowerCase().includes('cancel')) {
        setError(t('login.passkey_error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!displayName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const beginRes = await passkeyRegisterBegin(displayName.trim());
      const { challengeId, ...options } = beginRes;
      const regResponse = await startRegistration(options as never);
      // Register completes with cookie auth; then login to get API key
      await passkeyRegisterComplete(challengeId, regResponse, deviceName.trim() || undefined);
      // After registration, do login to get the API key
      const beginRes2 = await passkeyLoginBegin();
      const { challengeId: cid2, ...opts2 } = beginRes2;
      const authResponse = await startAuthentication(opts2 as never);
      const res = await passkeyLoginCompleteNative(cid2, authResponse);
      redirectWithKey(res.apiKey, res.userId, res.keyId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('cancel')) {
        setError(t('login.passkey_error'));
      }
    } finally {
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

        {error && (
          <div style={{ color: '#f87171', marginBottom: 16, textAlign: 'center', fontSize: 14 }}>
            {error}
          </div>
        )}

        {mode === 'buttons' && (
          <>
            <button
              class="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}
              onClick={handleLogin}
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
              onClick={() => { setMode('register'); setError(null); }}
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
              onClick={() => { setMode('buttons'); setError(null); }}
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
