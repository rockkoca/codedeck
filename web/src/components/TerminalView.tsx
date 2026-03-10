import { useEffect, useRef, useCallback } from 'preact/hooks';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalDiff } from '../types.js';

interface Props {
  sessionName: string;
  onDiff?: (applyDiff: (diff: TerminalDiff) => void) => void;
}

export function TerminalView({ sessionName, onDiff }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const linesRef = useRef<string[]>([]);

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#0f0f13',
        foreground: '#e2e8f0',
        cursor: '#3b82f6',
        selectionBackground: '#1d4ed840',
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      convertEol: true,
      scrollback: 5000,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    if (containerRef.current) {
      term.open(containerRef.current);
      fitAddon.fit();
    }

    termRef.current = term;
    fitRef.current = fitAddon;

    const observer = new ResizeObserver(() => fitAddon.fit());
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

    // Apply line-level diffs to the local line buffer, then redraw
    const lines = linesRef.current;
    for (const [lineIdx, content] of diff.lines) {
      lines[lineIdx] = content;
    }

    // Ensure array length matches row count
    linesRef.current = lines.slice(0, diff.rows);

    // Write full frame to terminal (simplest approach for reliability)
    term.reset();
    term.write(linesRef.current.join('\r\n'));
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
