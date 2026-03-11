/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Replaces the old terminal-diff-based stub.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TimelineEvent } from '../ws-client.js';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
}

export function ChatView({ events, loading }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll on new events
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events.length, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  if (loading) {
    return <div class="chat-view"><div class="chat-loading">Loading timeline...</div></div>;
  }

  const visible = events.filter((e) => !e.hidden);

  return (
    <div class="chat-view" ref={scrollRef} onScroll={handleScroll}>
      {visible.length === 0 && (
        <div class="chat-loading">No events yet</div>
      )}
      {visible.map((event) => (
        <ChatEvent key={event.eventId} event={event} />
      ))}
      <div ref={bottomRef} />
      {!autoScroll && (
        <button
          class="chat-scroll-btn"
          onClick={() => {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            setAutoScroll(true);
          }}
        >
          ↓
        </button>
      )}
    </div>
  );
}

function ChatEvent({ event }: { event: TimelineEvent }) {
  switch (event.type) {
    case 'user.message':
      return (
        <div class="chat-event chat-user">
          <div class="chat-bubble-content">{String(event.payload.text ?? '')}</div>
          <ChatTime ts={event.ts} />
        </div>
      );

    case 'assistant.text':
      return (
        <div class="chat-event chat-assistant">
          {String(event.payload.text ?? '')}
        </div>
      );

    case 'tool.call':
      return (
        <div class="chat-event chat-tool">
          <span class="chat-tool-icon">{'>'}</span>
          {String(event.payload.tool ?? 'tool')}
          {event.payload.input ? ` ${truncate(String(event.payload.input), 60)}` : ''}
        </div>
      );

    case 'tool.result':
      return (
        <div class="chat-event chat-tool">
          <span class="chat-tool-icon">{'<'}</span>
          {event.payload.error ? `error: ${truncate(String(event.payload.error), 80)}` : 'done'}
        </div>
      );

    case 'mode.state':
      return (
        <div class="chat-event">
          <span class="chat-mode">{String(event.payload.mode ?? event.payload.state ?? '')}</span>
        </div>
      );

    case 'session.state':
      return (
        <div class="chat-event chat-system">
          {String(event.payload.state ?? '')}
        </div>
      );

    case 'terminal.snapshot':
      return (
        <SnapshotEvent event={event} />
      );

    default:
      return null;
  }
}

function SnapshotEvent({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const lines = (event.payload.lines as string[] | undefined) ?? [];

  return (
    <div class="chat-event chat-system">
      <button
        class="chat-snapshot-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '[-] Terminal snapshot' : '[+] Terminal snapshot'}
      </button>
      {expanded && (
        <pre class="chat-snapshot-content">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

function ChatTime({ ts }: { ts: number }) {
  return (
    <div class="chat-bubble-time">
      {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}
