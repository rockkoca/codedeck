/**
 * Timeline event bus — per-session seq counter, ring buffer, replay.
 * Singleton: import { timelineEmitter } from './timeline-emitter.js'
 */

import { randomUUID } from 'crypto';
import type { TimelineEvent, TimelineEventType, TimelineSource, TimelineConfidence } from './timeline-event.js';
import { timelineStore } from './timeline-store.js';

const MAX_BUFFER = 500;

export class TimelineEmitter {
  private seqMap = new Map<string, number>();
  private buffer = new Map<string, TimelineEvent[]>();
  private handlers = new Set<(e: TimelineEvent) => void>();
  /** Daemon startup timestamp — changes on restart, used for epoch-based seq continuity */
  readonly epoch = Date.now();

  emit(
    sessionId: string,
    type: TimelineEventType,
    payload: Record<string, unknown>,
    opts?: { source?: TimelineSource; confidence?: TimelineConfidence },
  ): TimelineEvent {
    const seq = (this.seqMap.get(sessionId) ?? 0) + 1;
    this.seqMap.set(sessionId, seq);

    const event: TimelineEvent = {
      eventId: randomUUID(),
      sessionId,
      ts: Date.now(),
      seq,
      epoch: this.epoch,
      source: opts?.source ?? 'daemon',
      confidence: opts?.confidence ?? 'high',
      type,
      payload,
    };

    // Ring buffer
    let buf = this.buffer.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffer.set(sessionId, buf);
    }
    buf.push(event);
    if (buf.length > MAX_BUFFER) {
      buf.splice(0, buf.length - MAX_BUFFER);
    }

    // Persist to disk
    timelineStore.append(event);

    // Notify handlers
    for (const h of this.handlers) {
      try { h(event); } catch { /* ignore */ }
    }

    return event;
  }

  on(handler: (e: TimelineEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /**
   * Replay events after a given seq for a session.
   * Tries ring buffer first, falls back to file store for older events.
   * Returns { events, truncated } where truncated=true if requested events fell off both buffer and file.
   */
  replay(sessionId: string, afterSeq: number): { events: TimelineEvent[]; truncated: boolean } {
    const buf = this.buffer.get(sessionId) ?? [];

    // Try ring buffer first
    if (buf.length > 0 && (afterSeq + 1) >= buf[0].seq) {
      // Ring buffer has all the requested events
      const events = buf.filter(e => e.seq > afterSeq);
      return { events, truncated: false };
    }

    // Ring buffer doesn't have old enough events — read from file store
    const fileEvents = timelineStore.read(sessionId, { epoch: this.epoch, afterSeq });
    return { events: fileEvents, truncated: false };
  }
}

export const timelineEmitter = new TimelineEmitter();
