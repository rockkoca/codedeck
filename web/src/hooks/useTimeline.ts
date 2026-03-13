/**
 * React hook for timeline event state management.
 * Loads from daemon file store on connect, caches in IndexedDB,
 * listens for real-time WS events, handles reconnection replay.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { WsClient, TimelineEvent, ServerMessage } from '../ws-client.js';
import { TimelineDB } from '../timeline-db.js';

const MAX_MEMORY_EVENTS = 500;
const ECHO_WINDOW_MS = 2000;
// Dedup window for user.message from JSONL vs web-UI-sent: JSONL watcher polls every 2s,
// so the same message can arrive twice (once from command-handler, once from JSONL).
// 5s is enough to catch the JSONL delay without hiding legitimate repeated messages.
const USER_MSG_DEDUP_WINDOW_MS = 5_000;

/** Normalize text for echo comparison: strip prompt prefixes, collapse whitespace. */
function normalizeForEcho(text: string): string {
  return text
    .trim()
    .replace(/^[❯>λ›$%#]\s*/, '')
    .replace(/\s+/g, ' ');
}

export interface UseTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling after a cache hit — content is visible but may be stale */
  refreshing: boolean;
}

export function useTimeline(
  sessionId: string | null,
  ws: WsClient | null,
): UseTimelineResult {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const dbRef = useRef<TimelineDB | null>(null);
  const epochRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const replayRequestIdRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef<string | null>(null);
  const historyLoadedRef = useRef<string | null>(null); // tracks which session has been loaded

  // Initialize DB once
  useEffect(() => {
    const db = new TimelineDB();
    dbRef.current = db;
    db.open().catch(() => {});
    return () => {
      db.close();
      dbRef.current = null;
    };
  }, []);

  // Reset on session change
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setLoading(false);
      epochRef.current = 0;
      seqRef.current = 0;
      historyLoadedRef.current = null;
      return;
    }

    // Show loading until we have content to display
    setLoading(true);
    setRefreshing(false);
    historyLoadedRef.current = null;

    // Load from IndexedDB as immediate cache while waiting for daemon
    const load = async () => {
      const db = dbRef.current;
      if (!db) return;
      const last = await db.getLastSeqAndEpoch(sessionId);
      if (last) {
        epochRef.current = last.epoch;
        seqRef.current = last.seq;
        const stored = await db.getEvents(sessionId, last.epoch, { limit: MAX_MEMORY_EVENTS });
        setEvents(stored);
        // Cache hit — show immediately, but always request full history from daemon
        // so tool.call / other events not in cache get filled in.
        setLoading(false);
        if (ws?.connected) {
          setRefreshing(true);
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId);
        }
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
        setEvents([]);
        // No cache — request full history from daemon
        if (ws?.connected) {
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId);
        } else {
          setLoading(false);
        }
      }
    };
    load().catch(() => {});
  }, [sessionId, ws]);

  // Append a single event, dedup by eventId
  const appendEvent = useCallback((event: TimelineEvent) => {
    setEvents((prev) => {
      if (prev.some((e) => e.eventId === event.eventId)) return prev;
      const next = [...prev, event];
      return next.length > MAX_MEMORY_EVENTS
        ? next.slice(next.length - MAX_MEMORY_EVENTS)
        : next;
    });
  }, []);

  /** Merge a batch of events into state (dedup + sort). */
  const mergeEvents = useCallback((incoming: TimelineEvent[]) => {
    setEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.eventId));
      const newEvents = incoming.filter((e) => !existingIds.has(e.eventId));
      if (newEvents.length === 0) return prev;
      const merged = [...prev, ...newEvents].sort((a, b) => a.seq - b.seq);
      return merged.length > MAX_MEMORY_EVENTS
        ? merged.slice(merged.length - MAX_MEMORY_EVENTS)
        : merged;
    });
  }, []);

  // Listen for WS messages
  useEffect(() => {
    if (!ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      // ── Real-time event ──
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;

        // Echo dedup: hide assistant.text that echoes a recent user message (e.g. prompt repeat)
        if (event.type === 'assistant.text' && event.payload.text) {
          const normalized = normalizeForEcho(String(event.payload.text));
          setEvents((prev) => {
            const recentUserMsg = prev.find(
              (e) =>
                e.type === 'user.message' &&
                e.ts > event.ts - ECHO_WINDOW_MS &&
                normalizeForEcho(String(e.payload.text ?? '')) === normalized,
            );
            if (recentUserMsg) event.hidden = true;
            return prev;
          });
        }

        // Dedup user.message: JSONL watcher re-emits web-UI-sent messages ~2s later.
        // If an identical user.message already exists within 30s, hide the duplicate.
        if (event.type === 'user.message' && event.payload.text) {
          const text = String(event.payload.text).trim();
          setEvents((prev) => {
            const isDup = prev.some(
              (e) =>
                e.type === 'user.message' &&
                Math.abs(e.ts - event.ts) < USER_MSG_DEDUP_WINDOW_MS &&
                String(e.payload.text ?? '').trim() === text,
            );
            if (isDup) event.hidden = true;
            return prev;
          });
        }

        // Epoch change detection
        if (event.epoch !== epochRef.current && epochRef.current > 0) {
          const oldEpoch = epochRef.current;
          epochRef.current = event.epoch;
          seqRef.current = event.seq;
          setEvents([event]);
          const db = dbRef.current;
          if (db && oldEpoch > 0) {
            db.clearSessionEpoch(sessionId, oldEpoch).catch(() => {});
          }
        } else {
          epochRef.current = event.epoch;
          seqRef.current = Math.max(seqRef.current, event.seq);
          appendEvent(event);
        }

        dbRef.current?.putEvent(event).catch(() => {});
      }

      // ── History response (full load from daemon file store) ──
      if (msg.type === 'timeline.history') {
        if (msg.sessionName !== sessionId) return;
        if (msg.requestId && msg.requestId !== historyRequestIdRef.current) return;
        historyRequestIdRef.current = null;
        historyLoadedRef.current = sessionId;

        const oldEpoch = epochRef.current;
        epochRef.current = msg.epoch;

        if (msg.events.length > 0) {
          const maxSeq = msg.events.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);

          // If epoch changed, replace events entirely — don't mix epochs (breaks merge order)
          if (oldEpoch !== 0 && oldEpoch !== msg.epoch) {
            setEvents(msg.events);
            if (dbRef.current) {
              dbRef.current.clearSessionEpoch(sessionId, oldEpoch).catch(() => {});
              dbRef.current.putEvents(msg.events).catch(() => {});
            }
          } else {
            mergeEvents(msg.events);
            dbRef.current?.putEvents(msg.events).catch(() => {});
          }
        } else if (oldEpoch !== 0 && oldEpoch !== msg.epoch) {
          // Epoch changed but no events — clear stale cache
          setEvents([]);
          if (dbRef.current) {
            dbRef.current.clearSessionEpoch(sessionId, oldEpoch).catch(() => {});
          }
        }
        setLoading(false);
        setRefreshing(false);
      }

      // ── Replay response (gap-fill after reconnect) ──
      if (msg.type === 'timeline.replay') {
        if (msg.sessionName !== sessionId) return;
        if (msg.requestId && msg.requestId !== replayRequestIdRef.current) return;
        replayRequestIdRef.current = null;
        const { events: replayEvents, truncated, epoch } = msg;

        if (epoch !== epochRef.current && epochRef.current > 0) {
          const oldEpoch = epochRef.current;
          epochRef.current = epoch;
          seqRef.current = 0;
          setEvents([]);
          if (dbRef.current && oldEpoch > 0) {
            dbRef.current.clearSessionEpoch(sessionId, oldEpoch).catch(() => {});
          }
        }

        if (truncated && ws) {
          ws.sendSnapshotRequest(sessionId);
        }

        if (replayEvents.length > 0) {
          const maxSeq = replayEvents.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);
          mergeEvents(replayEvents);
          dbRef.current?.putEvents(replayEvents).catch(() => {});
        }
        setRefreshing(false);
      }

      // ── Reconnect: request replay to fill gaps ──
      if (msg.type === 'daemon.reconnected' || (msg.type === 'session.event' && (msg as { event: string }).event === 'connected')) {
        if (ws && sessionId && epochRef.current > 0) {
          replayRequestIdRef.current = ws.sendTimelineReplayRequest(sessionId, seqRef.current, epochRef.current);
        } else if (ws && sessionId) {
          // No epoch yet — request full history
          historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId);
        }
      }
    };

    // Always request full history on connect (cache is just for instant display).
    if (ws.connected && historyLoadedRef.current !== sessionId) {
      historyRequestIdRef.current = ws.sendTimelineHistoryRequest(sessionId);
    }

    const unsub = ws.onMessage(handler);
    return unsub;
  }, [ws, sessionId, appendEvent, mergeEvents]);

  return { events, loading, refreshing };
}
