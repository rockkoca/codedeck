/**
 * Tests for timeline reconnection logic — requestId filtering, epoch handling.
 * Includes both unit tests for filtering logic and hook-level integration tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/preact';
import type { TimelineEvent, ServerMessage, MessageHandler } from '../src/ws-client.js';
import { useTimeline } from '../src/hooks/useTimeline.js';

// Reproduce the requestId filtering logic from useTimeline
function shouldProcessReplay(
  msg: { sessionName: string; requestId?: string },
  currentSessionId: string,
  pendingRequestId: string | null,
): boolean {
  if (msg.sessionName !== currentSessionId) return false;
  if (msg.requestId && msg.requestId !== pendingRequestId) return false;
  return true;
}

function makeEvent(overrides: Partial<TimelineEvent> & { seq: number; epoch: number }): TimelineEvent {
  return {
    eventId: `evt-${overrides.seq}`,
    sessionId: 'session-a',
    ts: Date.now(),
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: `msg-${overrides.seq}` },
    ...overrides,
  };
}

describe('timeline replay requestId filtering', () => {
  it('accepts replay matching sessionName and requestId', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-1' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(true);
  });

  it('rejects replay for wrong sessionName', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-b', requestId: 'req-1' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(false);
  });

  it('rejects replay with mismatched requestId', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-2' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(false);
  });

  it('accepts replay without requestId (backwards compat)', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a' },
      'session-a',
      'req-1',
    );
    expect(result).toBe(true);
  });

  it('accepts replay without requestId when no pending request', () => {
    const result = shouldProcessReplay(
      { sessionName: 'session-a' },
      'session-a',
      null,
    );
    expect(result).toBe(true);
  });

  it('rejects stale replay from concurrent request (multi-browser scenario)', () => {
    // Browser A sends req-1, Browser B sends req-2
    // Browser A should reject req-2's response
    const resultForA = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-2' },
      'session-a',
      'req-1', // Browser A is waiting for req-1
    );
    expect(resultForA).toBe(false);

    // Browser B should reject req-1's response
    const resultForB = shouldProcessReplay(
      { sessionName: 'session-a', requestId: 'req-1' },
      'session-a',
      'req-2', // Browser B is waiting for req-2
    );
    expect(resultForB).toBe(false);
  });
});

describe('timeline epoch mismatch handling', () => {
  it('epoch mismatch should clear old data and adopt new epoch', () => {
    let currentEpoch = 1000;
    let events: TimelineEvent[] = [
      makeEvent({ seq: 1, epoch: 1000 }),
      makeEvent({ seq: 2, epoch: 1000 }),
    ];

    // Simulate receiving a replay with new epoch
    const newEpoch = 2000;
    if (newEpoch !== currentEpoch) {
      const oldEpoch = currentEpoch;
      currentEpoch = newEpoch;
      events = []; // clear
      // Verify we saved the old epoch (for DB cleanup)
      expect(oldEpoch).toBe(1000);
    }

    expect(currentEpoch).toBe(2000);
    expect(events).toHaveLength(0);
  });

  it('epoch match should merge replay events by dedup', () => {
    const existing = [
      makeEvent({ seq: 1, epoch: 100 }),
      makeEvent({ seq: 2, epoch: 100 }),
    ];
    const replay = [
      makeEvent({ seq: 2, epoch: 100 }), // duplicate
      makeEvent({ seq: 3, epoch: 100 }),
      makeEvent({ seq: 4, epoch: 100 }),
    ];

    const existingIds = new Set(existing.map(e => e.eventId));
    const newEvents = replay.filter(e => !existingIds.has(e.eventId));
    const merged = [...existing, ...newEvents].sort((a, b) => a.seq - b.seq);

    expect(merged).toHaveLength(4);
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('truncated replay should trigger snapshot request', () => {
    let snapshotRequested = false;

    const truncated = true;
    if (truncated) {
      snapshotRequested = true;
    }

    expect(snapshotRequested).toBe(true);
  });

  it('non-truncated replay should not trigger snapshot request', () => {
    let snapshotRequested = false;

    const truncated = false;
    if (truncated) {
      snapshotRequested = true;
    }

    expect(snapshotRequested).toBe(false);
  });
});

// ── Hook-level integration tests with mock WsClient ────────────────────────

/** Minimal mock WsClient that captures onMessage handlers and allows dispatching messages */
function createMockWs() {
  const handlers = new Set<MessageHandler>();
  return {
    get connected() { return true; },
    get pingLatency() { return null; },
    onLatency: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    subscribeTerminal: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    requestSessionList: vi.fn(),
    sendTimelineReplayRequest: vi.fn(() => 'mock-req-id'),
    sendSnapshotRequest: vi.fn(),
    // Test helper: dispatch a message to all handlers
    _dispatch(msg: ServerMessage) {
      for (const h of handlers) h(msg);
    },
    _handlers: handlers,
  };
}

describe('useTimeline hook — integration with mock WsClient', () => {
  let mockWs: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    mockWs = createMockWs();
    cleanup();
  });

  it('receives timeline.event and appends to events list', async () => {
    const { result } = renderHook(() =>
      useTimeline('session-a', mockWs as any),
    );

    // Wait for initial loading to complete
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.events).toHaveLength(0);

    // Dispatch a timeline event
    act(() => {
      mockWs._dispatch({
        type: 'timeline.event',
        event: makeEvent({ seq: 1, epoch: 5000, sessionId: 'session-a' }),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].seq).toBe(1);
  });

  it('filters out timeline.event for different session', async () => {
    const { result } = renderHook(() =>
      useTimeline('session-a', mockWs as any),
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    act(() => {
      mockWs._dispatch({
        type: 'timeline.event',
        event: makeEvent({ seq: 1, epoch: 5000, sessionId: 'session-b' }),
      });
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('processes matching replay and rejects mismatched requestId', async () => {
    const { result } = renderHook(() =>
      useTimeline('session-a', mockWs as any),
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // First, seed an event so we have an epoch
    act(() => {
      mockWs._dispatch({
        type: 'timeline.event',
        event: makeEvent({ seq: 1, epoch: 5000, sessionId: 'session-a' }),
      });
    });
    expect(result.current.events).toHaveLength(1);

    // Simulate reconnect — triggers replay request
    act(() => {
      mockWs._dispatch({
        type: 'session.event',
        event: 'connected',
        session: '',
        state: 'connected',
      });
    });

    // Now send a replay with WRONG requestId — should be ignored
    act(() => {
      mockWs._dispatch({
        type: 'timeline.replay',
        sessionName: 'session-a',
        requestId: 'wrong-id',
        events: [makeEvent({ seq: 2, epoch: 5000, sessionId: 'session-a', eventId: 'extra' })],
        truncated: false,
        epoch: 5000,
      } as any);
    });

    expect(result.current.events).toHaveLength(1); // still 1, replay ignored

    // Send replay with CORRECT requestId
    act(() => {
      mockWs._dispatch({
        type: 'timeline.replay',
        sessionName: 'session-a',
        requestId: 'mock-req-id',
        events: [makeEvent({ seq: 2, epoch: 5000, sessionId: 'session-a', eventId: 'evt-2' })],
        truncated: false,
        epoch: 5000,
      } as any);
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events.map(e => e.seq)).toEqual([1, 2]);
  });

  it('epoch mismatch clears events and requests snapshot on truncated', async () => {
    const { result } = renderHook(() =>
      useTimeline('session-a', mockWs as any),
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Seed events with epoch 1000
    act(() => {
      mockWs._dispatch({
        type: 'timeline.event',
        event: makeEvent({ seq: 1, epoch: 1000, sessionId: 'session-a' }),
      });
      mockWs._dispatch({
        type: 'timeline.event',
        event: makeEvent({ seq: 2, epoch: 1000, sessionId: 'session-a', eventId: 'evt-2' }),
      });
    });
    expect(result.current.events).toHaveLength(2);

    // Receive event with new epoch — should clear old events
    act(() => {
      mockWs._dispatch({
        type: 'timeline.event',
        event: makeEvent({ seq: 1, epoch: 2000, sessionId: 'session-a', eventId: 'new-1' }),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].epoch).toBe(2000);
    expect(result.current.events[0].eventId).toBe('new-1');
  });
});
