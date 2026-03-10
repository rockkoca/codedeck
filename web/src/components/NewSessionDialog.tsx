import { useState } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

interface Props {
  ws: WsClient | null;
  onClose: () => void;
}

type AgentType = 'claude-code' | 'codex' | 'opencode';

export function NewSessionDialog({ ws, onClose }: Props) {
  const [project, setProject] = useState('');
  const [dir, setDir] = useState('~/');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [error, setError] = useState('');

  const handleStart = () => {
    if (!project.trim()) { setError('Project name is required'); return; }
    if (!dir.trim()) { setError('Working directory is required'); return; }
    if (!ws?.connected) { setError('Not connected'); return; }

    ws.sendSessionCommand('start', {
      project: project.trim(),
      dir: dir.trim(),
      agentType,
    });
    onClose();
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter') handleStart();
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: '#00000080',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={handleKey}
      role="dialog"
      aria-label="New session"
    >
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 24, width: 400 }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 16, color: '#f1f5f9' }}>Start New Session</h2>

        <div class="form-group">
          <label>Project name</label>
          <input
            type="text"
            placeholder="my-project"
            value={project}
            onInput={(e) => { setProject((e.target as HTMLInputElement).value); setError(''); }}
            autoFocus
          />
        </div>

        <div class="form-group">
          <label>Working directory</label>
          <input
            type="text"
            placeholder="~/projects/my-project"
            value={dir}
            onInput={(e) => setDir((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="form-group">
          <label>Agent type</label>
          <select
            value={agentType}
            onChange={(e) => setAgentType((e.target as HTMLSelectElement).value as AgentType)}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
          >
            <option value="claude-code">Claude Code (CC)</option>
            <option value="codex">Codex CLI</option>
            <option value="opencode">OpenCode</option>
          </select>
        </div>

        {error && <p style={{ color: '#f87171', fontSize: 13, margin: '0 0 12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart}>Start</button>
        </div>
      </div>
    </div>
  );
}
