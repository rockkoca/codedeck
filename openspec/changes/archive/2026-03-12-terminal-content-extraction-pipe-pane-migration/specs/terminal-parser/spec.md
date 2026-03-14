## ADDED Requirements

### Requirement: Raw PTY stream parser state
The system SHALL provide a per-session raw stream parser that maintains state for partial UTF-8, partial ANSI escape sequences, carriage-return handling, and current line accumulation.

#### Scenario: UTF-8 split across chunks
- **WHEN** a multibyte UTF-8 character is split between two chunks
- **THEN** parser SHALL buffer the incomplete bytes and emit correct decoded text once complete

#### Scenario: ANSI sequence split across chunks
- **WHEN** an ANSI escape sequence starts in one chunk and ends in another
- **THEN** parser SHALL preserve parser correctness and SHALL NOT emit escape bytes as visible text

### Requirement: Line completion semantics
The parser SHALL emit assistant text only from completed lines and SHALL distinguish overwrite redraw from real newline output.

#### Scenario: CRLF line completion
- **WHEN** parser sees `\r\n`
- **THEN** it SHALL emit the pre-CR line as a completed line

#### Scenario: Carriage-return overwrite
- **WHEN** parser sees `\r` not followed by `\n`
- **THEN** current line SHALL be treated as overwritten and SHALL NOT be emitted as completed output

#### Scenario: Pure LF line completion
- **WHEN** parser sees `\n` without a preceding `\r`
- **THEN** it SHALL emit the current line as a completed line

### Requirement: Extracted text classification integration
Each completed line SHALL be normalized and classified before emission, and hidden chrome patterns SHALL be excluded.

#### Scenario: Hidden line filtered
- **WHEN** a completed line is classified as `HIDE`
- **THEN** parser SHALL NOT emit it into assistant text accumulation

#### Scenario: Keep line emitted
- **WHEN** a completed line is classified as `KEEP`
- **THEN** parser SHALL include it in assistant text accumulation and downstream throttled emission
