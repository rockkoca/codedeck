/**
 * useSubSessions — loads sub-session list from PG, handles create/close,
 * and triggers daemon rebuild on connect.
 */
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import {
  listSubSessions,
  createSubSession as apiCreate,
  patchSubSession,
  type SubSessionData,
} from '../api.js';
import type { WsClient } from '../ws-client.js';

export interface SubSession extends SubSessionData {
  sessionName: string;
  /** runtime state from daemon */
  state: 'running' | 'stopped' | 'starting' | 'unknown';
}

function toSessionName(id: string): string {
  return `deck_sub_${id}`;
}

export function useSubSessions(
  serverId: string | null,
  ws: WsClient | null,
  connected: boolean,
) {
  const [subSessions, setSubSessions] = useState<SubSession[]>([]);
  const [loadedServerId, setLoadedServerId] = useState<string | null>(null);
  const rebuiltRef = useRef(false);

  // Load from PG when server changes
  useEffect(() => {
    if (!serverId) { setSubSessions([]); setLoadedServerId(null); return; }
    rebuiltRef.current = false;
    listSubSessions(serverId)
      .then((list) => {
        setSubSessions(list.map((s) => ({
          ...s,
          sessionName: toSessionName(s.id),
          state: 'unknown' as const,
        })));
        setLoadedServerId(serverId);
      })
      .catch(() => {});
  }, [serverId]);

  // Rebuild all when daemon connects (once per connection)
  useEffect(() => {
    if (!connected || !ws || subSessions.length === 0 || rebuiltRef.current) return;
    rebuiltRef.current = true;
    ws.subSessionRebuildAll(subSessions.map((s) => ({
      id: s.id,
      type: s.type,
      shellBin: s.shellBin,
      cwd: s.cwd,
      ccSessionId: s.ccSessionId,
    })));
  }, [connected, ws, subSessions]);

  // Reset rebuild flag when disconnected
  useEffect(() => {
    if (!connected) rebuiltRef.current = false;
  }, [connected]);

  const create = useCallback(async (
    type: string,
    shellBin?: string,
    cwd?: string,
    label?: string,
  ): Promise<SubSession | null> => {
    if (!serverId) return null;
    try {
      const ccSessionId = type === 'claude-code' ? crypto.randomUUID() : undefined;
      const res = await apiCreate(serverId, { type, shellBin, cwd, label, ccSessionId });
      const sub: SubSession = {
        ...res.subSession,
        sessionName: res.sessionName,
        state: 'starting',
      };
      setSubSessions((prev) => [...prev, sub]);
      // Ask daemon to start it
      ws?.subSessionStart(sub.id, type, shellBin, cwd, ccSessionId);
      return sub;
    } catch {
      return null;
    }
  }, [serverId, ws]);

  const close = useCallback(async (id: string) => {
    if (!serverId) return;
    const sub = subSessions.find((s) => s.id === id);
    if (!sub) return;
    // Stop the tmux session
    ws?.subSessionStop(sub.sessionName);
    // Mark closed in PG
    await patchSubSession(serverId, id, { closedAt: Date.now() }).catch(() => {});
    // Remove from local state
    setSubSessions((prev) => prev.filter((s) => s.id !== id));
  }, [serverId, ws, subSessions]);

  return { subSessions, loadedServerId, create, close };
}
