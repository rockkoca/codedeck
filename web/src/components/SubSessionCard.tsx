/**
 * SubSessionCard — preview card showing live chat/terminal content for a sub-session.
 * Content renders at native size (no scaling) — card acts as a clipped viewport.
 */
import { useRef } from 'preact/hooks';
import { ChatView } from './ChatView.js';
import { TerminalView } from './TerminalView.js';
import { useTimeline } from '../hooks/useTimeline.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';

const TYPE_ICON: Record<string, string> = {
  'claude-code': '⚡',
  'codex': '📦',
  'opencode': '🔆',
  'shell': '🐚',
};

const STATE_BADGE: Record<string, string> = {
  starting: '…',
  unknown: '?',
  stopped: '■',
};

interface Props {
  sub: SubSession;
  ws: WsClient | null;
  connected: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
}

export function SubSessionCard({ sub, ws, connected, isOpen, onOpen, onDiff, onHistory }: Props) {
  const isShell = sub.type === 'shell';
  const { events, refreshing } = isShell ? { events: [], refreshing: false } : useTimeline(sub.sessionName, ws);
  const termScrollRef = useRef<(() => void) | null>(null);
  const label = sub.label ?? (isShell ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type);
  const icon = TYPE_ICON[sub.type] ?? '⚡';
  const badge = STATE_BADGE[sub.state];

  return (
    <div
      class={`subcard${isOpen ? ' subcard-open' : ''}`}
      onClick={onOpen}
    >
      {/* Header */}
      <div class="subcard-header">
        <span class="subcard-icon">{icon}</span>
        <span class="subcard-label">{label}</span>
        {badge && <span class="subcard-badge">{badge}</span>}
        {sub.state === 'running' && <span class="subcard-running">●</span>}
      </div>

      {/* Preview — native size, clipped by card overflow:hidden, non-interactive */}
      <div class="subcard-preview">
        {isShell ? (
          <TerminalView
            sessionName={sub.sessionName}
            ws={ws}
            connected={connected}
            onDiff={(apply) => onDiff(sub.sessionName, apply)}
            onHistory={(apply) => onHistory(sub.sessionName, apply)}
            onScrollBottomFn={(fn) => { termScrollRef.current = fn; }}
          />
        ) : (
          <ChatView
            events={events}
            loading={false}
            refreshing={refreshing}
            sessionId={sub.sessionName}
            preview
          />
        )}
      </div>
    </div>
  );
}
