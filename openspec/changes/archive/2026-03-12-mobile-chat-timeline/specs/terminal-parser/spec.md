## ADDED Requirements

### Requirement: Deterministic scroll detection
The terminal parser SHALL detect scrolling by comparing consecutive terminal frames. It SHALL find the maximum `k` where `currentLines[0..rows-k-1] === previousLines[k..rows-1]`. If `k > 0`: `scrolled=true`, `newLineCount=k`, new content is `currentLines[rows-k..rows-1]`. If `k = 0`: `scrolled=false`, `newLineCount=0`.

#### Scenario: Screen scrolled by 3 lines
- **WHEN** current frame lines 0-16 match previous frame lines 3-19 (for a 20-row terminal)
- **THEN** `scrolled` SHALL be `true` and `newLineCount` SHALL be `3`

#### Scenario: Local repaint without scroll
- **WHEN** only lines 5-7 changed between frames but no scroll shift detected
- **THEN** `scrolled` SHALL be `false` and `newLineCount` SHALL be `0`

#### Scenario: Identical frames
- **WHEN** current frame equals previous frame
- **THEN** `scrolled` SHALL be `false` and `newLineCount` SHALL be `0`

### Requirement: Content extraction only on scroll
The terminal parser SHALL extract `assistant.text` content ONLY when `scrolled=true && newLineCount > 0`. Non-scrolled diffs (local repaints) SHALL NOT produce `assistant.text` events.

#### Scenario: Scrolled content extracted
- **WHEN** a diff has `scrolled=true` and `newLineCount=5`
- **THEN** the bottom 5 lines SHALL be extracted, stripped of ANSI, and emitted as `assistant.text`

#### Scenario: Non-scrolled diff ignored
- **WHEN** a diff has `scrolled=false`
- **THEN** no `assistant.text` event SHALL be emitted

### Requirement: Line classification
The terminal parser SHALL classify extracted lines into HIDE, MUTED, or KEEP categories:
- **HIDE**: Exact match "How is Claude doing this session", pure braille spinner lines (characters in U+2800-U+28FF only)
- **MUTED**: Lines where box-drawing characters (U+2500-U+257F) comprise >80% of non-whitespace content
- **KEEP**: All other content including any natural language text

#### Scenario: Braille spinner line hidden
- **WHEN** a line contains only braille characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
- **THEN** it SHALL be classified as HIDE

#### Scenario: Chinese text preserved
- **WHEN** a line contains "正在分析代码结构..."
- **THEN** it SHALL be classified as KEEP

#### Scenario: Box-drawing border muted
- **WHEN** a line is "╭──────────────────────────────╮"
- **THEN** it SHALL be classified as MUTED

#### Scenario: Mixed content preserved
- **WHEN** a line contains "│ Reading file.ts │" (box-drawing < 80%)
- **THEN** it SHALL be classified as KEEP

### Requirement: ANSI stripping
The terminal parser SHALL strip all ANSI escape sequences from extracted lines before classification and text assembly. It SHALL handle CSI sequences (`\x1b[...`), OSC sequences (`\x1b]...\x07`), and other common terminal escapes.

#### Scenario: Color codes stripped
- **WHEN** a line contains `\x1b[32mSuccess\x1b[0m`
- **THEN** the stripped result SHALL be `Success`

#### Scenario: CJK with ANSI stripped
- **WHEN** a line contains ANSI-wrapped Chinese characters
- **THEN** the Chinese text SHALL be preserved after stripping

### Requirement: assistant.text event emission
The terminal parser SHALL emit `assistant.text` TimelineEvents via `timelineEmitter` with `source: 'terminal-parse'` and `confidence: 'low'`. The payload SHALL include the assembled text from KEEP and MUTED lines (HIDE lines excluded).

#### Scenario: Multi-line extraction
- **WHEN** 5 new lines are extracted with 4 KEEP and 1 HIDE
- **THEN** a single `assistant.text` event SHALL be emitted with the 4 KEEP lines joined by newlines

#### Scenario: All lines hidden
- **WHEN** all extracted lines are classified as HIDE
- **THEN** no `assistant.text` event SHALL be emitted
