import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { passkeyLoginBegin, passkeyLoginComplete, passkeyRegisterBegin, passkeyRegisterComplete } from '../api.js';

interface Props {
  onLogin?: () => void;
}

export function LoginPage({ onLogin }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'buttons' | 'register'>('buttons');
  const [displayName, setDisplayName] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGithub = () => {
    const params = new URLSearchParams({ reauth: '1', origin: window.location.origin });
    window.location.href = `/api/auth/github?${params}`;
  };

  const handlePasskeyLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const beginRes = await passkeyLoginBegin();
      const { challengeId, ...options } = beginRes;
      const authResponse = await startAuthentication(options as never);
      await passkeyLoginComplete(challengeId, authResponse);
      onLogin?.();
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('cancelled') && !msg.includes('NotAllowedError')) {
        setError(t('login.passkey_error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyRegister = async () => {
    if (!displayName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const beginRes = await passkeyRegisterBegin(displayName.trim());
      const { challengeId, ...options } = beginRes;
      const regResponse = await startRegistration(options as never);
      await passkeyRegisterComplete(challengeId, regResponse, deviceName.trim() || undefined);
      onLogin?.();
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('cancelled') && !msg.includes('NotAllowedError')) {
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
            {/* Passkey login */}
            <button
              class="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}
              onClick={handlePasskeyLogin}
              disabled={loading}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2C9.24 2 7 4.24 7 7c0 2.08 1.26 3.86 3.08 4.63L9 22h6l-1.08-10.37C15.74 10.86 17 9.08 17 7c0-2.76-2.24-5-5-5z"/>
                <circle cx="12" cy="7" r="2"/>
              </svg>
              {loading ? t('common.loading') : t('login.passkey_signin')}
            </button>

            {/* Create account with passkey */}
            <button
              class="btn btn-secondary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 }}
              onClick={() => { setMode('register'); setError(null); }}
              disabled={loading}
            >
              {t('login.passkey_create')}
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: '#334155' }} />
              <span style={{ color: '#64748b', fontSize: 12 }}>{t('login.or')}</span>
              <div style={{ flex: 1, height: 1, background: '#334155' }} />
            </div>

            {/* GitHub OAuth */}
            <button
              class="btn btn-ghost"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              onClick={handleGithub}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              {t('login.github_signin')}
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
              onClick={handlePasskeyRegister}
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
