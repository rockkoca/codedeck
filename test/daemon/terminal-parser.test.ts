import { describe, it, expect } from 'vitest';
import { stripAnsi, classifyLine, extractScrolledText } from '../../src/daemon/terminal-parser.js';

describe('stripAnsi', () => {
  it('removes CSI escape sequences', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('\x1b[1;33mwarning\x1b[0m')).toBe('warning');
    expect(stripAnsi('\x1b[2J')).toBe('');
  });

  it('removes OSC sequences', () => {
    // OSC sequences: ESC ] ... BEL
    expect(stripAnsi('\x1b]0;window title\x07text')).toBe('text');
    expect(stripAnsi('\x1b]2;some title\x07')).toBe('');
  });

  it('removes other ESC sequences', () => {
    // ANSI_OTHER = /\x1b[^[\]].?/g — matches ESC + 1 non-bracket char + optional non-newline char
    // '\x1b>' → ESC + '>' with no trailing char → ''
    expect(stripAnsi('\x1b>')).toBe('');
    // '\x1b=X' → ESC + '=' + 'X' → '' (the optional char IS consumed)
    expect(stripAnsi('\x1b=X')).toBe('');
    // Note: the optional trailing char IS consumed, so 'a' in '\x1b>after' is eaten
    // '\x1b>after' → ESC + '>' + 'a' consumed → 'fter'
    expect(stripAnsi('\x1b>after')).toBe('fter');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });

  it('handles mixed ANSI and plain text', () => {
    const input = '\x1b[31mError:\x1b[0m something went wrong';
    expect(stripAnsi(input)).toBe('Error: something went wrong');
  });
});

describe('classifyLine', () => {
  it('returns HIDE for empty string', () => {
    expect(classifyLine('')).toBe('HIDE');
  });

  it('returns HIDE for whitespace-only string', () => {
    expect(classifyLine('   ')).toBe('HIDE');
    expect(classifyLine('\t\t')).toBe('HIDE');
  });

  it('returns HIDE for "How is Claude doing this session?"', () => {
    expect(classifyLine('How is Claude doing this session?')).toBe('HIDE');
    expect(classifyLine('  How is Claude doing this session?  ')).toBe('HIDE');
  });

  it('returns HIDE for "How is Claude doing this session" (no question mark)', () => {
    expect(classifyLine('How is Claude doing this session')).toBe('HIDE');
  });

  it('returns HIDE for pure braille chars', () => {
    // Braille range U+2800-U+28FF
    expect(classifyLine('\u2812\u2816\u2800\u2812')).toBe('HIDE');
    expect(classifyLine('\u28FF\u2800')).toBe('HIDE');
  });

  it('returns HIDE for braille spinner with whitespace', () => {
    expect(classifyLine('  \u2812\u2816  ')).toBe('HIDE');
  });

  it('returns MUTED for >80% box-drawing characters', () => {
    // Box-drawing: U+2500-U+257F
    // Create a string that is 90% box-drawing
    const boxLine = '\u2500\u2501\u2502\u2503\u2504\u2505\u2506\u2507\u2508\u2509'; // 10 box chars
    expect(classifyLine(boxLine)).toBe('MUTED');
  });

  it('returns MUTED for a typical table border line', () => {
    // ─────────────────── (all box-drawing)
    const border = '\u2500'.repeat(20);
    expect(classifyLine(border)).toBe('MUTED');
  });

  it('returns KEEP for normal ASCII text', () => {
    expect(classifyLine('hello world')).toBe('KEEP');
    expect(classifyLine('Error: failed to connect')).toBe('KEEP');
    expect(classifyLine('const x = 42;')).toBe('KEEP');
  });

  it('returns KEEP for CJK text', () => {
    expect(classifyLine('你好世界')).toBe('KEEP');
    expect(classifyLine('日本語テスト')).toBe('KEEP');
  });

  it('returns KEEP for emoji text', () => {
    expect(classifyLine('✅ Build passed')).toBe('KEEP');
    expect(classifyLine('🚀 Deploying...')).toBe('KEEP');
  });

  it('returns KEEP for mixed box-drawing below 80% threshold', () => {
    // 1 box char out of 10 total non-ws chars = 10%
    const mixed = 'hello\u2500world';
    expect(classifyLine(mixed)).toBe('KEEP');
  });
});

describe('extractScrolledText', () => {
  it('returns text from new bottom lines', () => {
    const lines = [
      'line 0 (old)',
      'line 1 (old)',
      'line 2 (new content)',
      'line 3 (more new)',
    ];
    // rows=4, newLineCount=2 → new lines are at index 2 and 3
    const result = extractScrolledText(lines, 4, 2);
    expect(result).toBe('line 2 (new content)\nline 3 (more new)');
  });

  it('strips ANSI codes from lines', () => {
    const lines = [
      'old line',
      '\x1b[32mgreen text\x1b[0m',
    ];
    const result = extractScrolledText(lines, 2, 1);
    expect(result).toBe('green text');
  });

  it('returns null when all new lines are HIDE', () => {
    const lines = [
      'old line',
      '',  // empty → HIDE
      '   ', // whitespace → HIDE
    ];
    // rows=3, newLineCount=2 → new lines are '' and '   '
    const result = extractScrolledText(lines, 3, 2);
    expect(result).toBeNull();
  });

  it('returns null when all new lines are braille spinners', () => {
    const lines = [
      'context line',
      '\u2812\u2816\u2800',
    ];
    const result = extractScrolledText(lines, 2, 1);
    expect(result).toBeNull();
  });

  it('excludes HIDE lines but includes MUTED and KEEP lines', () => {
    const lines = [
      'old',
      '\u2500\u2500\u2500\u2500\u2500',  // MUTED (box-drawing border)
      '',                                   // HIDE (empty)
      'actual content',                     // KEEP
    ];
    // rows=4, newLineCount=3 → new lines are the last 3
    const result = extractScrolledText(lines, 4, 3);
    expect(result).toContain('actual content');
    expect(result).not.toContain('old');
    // Empty line is skipped
    const parts = result!.split('\n');
    expect(parts).not.toContain('');
  });

  it('returns single new line', () => {
    const lines = ['old', 'new important output'];
    const result = extractScrolledText(lines, 2, 1);
    expect(result).toBe('new important output');
  });
});
