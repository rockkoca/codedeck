/**
 * SubSessionWindow — floating, draggable/resizable window for a sub-session.
 * Renders TerminalView or ChatView and an independent input bar.
 */
import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { TerminalView } from './TerminalView.js';
import { ChatView } from './ChatView.js';
import { useTimeline } from '../hooks/useTimeline.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';

interface WindowGeometry { x: number; y: number; w: number; h: number }

interface Props {
  sub: SubSession;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  onClose: () => void;
  zIndex: number;
  onFocus: () => void;
}

type ViewMode = 'terminal' | 'chat';

const LOCAL_KEY = (id: string) => `rcc_subsession_${id}`;
const DEFAULT_W = 620;
const DEFAULT_H = 420;
const MIN_W = 300;
const MIN_H = 200;

function loadLocal(id: string): { geom: WindowGeometry; viewMode: ViewMode } {
  try {
    const raw = localStorage.getItem(LOCAL_KEY(id));
    if (raw) return JSON.parse(raw) as { geom: WindowGeometry; viewMode: ViewMode };
  } catch { /* ignore */ }
  const cx = Math.max(0, (window.innerWidth - DEFAULT_W) / 2);
  const cy = Math.max(0, (window.innerHeight - DEFAULT_H) / 2 - 80);
  return { geom: { x: cx, y: cy, w: DEFAULT_W, h: DEFAULT_H }, viewMode: 'terminal' };
}

function saveLocal(id: string, geom: WindowGeometry, viewMode: ViewMode) {
  try {
    localStorage.setItem(LOCAL_KEY(id), JSON.stringify({ geom, viewMode }));
  } catch { /* ignore */ }
}

export function SubSessionWindow({
  sub, ws, connected, onDiff, onHistory, onClose, zIndex, onFocus,
}: Props) {
  const { events } = useTimeline(sub.sessionName, ws);
  const initial = loadLocal(sub.id);
  const [geom, setGeom] = useState<WindowGeometry>(initial.geom);
  const [viewMode, setViewMode] = useState<ViewMode>(initial.viewMode);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const termScrollRef = useRef<(() => void) | null>(null);
  const chatScrollRef = useRef<(() => void) | null>(null);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Persist on change
  useEffect(() => {
    saveLocal(sub.id, geom, viewMode);
  }, [sub.id, geom, viewMode]);

  // ── Dragging ──────────────────────────────────────────────────────────────
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const onHeaderMouseDown = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: geomRef.current.x, oy: geomRef.current.y };
    onFocus();

    const onMove = (me: MouseEvent) => {
      if (!dragStart.current) return;
      const dx = me.clientX - dragStart.current.mx;
      const dy = me.clientY - dragStart.current.my;
      setGeom((g) => ({ ...g, x: dragStart.current!.ox + dx, y: dragStart.current!.oy + dy }));
    };
    const onUp = () => {
      dragStart.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, [onFocus]);

  // ── Resizing ──────────────────────────────────────────────────────────────
  type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

  const onResizeMouseDown = useCallback((dir: ResizeDir) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onFocus();
    const startG = { ...geomRef.current };
    const sx = e.clientX, sy = e.clientY;

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - sx;
      const dy = me.clientY - sy;
      setGeom((_g) => {
        let { x, y, w, h } = { ...startG };
        if (dir.includes('e')) w = Math.max(MIN_W, startG.w + dx);
        if (dir.includes('s')) h = Math.max(MIN_H, startG.h + dy);
        if (dir.includes('w')) { w = Math.max(MIN_W, startG.w - dx); x = startG.x + (startG.w - w); }
        if (dir.includes('n')) { h = Math.max(MIN_H, startG.h - dy); y = startG.y + (startG.h - h); }
        return { x, y, w, h };
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onFocus]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !ws?.connected) return;
    ws.sendSessionMessage(sub.sessionName, text);
    setInput('');
    setTimeout(() => {
      if (viewModeRef.current === 'chat') chatScrollRef.current?.();
      else termScrollRef.current?.();
    }, 50);
  }, [input, ws, sub.sessionName]);

  const typeLabel = sub.label ?? (sub.type === 'shell' ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type);

  // Mobile: full-screen overlay
  const style: Record<string, string | number> = isMobile
    ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex }
    : { position: 'fixed', left: geom.x, top: geom.y, width: geom.w, height: geom.h, zIndex };

  return (
    <div
      class="subsession-window"
      style={style}
      onMouseDown={onFocus}
    >
      {/* 8-direction resize handles (desktop only) */}
      {!isMobile && (['n','s','e','w','ne','nw','se','sw'] as ResizeDir[]).map((dir) => (
        <div
          key={dir}
          class={`resize-handle resize-${dir}`}
          onMouseDown={onResizeMouseDown(dir)}
        />
      ))}

      {/* Header */}
      <div class="subsession-header" onMouseDown={onHeaderMouseDown}>
        <span class="subsession-drag-icon">⠿</span>
        <span class="subsession-title">{typeLabel}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            class={`subsession-mode-btn${viewMode === 'chat' ? ' active' : ''}`}
            onClick={() => setViewMode('chat')}
            title="Chat view"
          >💬</button>
          <button
            class={`subsession-mode-btn${viewMode === 'terminal' ? ' active' : ''}`}
            onClick={() => setViewMode('terminal')}
            title="Terminal view"
          >⌨</button>
          <button class="subsession-close-btn" onClick={onClose} title="Close">×</button>
        </div>
      </div>

      {/* Content */}
      <div class="subsession-content">
        <div style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}>
          <TerminalView
            sessionName={sub.sessionName}
            ws={ws}
            connected={connected}
            onDiff={(apply) => onDiff(sub.sessionName, apply)}
            onHistory={(apply) => onHistory(sub.sessionName, apply)}
            onScrollBottomFn={(fn) => { termScrollRef.current = fn; }}
          />
        </div>
        {viewMode === 'chat' && (
          <ChatView
            events={events}
            loading={false}
            onScrollBottomFn={(fn) => { chatScrollRef.current = fn; }}
          />
        )}
      </div>

      {/* Input bar */}
      <div class="subsession-input-bar">
        <input
          ref={inputRef}
          class="subsession-input"
          placeholder="Ask or type..."
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
        />
        <button
          class="btn btn-primary subsession-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || !ws?.connected}
        >
          Send
        </button>
      </div>
    </div>
  );
}
