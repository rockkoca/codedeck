import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SessionTabs } from './components/SessionTabs.js';
import { TerminalView } from './components/TerminalView.js';
import { SessionControls } from './components/SessionControls.js';
import { useQuickData } from './components/QuickInputPanel.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { WsClient } from './ws-client.js';
import { configure as configureApi, apiFetch } from './api.js';
import type { SessionInfo, TerminalDiff } from './types.js';

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

  // On mount: if restoring terminal view, immediately fetch sessions from D1
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSessionState] = useState<string | null>(
    () => localStorage.getItem('rcc_session'),
  );
  const [showNewSession, setShowNewSession] = useState(false);
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const quickData = useQuickData();

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
  const focusTerminal = useCallback(() => {
    termFitFnRef.current?.();
    if (!isMobile) termFocusFnRef.current?.();
  }, [isMobile]);

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
      }
      if (msg.type === 'terminal.history') {
        const applyHistory = historyApplyersRef.current.get(msg.sessionName);
        applyHistory?.(msg.content);
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

  // Subscribe to terminal when session changes OR when WS connects
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || !activeSession) return;
    ws.subscribeTerminal(activeSession);
    return () => ws.unsubscribeTerminal(activeSession);
  }, [activeSession, connected]);

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
              <span class={`badge ${connected ? 'badge-online' : 'badge-offline'}`} style={{ fontSize: 10 }}>
                {connected ? '● Online' : '○ Offline'}
              </span>
            </div>

            <SessionTabs
              sessions={sessions}
              activeSession={activeSession}
              connected={connected}
              latencyMs={latencyMs}
              onSelect={setActiveSession}
              onNewSession={() => setShowNewSession(true)}
              onStopProject={handleStopProject}
              onRestartProject={handleRestartProject}
              renameRequest={renameRequest}
              onRenameHandled={() => setRenameRequest(null)}
              onRenameSession={handleRenameSession}
            />

            {activeSession ? (
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
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 32 }}>⌨</div>
                <div>Select a session or start a new one</div>
                <button class="btn btn-primary" onClick={() => setShowNewSession(true)}>
                  + New Session
                </button>
              </div>
            )}

            <SessionControls ws={wsRef.current} activeSession={activeSessionInfo} inputRef={inputRef} onAfterAction={focusTerminal} onStopProject={handleStopProject} onRenameSession={() => activeSession && setRenameRequest(activeSession)} sessionDisplayName={activeSessionInfo?.project ?? null} quickData={quickData} />
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
    </div>
  );
}
