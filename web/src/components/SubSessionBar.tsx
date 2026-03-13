/**
 * SubSessionBar — bottom panel showing sub-session preview cards.
 * Cards show live chat/terminal previews. Single or double row layout.
 */
import { useState } from 'preact/hooks';
import { SubSessionCard } from './SubSessionCard.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';

interface Props {
  subSessions: SubSession[];
  openIds: Set<string>;
  onOpen: (id: string) => void;
  onNew: () => void;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
}

type Layout = 'single' | 'double';

function loadLayout(): Layout {
  try {
    const v = localStorage.getItem('rcc_subcard_layout');
    if (v === 'double') return 'double';
  } catch { /* ignore */ }
  return 'single';
}

export function SubSessionBar({ subSessions, openIds, onOpen, onNew, ws, connected, onDiff, onHistory }: Props) {
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [collapsed, setCollapsed] = useState(false);

  const toggleLayout = () => {
    const next: Layout = layout === 'single' ? 'double' : 'single';
    setLayout(next);
    try { localStorage.setItem('rcc_subcard_layout', next); } catch { /* ignore */ }
  };

  if (subSessions.length === 0 && collapsed) return null;

  return (
    <div class="subcard-bar">
      {/* Toolbar */}
      <div class="subcard-toolbar">
        <button class="subcard-toolbar-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Show' : 'Hide'}>
          {collapsed ? '▲' : '▼'}
        </button>
        {!collapsed && (
          <>
            <button class="subcard-toolbar-btn" onClick={toggleLayout} title={layout === 'single' ? 'Double row' : 'Single row'}>
              {layout === 'single' ? '⊞' : '☰'}
            </button>
            <span class="subcard-toolbar-label">Sub-sessions ({subSessions.length})</span>
          </>
        )}
        <button class="subcard-toolbar-add" onClick={onNew} title="New sub-session">+</button>
      </div>

      {/* Cards */}
      {!collapsed && subSessions.length > 0 && (
        <div class={`subcard-scroll ${layout === 'double' ? 'subcard-double' : 'subcard-single'}`}>
          {subSessions.map((sub) => (
            <SubSessionCard
              key={sub.id}
              sub={sub}
              ws={ws}
              connected={connected}
              isOpen={openIds.has(sub.id)}
              onOpen={() => onOpen(sub.id)}
              onDiff={onDiff}
              onHistory={onHistory}
            />
          ))}
        </div>
      )}
    </div>
  );
}
