/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Merges consecutive streaming assistant.text events into single blocks.
 * Supports basic Markdown rendering (code blocks, inline code, bold).
 */
import { useEffect, useRef, useState, useMemo } from 'preact/hooks';
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
  const programmaticScrollRef = useRef(false);

  const viewItems = useMemo(() => buildViewItems(events), [events]);

  const scrollToBottom = () => {
    programmaticScrollRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    // Clear the flag after animation completes
    setTimeout(() => { programmaticScrollRef.current = false; }, 500);
  };

  // Auto-scroll on new events
  useEffect(() => {
    if (autoScroll) {
      scrollToBottom();
    }
  }, [viewItems.length, events.length, autoScroll]);

  const handleScroll = () => {
    // Ignore scroll events triggered by programmatic scrollIntoView
    if (programmaticScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  if (loading) {
    return <div class="chat-view"><div class="chat-loading">Loading timeline...</div></div>;
  }

  return (
    <div class="chat-view-wrap">
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
      </div>
      {!autoScroll && (
        <button
          class="chat-scroll-btn"
          onClick={() => {
            setAutoScroll(true);
            scrollToBottom();
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

interface TextSegment {
  type: 'text' | 'code' | 'bold' | 'italic';
  content: string;
}

/** Parse inline markdown: `code`, **bold**, *italic* */
function parseInline(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', content: text.slice(last, match.index) });
    if (match[1] !== undefined) segments.push({ type: 'code', content: match[1] });
    else if (match[2] !== undefined) segments.push({ type: 'bold', content: match[2] });
    else if (match[3] !== undefined) segments.push({ type: 'italic', content: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last) });
  return segments;
}

interface CodeBlock { type: 'code-block'; lang: string; code: string }
interface TextBlock { type: 'text-block'; text: string }
type Block = CodeBlock | TextBlock;

/** Split text into code blocks and text blocks. */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) blocks.push({ type: 'text-block', text: text.slice(last, match.index) });
    blocks.push({ type: 'code-block', lang: match[1] || '', code: match[2].replace(/\n$/, '') });
    last = match.index + match[0].length;
  }
  if (last < text.length) blocks.push({ type: 'text-block', text: text.slice(last) });
  return blocks;
}

/** Render inline segments as JSX. */
function InlineText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <span>
      {lines.map((line, li) => {
        const segments = parseInline(line);
        return (
          <span key={li}>
            {li > 0 && <br />}
            {segments.map((seg, si) => {
              switch (seg.type) {
                case 'code': return <code key={si} class="chat-inline-code">{seg.content}</code>;
                case 'bold': return <strong key={si}>{seg.content}</strong>;
                case 'italic': return <em key={si}>{seg.content}</em>;
                default: return <span key={si}>{seg.content}</span>;
              }
            })}
          </span>
        );
      })}
    </span>
  );
}

/** Render markdown text with code blocks and inline formatting. */
function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div class="chat-rich-text">
      {blocks.map((block, i) =>
        block.type === 'code-block' ? (
          <div key={i} class="chat-code-block">
            {block.lang && <div class="chat-code-lang">{block.lang}</div>}
            <pre><code>{block.code}</code></pre>
          </div>
        ) : (
          <InlineText key={i} text={block.text} />
        ),
      )}
    </div>
  );
}
