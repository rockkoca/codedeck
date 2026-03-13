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
  /** Receives a function that forces the chat list to scroll to the bottom. */
  onScrollBottomFn?: (fn: () => void) => void;
}

/** A merged view item — either a single event, merged assistant text, or collapsed tool summary. */
interface ViewItem {
  key: string;
  type: 'event' | 'assistant-block' | 'tool-summary';
  event?: TimelineEvent;
  /** Merged text for assistant-block */
  text?: string;
  /** Tool summary label for tool-summary */
  toolLabel?: string;
  ts?: number;
  lastTs?: number;
}

/** Merge consecutive assistant.text events into blocks for display.
 *  Also:
 *  - Merge consecutive tool.call + tool.result pairs into compact single lines
 *  - Deduplicate consecutive session.state events with same state (keep last)
 */
function buildViewItems(events: TimelineEvent[]): ViewItem[] {
  const visible = events.filter((e) => !e.hidden);

  // Pre-pass: merge tool.call+tool.result pairs and dedup session.state
  const consolidated: TimelineEvent[] = [];
  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i];

    // Merge tool.call followed by tool.result into a single synthetic event
    if (ev.type === 'tool.call') {
      const next = visible[i + 1];
      if (next && next.type === 'tool.result') {
        const toolName = String(ev.payload.tool ?? 'tool');
        const input = ev.payload.input ? ` ${truncate(String(ev.payload.input), 60)}` : '';
        const status = next.payload.error ? `✗ ${truncate(String(next.payload.error), 60)}` : '✓';
        consolidated.push({
          ...ev,
          type: 'tool.call',
          payload: { ...ev.payload, tool: toolName, input: `${input} ${status}`.trim(), _merged: true },
        });
        i++; // skip the tool.result
        continue;
      }
    }

    // Collapse ALL consecutive session.state events to just the last one.
    // During idle↔running oscillation many alternating states accumulate —
    // we only care about the final settled state, not the history of thrashing.
    if (ev.type === 'session.state') {
      const next = visible[i + 1];
      if (next && next.type === 'session.state') {
        continue; // skip — keep only the last in any consecutive run
      }
    }

    consolidated.push(ev);
  }

  // Main pass: merge assistant.text blocks
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

  for (const event of consolidated) {
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

export function ChatView({ events, loading, sessionState, onScrollBottomFn }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const viewItems = useMemo(() => buildViewItems(events), [events]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  };

  // Expose scroll-to-bottom so parent can force-snap after sending a message
  useEffect(() => {
    onScrollBottomFn?.(scrollToBottom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScrollBottomFn]);

  // Auto-scroll on new events — only read autoScrollRef, not setState, to avoid re-trigger loops
  useEffect(() => {
    if (autoScrollRef.current) {
      scrollToBottom();
    }
  }, [viewItems.length, events.length]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
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
      </div>
      {showScrollBtn && (
        <button
          class="chat-scroll-btn"
          onClick={() => {
            autoScrollRef.current = true;
            setShowScrollBtn(false);
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
      // Standalone tool.result (not merged) — still rendered for cases without a preceding call
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
