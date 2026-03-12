import { useEffect, useRef, useCallback, useState } from 'preact/hooks';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';

interface Props {
  sessionName: string;
  ws: WsClient | null;
  connected?: boolean;
  onDiff?: (applyDiff: (diff: TerminalDiff) => void) => void;
  onHistory?: (applyHistory: (content: string) => void) => void;
  /** Receives a function that focuses the xterm terminal — call it to restore keyboard to xterm. */
  onFocusFn?: (fn: () => void) => void;
  /** Receives a function that fits the terminal to its container and syncs size to tmux. */
  onFitFn?: (fn: () => void) => void;
}

export function TerminalView({ sessionName, ws, connected, onDiff, onHistory, onFocusFn, onFitFn }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const linesRef = useRef<string[]>([]);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  // Touch scroll tracking: suppress auto-scroll for 1s after user releases touch
  const lastTouchEndRef = useRef<number>(0);
  const isTouchingRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // User intent: true = auto-follow bottom (State 2), false = user scrolled up (State 1).
  // Only changed by real user scroll actions (onScroll), NOT by onLineFeed/writes.
  // This prevents intermediate xterm write states from corrupting the follow flag.
  const autoFollowRef = useRef(true);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Scroll state: show button + progress bar when scrolled up
  const [scrolledUp, setScrolledUp] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(1); // 0..1, 1 = bottom
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showScrollbar, setShowScrollbar] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#0f0f13',
        foreground: '#e2e8f0',
        cursor: '#3b82f6',
        selectionBackground: '#1d4ed860',
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      convertEol: true,
      scrollback: 5000,
      allowTransparency: false,
      cursorBlink: true,
      // On mobile: disable xterm's built-in textarea focus so tapping the
      // terminal does not pop up the keyboard. Input goes via SessionControls.
      disableStdin: isMobile,
    });

    // Copy selected text to clipboard on Ctrl+C / Cmd+C when selection exists
    term.attachCustomKeyEventHandler((ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false; // prevent sending ^C to tmux when we're copying
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    let fitTimer: ReturnType<typeof setTimeout> | null = null;

    if (containerRef.current) {
      term.open(containerRef.current);
      // Defer fit until container has non-zero dimensions (mobile needs a frame to lay out)
      let fitDone = false;
      const doFit = () => {
        const el = containerRef.current;
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddon.fit();
          fitDone = true;
        }
      };
      requestAnimationFrame(() => {
        doFit();
        if (!fitDone) requestAnimationFrame(() => { doFit(); });
      });
      // Fallback: force a fit after 400ms for slow mobile renders
      fitTimer = setTimeout(() => {
        if (!fitDone) {
          fitAddon.fit();
          fitDone = true;
        }
      }, 400);
      // Auto-focus terminal on mount for desktop keyboard input
      if (!isMobile) {
        requestAnimationFrame(() => term.focus());
      }
    }

    // Forward all keyboard input to the tmux session
    term.onData((data) => {
      wsRef.current?.sendInput(sessionName, data);
    });

    // Sync terminal dimensions to tmux on every resize
    term.onResize(({ cols, rows }) => {
      wsRef.current?.sendResize(sessionName, cols, rows);
    });

    // Track scroll position for "scroll to bottom" button + progress bar.
    // onScroll = real user scroll action → update autoFollowRef (sticky intent).
    // onLineFeed = xterm write in progress → only update UI, NOT autoFollowRef.
    const onScrollEvent = () => {
      const buf = term.buffer.active;
      const baseY = buf.baseY;
      const viewportY = buf.viewportY;
      const atBottom = viewportY >= baseY || baseY === 0;
      // Update user intent: if they scrolled to bottom, re-enter auto-follow
      autoFollowRef.current = atBottom;
      setScrolledUp(!atBottom);
      setScrollProgress(baseY > 0 ? viewportY / baseY : 1);
      setShowScrollbar(true);
      if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
      scrollHideTimerRef.current = setTimeout(() => setShowScrollbar(false), 1500);
    };
    const onLineFeedEvent = () => {
      // Only update UI indicators — do NOT touch autoFollowRef here.
      // onLineFeed fires during term.write() at intermediate buffer states,
      // which would corrupt the sticky auto-follow flag.
      const buf = term.buffer.active;
      const baseY = buf.baseY;
      const viewportY = buf.viewportY;
      const atBottom = viewportY >= baseY || baseY === 0;
      setScrolledUp(!atBottom);
      setScrollProgress(baseY > 0 ? viewportY / baseY : 1);
    };
    term.onScroll(onScrollEvent);
    term.onLineFeed(onLineFeedEvent);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Expose focus function so parent can restore keyboard to xterm after button clicks
    onFocusFn?.(() => term.focus());

    // Expose fit function so parent can trigger resize on send / focus
    onFitFn?.(() => { fitAddon.fit(); });

    // Re-fit when window regains focus or tab becomes visible.
    // fitAddon.fit() triggers term.onResize which syncs to tmux only if dimensions changed.
    const onWindowFocus = () => { fitAddon.fit(); };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') fitAddon.fit(); };
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      // Re-paint buffered content in place so resize doesn't flash blank
      if (linesRef.current.length > 0) {
        let buf = '\x1b[H';
        for (let i = 0; i < linesRef.current.length; i++) {
          buf += (linesRef.current[i] ?? '') + '\x1b[K';
          if (i < linesRef.current.length - 1) buf += '\r\n';
        }
        buf += '\x1b[J';
        term.write(buf);
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      if (fitTimer) clearTimeout(fitTimer);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionName]); // eslint-disable-line react-hooks/exhaustive-deps

  // When WS reconnects (connected → true), re-send terminal dimensions so tmux
  // always matches xterm — prevents garbled/corrupted display (花屏).
  useEffect(() => {
    if (!connected) return;
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws) {
      ws.sendResize(sessionName, term.cols, term.rows);
    }
  }, [connected, sessionName]);

  // Raw PTY bytes: feed directly into xterm.js.
  // Register handler during render (not in useEffect) to avoid timing gaps
  // where ws becomes available but the effect hasn't re-run yet.
  if (ws) {
    ws.onTerminalRaw((sName: string, data: Uint8Array) => {
      if (sName !== sessionName) return;
      termRef.current?.write(data);
    });
  }
  // Cleanup on unmount only
  useEffect(() => {
    return () => { wsRef.current?.onTerminalRaw(null); };
  }, []);

  // Handle terminal.stream_reset — reset xterm state so stale ANSI doesn't corrupt (Task 5.4)
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'terminal.stream_reset' && msg.session === sessionName) {
        termRef.current?.reset();
        linesRef.current = [];
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionName]);

  const applyDiff = useCallback((diff: TerminalDiff) => {
    const term = termRef.current;
    if (!term) return;

    const lines = linesRef.current;
    for (const [lineIdx, content] of diff.lines) {
      while (lines.length <= lineIdx) lines.push('');
      lines[lineIdx] = content;
    }
    while (lines.length < diff.rows) lines.push('');
    linesRef.current = lines.slice(0, diff.rows);

    if (diff.fullFrame) {
      // Full frame: rewrite entire screen from cursor home
      let buf = '\x1b[H';
      for (let i = 0; i < linesRef.current.length; i++) {
        buf += (linesRef.current[i] ?? '') + '\x1b[K';
        if (i < linesRef.current.length - 1) buf += '\r\n';
      }
      buf += '\x1b[J';
      term.write(buf);
    } else if (diff.lines.length > 0) {
      // Partial update: only write changed lines using cursor addressing
      let buf = '';
      for (const [lineIdx, content] of diff.lines) {
        // CSI row;col H — 1-based row addressing
        buf += `\x1b[${lineIdx + 1};1H${content}\x1b[K`;
      }
      term.write(buf);
    }

    // Auto-scroll to bottom only when in auto-follow mode (State 2).
    // autoFollowRef is a sticky user-intent flag — only changed by real scroll events,
    // not by onLineFeed intermediate states during write processing.
    const touchIdle = !isTouchingRef.current && (Date.now() - lastTouchEndRef.current > 1000);
    if (touchIdle && autoFollowRef.current) {
      setTimeout(() => {
        if (autoFollowRef.current) term.scrollToBottom();
      }, 0);
    }
  }, []);

  const applyHistory = useCallback((content: string) => {
    const term = termRef.current;
    if (!term || !content) return;
    // Write history into scrollback: save cursor, move to top, write history lines,
    // then the visible frame will be painted on top by the next diff.
    // We use the normal buffer — history goes above current viewport.
    const historyLines = content.split('\n');
    // Write history lines followed by newlines — these go into scrollback
    for (const line of historyLines) {
      term.write(line + '\r\n');
    }
  }, []);

  useEffect(() => {
    onDiff?.(applyDiff);
  }, [applyDiff, onDiff]);

  useEffect(() => {
    onHistory?.(applyHistory);
  }, [applyHistory, onHistory]);

  const scrollToBottom = () => {
    // Re-enter auto-follow mode (State 2) before scrolling
    autoFollowRef.current = true;
    termRef.current?.scrollToBottom();
  };

  return (
    <div class="terminal-wrap" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <div
        ref={containerRef}
        class="terminal-container"
        style={{ width: '100%', height: '100%', overflow: 'hidden' }}
        onClick={isMobile ? undefined : () => { fitRef.current?.fit(); }}
        onTouchStart={isMobile ? (e) => {
          isTouchingRef.current = true;
          const t = e.touches[0];
          touchStartPosRef.current = { x: t.clientX, y: t.clientY };
          e.preventDefault(); // block keyboard popup from xterm
        } : undefined}
        onTouchEnd={isMobile ? () => {
          isTouchingRef.current = false;
          lastTouchEndRef.current = Date.now();
          touchStartPosRef.current = null;
        } : undefined}
        onTouchCancel={isMobile ? () => {
          isTouchingRef.current = false;
          lastTouchEndRef.current = Date.now();
          touchStartPosRef.current = null;
        } : undefined}
      />

      {/* Scroll progress bar — right edge, only visible while scrolling */}
      {showScrollbar && (
        <div class="term-scroll-track">
          <div class="term-scroll-thumb" style={{ top: `${scrollProgress * 100}%` }} />
        </div>
      )}

      {/* Scroll to bottom button */}
      {scrolledUp && (
        <button class="term-scroll-bottom" onClick={scrollToBottom} title="Scroll to bottom">
          ↓
        </button>
      )}
    </div>
  );
}
