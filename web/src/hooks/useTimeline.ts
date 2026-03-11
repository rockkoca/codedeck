/**
 * React hook for timeline event state management.
 * Loads from IndexedDB on mount, listens for WS events,
 * handles reconnection replay with epoch checking.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { WsClient, TimelineEvent, ServerMessage } from '../ws-client.js';
import { TimelineDB } from '../timeline-db.js';

const MAX_MEMORY_EVENTS = 500;
const INITIAL_LOAD_LIMIT = 200;
const ECHO_WINDOW_MS = 2000;

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
}

export function useTimeline(
  sessionId: string | null,
  ws: WsClient | null,
): UseTimelineResult {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const dbRef = useRef<TimelineDB | null>(null);
  const epochRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const replayRequestIdRef = useRef<string | null>(null);

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

  // Load events from IndexedDB when session changes
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setLoading(false);
      epochRef.current = 0;
      seqRef.current = 0;
      return;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      const db = dbRef.current;
      if (!db) {
        setLoading(false);
        return;
      }

      const last = await db.getLastSeqAndEpoch(sessionId);
      if (cancelled) return;

      if (last) {
        epochRef.current = last.epoch;
        seqRef.current = last.seq;
        const stored = await db.getEvents(sessionId, last.epoch, { limit: INITIAL_LOAD_LIMIT });
        if (cancelled) return;
        setEvents(stored);
      } else {
        epochRef.current = 0;
        seqRef.current = 0;
        setEvents([]);
      }
      setLoading(false);
    };

    load().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [sessionId]);

  // Append a single event, dedup by eventId
  const appendEvent = useCallback((event: TimelineEvent) => {
    setEvents((prev) => {
      if (prev.some((e) => e.eventId === event.eventId)) return prev;
      const next = [...prev, event];
      // Trim to keep memory bounded
      return next.length > MAX_MEMORY_EVENTS
        ? next.slice(next.length - MAX_MEMORY_EVENTS)
        : next;
    });
  }, []);

  // Listen for WS messages
  useEffect(() => {
    if (!ws || !sessionId) return;

    const handler = (msg: ServerMessage) => {
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        if (event.sessionId !== sessionId) return;

        // Echo dedup: if assistant.text matches a recent user.message, hide it
        if (event.type === 'assistant.text' && event.payload.text) {
          const normalized = normalizeForEcho(String(event.payload.text));
          setEvents((prev) => {
            const recentUserMsg = prev.find(
              (e) =>
                e.type === 'user.message' &&
                e.ts > event.ts - ECHO_WINDOW_MS &&
                normalizeForEcho(String(e.payload.text ?? '')) === normalized,
            );
            if (recentUserMsg) {
              event.hidden = true;
            }
            return prev;
          });
        }

        // Update tracking
        if (event.epoch !== epochRef.current) {
          // Epoch changed (daemon restarted) — clear old epoch data
          const oldEpoch = epochRef.current;
          epochRef.current = event.epoch;
          seqRef.current = event.seq;
          setEvents([event]);
          // Clear OLD epoch from DB (not the new one)
          const db = dbRef.current;
          if (db && oldEpoch > 0) {
            db.clearSessionEpoch(sessionId, oldEpoch).catch(() => {});
          }
        } else {
          seqRef.current = Math.max(seqRef.current, event.seq);
          appendEvent(event);
        }

        // Persist to IndexedDB
        dbRef.current?.putEvent(event).catch(() => {});
      }

      if (msg.type === 'timeline.replay') {
        // Filter: only process replays for the current session AND our own request
        if (msg.sessionName !== sessionId) return;
        if (msg.requestId && msg.requestId !== replayRequestIdRef.current) return;
        replayRequestIdRef.current = null;
        const { events: replayEvents, truncated, epoch } = msg;

        if (epoch !== epochRef.current) {
          // Epoch mismatch — daemon restarted — clear OLD epoch data
          const oldEpoch = epochRef.current;
          epochRef.current = epoch;
          seqRef.current = 0;
          setEvents([]);
          if (dbRef.current && sessionId && oldEpoch > 0) {
            dbRef.current.clearSessionEpoch(sessionId, oldEpoch).catch(() => {});
          }
        }

        if (truncated && ws && sessionId) {
          // We missed events — request a terminal snapshot for context
          ws.sendSnapshotRequest(sessionId);
        }

        if (replayEvents.length > 0) {
          // Merge replay events
          setEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.eventId));
            const newEvents = replayEvents.filter((e) => !existingIds.has(e.eventId));
            if (newEvents.length === 0) return prev;
            const merged = [...prev, ...newEvents].sort((a, b) => a.seq - b.seq);
            return merged.length > MAX_MEMORY_EVENTS
              ? merged.slice(merged.length - MAX_MEMORY_EVENTS)
              : merged;
          });

          // Update seq tracking
          const maxSeq = replayEvents.reduce((max, e) => Math.max(max, e.seq), 0);
          seqRef.current = Math.max(seqRef.current, maxSeq);

          // Persist replay events to DB
          dbRef.current?.putEvents(replayEvents).catch(() => {});
        }
      }

      // On reconnect, request replay to fill gaps
      if (msg.type === 'daemon.reconnected' || (msg.type === 'session.event' && (msg as { event: string }).event === 'connected')) {
        if (ws && sessionId && epochRef.current > 0) {
          replayRequestIdRef.current = ws.sendTimelineReplayRequest(sessionId, seqRef.current, epochRef.current);
        }
      }
    };

    const unsub = ws.onMessage(handler);
    return unsub;
  }, [ws, sessionId, appendEvent]);

  return { events, loading };
}
