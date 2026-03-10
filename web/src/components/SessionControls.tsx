import { useState } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';

interface Props {
  ws: WsClient | null;
  activeSession: SessionInfo | null;
  latencyMs?: number | null;
}

export function SessionControls({ ws, activeSession, latencyMs }: Props) {
  const [input, setInput] = useState('');

  const latencyColor = latencyMs == null ? '#94a3b8'
    : latencyMs < 150 ? '#22c55e'
    : latencyMs < 400 ? '#f59e0b'
    : '#ef4444';

  const handleSend = () => {
    if (!input.trim() || !ws || !activeSession) return;
    ws.sendSessionCommand('send', {
      sessionName: activeSession.name,
      text: input.trim(),
    });
    setInput('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const [confirmRestart, setConfirmRestart] = useState(false);

  const handleRestartClick = () => {
    if (!ws || !activeSession) return;
    if (confirmRestart) {
      ws.sendSessionCommand('restart', { project: activeSession.project });
      setConfirmRestart(false);
    } else {
      setConfirmRestart(true);
      setTimeout(() => setConfirmRestart(false), 3000);
    }
  };

  const disabled = !ws?.connected || !activeSession;

  return (
    <div class="controls">
      <input
        type="text"
        placeholder={disabled ? 'Not connected' : `Send to ${activeSession?.name ?? 'session'}…`}
        value={input}
        onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label="Message input"
      />
      <button
        class="btn btn-primary"
        onClick={handleSend}
        disabled={disabled || !input.trim()}
      >
        Send
      </button>
      <button
        class={`btn ${confirmRestart ? 'btn-danger' : 'btn-secondary'}`}
        onClick={handleRestartClick}
        disabled={disabled}
        title={confirmRestart ? 'Click again to confirm restart' : 'Restart session'}
      >
        {confirmRestart ? 'Confirm?' : 'Restart'}
      </button>
      <span style={{ marginLeft: 8, fontSize: 12, fontFamily: 'monospace', color: latencyColor, minWidth: 56, whiteSpace: 'nowrap' }}>
        ⏱ {latencyMs != null ? `${latencyMs}ms` : '—'}
      </span>
    </div>
  );
}
