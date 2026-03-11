import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineEmitter } from '../../src/daemon/timeline-emitter.js';

/**
 * Focused tests for TimelineEmitter.replay() logic.
 * The ring buffer caps at 500 events; once it wraps, the minimum seq
 * in the buffer jumps above 0. This file verifies all branch conditions
 * in the truncated flag calculation:
 *
 *   truncated = (afterSeq + 1) < bufMinSeq
 */

describe('TimelineEmitter.replay — truncation logic', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
  });

  it('afterSeq+1 < bufMinSeq → truncated: true', () => {
    const session = 'trunc-test';
    // Emit 510 events; buffer keeps the last 500 (seq 11–510), evicting seq 1–10
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // afterSeq=3 → want events from seq 4+, but buffer starts at seq 11
    // 4 < 11 → truncated
    const { truncated, events } = emitter.replay(session, 3);
    expect(truncated).toBe(true);
    // Events returned are those with seq > 3 that ARE in the buffer (seq 11–510)
    expect(events.length).toBe(500);
  });

  it('exact match: afterSeq = last seq in buffer → truncated: false, empty events', () => {
    const session = 'exact-match';
    emitter.emit(session, 'session.state', { state: 'idle' }); // seq 1
    emitter.emit(session, 'assistant.text', { text: 'hello' }); // seq 2
    emitter.emit(session, 'assistant.text', { text: 'world' }); // seq 3

    const { truncated, events } = emitter.replay(session, 3);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('empty buffer → truncated: false (no events ever emitted, nothing was lost)', () => {
    const { truncated, events } = emitter.replay('never-used-session', 99);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('normal replay: returns only events with seq > afterSeq', () => {
    const session = 'normal-replay';
    for (let i = 0; i < 10; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i + 1}` });
    }

    const { truncated, events } = emitter.replay(session, 5);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
  });

  it('afterSeq=0 with non-empty buffer → truncated: false, all events returned', () => {
    const session = 'from-zero';
    emitter.emit(session, 'user.message', { text: 'a' }); // seq 1
    emitter.emit(session, 'user.message', { text: 'b' }); // seq 2

    const { truncated, events } = emitter.replay(session, 0);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
  });

  it('afterSeq exactly at buffer boundary (bufMinSeq - 1) → truncated: false', () => {
    const session = 'boundary';
    // 505 events → buffer holds 500, min seq = 6
    for (let i = 0; i < 505; i++) {
      emitter.emit(session, 'assistant.text', { text: `x-${i}` });
    }

    // afterSeq=5 → afterSeq+1=6 = bufMinSeq → NOT truncated
    const { truncated } = emitter.replay(session, 5);
    expect(truncated).toBe(false);
  });

  it('afterSeq one below boundary (bufMinSeq - 2) → truncated: true', () => {
    const session = 'just-below';
    // 505 events → buffer holds seq 6–505, bufMinSeq = 6
    for (let i = 0; i < 505; i++) {
      emitter.emit(session, 'assistant.text', { text: `x-${i}` });
    }

    // afterSeq=4 → afterSeq+1=5 < bufMinSeq(6) → truncated
    const { truncated } = emitter.replay(session, 4);
    expect(truncated).toBe(true);
  });

  it('replay preserves event order (seq ascending)', () => {
    const session = 'order-check';
    for (let i = 0; i < 5; i++) {
      emitter.emit(session, 'assistant.text', { text: `item-${i}` });
    }

    const { events } = emitter.replay(session, 0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});
