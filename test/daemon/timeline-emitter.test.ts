import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineEmitter } from '../../src/daemon/timeline-emitter.js';

describe('TimelineEmitter — seq counter', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
  });

  it('seq is monotonically increasing per session', () => {
    const e1 = emitter.emit('session-a', 'assistant.text', { text: 'hello' });
    const e2 = emitter.emit('session-a', 'assistant.text', { text: 'world' });
    const e3 = emitter.emit('session-a', 'session.state', { state: 'idle' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('different sessions have independent seq counters', () => {
    const a1 = emitter.emit('session-a', 'assistant.text', { text: 'hi' });
    const b1 = emitter.emit('session-b', 'assistant.text', { text: 'hello' });
    const a2 = emitter.emit('session-a', 'session.state', { state: 'idle' });
    const b2 = emitter.emit('session-b', 'session.state', { state: 'idle' });

    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1);
    expect(b2.seq).toBe(2);
  });

  it('emitted event contains expected fields', () => {
    const event = emitter.emit('session-x', 'user.message', { text: 'test' }, {
      source: 'hook',
      confidence: 'medium',
    });
    expect(event.sessionId).toBe('session-x');
    expect(event.type).toBe('user.message');
    expect(event.payload).toEqual({ text: 'test' });
    expect(event.source).toBe('hook');
    expect(event.confidence).toBe('medium');
    expect(event.epoch).toBe(emitter.epoch);
    expect(typeof event.eventId).toBe('string');
    expect(event.eventId).toHaveLength(36); // UUID
  });

  it('defaults source to daemon and confidence to high', () => {
    const event = emitter.emit('session-x', 'session.state', { state: 'idle' });
    expect(event.source).toBe('daemon');
    expect(event.confidence).toBe('high');
  });
});

describe('TimelineEmitter — ring buffer', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
  });

  it('ring buffer caps at 500, evicting oldest events', () => {
    const session = 'session-buf';
    // Emit 510 events
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // Replay from seq 0 — should get only the last 500
    const { events } = emitter.replay(session, 0);
    expect(events).toHaveLength(500);
    // The first event in the buffer should be seq 11 (510 - 500 + 1)
    expect(events[0].seq).toBe(11);
    // The last should be seq 510
    expect(events[events.length - 1].seq).toBe(510);
  });

  it('ring buffer does not exceed 500 for a single session', () => {
    const session = 'session-cap';
    for (let i = 0; i < 600; i++) {
      emitter.emit(session, 'session.state', { state: 'idle' });
    }
    const { events } = emitter.replay(session, 0);
    expect(events.length).toBeLessThanOrEqual(500);
  });

  it('buffers for different sessions do not interfere', () => {
    for (let i = 0; i < 510; i++) {
      emitter.emit('session-a', 'assistant.text', { text: `a-${i}` });
    }
    emitter.emit('session-b', 'user.message', { text: 'only-one' });

    const { events: bEvents } = emitter.replay('session-b', 0);
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0].payload.text).toBe('only-one');
  });
});

describe('TimelineEmitter — replay', () => {
  let emitter: TimelineEmitter;

  beforeEach(() => {
    emitter = new TimelineEmitter();
  });

  it('replay returns only events with seq > afterSeq', () => {
    const session = 'session-replay';
    emitter.emit(session, 'assistant.text', { text: 'one' });   // seq 1
    emitter.emit(session, 'assistant.text', { text: 'two' });   // seq 2
    emitter.emit(session, 'assistant.text', { text: 'three' }); // seq 3

    const { events } = emitter.replay(session, 1);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);
  });

  it('replay with afterSeq=0 returns all events', () => {
    const session = 'session-all';
    emitter.emit(session, 'assistant.text', { text: 'a' });
    emitter.emit(session, 'assistant.text', { text: 'b' });

    const { events } = emitter.replay(session, 0);
    expect(events).toHaveLength(2);
  });

  it('replay with afterSeq equal to last seq returns empty events', () => {
    const session = 'session-last';
    emitter.emit(session, 'session.state', { state: 'idle' }); // seq 1

    const { events, truncated } = emitter.replay(session, 1);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  it('truncated is true when afterSeq+1 < buffer min seq', () => {
    const session = 'session-trunc';
    // Fill 510 events so oldest (seq 1-10) are evicted; buffer starts at seq 11
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }

    // afterSeq=5 means we want from seq 6, but buffer starts at 11 → truncated
    const { truncated } = emitter.replay(session, 5);
    expect(truncated).toBe(true);
  });

  it('truncated is false when afterSeq matches buffer min seq - 1', () => {
    const session = 'session-no-trunc';
    for (let i = 0; i < 510; i++) {
      emitter.emit(session, 'assistant.text', { text: `msg-${i}` });
    }
    // Buffer min seq = 11, so afterSeq=10 means afterSeq+1=11 which equals bufMinSeq
    const { truncated } = emitter.replay(session, 10);
    expect(truncated).toBe(false);
  });

  it('empty buffer with afterSeq=0 → truncated: false (no events ever emitted)', () => {
    const { events, truncated } = emitter.replay('session-empty', 0);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  it('empty buffer with positive afterSeq → truncated: false (no events ever emitted)', () => {
    const { events, truncated } = emitter.replay('session-empty', 5);
    expect(events).toHaveLength(0);
    expect(truncated).toBe(false);
  });
});

describe('TimelineEmitter — on/off handlers', () => {
  it('calls registered handler on emit', () => {
    const emitter = new TimelineEmitter();
    const received: unknown[] = [];
    emitter.on((e) => received.push(e));

    emitter.emit('session-h', 'session.state', { state: 'idle' });
    expect(received).toHaveLength(1);
  });

  it('stops calling handler after unsubscribe', () => {
    const emitter = new TimelineEmitter();
    const received: unknown[] = [];
    const unsub = emitter.on((e) => received.push(e));
    unsub();

    emitter.emit('session-h', 'session.state', { state: 'idle' });
    expect(received).toHaveLength(0);
  });
});
