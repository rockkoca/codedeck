/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Merges consecutive streaming assistant.text events into single blocks.
 * Supports basic Markdown rendering (code blocks, inline code, bold).
 */
import { useEffect, useRef, useState, useMemo } from 'preact/hooks';
import { h, type VNode } from 'preact';
import type { TimelineEvent } from '../ws-client.js';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
  sessionState?: string;
}

/** A merged view item — either a single event or merged assistant text chunks. */
interface ViewItem {
  key: string;
  type: 'event' | 'assistant-block';
  event?: TimelineEvent;
  /** Merged text for assistant-block */
  text?: string;
  ts?: number;
  lastTs?: number;
}

/** Merge consecutive assistant.text events into blocks for display. */
function buildViewItems(events: TimelineEvent[]): ViewItem[] {
  const visible = events.filter((e) => !e.hidden);
  const items: ViewItem[] = [];
  let pendingText: string[] = [];
  let pendingFirstTs = 0;
  let pendingLastTs = 0;
  let pendingKey = '';

  const flushPending = () => {
    if (pendingText.length > 0) {
      items.push({
        key: pendingKey,
        type: 'assistant-block',
        text: pendingText.join('\n'),
        ts: pendingFirstTs,
        lastTs: pendingLastTs,
      });
      pendingText = [];
    }
  };

  for (const event of visible) {
    if (event.type === 'assistant.text') {
      const text = String(event.payload.text ?? '');
      if (!text) continue;
      if (pendingText.length === 0) {
        pendingKey = event.eventId;
        pendingFirstTs = event.ts;
      }
      pendingLastTs = event.ts;
      pendingText.push(text);
    } else {
      flushPending();
      items.push({ key: event.eventId, type: 'event', event });
    }
  }
  flushPending();

  return items;
}

export function ChatView({ events, loading, sessionState }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const viewItems = useMemo(() => buildViewItems(events), [events]);

  // Auto-scroll on new events
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [viewItems.length, events.length, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  if (loading) {
    return <div class="chat-view"><div class="chat-loading">Loading timeline...</div></div>;
  }

  return (
    <div class="chat-view" ref={scrollRef} onScroll={handleScroll}>
      {viewItems.length === 0 && (
        <div class="chat-loading">
          {sessionState ? `Session ${sessionState}` : 'No events yet'}
        </div>
      )}
      {viewItems.map((item) =>
        item.type === 'assistant-block' ? (
          <div key={item.key} class="chat-event chat-assistant">
            <RichText text={item.text!} />
            <ChatTime ts={item.lastTs ?? item.ts ?? 0} />
          </div>
        ) : (
          <ChatEvent key={item.key} event={item.event!} />
        ),
      )}
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

    case 'session.state': {
      const state = String(event.payload.state ?? '');
      const stateLabel: Record<string, string> = {
        idle: 'Agent idle — waiting for input',
        running: 'Agent working...',
        starting: 'Session starting...',
        stopped: 'Session stopped',
      };
      return (
        <div class="chat-event chat-system">
          {stateLabel[state] ?? state}
          <ChatTime ts={event.ts} />
        </div>
      );
    }

    case 'terminal.snapshot':
      return <SnapshotEvent event={event} />;

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

// ── Lightweight Markdown renderer ─────────────────────────────────────────

/** Render inline markdown: `code`, **bold**, *italic* */
function renderInline(text: string): (string | VNode)[] {
  const parts: (string | VNode)[] = [];
  // Match `code`, **bold**, *italic* — in priority order
  const regex = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      parts.push(h('code', { class: 'chat-inline-code' }, match[1]));
    } else if (match[2] !== undefined) {
      parts.push(h('strong', null, match[2]));
    } else if (match[3] !== undefined) {
      parts.push(h('em', null, match[3]));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Render markdown text with code blocks and inline formatting. */
function RichText({ text }: { text: string }) {
  // Split by fenced code blocks: ```lang\n...\n```
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const parts: VNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    if (match.index > last) {
      const before = text.slice(last, match.index);
      parts.push(h('span', { key: key++ }, ...renderTextLines(before)));
    }
    // Code block
    const lang = match[1] || '';
    const code = match[2].replace(/\n$/, '');
    parts.push(
      h('div', { key: key++, class: 'chat-code-block' },
        lang && h('div', { class: 'chat-code-lang' }, lang),
        h('pre', null, h('code', null, code)),
      ),
    );
    last = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (last < text.length) {
    parts.push(h('span', { key: key++ }, ...renderTextLines(text.slice(last))));
  }

  return h('div', { class: 'chat-rich-text' }, ...parts);
}

/** Render text lines with inline formatting, preserving newlines. */
function renderTextLines(text: string): (string | VNode)[] {
  const lines = text.split('\n');
  const result: (string | VNode)[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) result.push(h('br', null));
    result.push(...renderInline(lines[i]));
  }
  return result;
}
