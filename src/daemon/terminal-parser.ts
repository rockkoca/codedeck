/**
 * Terminal diff → assistant.text extraction.
 * Only extracts from scrolled diffs (newLineCount > 0).
 * Conservative classification: HIDE known chrome, KEEP everything else.
 */

import { timelineEmitter } from './timeline-emitter.js';

// ── ANSI stripping ───────────────────────────────────────────────────────────

const ANSI_CSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const ANSI_OSC = /\x1b\].*?\x07/g;
const ANSI_OTHER = /\x1b[^[\]].?/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(ANSI_OTHER, '');
}

// ── Line classification ──────────────────────────────────────────────────────

export type LineClass = 'HIDE' | 'MUTED' | 'KEEP';

const BRAILLE_RANGE = /^[\u2800-\u28FF\s]+$/;
const HIDE_EXACT = new Set([
  'How is Claude doing this session?',
  'How is Claude doing this session',
]);

// Box-drawing: U+2500-U+257F
const BOX_DRAWING = /[\u2500-\u257F]/g;

export function classifyLine(stripped: string): LineClass {
  const trimmed = stripped.trim();
  if (!trimmed) return 'HIDE';

  // Exact match hide
  if (HIDE_EXACT.has(trimmed)) return 'HIDE';

  // Pure braille spinner line
  if (BRAILLE_RANGE.test(trimmed)) return 'HIDE';

  // Box-drawing dominated (>80% of non-whitespace)
  const nonWs = trimmed.replace(/\s/g, '');
  if (nonWs.length > 0) {
    const boxCount = (nonWs.match(BOX_DRAWING) ?? []).length;
    if (boxCount / nonWs.length > 0.8) return 'MUTED';
  }

  return 'KEEP';
}

// ── Text extraction from scrolled diffs ──────────────────────────────────────

/**
 * Extract assistant text from new lines that appeared due to scrolling.
 * Only call when scrolled=true && newLineCount > 0.
 * @param allLines All current screen lines (with ANSI)
 * @param rows Total visible rows
 * @param newLineCount Number of new lines at the bottom
 */
export function extractScrolledText(
  allLines: string[],
  rows: number,
  newLineCount: number,
): string | null {
  const startIdx = rows - newLineCount;
  const newLines = allLines.slice(startIdx, rows);

  const kept: string[] = [];
  for (const line of newLines) {
    const stripped = stripAnsi(line).trimEnd();
    const cls = classifyLine(stripped);
    if (cls !== 'HIDE') {
      kept.push(stripped);
    }
  }

  if (kept.length === 0) return null;
  return kept.join('\n');
}

/**
 * Process a terminal diff and emit assistant.text for changed content.
 * Called from terminal-streamer after each diff.
 *
 * Two modes:
 * 1. Scrolled: extract new lines at the bottom (bulk text)
 * 2. In-place changes: extract changed line content as streaming chunks
 */
export function processTerminalDiff(
  sessionName: string,
  allLines: string[],
  rows: number,
  scrolled: boolean,
  newLineCount: number,
  changedLines?: Array<[number, string]>,
  isFullFrame?: boolean,
): void {
  // Scrolled: bulk extract new bottom lines
  if (scrolled && newLineCount > 0) {
    const text = extractScrolledText(allLines, rows, newLineCount);
    if (text) {
      timelineEmitter.emit(sessionName, 'assistant.text', { text }, {
        source: 'terminal-parse',
        confidence: 'low',
      });
    }
    return;
  }

  // In-place changes (streaming typing): extract changed text
  if (!isFullFrame && changedLines && changedLines.length > 0) {
    const kept: string[] = [];
    for (const [, line] of changedLines) {
      const stripped = stripAnsi(line).trimEnd();
      const cls = classifyLine(stripped);
      if (cls === 'KEEP' && stripped.length > 0) {
        kept.push(stripped);
      }
    }
    if (kept.length > 0) {
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: kept.join('\n'),
        streaming: true,
      }, {
        source: 'terminal-parse',
        confidence: 'low',
      });
    }
  }
}
