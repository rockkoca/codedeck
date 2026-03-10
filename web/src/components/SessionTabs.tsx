import type { SessionInfo } from '../types.js';

interface Props {
  sessions: SessionInfo[];
  activeSession: string | null;
  onSelect: (sessionName: string) => void;
}

export function SessionTabs({ sessions, activeSession, onSelect }: Props) {
  if (sessions.length === 0) {
    return (
      <div class="tab-bar" style={{ padding: '8px 16px', color: '#64748b', fontSize: '12px' }}>
        No active sessions
      </div>
    );
  }

  return (
    <div class="tab-bar" role="tablist">
      {sessions.map((s) => {
        const isBrain = s.role === 'brain';
        const stateClass = s.state === 'running' ? 'busy' : s.state === 'idle' ? 'idle' : '';
        const classes = [
          'tab',
          isBrain ? 'brain' : '',
          s.name === activeSession ? 'active' : '',
          stateClass,
        ].filter(Boolean).join(' ');

        return (
          <button
            key={s.name}
            class={classes}
            role="tab"
            aria-selected={s.name === activeSession}
            onClick={() => onSelect(s.name)}
            title={`${s.agentType} — ${s.state}`}
          >
            {isBrain ? `🧠 ${s.project}` : `W${s.name.split('_w')[1] ?? '?'}`}
          </button>
        );
      })}
    </div>
  );
}
