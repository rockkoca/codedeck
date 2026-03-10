import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SessionTabs } from './components/SessionTabs.js';
import { TerminalView } from './components/TerminalView.js';
import { SessionControls } from './components/SessionControls.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { WsClient } from './ws-client.js';
import { configure as configureApi, apiFetch } from './api.js';
import type { SessionInfo, TerminalDiff } from './types.js';

interface AuthState {
  token: string;
  userId: string;
  baseUrl: string;
}

type View = 'dashboard' | 'terminal';

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

  const [view, setView] = useState<View>('dashboard');
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  // Keep layout within the visual viewport on mobile (avoids keyboard covering controls)
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

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const wsRef = useRef<WsClient | null>(null);
  const diffApplyersRef = useRef<Map<string, (diff: TerminalDiff) => void>>(new Map());

  // Set up WebSocket only when in terminal view with a selected server
  useEffect(() => {
    if (!auth || view !== 'terminal' || !selectedServerId) return;

    const ws = new WsClient(auth.baseUrl, selectedServerId, auth.token);
    wsRef.current = ws;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        if (msg.event === 'connected') {
          setConnected(true);
          // Request session list immediately so we can restore tabs after refresh
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
    });

    ws.connect();

    return () => {
      unsub();
      ws.disconnect();
      wsRef.current = null;
      setConnected(false);
    };
  }, [auth, view, selectedServerId]);

  // Subscribe to terminal when session changes
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !activeSession) return;
    setLatencyMs(null);
    ws.subscribeTerminal(activeSession);
    return () => ws.unsubscribeTerminal(activeSession);
  }, [activeSession]);

  const handleLogin = useCallback((state: AuthState) => {
    localStorage.setItem('rcc_auth', JSON.stringify(state));
    setAuth(state);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('rcc_auth');
    setAuth(null);
    setSessions([]);
    setActiveSession(null);
    setView('dashboard');
    setSelectedServerId(null);
  }, []);

  const handleSelectServer = useCallback(async (serverId: string) => {
    setSelectedServerId(serverId);
    setView('terminal');
    // Immediately load sessions from D1 — no need to wait for WS handshake
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
  }, []);

  const handleBackToDashboard = useCallback(() => {
    setView('dashboard');
    setSelectedServerId(null);
    setActiveSession(null);
  }, []);

  const registerDiffApplyer = useCallback((sessionName: string, apply: (d: TerminalDiff) => void) => {
    diffApplyersRef.current.set(sessionName, apply);
  }, []);

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  if (view === 'dashboard') {
    return <DashboardPage onSelectServer={handleSelectServer} onLogout={handleLogout} />;
  }

  const activeSessionInfo = sessions.find((s) => s.name === activeSession) ?? null;

  return (
    <div class="layout">
      {/* Sidebar */}
      <aside class="sidebar">
        <div class="sidebar-header">
          <button class="btn btn-secondary" style={{ marginRight: 8, padding: '4px 8px' }} onClick={handleBackToDashboard}>
            ←
          </button>
          Codedeck
        </div>
        <div style={{ padding: '8px 16px 4px', fontSize: 11, color: '#64748b' }}>
          <span class={`badge ${connected ? 'badge-online' : 'badge-offline'}`}>
            {connected ? '● Online' : '○ Offline'}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ padding: '12px 16px', borderTop: '1px solid #334155' }}>
          <button class="btn btn-secondary" style={{ width: '100%', marginBottom: 8 }} onClick={() => setShowNewSession(true)}>
            + New Session
          </button>
          <button class="btn btn-secondary" style={{ width: '100%', fontSize: 11 }} onClick={handleLogout}>
            Log Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main class="main">
        <SessionTabs
          sessions={sessions}
          activeSession={activeSession}
          onSelect={setActiveSession}
        />

        {activeSession ? (
          <TerminalView
            key={activeSession}
            sessionName={activeSession}
            ws={wsRef.current}
            onDiff={(apply) => registerDiffApplyer(activeSession, apply)}
            onLatency={setLatencyMs}
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

        <SessionControls ws={wsRef.current} activeSession={activeSessionInfo} latencyMs={latencyMs} />
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
