import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SessionTabs } from './components/SessionTabs.js';
import { TerminalView } from './components/TerminalView.js';
import { ChatView } from './components/ChatView.js';
import { SessionControls } from './components/SessionControls.js';
import { useQuickData } from './components/QuickInputPanel.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { useTimeline } from './hooks/useTimeline.js';
import { WsClient } from './ws-client.js';
import { configure as configureApi, apiFetch } from './api.js';
import type { SessionInfo, TerminalDiff } from './types.js';

type ViewMode = 'terminal' | 'chat';

interface AuthState {
  token: string;
  userId: string;
  baseUrl: string;
}

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  createdAt: number;
}

function isServerOnline(s: ServerInfo): boolean {
  if (s.status === 'offline') return false;
  if (!s.lastHeartbeatAt) return false;
  return Date.now() - s.lastHeartbeatAt < 2 * 60 * 1000;
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    try {
      const raw = localStorage.getItem('rcc_auth');
      const state = raw ? (JSON.parse(raw) as AuthState) : null;
      if (state) configureApi(state.baseUrl, state.token);
      return state;
    } catch {
      return null;
    }
  });

  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    () => localStorage.getItem('rcc_server'),
  );
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    () => localStorage.getItem('rcc_server_name'),
  );
  const [showMobileServerMenu, setShowMobileServerMenu] = useState(false);

  // Keep layout height within visual viewport on mobile (keyboard-aware)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    };
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  // Handle OAuth callback token in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const userId = params.get('userId');
    if (token && userId) {
      const authState: AuthState = { token, userId, baseUrl: window.location.origin };
      localStorage.setItem('rcc_auth', JSON.stringify(authState));
      setAuth(authState);
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // Configure API client when auth changes
  useEffect(() => {
    if (auth) configureApi(auth.baseUrl, auth.token);
  }, [auth]);

  // Load servers list whenever auth is available
  const loadServers = useCallback(async () => {
    if (!auth) return;
    try {
      const data = await apiFetch<{ servers: ServerInfo[] }>('/api/server');
      setServers(data.servers);
      // Populate selected server name if missing
      if (selectedServerId) {
        const found = data.servers.find((s) => s.id === selectedServerId);
        if (found && !selectedServerName) {
          localStorage.setItem('rcc_server_name', found.name);
          setSelectedServerName(found.name);
        }
      }
    } catch { /* ignore */ }
  }, [auth, selectedServerId, selectedServerName]);

  useEffect(() => { loadServers(); }, [loadServers]);

  // Rename = update project_name in D1 + local sessions state
  const handleRenameSession = useCallback(async (sessionName: string, newProjectName: string) => {
    if (!selectedServerId || !newProjectName) return;
    // Optimistic update
    setSessions((prev) => prev.map((s) => s.name === sessionName ? { ...s, project: newProjectName } : s));
    try {
      await apiFetch(`/api/server/${selectedServerId}/sessions/${encodeURIComponent(sessionName)}/rename`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newProjectName }),
      });
    } catch { /* best-effort */ }
  }, [selectedServerId]);

  // Fetch sessions from DB immediately when auth + server are available
  useEffect(() => {
    if (!auth || !selectedServerId) return;
    apiFetch<{ sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; state: string }> }>(
      `/api/server/${selectedServerId}/sessions`,
    ).then((data) => {
      setSessions(data.sessions.map((s) => ({
        name: s.name,
        project: s.project_name,
        role: s.role as SessionInfo['role'],
        agentType: s.agent_type,
        state: s.state as SessionInfo['state'],
      })));
    }).catch(() => {/* WS fallback */});
  }, [auth, selectedServerId]);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSessionState] = useState<string | null>(
    () => localStorage.getItem('rcc_session'),
  );
  const [showNewSession, setShowNewSession] = useState(false);
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [idleAlerts, setIdleAlerts] = useState<Set<string>>(new Set());
  const [activeTools, setActiveTools] = useState<Map<string, string>>(new Map());
  const [toasts, setToasts] = useState<Array<{ id: number; sessionName: string; project: string; kind: 'idle' | 'notification'; title?: string; message?: string }>>([]);
  const [detectedModels, setDetectedModels] = useState<Map<string, 'opus' | 'sonnet' | 'haiku'>>(new Map());
  const quickData = useQuickData();
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  const setActiveSession = useCallback((name: string | null) => {
    if (name) localStorage.setItem('rcc_session', name);
    else localStorage.removeItem('rcc_session');
    setActiveSessionState(name);
  }, []);

  const wsRef = useRef<WsClient | null>(null);
  const diffApplyersRef = useRef<Map<string, (diff: TerminalDiff) => void>>(new Map());
  const historyApplyersRef = useRef<Map<string, (content: string) => void>>(new Map());
  const inputRef = useRef<HTMLDivElement>(null);
  const termFocusFnRef = useRef<(() => void) | null>(null);
  const termFitFnRef = useRef<(() => void) | null>(null);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem('rcc_viewMode');
    if (stored === 'terminal' || stored === 'chat') return stored;
    return isMobile ? 'chat' : 'terminal';
  });
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next = prev === 'terminal' ? 'chat' : 'terminal';
      localStorage.setItem('rcc_viewMode', next);
      return next;
    });
  }, []);

  const focusTerminal = useCallback(() => {
    termFitFnRef.current?.();
    if (!isMobile) termFocusFnRef.current?.();
  }, [isMobile]);

  // Timeline events for chat view
  const { events: timelineEvents, loading: timelineLoading } = useTimeline(activeSession, wsRef.current);

  // Set up WebSocket only when a server is selected
  useEffect(() => {
    if (!auth || !selectedServerId) return;

    const ws = new WsClient(auth.baseUrl, selectedServerId, auth.token);
    wsRef.current = ws;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        if (msg.event === 'connected') {
          setConnected(true);
          ws.requestSessionList();
        }
        if (msg.event === 'disconnected') setConnected(false);
        setSessions((prev) => {
          const existing = prev.find((s) => s.name === msg.session);
          if (!existing && msg.session) {
            return [...prev, { name: msg.session, project: '', role: 'brain', agentType: 'unknown', state: msg.state as SessionInfo['state'] }];
          }
          return prev.map((s) => s.name === msg.session ? { ...s, state: msg.state as SessionInfo['state'] } : s);
        });
      }
      if (msg.type === 'session_list') {
        setSessions(msg.sessions.map((s) => ({
          name: s.name,
          project: s.project,
          role: s.role as SessionInfo['role'],
          agentType: s.agentType,
          state: s.state as SessionInfo['state'],
        })));
      }
      if (msg.type === 'terminal.diff') {
        const apply = diffApplyersRef.current.get(msg.diff.sessionName);
        apply?.(msg.diff);
        // Scan lines for model keywords to detect active model
        const sessionName = msg.diff.sessionName;
        const stripped = msg.diff.lines.map(([, l]) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')).join(' ').toLowerCase();
        const detected: 'opus' | 'sonnet' | 'haiku' | null =
          stripped.includes('opus') ? 'opus' :
          stripped.includes('sonnet') ? 'sonnet' :
          stripped.includes('haiku') ? 'haiku' : null;
        if (detected) {
          setDetectedModels((prev) => {
            if (prev.get(sessionName) === detected) return prev;
            const next = new Map(prev);
            next.set(sessionName, detected);
            return next;
          });
        }
      }
      if (msg.type === 'terminal.history') {
        const applyHistory = historyApplyersRef.current.get(msg.sessionName);
        applyHistory?.(msg.content);
      }
      if (msg.type === 'session.idle') {
        const sessionName = msg.session as string;
        const project = (msg.project as string) || sessionName;
        // Clear any active tool since session is now idle
        setActiveTools((prev) => { const m = new Map(prev); m.delete(sessionName); return m; });
        // Add tab pulse alert (only when not the currently active tab)
        if (sessionName !== activeSessionRef.current) {
          setIdleAlerts((prev) => new Set([...prev, sessionName]));
        }
        // Always show a toast
        const id = Date.now();
        setToasts((prev) => [...prev, { id, sessionName, project, kind: 'idle' }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
      }
      if (msg.type === 'session.notification') {
        const sessionName = msg.session;
        const project = msg.project || sessionName;
        const id = Date.now();
        setToasts((prev) => [...prev, { id, sessionName, project, kind: 'notification', title: msg.title, message: msg.message }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
      }
      if (msg.type === 'session.tool') {
        const sessionName = msg.session;
        setActiveTools((prev) => {
          const m = new Map(prev);
          if (msg.tool) m.set(sessionName, msg.tool);
          else m.delete(sessionName);
          return m;
        });
      }
      if (msg.type === 'daemon.reconnected') {
        // Daemon process (re)started — all its subscriptions are gone.
        // Re-subscribe immediately so terminal resumes without a page refresh.
        const session = activeSessionRef.current;
        if (session) {
          ws.subscribeTerminal(session);
          if (viewModeRef.current === 'chat') {
            ws.sendResize(session, 200, 50);
          }
        }
      }
    });

    ws.onLatency((ms) => setLatencyMs(ms));
    ws.connect();

    return () => {
      unsub();
      ws.onLatency(null);
      ws.disconnect();
      wsRef.current = null;
      setConnected(false);
      setLatencyMs(null);
    };
  }, [auth, selectedServerId]);

  // Subscribe to terminal when session changes OR when WS connects.
  // Always subscribe (even in chat mode) so timeline events are generated
  // from terminal diff parsing. In chat mode, restore tmux to a large
  // viewport so the agent isn't cramped by mobile screen dimensions.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || !activeSession) return;
    ws.subscribeTerminal(activeSession);
    if (viewMode === 'chat') {
      // Restore tmux to a comfortable size for the agent
      ws.sendResize(activeSession, 200, 50);
    }
    return () => {
      try { ws.unsubscribeTerminal(activeSession); } catch { /* ignore */ }
    };
  }, [activeSession, connected, viewMode]);

  // Re-subscribe when tab/window becomes visible (handles sleep/wake, background tabs)
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      const session = activeSessionRef.current;
      if (!ws?.connected || !session) return;
      ws.subscribeTerminal(session);
      if (viewModeRef.current === 'chat') {
        ws.sendResize(session, 200, 50);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []); // no deps — uses refs

  // Global keyboard passthrough
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ws = wsRef.current;
      const session = activeSession;
      if (!ws?.connected || !session) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (el?.isContentEditable) return;

      let data: string | null = null;
      if (e.key === 'Enter')     { data = '\r'; }
      else if (e.key === 'Backspace') { data = '\x7f'; }
      else if (e.key === 'Tab')  { data = '\t'; e.preventDefault(); }
      else if (e.key === 'Escape') { data = '\x1b'; }
      else if (e.key === 'ArrowUp')    { data = '\x1b[A'; }
      else if (e.key === 'ArrowDown')  { data = '\x1b[B'; }
      else if (e.key === 'ArrowRight') { data = '\x1b[C'; }
      else if (e.key === 'ArrowLeft')  { data = '\x1b[D'; }
      else if (e.key === 'Home')  { data = '\x1b[H'; }
      else if (e.key === 'End')   { data = '\x1b[F'; }
      else if (e.key === 'Delete') { data = '\x1b[3~'; }
      else if (e.ctrlKey && e.key.length === 1) {
        const code = e.key.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) { data = String.fromCharCode(code); }
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        data = e.key;
      }

      if (data !== null) {
        e.preventDefault();
        ws.sendInput(session, data);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeSession, connected]);

  const handleLogin = useCallback((state: AuthState) => {
    localStorage.setItem('rcc_auth', JSON.stringify(state));
    setAuth(state);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('rcc_auth');
    localStorage.removeItem('rcc_server');
    localStorage.removeItem('rcc_server_name');
    localStorage.removeItem('rcc_session');
    setAuth(null);
    setSessions([]);
    setActiveSession(null);
    setSelectedServerId(null);
  }, [setActiveSession]);

  const handleSelectServer = useCallback(async (serverId: string, serverName?: string) => {
    localStorage.setItem('rcc_server', serverId);
    if (serverName) { localStorage.setItem('rcc_server_name', serverName); setSelectedServerName(serverName); }
    setSessions([]);
    setActiveSession(null);
    setSelectedServerId(serverId);
    setShowMobileServerMenu(false);
    // Immediately load sessions from D1
    try {
      const data = await apiFetch<{ sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; state: string }> }>(`/api/server/${serverId}/sessions`);
      setSessions(data.sessions.map((s) => ({
        name: s.name,
        project: s.project_name,
        role: s.role as SessionInfo['role'],
        agentType: s.agent_type,
        state: s.state as SessionInfo['state'],
      })));
    } catch {
      // fallback: WS will populate sessions on connect
    }
  }, [setActiveSession]);

  const handleBackToDashboard = useCallback(() => {
    localStorage.removeItem('rcc_server');
    localStorage.removeItem('rcc_server_name');
    localStorage.removeItem('rcc_session');
    setSelectedServerId(null);
    setSelectedServerName(null);
    setActiveSession(null);
    setShowMobileServerMenu(false);
  }, [setActiveSession]);

  const handleStopProject = useCallback((project: string) => {
    if (!wsRef.current) return;
    wsRef.current.sendSessionCommand('stop', { project });
    setSessions((prev) => prev.filter((s) => s.project !== project));
    if (sessions.some((s) => s.project === project && s.name === activeSession)) {
      setActiveSession(null);
    }
  }, [sessions, activeSession, setActiveSession]);

  const handleRestartProject = useCallback((project: string, fresh?: boolean) => {
    wsRef.current?.sendSessionCommand('restart', { project, ...(fresh ? { fresh: true } : {}) });
  }, []);

  const registerDiffApplyer = useCallback((sessionName: string, apply: (d: TerminalDiff) => void) => {
    diffApplyersRef.current.set(sessionName, apply);
  }, []);

  const registerHistoryApplyer = useCallback((sessionName: string, apply: (content: string) => void) => {
    historyApplyersRef.current.set(sessionName, apply);
  }, []);

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const activeSessionInfo = sessions.find((s) => s.name === activeSession) ?? null;

  return (
    <div class="layout">
      {/* Sidebar — server list */}
      <aside class="sidebar">
        <div class="sidebar-header">Codedeck</div>
        <div class="server-list">
          {servers.map((server) => {
            const online = isServerOnline(server);
            return (
              <button
                key={server.id}
                class={`server-item${server.id === selectedServerId ? ' active' : ''}${online ? '' : ' offline'}`}
                onClick={() => handleSelectServer(server.id, server.name)}
              >
                <span class="server-item-dot" style={{ color: online ? '#4ade80' : '#475569' }}>
                  {online ? '●' : '○'}
                </span>
                {server.name}
              </button>
            );
          })}
          {servers.length === 0 && (
            <div style={{ padding: '12px 16px', fontSize: 12, color: '#475569' }}>No devices</div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ padding: '12px 16px', borderTop: '1px solid #334155' }}>
          <button class="btn btn-secondary" style={{ width: '100%', fontSize: 11 }} onClick={handleLogout}>
            Log Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main class="main">
        {!selectedServerId ? (
          <DashboardPage onSelectServer={handleSelectServer} onLogout={handleLogout} onServersLoaded={setServers} />
        ) : (
          <>
            {/* Mobile-only server switcher */}
            <div class="mobile-server-bar">
              <div class="mobile-server-switcher-wrap">
                <button
                  class="mobile-server-btn"
                  onClick={() => setShowMobileServerMenu((o) => !o)}
                >
                  ≡ {selectedServerName ?? 'Server'} ▾
                </button>
                {showMobileServerMenu && (
                  <div class="mobile-server-menu">
                    <button class="mobile-server-menu-item" onClick={handleBackToDashboard}>
                      ← Home
                    </button>
                    {servers.map((s) => {
                      const online = isServerOnline(s);
                      return (
                        <button
                          key={s.id}
                          class={`mobile-server-menu-item${s.id === selectedServerId ? ' active' : ''}`}
                          onClick={() => handleSelectServer(s.id, s.name)}
                        >
                          <span style={{ color: online ? '#4ade80' : '#475569' }}>{online ? '●' : '○'}</span>
                          {' '}{s.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button class="view-toggle" onClick={toggleViewMode}>
                  {viewMode === 'chat' ? '⌨' : '💬'}
                </button>
                <span class={`badge ${connected ? 'badge-online' : 'badge-offline'}`} style={{ fontSize: 10 }}>
                  {connected ? '● Online' : '○ Offline'}
                </span>
              </div>
            </div>

            <SessionTabs
              sessions={sessions}
              activeSession={activeSession}
              connected={connected}
              latencyMs={latencyMs}
              idleAlerts={idleAlerts}
              activeTools={activeTools}
              onAlertDismiss={(name) => setIdleAlerts((prev) => { const s = new Set(prev); s.delete(name); return s; })}
              onSelect={(name) => { setActiveSession(name); setIdleAlerts((prev) => { const s = new Set(prev); s.delete(name); return s; }); }}
              onNewSession={() => setShowNewSession(true)}
              onStopProject={handleStopProject}
              onRestartProject={handleRestartProject}
              renameRequest={renameRequest}
              onRenameHandled={() => setRenameRequest(null)}
              onRenameSession={handleRenameSession}
            />

            {activeSession ? (
              viewMode === 'chat' ? (
                <ChatView events={timelineEvents} loading={timelineLoading} sessionState={activeSessionInfo?.state} />
              ) : (
                <TerminalView
                  key={activeSession}
                  sessionName={activeSession}
                  ws={wsRef.current}
                  connected={connected}
                  onDiff={(apply) => registerDiffApplyer(activeSession, apply)}
                  onHistory={(apply) => registerHistoryApplyer(activeSession, apply)}
                  onFocusFn={(fn) => { termFocusFnRef.current = fn; }}
                  onFitFn={(fn) => { termFitFnRef.current = fn; }}
                />
              )
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 32 }}>⌨</div>
                <div>Select a session or start a new one</div>
                <button class="btn btn-primary" onClick={() => setShowNewSession(true)}>
                  + New Session
                </button>
              </div>
            )}

            <SessionControls ws={wsRef.current} activeSession={activeSessionInfo} inputRef={inputRef} onAfterAction={focusTerminal} onStopProject={handleStopProject} onRenameSession={() => activeSession && setRenameRequest(activeSession)} sessionDisplayName={activeSessionInfo?.project ?? null} quickData={quickData} detectedModel={activeSession ? detectedModels.get(activeSession) : undefined} hideShortcuts={viewMode === 'chat'} />
          </>
        )}
      </main>

      {showNewSession && (
        <NewSessionDialog
          ws={wsRef.current}
          onClose={() => setShowNewSession(false)}
          onSessionStarted={(name) => { setActiveSession(name); setShowNewSession(false); }}
        />
      )}

      {/* Toasts: idle completions + CC notifications */}
      {toasts.length > 0 && (
        <div class="toast-container">
          {toasts.map((t) => (
            <div
              key={t.id}
              class={`toast toast-${t.kind}`}
              onClick={() => {
                setActiveSession(t.sessionName);
                setIdleAlerts((prev) => { const s = new Set(prev); s.delete(t.sessionName); return s; });
                setToasts((prev) => prev.filter((x) => x.id !== t.id));
              }}
            >
              <span class="toast-icon">{t.kind === 'idle' ? '✓' : '🔔'}</span>
              <span class="toast-body">
                {t.kind === 'idle' ? (
                  <><strong>{t.project}</strong> 完成了</>
                ) : (
                  <><strong>{t.title || t.project}</strong>{t.message ? <> — {t.message}</> : null}</>
                )}
              </span>
              <button class="toast-close" onClick={(e) => { e.stopPropagation(); setToasts((prev) => prev.filter((x) => x.id !== t.id)); }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
