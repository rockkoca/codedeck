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

  const handleStop = () => {
    if (!ws || !activeSession) return;
    ws.sendSessionCommand('stop', { session: activeSession.name });
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
        class="btn btn-danger"
        onClick={handleStop}
        disabled={disabled}
        title="Stop session"
      >
        Stop
      </button>
      <span style={{ marginLeft: 8, fontSize: 12, fontFamily: 'monospace', color: latencyColor, minWidth: 56, whiteSpace: 'nowrap' }}>
        ⏱ {latencyMs != null ? `${latencyMs}ms` : '—'}
      </span>
    </div>
  );
}
