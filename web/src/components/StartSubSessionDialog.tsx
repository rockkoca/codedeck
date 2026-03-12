/**
 * StartSubSessionDialog — choose type (cc/codex/opencode/shell) and launch a sub-session.
 */
import { useState, useEffect } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

interface Props {
  ws: WsClient | null;
  onStart: (type: string, shellBin?: string, cwd?: string, label?: string) => void;
  onClose: () => void;
}

const AGENT_TYPES = [
  { id: 'claude-code', label: 'Claude Code', icon: '⚡' },
  { id: 'codex', label: 'Codex', icon: '📦' },
  { id: 'opencode', label: 'OpenCode', icon: '🔆' },
  { id: 'shell', label: 'Shell', icon: '🐚' },
];

const DEFAULT_SHELL_KEY = 'rcc_default_shell';

export function StartSubSessionDialog({ ws, onStart, onClose }: Props) {
  const [type, setType] = useState('claude-code');
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>(() => localStorage.getItem(DEFAULT_SHELL_KEY) ?? '');
  const [cwd, setCwd] = useState('');
  const [label, setLabel] = useState('');
  const [detectingShells, setDetectingShells] = useState(false);

  // Request shell detection from daemon
  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        setShells(msg.shells);
        setDetectingShells(false);
        // Pre-select default shell
        const saved = localStorage.getItem(DEFAULT_SHELL_KEY);
        if (saved && msg.shells.includes(saved)) {
          setShellBin(saved);
        } else if (msg.shells.length > 0 && !shellBin) {
          setShellBin(msg.shells[0]);
        }
      }
    });

    setDetectingShells(true);
    ws.subSessionDetectShells();
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const handleStart = () => {
    const selectedShell = type === 'shell' ? (shellBin || undefined) : undefined;
    if (type === 'shell' && selectedShell) {
      localStorage.setItem(DEFAULT_SHELL_KEY, selectedShell);
    }
    onStart(type, selectedShell, cwd || undefined, label || undefined);
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 380 }}>
        <div class="dialog-header">
          <span>New Sub-Session</span>
          <button class="dialog-close" onClick={onClose}>×</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Type selection */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {AGENT_TYPES.map((at) => (
                <button
                  key={at.id}
                  class={`subsession-type-btn${type === at.id ? ' active' : ''}`}
                  onClick={() => setType(at.id)}
                >
                  <span>{at.icon}</span> {at.label}
                </button>
              ))}
            </div>
          </div>

          {/* Shell binary picker (only for shell type) */}
          {type === 'shell' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Shell</div>
              {detectingShells ? (
                <div style={{ fontSize: 12, color: '#64748b' }}>Detecting shells...</div>
              ) : shells.length > 0 ? (
                <select
                  class="input"
                  value={shellBin}
                  onChange={(e) => setShellBin((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%' }}
                >
                  {shells.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <input
                  class="input"
                  placeholder="/bin/bash"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
            </div>
          )}

          {/* Working directory */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Working directory (optional)</div>
            <input
              class="input"
              placeholder="~/projects/myapp"
              value={cwd}
              onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Label (optional)</div>
            <input
              class="input"
              placeholder="e.g. backend"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart}>Launch</button>
        </div>
      </div>
    </div>
  );
}
