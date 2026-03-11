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
    }

    // Forward all keyboard input to the tmux session
    term.onData((data) => {
      wsRef.current?.sendInput(sessionName, data);
    });

    // Sync terminal dimensions to tmux on every resize
    term.onResize(({ cols, rows }) => {
      wsRef.current?.sendResize(sessionName, cols, rows);
    });

    // Track scroll position for "scroll to bottom" button + progress bar
    const updateScroll = () => {
      const buf = term.buffer.active;
      const baseY = buf.baseY; // total lines above viewport
      const viewportY = buf.viewportY; // current scroll offset
      const atBottom = viewportY >= baseY;
      setScrolledUp(!atBottom && baseY > 0);
      setScrollProgress(baseY > 0 ? viewportY / baseY : 1);
      // Show scrollbar briefly
      setShowScrollbar(true);
      if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
      scrollHideTimerRef.current = setTimeout(() => setShowScrollbar(false), 1500);
    };
    term.onScroll(updateScroll);
    // Also listen to lineFeed to update when new content arrives
    term.onLineFeed(updateScroll);

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

  const applyDiff = useCallback((diff: TerminalDiff) => {
    const term = termRef.current;
    if (!term) return;

    const lines = linesRef.current;
    for (const [lineIdx, content] of diff.lines) {
      // Fill any sparse gaps created by out-of-bounds assignment
      while (lines.length <= lineIdx) lines.push('');
      lines[lineIdx] = content;
    }
    while (lines.length < diff.rows) lines.push('');
    linesRef.current = lines.slice(0, diff.rows);

    // In-place overwrite: move cursor home, write each line clearing remainder,
    // then clear from cursor to end of display. Avoids \x1b[2J which pushes
    // the current screen into scrollback, causing duplicate content on scroll-up.
    let buf = '\x1b[H';
    for (let i = 0; i < linesRef.current.length; i++) {
      buf += (linesRef.current[i] ?? '') + '\x1b[K';
      if (i < linesRef.current.length - 1) buf += '\r\n';
    }
    buf += '\x1b[J'; // clear remaining rows below
    term.write(buf);

    // Auto-scroll to bottom unless user is actively scrolling
    // (touched within the last 1 second)
    const touchIdle = !isTouchingRef.current && (Date.now() - lastTouchEndRef.current > 1000);
    if (touchIdle) {
      term.scrollToBottom();
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
