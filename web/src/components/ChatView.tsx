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
  /** True while gap-filling new events after a cache hit */
  refreshing?: boolean;
  sessionState?: string;
  sessionId?: string | null;
  /** Receives a function that forces the chat list to scroll to the bottom. */
  onScrollBottomFn?: (fn: () => void) => void;
  /** When true, render as a non-interactive preview (no scroll button, no status bar) */
  preview?: boolean;
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
  const visible = events.filter((e) => !e.hidden && e.type !== 'assistant.thinking' && e.type !== 'agent.status');

  // Pre-pass: merge tool.call+tool.result pairs and dedup session.state
  const consolidated: TimelineEvent[] = [];
  // Track tool.result eventIds that have been consumed by a preceding tool.call merge
  const consumedIds = new Set<string>();

  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i];

    // Skip already-consumed tool.result events
    if (consumedIds.has(ev.eventId)) continue;

    // Merge tool.call with its matching tool.result.
    // Scan forward up to 10 events to find the tool.result — user.message /
    // command.ack etc. can land between them during a long-running tool.
    if (ev.type === 'tool.call') {
      let resultIdx = -1;
      for (let j = i + 1; j <= Math.min(i + 10, visible.length - 1); j++) {
        if (visible[j].type === 'tool.result') { resultIdx = j; break; }
        if (visible[j].type === 'tool.call') break; // another call started, stop
      }
      if (resultIdx !== -1) {
        const next = visible[resultIdx];
        consumedIds.add(next.eventId); // mark tool.result as consumed
        const toolName = String(ev.payload.tool ?? 'tool');
        const input = ev.payload.input ? ` ${truncate(String(ev.payload.input), 60)}` : '';
        const status = next.payload.error ? `✗ ${truncate(String(next.payload.error), 60)}` : '✓';
        consolidated.push({
          ...ev,
          type: 'tool.call',
          payload: { ...ev.payload, tool: toolName, input: `${input} ${status}`.trim(), _merged: true },
        });
        continue;
      }
    }

    // Deduplicate consecutive session.state events with the same state — keep last
    if (ev.type === 'session.state') {
      const next = visible[i + 1];
      if (next && next.type === 'session.state' && String(next.payload.state) === String(ev.payload.state)) {
        continue; // skip — keep the next (checked again on next iteration)
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
      // Trim and collapse 3+ consecutive blank lines to 1 (CC output often has many trailing newlines)
      const text = String(event.payload.text ?? '').trim().replace(/\n{3,}/g, '\n\n');
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

export function ChatView({ events, loading, refreshing, sessionState, sessionId, onScrollBottomFn, preview }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const viewItems = useMemo(() => buildViewItems(events), [events]);

  // Extract active status: show last thinking or agent.status until any other event arrives after it
  const statusText = useMemo(() => {
    let lastStatus: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'assistant.thinking' && e.payload.text) {
        lastStatus = String(e.payload.text);
        break;
      }
      if (e.type === 'agent.status' && e.payload.label) {
        lastStatus = String(e.payload.label);
        break;
      }
      // Any other event type means status is done
      if (e.type !== 'assistant.thinking' && e.type !== 'agent.status') break;
    }
    return lastStatus;
  }, [events]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  };

  // On session change, reset scroll position to bottom
  useEffect(() => {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
  }, [sessionId]);

  // On mobile: when keyboard opens, viewport shrinks and scrollTop can reset to 0.
  // Save scrollTop on focusin, restore it when visualViewport height decreases (keyboard appeared).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let savedScrollTop = 0;
    let prevHeight = vv.height;
    const onFocusIn = () => {
      savedScrollTop = scrollRef.current?.scrollTop ?? 0;
    };
    const onResize = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (vv.height < prevHeight) {
        // Keyboard appeared — restore scroll position
        el.scrollTop = savedScrollTop;
      }
      prevHeight = vv.height;
    };
    vv.addEventListener('resize', onResize);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      vv.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  // Expose scroll-to-bottom so parent can force-snap after sending a message
  useEffect(() => {
    onScrollBottomFn?.(scrollToBottom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScrollBottomFn]);

  // Auto-scroll on new events — use requestAnimationFrame so DOM has updated
  // In preview mode, always scroll to bottom (no user interaction possible)
  useEffect(() => {
    if (preview || autoScrollRef.current) {
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }, [viewItems.length, events.length, preview]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Use generous threshold — 150px from bottom still counts as "at bottom"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  };

  if (loading) {
    return <div class="chat-view"><div class="chat-loading">加载聊天记录中...</div></div>;
  }

  return (
    <div class="chat-view-wrap">
      {refreshing && <div class="chat-refreshing">↻ 同步最新消息...</div>}
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
      {/* Thinking status bar — fixed at bottom, shows real CC thinking from JSONL */}
      {!preview && statusText && (
        <div class="chat-thinking-bar">
          <span class="chat-thinking-dots">●●●</span>
          {' '}{truncate(statusText, 120)}
        </div>
      )}
      {!preview && showScrollBtn && (
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
          <span class="chat-tool-name">{String(event.payload.tool ?? 'tool')}</span>
          {event.payload.input ? <span class="chat-tool-input">{' '}{truncate(String(event.payload.input), 60)}</span> : null}
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
        started: 'Session started',
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
