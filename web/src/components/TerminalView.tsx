import { useEffect, useRef, useCallback } from 'preact/hooks';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';

interface Props {
  sessionName: string;
  ws: WsClient | null;
  onDiff?: (applyDiff: (diff: TerminalDiff) => void) => void;
  onLatency?: (ms: number) => void;
}

export function TerminalView({ sessionName, ws, onDiff, onLatency }: Props) {
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

    if (containerRef.current) {
      term.open(containerRef.current);
      // Defer fit until container has non-zero dimensions (mobile may need a frame to lay out)
      const doInitialFit = () => {
        const el = containerRef.current;
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddon.fit();
        } else {
          requestAnimationFrame(doInitialFit);
        }
      };
      requestAnimationFrame(doInitialFit);
    }

    // Forward all keyboard input to the tmux session; record send time for latency
    term.onData((data) => {
      lastInputAtRef.current = Date.now();
      wsRef.current?.sendInput(sessionName, data);
    });

    // Sync terminal dimensions to tmux on every resize (mobile viewport changes too)
    term.onResize(({ cols, rows }) => {
      wsRef.current?.sendResize(sessionName, cols, rows);
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      // Re-paint buffered content immediately so resize doesn't flash blank
      if (linesRef.current.length > 0) {
        term.write('\x1b[2J\x1b[H' + linesRef.current.join('\r\n'));
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionName]);

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
  }, []);

  useEffect(() => {
    onDiff?.(applyDiff);
  }, [applyDiff, onDiff]);

  return (
    <div
      ref={containerRef}
      class="terminal-container"
      style={{ flex: 1, overflow: 'hidden' }}
    />
  );
}
