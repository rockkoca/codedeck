/**
 * SubSessionBar — bottom strip showing minimized sub-session cards + "+" button.
 */
import type { SubSession } from '../hooks/useSubSessions.js';

const TYPE_ICON: Record<string, string> = {
  'claude-code': '⚡',
  'codex': '📦',
  'opencode': '🔆',
  'shell': '🐚',
};

interface Props {
  subSessions: SubSession[];
  openIds: Set<string>;
  onOpen: (id: string) => void;
  onNew: () => void;
}

export function SubSessionBar({ subSessions, openIds, onOpen, onNew }: Props) {
  return (
    <div class="subsession-bar">
      {subSessions.map((sub) => {
        const label = sub.label ?? (sub.type === 'shell'
          ? (sub.shellBin?.split('/').pop() ?? 'shell')
          : sub.type);
        const icon = TYPE_ICON[sub.type] ?? '⚡';
        const isOpen = openIds.has(sub.id);
        return (
          <button
            key={sub.id}
            class={`subsession-card${isOpen ? ' open' : ''}`}
            onClick={() => onOpen(sub.id)}
            title={label}
          >
            <span class="subsession-card-icon">{icon}</span>
            <span class="subsession-card-label">{label}</span>
            {sub.state === 'starting' && <span class="subsession-card-badge">…</span>}
            {sub.state === 'unknown' && <span class="subsession-card-badge">?</span>}
          </button>
        );
      })}
      <button class="subsession-add-btn" onClick={onNew} title="New sub-session">+</button>
    </div>
  );
}
