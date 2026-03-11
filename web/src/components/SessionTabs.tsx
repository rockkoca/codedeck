import { useState, useRef, useEffect } from 'preact/hooks';
import type { SessionInfo } from '../types.js';

interface Props {
  sessions: SessionInfo[];
  activeSession: string | null;
  connected?: boolean;
  latencyMs?: number | null;
  /** Set of session names that just went idle — shows pulse alert on that tab */
  idleAlerts?: Set<string>;
  onAlertDismiss?: (sessionName: string) => void;
  /** Map of session name → currently running tool name */
  activeTools?: Map<string, string>;
  onSelect: (name: string) => void;
  onNewSession: () => void;
  onStopProject: (project: string) => void;
  onRestartProject: (project: string, fresh?: boolean) => void;
  /** When set to a session name, triggers inline rename */
  renameRequest?: string | null;
  onRenameHandled?: () => void;
  /** Called when user commits a rename — updates project_name in D1 */
  onRenameSession?: (sessionName: string, newProjectName: string) => void;
}

interface CtxMenu { x: number; y: number; session: SessionInfo }

const AGENT_BADGE: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'cc', color: '#7c3aed' },
  'codex':       { label: 'cx', color: '#d97706' },
  'opencode':    { label: 'oc', color: '#059669' },
};

export function SessionTabs({ sessions, activeSession, connected, latencyMs, idleAlerts, onAlertDismiss, activeTools, onSelect, onNewSession, onStopProject, onRestartProject, renameRequest, onRenameHandled, onRenameSession }: Props) {
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ctx) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtx(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctx]);

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.select(), 0);
  }, [renaming]);

  // External rename trigger (from ⋯ menu in SessionControls)
  useEffect(() => {
    if (!renameRequest) return;
    const session = sessions.find((s) => s.name === renameRequest);
    if (session) startRename(session);
    onRenameHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);

  const getLabel = (s: SessionInfo) =>
    s.role === 'brain' ? `🧠 ${s.project}` : `W${s.name.split('_w')[1] ?? '?'}`;

  const agentBadge = (agentType: string) => {
    const b = AGENT_BADGE[agentType];
    if (!b) return null;
    return <span class="agent-badge" style={{ background: b.color }}>{b.label}</span>;
  };

  const openCtx = (e: MouseEvent, session: SessionInfo) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, session });
  };

  const startRename = (s: SessionInfo) => {
    setCtx(null);
    setRenameVal(s.project);
    setRenaming(s.name);
  };

  const commitRename = () => {
    if (!renaming) return;
    const trimmed = renameVal.trim();
    if (trimmed) onRenameSession?.(renaming, trimmed);
    setRenaming(null);
  };

  const menuX = ctx ? Math.min(ctx.x, window.innerWidth - 160) : 0;
  const menuY = ctx ? Math.min(ctx.y, window.innerHeight - 170) : 0;

  return (
    <div class="tab-bar" role="tablist">
      {sessions.length === 0 && (
        <span class="tab-empty">No active sessions</span>
      )}

      {sessions.map((s) => {
        const isActive = s.name === activeSession;
        const isBrain = s.role === 'brain';
        const hasAlert = idleAlerts?.has(s.name) ?? false;
        const activeTool = activeTools?.get(s.name) ?? null;
        const stateClass = s.state === 'running' ? 'busy' : s.state === 'idle' ? 'idle' : '';
        const classes = ['tab', isBrain ? 'brain' : '', isActive ? 'active' : '', stateClass, hasAlert ? 'alert' : ''].filter(Boolean).join(' ');

        // WS latency shown inline on the active tab
        const latencyColor = latencyMs == null ? '#4ade80' : latencyMs < 150 ? '#4ade80' : latencyMs < 400 ? '#f59e0b' : '#ef4444';

        return (
          <div key={s.name} class="tab-wrap">
            {renaming === s.name ? (
              <input
                ref={renameRef}
                class="tab-rename-input"
                value={renameVal}
                onInput={(e) => setRenameVal((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={commitRename}
              />
            ) : (
              <button
                class={classes}
                role="tab"
                aria-selected={isActive}
                onClick={() => { onSelect(s.name); if (hasAlert) onAlertDismiss?.(s.name); }}
                onContextMenu={(e) => openCtx(e, s)}
                title={`${s.agentType} — ${s.state}`}
              >
                {agentBadge(s.agentType)}
                {getLabel(s)}
                {activeTool && (
                  <span class="tab-tool" title={`Running: ${activeTool}`}>⚙ {activeTool}</span>
                )}
                {isActive && (
                  <span class="tab-ws-dot" style={{ color: connected ? latencyColor : '#ef4444' }} title={connected ? (latencyMs != null ? `${latencyMs}ms` : 'Connected') : 'Disconnected'}>
                    ●{connected && latencyMs != null && <span class="tab-latency">{latencyMs}ms</span>}
                  </span>
                )}
              </button>
            )}
          </div>
        );
      })}

      <button class="tab-add-btn" onClick={onNewSession} title="New session">＋</button>

      {ctx && (
        <div ref={menuRef} class="tab-context-menu" style={{ left: menuX, top: menuY }}>
          <button class="menu-item" onClick={() => { onRestartProject(ctx.session.project); setCtx(null); }}>↺ Restart</button>
          <button class="menu-item" onClick={() => { onRestartProject(ctx.session.project, true); setCtx(null); }}>＋ New</button>
          <button class="menu-item" onClick={() => startRename(ctx.session)}>✎ Rename</button>
          <div class="menu-divider" />
          <button class="menu-item menu-item-danger" onClick={() => { onStopProject(ctx.session.project); setCtx(null); }}>✕ Stop</button>
        </div>
      )}
    </div>
  );
}
