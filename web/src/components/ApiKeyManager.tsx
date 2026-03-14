import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';

interface KeyInfo {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

interface Props {
  keys: KeyInfo[];
  onKeysChanged: () => void;
}

export function ApiKeyManager({ keys, onKeysChanged }: Props) {
  const { t } = useTranslation();
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const body = newLabel.trim() ? { label: newLabel.trim() } : {};
      const res = await apiFetch<{ id: string; apiKey: string }>('/api/auth/user/me/keys', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setNewKey(res.apiKey);
      setNewLabel('');
      onKeysChanged();
    } catch (err) {
      console.error('Failed to generate key:', err);
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    try {
      await apiFetch(`/api/auth/user/me/keys/${keyId}`, { method: 'DELETE' });
      onKeysChanged();
    } catch (err) {
      console.error('Failed to revoke key:', err);
    }
  };

  const handleCopy = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>API Keys</h2>

      {/* New key reveal */}
      {newKey && (
        <div style={{ background: '#1e293b', border: '1px solid #f59e0b', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ color: '#f59e0b', fontWeight: 600, marginBottom: 8 }}>Save this key — it will not be shown again</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 13, color: '#e2e8f0' }}>{newKey}</code>
            <button class="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={handleCopy}>
              {copied ? t('api_key.copied') : t('api_key.copy')}
            </button>
          </div>
          <button class="btn btn-secondary" style={{ marginTop: 8, fontSize: 12 }} onClick={() => setNewKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Generate new key */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          placeholder={t('api_key.label_placeholder')}
          value={newLabel}
          onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0' }}
        />
        <button class="btn btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? t('api_key.generating') : t('api_key.generate')}
        </button>
      </div>

      {/* Key list */}
      {keys.length === 0 ? (
        <div style={{ color: '#64748b', padding: 16, textAlign: 'center' }}>No API keys yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8', fontSize: 12 }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Label</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Created</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Status</th>
              <th style={{ textAlign: 'right', padding: '8px 12px' }}></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} style={{ borderBottom: '1px solid #1e293b' }}>
                <td style={{ padding: '8px 12px', color: '#e2e8f0' }}>{k.label || '(no label)'}</td>
                <td style={{ padding: '8px 12px', color: '#94a3b8', fontSize: 13 }}>
                  {new Date(k.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {k.revokedAt ? (
                    <span style={{ color: '#ef4444', fontSize: 12 }}>Revoked</span>
                  ) : (
                    <span style={{ color: '#22c55e', fontSize: 12 }}>Active</span>
                  )}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  {!k.revokedAt && (
                    <button class="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => handleRevoke(k.id)}>
                      {t('api_key.revoke')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
