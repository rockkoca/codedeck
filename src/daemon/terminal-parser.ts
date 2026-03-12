/**
 * Terminal diff → assistant.text extraction.
 * Extracts text from terminal changes with dedup and throttling.
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

// ── Streaming text accumulator (per-session throttle + dedup) ────────────────

const THROTTLE_MS = 500;

interface SessionAcc {
  /** Current screen text snapshot (stripped, KEEP lines only) */
  lastScreenText: string;
  /** Accumulated new text since last emit */
  pendingText: string;
  /** Timer for throttled emit */
  timer: ReturnType<typeof setTimeout> | null;
}

const accumulators = new Map<string, SessionAcc>();

function getAcc(sessionName: string): SessionAcc {
  let acc = accumulators.get(sessionName);
  if (!acc) {
    acc = { lastScreenText: '', pendingText: '', timer: null };
    accumulators.set(sessionName, acc);
  }
  return acc;
}

function flushAcc(sessionName: string): void {
  const acc = accumulators.get(sessionName);
  if (!acc || !acc.pendingText) return;

  timelineEmitter.emit(sessionName, 'assistant.text', {
    text: acc.pendingText,
    streaming: true,
  }, {
    source: 'terminal-parse',
    confidence: 'low',
  });

  acc.pendingText = '';
  acc.timer = null;
}

/**
 * Extract the visible "content" text from screen lines — used to detect
 * what actually changed between frames.
 */
function screenContentText(allLines: string[]): string {
  const kept: string[] = [];
  for (const line of allLines) {
    const stripped = stripAnsi(line).trimEnd();
    if (classifyLine(stripped) === 'KEEP') {
      kept.push(stripped);
    }
  }
  return kept.join('\n');
}

/**
 * Process a terminal diff and emit assistant.text for meaningful changes.
 * Throttled to emit at most every 500ms, deduplicates unchanged content.
 */
export function processTerminalDiff(
  sessionName: string,
  allLines: string[],
  rows: number,
  scrolled: boolean,
  newLineCount: number,
  _changedLines?: Array<[number, string]>,
  isFullFrame?: boolean,
): void {
  // Scrolled: emit immediately (bulk text that scrolled off)
  if (scrolled && newLineCount > 0) {
    const text = extractScrolledText(allLines, rows, newLineCount);
    if (text) {
      timelineEmitter.emit(sessionName, 'assistant.text', { text }, {
        source: 'terminal-parse',
        confidence: 'low',
      });
      // Update screen snapshot after scroll
      const acc = getAcc(sessionName);
      acc.lastScreenText = screenContentText(allLines);
    }
    return;
  }

  // Full frame: just update the baseline, don't emit
  if (isFullFrame) {
    const acc = getAcc(sessionName);
    acc.lastScreenText = screenContentText(allLines);
    return;
  }

  // In-place changes: compare full screen text to find new content
  const acc = getAcc(sessionName);
  const currentText = screenContentText(allLines);

  if (currentText === acc.lastScreenText) return; // no meaningful change

  // Find the new text: what's in current but extends beyond previous
  // Simple approach: if current starts with previous content, the diff is the tail
  let newText = '';
  if (currentText.startsWith(acc.lastScreenText) && acc.lastScreenText.length > 0) {
    newText = currentText.slice(acc.lastScreenText.length).trim();
  } else if (acc.lastScreenText && currentText.length > acc.lastScreenText.length) {
    // Content changed in a non-append way — just take the diff of last lines
    const prevLines = acc.lastScreenText.split('\n');
    const currLines = currentText.split('\n');
    const diffLines: string[] = [];
    for (let i = 0; i < currLines.length; i++) {
      if (i >= prevLines.length || currLines[i] !== prevLines[i]) {
        diffLines.push(currLines[i]);
      }
    }
    newText = diffLines.join('\n').trim();
  }

  acc.lastScreenText = currentText;

  if (!newText) return;

  // Accumulate and throttle
  if (acc.pendingText) {
    acc.pendingText += '\n' + newText;
  } else {
    acc.pendingText = newText;
  }

  if (!acc.timer) {
    acc.timer = setTimeout(() => flushAcc(sessionName), THROTTLE_MS);
  }
}
