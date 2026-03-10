import { useState } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';

interface Props {
  ws: WsClient | null;
  activeSession: SessionInfo | null;
}

export function SessionControls({ ws, activeSession }: Props) {
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim() || !ws || !activeSession) return;
    ws.sendSessionCommand('send', {
      session: activeSession.name,
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
    </div>
  );
}
