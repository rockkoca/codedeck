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

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const TYPE_ICON: Record<string, string> = {
  'claude-code': '⚡',
  'codex': '📦',
  'opencode': '🔆',
  'shell': '🐚',
};

type Layout = 'single' | 'double';

interface CardSize { w: number; h: number }

const DEFAULT_SIZE: CardSize = { w: 350, h: 250 };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v) return JSON.parse(v) as T;
  } catch { /* ignore */ }
  return fallback;
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

export function SubSessionBar({ subSessions, openIds, onOpen, onNew, ws, connected, onDiff, onHistory }: Props) {
  const [layout, setLayout] = useState<Layout>(() => load('rcc_subcard_layout', 'single'));
  const [collapsed, setCollapsed] = useState(isMobile);
  const [showSizePanel, setShowSizePanel] = useState(false);
  const [cardSize, setCardSize] = useState<CardSize>(() => load('rcc_subcard_size', DEFAULT_SIZE));
  const [draftW, setDraftW] = useState(String(cardSize.w));
  const [draftH, setDraftH] = useState(String(cardSize.h));

  const toggleLayout = () => {
    const next: Layout = layout === 'single' ? 'double' : 'single';
    setLayout(next);
    save('rcc_subcard_layout', next);
  };

  const applySize = () => {
    const w = Math.max(200, Math.min(800, parseInt(draftW) || DEFAULT_SIZE.w));
    const h = Math.max(150, Math.min(600, parseInt(draftH) || DEFAULT_SIZE.h));
    const next = { w, h };
    setCardSize(next);
    save('rcc_subcard_size', next);
    setDraftW(String(w));
    setDraftH(String(h));
    setShowSizePanel(false);
  };

  const resetSize = () => {
    setCardSize(DEFAULT_SIZE);
    save('rcc_subcard_size', DEFAULT_SIZE);
    setDraftW(String(DEFAULT_SIZE.w));
    setDraftH(String(DEFAULT_SIZE.h));
    setShowSizePanel(false);
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
            <button
              class={`subcard-toolbar-btn${showSizePanel ? ' subcard-toolbar-btn-active' : ''}`}
              onClick={() => { setShowSizePanel(!showSizePanel); setDraftW(String(cardSize.w)); setDraftH(String(cardSize.h)); }}
              title="Card size"
            >
              ⚙
            </button>
            <span class="subcard-toolbar-label">Sub-sessions ({subSessions.length})</span>
          </>
        )}
        <button class="subcard-toolbar-add" onClick={onNew} title="New sub-session">+</button>
      </div>

      {/* Size settings panel */}
      {!collapsed && showSizePanel && (
        <div class="subcard-size-panel">
          <span class="subcard-size-label">Card size</span>
          <label class="subcard-size-field">
            W
            <input
              type="number"
              class="subcard-size-input"
              value={draftW}
              min={200} max={800}
              onInput={(e) => setDraftW((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <label class="subcard-size-field">
            H
            <input
              type="number"
              class="subcard-size-input"
              value={draftH}
              min={150} max={600}
              onInput={(e) => setDraftH((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <button class="subcard-toolbar-btn" onClick={applySize}>Apply</button>
          <button class="subcard-toolbar-btn" onClick={resetSize}>Reset</button>
        </div>
      )}

      {/* Collapsed: compact buttons (all platforms) */}
      {collapsed && subSessions.length > 0 && (
        <div class="subsession-bar" style={{ borderTop: 'none' }}>
          {subSessions.map((sub) => {
            const label = sub.label ?? (sub.type === 'shell' ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type);
            const icon = TYPE_ICON[sub.type] ?? '⚡';
            const isOpen = openIds.has(sub.id);
            return (
              <button
                key={sub.id}
                class={`subsession-card${isOpen ? ' open' : ''} mobile`}
                onClick={() => onOpen(sub.id)}
                title={label}
              >
                <span class="subsession-card-icon">{icon}</span>
                <span class="subsession-card-label">{label.slice(0, 4)}</span>
                {sub.state === 'starting' && <span class="subsession-card-badge">…</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded: preview cards (all platforms) */}
      {!collapsed && subSessions.length > 0 && (
        <div
          class={`subcard-scroll ${layout === 'double' ? 'subcard-double' : 'subcard-single'}`}
          style={layout === 'double' ? { gridAutoColumns: 'max-content' } : undefined}
        >
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
              cardW={cardSize.w}
              cardH={cardSize.h}
            />
          ))}
        </div>
      )}
    </div>
  );
}
