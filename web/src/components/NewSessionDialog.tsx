import { useState, useEffect } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

interface Props {
  ws: WsClient | null;
  onClose: () => void;
  onSessionStarted: (sessionName: string) => void;
}

type AgentType = 'claude-code' | 'codex' | 'opencode' | 'gemini';

export function NewSessionDialog({ ws, onClose, onSessionStarted }: Props) {
  const [project, setProject] = useState('');
  const [dir, setDir] = useState('~/');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  // Listen for session.event started/error while dialog is open
  useEffect(() => {
    if (!ws || !starting) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        const name = msg.session ?? '';
        if (msg.event === 'started' && name.startsWith(`deck_${project.trim()}_`)) {
          unsub();
          onSessionStarted(name);
          onClose();
        } else if (msg.event === 'error' && name.startsWith(`deck_${project.trim()}_`)) {
          unsub();
          setError(`Session failed to start: ${msg.state}`);
          setStarting(false);
        }
      }
      if (msg.type === 'session.error') {
        unsub();
        setError((msg as unknown as { message: string }).message || 'Failed to start session');
        setStarting(false);
      }
    });

    // Timeout after 15s
    const timeout = setTimeout(() => {
      unsub();
      setError('Timed out waiting for session to start. Check daemon logs.');
      setStarting(false);
    }, 15_000);

    return () => { unsub(); clearTimeout(timeout); };
  }, [starting, ws, project]);

  const handleStart = () => {
    if (!project.trim()) { setError('Project name is required'); return; }
    if (!dir.trim()) { setError('Working directory is required'); return; }
    if (!ws) { setError('Not connected to daemon'); return; }
    if (!ws.connected) { setError('Daemon is offline — check that codedeck daemon is running'); return; }

    setError('');
    setStarting(true);
    ws.sendSessionCommand('start', { project: project.trim(), dir: dir.trim(), agentType });
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !starting) onClose();
    if (e.key === 'Enter' && !starting) handleStart();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={(e) => { if (e.target === e.currentTarget && !starting) onClose(); }}
      onKeyDown={handleKey}
      role="dialog"
    >
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 24, width: 400 }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 16, color: '#f1f5f9' }}>Start New Session</h2>

        <div class="form-group">
          <label>Project name</label>
          <input
            type="text"
            placeholder="my-project"
            value={project}
            disabled={starting}
            onInput={(e) => { setProject((e.target as HTMLInputElement).value); setError(''); }}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellcheck={false}
            data-lpignore="true"
            data-1p-ignore
          />
        </div>

        <div class="form-group">
          <label>Working directory</label>
          <input
            type="text"
            placeholder="~/projects/my-project"
            value={dir}
            disabled={starting}
            onInput={(e) => setDir((e.target as HTMLInputElement).value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellcheck={false}
            data-lpignore="true"
            data-1p-ignore
          />
        </div>

        <div class="form-group">
          <label>Agent type</label>
          <select
            value={agentType}
            disabled={starting}
            onChange={(e) => setAgentType((e.target as HTMLSelectElement).value as AgentType)}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="opencode">OpenCode</option>
            <option value="gemini">Gemini CLI</option>
          </select>
        </div>

        {error && (
          <p style={{ color: '#f87171', fontSize: 13, margin: '0 0 12px', background: '#450a0a', padding: '8px 12px', borderRadius: 4, border: '1px solid #7f1d1d' }}>
            {error}
          </p>
        )}

        {starting && (
          <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 12px' }}>
            Starting session...
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button class="btn btn-secondary" onClick={onClose} disabled={starting}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart} disabled={starting}>
            {starting ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
