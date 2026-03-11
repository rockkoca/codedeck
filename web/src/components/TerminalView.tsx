import { useEffect, useRef, useCallback } from 'preact/hooks';
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
  onLatency?: (ms: number) => void;
  /** Called when the user taps the terminal on mobile — use to focus the input box. */
  onTap?: () => void;
  /** Receives a function that focuses the xterm terminal — call it to restore keyboard to xterm. */
  onFocusFn?: (fn: () => void) => void;
  /** Receives a function that fits the terminal to its container and syncs size to tmux. */
  onFitFn?: (fn: () => void) => void;
  /** Receives a function to mark that input was just sent — starts latency timer. */
  onMarkInputFn?: (fn: () => void) => void;
}

export function TerminalView({ sessionName, ws, connected, onDiff, onLatency, onTap, onFocusFn, onFitFn, onMarkInputFn }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const linesRef = useRef<string[]>([]);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const onLatencyRef = useRef(onLatency);
  onLatencyRef.current = onLatency;

  // Latency tracking: record when last input was sent, compute on next diff
  const lastInputAtRef = useRef<number | null>(null);

  // Touch scroll tracking: suppress auto-scroll for 1s after user releases touch
  const lastTouchEndRef = useRef<number>(0);
  const isTouchingRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

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

    // Forward all keyboard input to the tmux session; record send time for latency
    term.onData((data) => {
      lastInputAtRef.current = Date.now();
      wsRef.current?.sendInput(sessionName, data);
    });

    // Sync terminal dimensions to tmux on every resize
    term.onResize(({ cols, rows }) => {
      wsRef.current?.sendResize(sessionName, cols, rows);
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    // Expose focus function so parent can restore keyboard to xterm after button clicks
    onFocusFn?.(() => term.focus());

    // Expose fit function so parent can trigger resize on send / focus
    onFitFn?.(() => { fitAddon.fit(); });

    // Expose markInput so parent can start latency timer when sending via input box
    onMarkInputFn?.(() => { lastInputAtRef.current = Date.now(); });

    // Re-fit when window regains focus or tab becomes visible.
    // fitAddon.fit() triggers term.onResize which syncs to tmux only if dimensions changed.
    const onWindowFocus = () => { fitAddon.fit(); };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') fitAddon.fit(); };
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      // Re-paint buffered content immediately so resize doesn't flash blank
      if (linesRef.current.length > 0) {
        term.write('\x1b[2J\x1b[H' + linesRef.current.join('\r\n'));
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

    // Measure round-trip latency from last keypress to this diff arriving
    if (lastInputAtRef.current !== null) {
      onLatencyRef.current?.(Date.now() - lastInputAtRef.current);
      lastInputAtRef.current = null;
    }

    const lines = linesRef.current;
    for (const [lineIdx, content] of diff.lines) {
      lines[lineIdx] = content;
    }
    while (lines.length < diff.rows) lines.push('');
    linesRef.current = lines.slice(0, diff.rows);

    // Full-frame rewrite: clear screen, move to home, write all lines with ANSI intact
    term.write('\x1b[2J\x1b[H' + linesRef.current.join('\r\n'));

    // Auto-scroll to bottom unless user is actively scrolling
    // (touched within the last 1 second)
    const touchIdle = !isTouchingRef.current && (Date.now() - lastTouchEndRef.current > 1000);
    if (touchIdle) {
      term.scrollToBottom();
    }
  }, []);

  useEffect(() => {
    onDiff?.(applyDiff);
  }, [applyDiff, onDiff]);

  return (
    <div
      ref={containerRef}
      class="terminal-container"
      style={{ flex: 1, overflow: 'hidden' }}
      onClick={isMobile ? undefined : () => { fitRef.current?.fit(); }}
      onTouchStart={isMobile ? (e) => {
        isTouchingRef.current = true;
        const t = e.touches[0];
        touchStartPosRef.current = { x: t.clientX, y: t.clientY };
        e.preventDefault(); // block keyboard popup from xterm
      } : undefined}
      onTouchEnd={isMobile ? (e) => {
        isTouchingRef.current = false;
        lastTouchEndRef.current = Date.now();
        // Detect tap (small movement) → focus input
        const t = e.changedTouches[0];
        const start = touchStartPosRef.current;
        if (start && Math.abs(t.clientX - start.x) < 10 && Math.abs(t.clientY - start.y) < 10) {
          onTap?.();
        }
        touchStartPosRef.current = null;
      } : undefined}
      onTouchCancel={isMobile ? () => {
        isTouchingRef.current = false;
        lastTouchEndRef.current = Date.now();
        touchStartPosRef.current = null;
      } : undefined}
    />
  );
}
