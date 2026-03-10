import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { LoginPage } from './pages/LoginPage.js';
import { SessionTabs } from './components/SessionTabs.js';
import { TerminalView } from './components/TerminalView.js';
import { SessionControls } from './components/SessionControls.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { WsClient } from './ws-client.js';
import type { SessionInfo, ServerInfo, TerminalDiff } from './types.js';

interface AuthState {
  token: string;
  serverId: string;
  serverUrl: string;
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    try {
      const raw = localStorage.getItem('rcc_auth');
      return raw ? (JSON.parse(raw) as AuthState) : null;
    } catch {
      return null;
    }
  });

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WsClient | null>(null);
  const diffApplyersRef = useRef<Map<string, (diff: TerminalDiff) => void>>(new Map());

  // Set up WebSocket when authenticated
  useEffect(() => {
    if (!auth) return;

    const ws = new WsClient(auth.serverUrl, auth.serverId, auth.token);
    wsRef.current = ws;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        if (msg.event === 'connected') setConnected(true);
        if (msg.event === 'disconnected') setConnected(false);
        // Update session list
        setSessions((prev) => {
          const existing = prev.find((s) => s.name === msg.session);
          if (!existing && msg.session) {
            return [...prev, { name: msg.session, project: '', role: 'brain', agentType: 'unknown', state: msg.state as SessionInfo['state'] }];
          }
          return prev.map((s) => s.name === msg.session ? { ...s, state: msg.state as SessionInfo['state'] } : s);
        });
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
  }, [auth]);

  // Subscribe to terminal when session changes
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !activeSession) return;
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
  }, []);

  const registerDiffApplyer = useCallback((sessionName: string, apply: (d: TerminalDiff) => void) => {
    diffApplyersRef.current.set(sessionName, apply);
  }, []);

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const activeSessionInfo = sessions.find((s) => s.name === activeSession) ?? null;

  return (
    <div class="layout">
      {/* Sidebar */}
      <aside class="sidebar">
        <div class="sidebar-header">Remote Chat CLI</div>
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
            onDiff={(apply) => registerDiffApplyer(activeSession, apply)}
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

        <SessionControls ws={wsRef.current} activeSession={activeSessionInfo} />
      </main>

      {showNewSession && (
        <NewSessionDialog ws={wsRef.current} onClose={() => setShowNewSession(false)} />
      )}
    </div>
  );
}
