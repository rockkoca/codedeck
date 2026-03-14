import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SessionTabs } from './components/SessionTabs.js';
import { TerminalView } from './components/TerminalView.js';
import { ChatView } from './components/ChatView.js';
import { SessionControls } from './components/SessionControls.js';
import { useQuickData } from './components/QuickInputPanel.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { SubSessionBar } from './components/SubSessionBar.js';
import { SubSessionWindow } from './components/SubSessionWindow.js';
import { StartSubSessionDialog } from './components/StartSubSessionDialog.js';
import { StartDiscussionDialog, type DiscussionPrefs, type SubSessionOption } from './components/StartDiscussionDialog.js';
import { DiscussionsPage } from './pages/DiscussionsPage.js';
import { useSubSessions } from './hooks/useSubSessions.js';
import { useTimeline } from './hooks/useTimeline.js';
import { WsClient } from './ws-client.js';
import { configure as configureApi, apiFetch, onAuthExpired, getUserPref } from './api.js';
import type { SessionInfo, TerminalDiff } from './types.js';

type ViewMode = 'terminal' | 'chat';

interface AuthState {
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
      if (state) configureApi(state.baseUrl);
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

  // When session expires mid-session (refresh failed), clear auth and show login.
  // Registered once so any apiFetch 401 after refresh failure lands here.
  useEffect(() => {
    onAuthExpired(() => {
      localStorage.removeItem('rcc_auth');
      setAuth(null);
    });
  }, []);

  // Verify session via /api/auth/user/me on mount (cookie-based auth)
  // Also handles post-OAuth redirect: cookie was set by server, we just need to confirm.
  useEffect(() => {
    const baseUrl = window.location.origin;
    configureApi(baseUrl);
    apiFetch<{ id: string }>('/api/auth/user/me').then((user) => {
      const authState: AuthState = { userId: user.id, baseUrl };
      localStorage.setItem('rcc_auth', JSON.stringify(authState));
      setAuth(authState);
    }).catch(() => {
      // Not authenticated — clear stale localStorage and show login (no reload)
      localStorage.removeItem('rcc_auth');
      setAuth(null);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Configure API client when auth changes
  useEffect(() => {
    if (auth) configureApi(auth.baseUrl);
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
    apiFetch<{ sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; state: string; project_dir?: string }> }>(
      `/api/server/${selectedServerId}/sessions`,
    ).then((data) => {
      const mapped = data.sessions.map((s) => ({
        name: s.name,
        project: s.project_name,
        role: s.role as SessionInfo['role'],
        agentType: s.agent_type,
        state: s.state as SessionInfo['state'],
        projectDir: s.project_dir,
      }));
      setSessions(mapped);
      // Only mark loaded if we got data — empty means daemon hasn't synced yet,
      // so wait for WS session_list to avoid flashing "No active sessions"
      if (mapped.length > 0) {
        setSessionsLoaded(true);
      }
      // Auto-select first session if none was previously saved
      if (mapped.length > 0 && !localStorage.getItem('rcc_session')) {
        setActiveSession(mapped[0].name);
      }
    }).catch(() => {/* WS fallback */});
  }, [auth, selectedServerId]);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
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

  // IDs of currently-open (non-minimized) sub-session windows
  const [openSubIds, setOpenSubIds] = useState<Set<string>>(new Set());
  // z-index per sub-session window
  const [subZIndexes, setSubZIndexes] = useState<Map<string, number>>(new Map());
  const [showSubDialog, setShowSubDialog] = useState(false);

  // ── Discussions ─────────────────────────────────────────────────────────────
  const [showDiscussionsPage, setShowDiscussionsPage] = useState(false);
  const [showDiscussionDialog, setShowDiscussionDialog] = useState(false);
  const [discussionPrefs, setDiscussionPrefs] = useState<DiscussionPrefs | null>(null);
  const [discussions, setDiscussions] = useState<Array<{
    id: string;
    topic: string;
    state: string;
    currentRound: number;
    maxRounds: number;
    currentSpeaker?: string;
    conclusion?: string;
    filePath?: string;
  }>>([]);

  const bringSubToFront = useCallback((id: string) => {
    setSubZIndexes((prev) => {
      const max = prev.size > 0 ? Math.max(...prev.values()) : 1000;
      const next = new Map(prev);
      next.set(id, max + 1);
      return next;
    });
  }, []);

  const toggleSubSession = useCallback((id: string) => {
    setOpenSubIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    bringSubToFront(id);
  }, [bringSubToFront]);

  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const setActiveSession = useCallback((name: string | null) => {
    if (name) localStorage.setItem('rcc_session', name);
    else localStorage.removeItem('rcc_session');
    setActiveSessionState(name);
  }, []);

  const wsRef = useRef<WsClient | null>(null);
  const [daemonStats, setDaemonStats] = useState<{ cpu: number; memUsed: number; memTotal: number; load1: number; load5: number; load15: number; uptime: number } | null>(null);

  // ── Sub-sessions ───────────────────────────────────────────────────────────
  const { subSessions, create: createSubSession, close: closeSubSession, restart: restartSubSession, rename: renameSubSession } = useSubSessions(
    selectedServerId,
    wsRef.current,
    connected,
  );

  const diffApplyersRef = useRef<Map<string, (diff: TerminalDiff) => void>>(new Map());
  const historyApplyersRef = useRef<Map<string, (content: string) => void>>(new Map());
  const inputRef = useRef<HTMLDivElement>(null);
  const termFocusFnsRef = useRef<Map<string, () => void>>(new Map());
  const termFitFnsRef = useRef<Map<string, () => void>>(new Map());
  const termScrollFnsRef = useRef<Map<string, () => void>>(new Map());
  const chatScrollFnRef = useRef<(() => void) | null>(null);
  const openSubIdsRef = useRef(openSubIds);
  openSubIdsRef.current = openSubIds;
  const subSessionsRef = useRef(subSessions);
  subSessionsRef.current = subSessions;

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const defaultViewMode: ViewMode = isMobile ? 'chat' : 'terminal';
  // Per-session view mode: Record<sessionName, ViewMode>
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>(() => {
    try {
      const stored = localStorage.getItem('rcc_viewModes');
      if (stored) return JSON.parse(stored) as Record<string, ViewMode>;
    } catch { /* ignore */ }
    return {};
  });
  // Current session's view mode, falls back to device default
  const viewMode: ViewMode = (activeSession && viewModes[activeSession]) ? viewModes[activeSession] : defaultViewMode;
  const toggleViewMode = useCallback(() => {
    if (!activeSession) return;
    setViewModes((prev) => {
      const current = prev[activeSession] ?? defaultViewMode;
      const next: ViewMode = current === 'terminal' ? 'chat' : 'terminal';
      const updated = { ...prev, [activeSession]: next };
      localStorage.setItem('rcc_viewModes', JSON.stringify(updated));
      return updated;
    });
  }, [activeSession, defaultViewMode]);

  const focusTerminal = useCallback(() => {
    if (!activeSession) return;
    termFitFnsRef.current.get(activeSession)?.();
    if (!isMobile) termFocusFnsRef.current.get(activeSession)?.();
  }, [activeSession, isMobile]);

  // Force scroll to bottom in whichever view is currently active
  const scrollActiveToBottom = useCallback(() => {
    if (!activeSession) return;
    const mode = viewModesRef.current[activeSession] ?? defaultViewMode;
    if (mode === 'chat') {
      chatScrollFnRef.current?.();
    } else {
      termScrollFnsRef.current.get(activeSession)?.();
    }
  }, [activeSession, defaultViewMode]);

  // Timeline events for chat view
  const { events: timelineEvents, loading: timelineLoading, refreshing: timelineRefreshing } = useTimeline(activeSession, wsRef.current);

  // Extract latest usage from timeline for the context bar in SessionControls
  const lastUsage = useMemo(() => {
    for (let i = timelineEvents.length - 1; i >= 0; i--) {
      const e = timelineEvents[i];
      if (e.type === 'usage.update' && e.payload.inputTokens) {
        return e.payload as { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string };
      }
    }
    return null;
  }, [timelineEvents]);

  // Set up WebSocket only when a server is selected
  useEffect(() => {
    if (!auth || !selectedServerId) return;

    const ws = new WsClient(auth.baseUrl, selectedServerId);
    wsRef.current = ws;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        if (msg.event === 'connected') {
          setConnected(true);
          ws.requestSessionList();
          ws.discussionList();
        }
        if (msg.event === 'disconnected') setConnected(false);
        if (msg.session && !msg.session.startsWith('deck_sub_')) {
          setSessions((prev) => {
            const existing = prev.find((s) => s.name === msg.session);
            if (!existing && msg.session) {
              return [...prev, { name: msg.session, project: '', role: 'brain', agentType: 'unknown', state: msg.state as SessionInfo['state'] }];
            }
            return prev.map((s) => s.name === msg.session ? { ...s, state: msg.state as SessionInfo['state'] } : s);
          });
        }
      }
      if (msg.type === 'session_list') {
        setSessions((prev) => msg.sessions.filter((s) => !s.name.startsWith('deck_sub_')).map((s) => {
          const existing = prev.find((p) => p.name === s.name);
          return {
            name: s.name,
            project: s.project,
            role: s.role as SessionInfo['role'],
            agentType: s.agentType,
            state: s.state as SessionInfo['state'],
            projectDir: existing?.projectDir,
          };
        }));
        setSessionsLoaded(true);
      }
      if (msg.type === 'terminal.diff') {
        const apply = diffApplyersRef.current.get(msg.diff.sessionName);
        apply?.(msg.diff);
        // Scan terminal lines for model keywords (catches Codex footer, fallback for all agents)
        const sessionName = msg.diff.sessionName;
        const stripped = msg.diff.lines.map(([, l]: [unknown, string]) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')).join(' ').toLowerCase();
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
      // Detect model from JSONL usage.update events (authoritative, overrides terminal scan)
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.type === 'usage.update' && event.payload.model) {
          const modelStr = String(event.payload.model).toLowerCase();
          const detected: 'opus' | 'sonnet' | 'haiku' | null =
            modelStr.includes('opus') ? 'opus' :
            modelStr.includes('sonnet') ? 'sonnet' :
            modelStr.includes('haiku') ? 'haiku' : null;
          if (detected) {
            setDetectedModels((prev) => {
              if (prev.get(event.sessionId) === detected) return prev;
              const next = new Map(prev);
              next.set(event.sessionId, detected);
              return next;
            });
          }
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
      if (msg.type === 'discussion.started') {
        setDiscussions((prev) => [
          ...prev,
          { id: msg.discussionId, topic: msg.topic, state: 'setup', currentRound: 0, maxRounds: msg.maxRounds },
        ]);
      }
      if (msg.type === 'discussion.update') {
        setDiscussions((prev) => prev.map((d) =>
          d.id === msg.discussionId
            ? { ...d, state: msg.state, currentRound: msg.currentRound, maxRounds: msg.maxRounds, currentSpeaker: msg.currentSpeaker }
            : d,
        ));
      }
      if (msg.type === 'discussion.done') {
        setDiscussions((prev) => prev.map((d) =>
          d.id === msg.discussionId
            ? { ...d, state: 'done', conclusion: msg.conclusion, filePath: msg.filePath }
            : d,
        ));
      }
      if (msg.type === 'discussion.error') {
        if (msg.discussionId) {
          setDiscussions((prev) => prev.map((d) =>
            d.id === msg.discussionId ? { ...d, state: 'failed' } : d,
          ));
        }
      }
      if (msg.type === 'discussion.list') {
        // Merge live discussions from daemon with existing DB history
        setDiscussions((prev) => {
          const liveIds = new Set(msg.discussions.map((d: { id: string }) => d.id));
          const dbHistory = prev.filter((d) => !liveIds.has(d.id) && (d.state === 'done' || d.state === 'failed'));
          return [...msg.discussions, ...dbHistory];
        });
      }
      if (msg.type === 'daemon.reconnected') {
        // Daemon process (re)started — all its subscriptions are gone.
        // Re-subscribe all sessions immediately so terminals resume without a page refresh.
        for (const s of sessionsRef.current) {
          ws.subscribeTerminal(s.name);
          const mode = viewModesRef.current[s.name] ?? defaultViewMode;
          if (mode === 'chat') {
            ws.sendResize(s.name, 200, 50);
          }
        }
        // Re-subscribe all sub-session terminals (for preview cards)
        for (const sub of subSessionsRef.current) {
          ws.subscribeTerminal(sub.sessionName);
        }
        // Refresh discussion list
        ws.discussionList();
      }
    });

    ws.onLatency((ms) => setLatencyMs(ms));
    const unsubStats = ws.onMessage((msg) => {
      if (msg.type === 'daemon.stats') {
        setDaemonStats({ cpu: msg.cpu, memUsed: msg.memUsed, memTotal: msg.memTotal, load1: msg.load1, load5: msg.load5, load15: msg.load15, uptime: msg.uptime });
      }
    });
    ws.connect();

    return () => {
      unsub();
      unsubStats();
      ws.onLatency(null);
      ws.disconnect();
      wsRef.current = null;
      setConnected(false);
      setLatencyMs(null);
      setDaemonStats(null);
    };
  }, [auth, selectedServerId]);

  // Subscribe to terminal for ALL sessions when connected.
  // Always subscribe (even in chat mode) so timeline events are generated
  // from terminal diff parsing. In chat mode, restore tmux to a large
  // viewport so the agent isn't cramped by mobile screen dimensions.
  // Use serialized session names as dep to avoid re-subscribing on state updates.
  const sessionNamesKey = sessions.map((s) => s.name).sort().join(',');
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || sessions.length === 0) return;
    const names = sessions.map((s) => s.name);
    for (const name of names) {
      ws.subscribeTerminal(name);
      const mode = viewModesRef.current[name] ?? defaultViewMode;
      if (mode === 'chat') {
        ws.sendResize(name, 200, 50);
      }
    }
    return () => {
      for (const name of names) {
        try { ws.unsubscribeTerminal(name); } catch { /* ignore */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionNamesKey]);

  // Subscribe terminal for ALL sub-sessions (needed for preview cards + open windows)
  const subSessionNamesKey = subSessions.map((s) => s.sessionName).sort().join(',');
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || subSessions.length === 0) return;
    const names = subSessions.map((s) => s.sessionName);
    for (const name of names) {
      try { ws.subscribeTerminal(name); } catch { /* ignore */ }
    }
    return () => {
      for (const name of names) {
        try { ws.unsubscribeTerminal(name); } catch { /* ignore */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, subSessionNamesKey]);

  // When switching to a session in terminal mode, trigger fit (display:none → flex needs refit)
  useEffect(() => {
    if (!activeSession || viewMode !== 'terminal') return;
    requestAnimationFrame(() => {
      termFitFnsRef.current.get(activeSession)?.();
    });
  }, [activeSession, viewMode]);

  // Re-subscribe when tab/window becomes visible (handles sleep/wake, background tabs)
  const viewModesRef = useRef(viewModes);
  viewModesRef.current = viewModes;
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      const session = activeSessionRef.current;
      if (!ws?.connected || !session) return;
      ws.subscribeTerminal(session);
      const mode = viewModesRef.current[session] ?? defaultViewMode;
      if (mode === 'chat') {
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

  const handleLogout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore — clear local state regardless */ }
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
    setSessionsLoaded(false);
    setActiveSession(null);
    setSelectedServerId(serverId);
    setShowMobileServerMenu(false);
    // Immediately load sessions from D1
    try {
      const data = await apiFetch<{ sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; state: string; project_dir?: string }> }>(`/api/server/${serverId}/sessions`);
      setSessions(data.sessions.map((s) => ({
        name: s.name,
        project: s.project_name,
        role: s.role as SessionInfo['role'],
        agentType: s.agent_type,
        state: s.state as SessionInfo['state'],
        projectDir: s.project_dir,
      })));
    } catch {
      // fallback: WS will populate sessions on connect
    }
    // Load completed discussion history from DB (live ones come via WS)
    try {
      const dData = await apiFetch<{ discussions: Array<{ id: string; topic: string; state: string; max_rounds: number; file_path: string | null; conclusion: string | null; started_at: number; finished_at: number | null }> }>(`/api/server/${serverId}/discussions`);
      const dbDiscussions = dData.discussions
        .filter((d) => d.state === 'done' || d.state === 'failed')
        .map((d) => ({
          id: d.id, topic: d.topic, state: d.state,
          currentRound: d.max_rounds, maxRounds: d.max_rounds,
          conclusion: d.conclusion ?? undefined, filePath: d.file_path ?? undefined,
        }));
      setDiscussions((prev) => {
        // Merge: keep live WS discussions, add DB history without duplicates
        const liveIds = new Set(prev.filter((d) => d.state !== 'done' && d.state !== 'failed').map((d) => d.id));
        const live = prev.filter((d) => liveIds.has(d.id));
        const history = dbDiscussions.filter((d) => !liveIds.has(d.id));
        return [...live, ...history];
      });
    } catch { /* ignore */ }
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
    return <LoginPage />;
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
        {daemonStats && connected && (
          <div class="sidebar-stats">
            <div class="sidebar-stats-row">
              <span style={{ color: daemonStats.cpu > 80 ? '#f87171' : daemonStats.cpu > 50 ? '#fbbf24' : '#4ade80' }}>
                CPU {daemonStats.cpu}%
              </span>
              <span style={{ color: '#a78bfa' }}>
                Load {daemonStats.load1}
              </span>
            </div>
            <div class="sidebar-stats-row">
              <span style={{ color: '#60a5fa' }}>
                Mem {(() => { const gb = daemonStats.memUsed / (1024 ** 3); return gb >= 1 ? `${gb.toFixed(1)}G` : `${(daemonStats.memUsed / (1024 ** 2)).toFixed(0)}M`; })()}/{(() => { const gb = daemonStats.memTotal / (1024 ** 3); return gb >= 1 ? `${gb.toFixed(1)}G` : `${(daemonStats.memTotal / (1024 ** 2)).toFixed(0)}M`; })()}
              </span>
              <span style={{ color: '#94a3b8' }}>
                {(() => { const s = daemonStats.uptime; const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); return d > 0 ? `${d}d ${h}h` : `${h}h`; })()}
              </span>
            </div>
          </div>
        )}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #334155' }}>
          <div style={{ fontSize: 10, color: '#475569', marginBottom: 8, textAlign: 'center' }}>
            {(() => { try { const d = new Date(__BUILD_TIME__); return `Build: ${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; } catch { return ''; } })()}
          </div>
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
                <span style={{ fontSize: 9, color: '#475569' }}>
                  {(() => { try { const d = new Date(__BUILD_TIME__); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; } catch { return ''; } })()}
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
              sessionsLoaded={sessionsLoaded}
            />

            {/* Desktop view mode toggle — mobile uses the one in mobile-server-bar */}
            {!isMobile && activeSession && (
              <div class="desktop-view-toggle">
                <button class="view-toggle" onClick={toggleViewMode}>
                  {viewMode === 'chat' ? '⌨ Terminal' : '💬 Chat'}
                </button>
              </div>
            )}

            {/* Terminal views: all sessions kept alive, show/hide via CSS */}
            {sessions.map((s) => {
              const isActive = s.name === activeSession;
              const sViewMode = viewModes[s.name] ?? defaultViewMode;
              const visible = isActive && sViewMode === 'terminal';
              return (
                <div
                  key={s.name}
                  style={{ display: visible ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}
                >
                  <TerminalView
                    sessionName={s.name}
                    ws={wsRef.current}
                    connected={connected}
                    onDiff={(apply) => registerDiffApplyer(s.name, apply)}
                    onHistory={(apply) => registerHistoryApplyer(s.name, apply)}
                    onFocusFn={(fn) => { termFocusFnsRef.current.set(s.name, fn); }}
                    onFitFn={(fn) => { termFitFnsRef.current.set(s.name, fn); }}
                    onScrollBottomFn={(fn) => { termScrollFnsRef.current.set(s.name, fn); }}
                  />
                </div>
              );
            })}

            {/* Chat view for active session in chat mode */}
            {activeSession && viewMode === 'chat' && (
              <ChatView events={timelineEvents} loading={timelineLoading} refreshing={timelineRefreshing} sessionId={activeSession} sessionState={activeSessionInfo?.state} onScrollBottomFn={(fn) => { chatScrollFnRef.current = fn; }} />
            )}

            {!activeSession && !sessionsLoaded && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', flexDirection: 'column', gap: 12 }}>
                <div class="spinner" />
                <div>Connecting...</div>
              </div>
            )}
            {!activeSession && sessionsLoaded && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 32 }}>⌨</div>
                <div>Select a session or start a new one</div>
                <button class="btn btn-primary" onClick={() => setShowNewSession(true)}>
                  + New Session
                </button>
              </div>
            )}

            {lastUsage && (() => {
              const ctx = lastUsage.contextWindow || 1_000_000;
              const total = lastUsage.inputTokens + lastUsage.cacheTokens;
              const totalPct = Math.min(100, total / ctx * 100);
              const cachePct = Math.min(totalPct, lastUsage.cacheTokens / ctx * 100);
              const newPct = totalPct - cachePct;
              const fmt = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
              const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
              const tip = [
                lastUsage.model ?? '',
                `Context: ${fmt(total)} / ${fmt(ctx)} (${pctStr}%)`,
                `  New: ${fmt(lastUsage.inputTokens)}  Cache: ${fmt(lastUsage.cacheTokens)}`,
              ].filter(Boolean).join('\n');
              return (
                <div class="session-usage-footer" title={tip}>
                  <div class="session-ctx-bar">
                    <div class="session-ctx-cache" style={{ width: `${cachePct}%` }} />
                    <div class="session-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
                  </div>
                  <div class="session-usage-stats">
                    <span class="session-usage-tokens">{fmt(total)} / {fmt(ctx)} ({pctStr}%)</span>
                    {lastUsage.model && <span class="session-usage-tokens" style={{ color: '#818cf8' }}>{lastUsage.model.includes('opus') ? 'opus' : lastUsage.model.includes('sonnet') ? 'sonnet' : lastUsage.model.includes('haiku') ? 'haiku' : lastUsage.model.includes('flash') ? 'flash' : lastUsage.model.split('-').pop()}</span>}
                  </div>
                </div>
              );
            })()}
            <SessionControls ws={wsRef.current} activeSession={activeSessionInfo} inputRef={inputRef} onAfterAction={focusTerminal} onSend={scrollActiveToBottom} onStopProject={handleStopProject} onRenameSession={() => activeSession && setRenameRequest(activeSession)} sessionDisplayName={activeSessionInfo?.project ?? null} quickData={quickData} detectedModel={activeSession ? detectedModels.get(activeSession) : undefined} hideShortcuts={false} />

            {/* Sub-session bar */}
            {selectedServerId && (
              <SubSessionBar
                subSessions={subSessions}
                openIds={openSubIds}
                onOpen={toggleSubSession}
                onNew={() => setShowSubDialog(true)}
                onNewDiscussion={() => {
                  void getUserPref('discussion_prefs').then((prefs) => {
                    setDiscussionPrefs(prefs as DiscussionPrefs | null);
                    setShowDiscussionDialog(true);
                  });
                }}
                onViewDiscussions={() => setShowDiscussionsPage(true)}
                discussions={discussions.filter((d) => d.state !== 'done' && d.state !== 'failed')}
                onStopDiscussion={(id) => wsRef.current?.discussionStop(id)}
                ws={wsRef.current}
                connected={connected}
                onDiff={registerDiffApplyer}
                onHistory={registerHistoryApplyer}
              />
            )}
          </>
        )}
      </main>

      {showDiscussionsPage && selectedServerId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#0a0e1a' }}>
          <DiscussionsPage
            serverId={selectedServerId}
            ws={wsRef.current}
            onBack={() => setShowDiscussionsPage(false)}
          />
        </div>
      )}

      {showNewSession && (
        <NewSessionDialog
          ws={wsRef.current}
          onClose={() => setShowNewSession(false)}
          onSessionStarted={(name) => { setActiveSession(name); setShowNewSession(false); }}
        />
      )}

      {/* Sub-session windows (floating) */}
      {subSessions.filter((s) => openSubIds.has(s.id)).map((sub) => (
        <SubSessionWindow
          key={sub.id}
          sub={sub}
          ws={wsRef.current}
          connected={connected}
          onDiff={registerDiffApplyer}
          onHistory={registerHistoryApplyer}
          onMinimize={() => setOpenSubIds((prev) => { const s = new Set(prev); s.delete(sub.id); return s; })}
          onClose={() => closeSubSession(sub.id)}
          onRestart={() => restartSubSession(sub.id)}
          onRename={() => {
            const label = prompt('Rename sub-session:', sub.label ?? '');
            if (label !== null) renameSubSession(sub.id, label);
          }}
          zIndex={subZIndexes.get(sub.id) ?? 1000}
          onFocus={() => bringSubToFront(sub.id)}
        />
      ))}

      {showDiscussionDialog && wsRef.current && (
        <StartDiscussionDialog
          ws={wsRef.current}
          defaultCwd={activeSessionInfo?.projectDir}
          existingSessions={subSessions.map((s): SubSessionOption => ({
            sessionName: s.sessionName,
            label: s.label ?? '',
            type: s.type,
          }))}
          savedPrefs={discussionPrefs}
          onClose={() => setShowDiscussionDialog(false)}
        />
      )}

      {showSubDialog && (
        <StartSubSessionDialog
          ws={wsRef.current}
          defaultCwd={activeSessionInfo?.projectDir}
          onStart={async (type, shellBin, cwd, label) => {
            setShowSubDialog(false);
            const sub = await createSubSession(type, shellBin, cwd, label);
            if (sub) {
              setOpenSubIds((prev) => new Set([...prev, sub.id]));
              bringSubToFront(sub.id);
            }
          }}
          onClose={() => setShowSubDialog(false)}
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
