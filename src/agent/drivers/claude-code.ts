import type { AgentDriver, LaunchOptions, DeleteBufferFn } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

const OVERLAY_PATTERNS = [
  /Allow|Deny/,
  /\[Y\/n\]/i,
  /Do you want to/i,
  /Press Enter to/i,
  /─{10,}/, // CC uses box-drawing chars for dialogs
];

export class ClaudeCodeDriver implements AgentDriver {
  readonly type = 'claude-code' as const;
  readonly promptChar = '❯';
  readonly spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    return `${cwd}claude --dangerously-skip-permissions`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    return `${cwd}claude --dangerously-skip-permissions -c`;
  }

  detectStatus(lines: string[]): AgentStatus {
    return detectStatus(lines, 'claude-code');
  }

  isOverlay(lines: string[]): boolean {
    const tail = lines.slice(-5).join('\n');
    return OVERLAY_PATTERNS.some((p) => p.test(tail));
  }

  async captureLastResponse(
    capturePane: () => Promise<string[]>,
    sendKeys: (keys: string) => Promise<void>,
    showBuffer: () => Promise<string>,
    deleteBuffer?: DeleteBufferFn,
  ): Promise<string> {
    // Always local — use /copy for clean output
    try {
      await sendKeys('/copy');
      await new Promise((r) => setTimeout(r, 2000));
      const buf = await showBuffer();
      if (buf.trim()) {
        // Immediately clear the buffer — task 12.15 clipboard cleanup
        await deleteBuffer?.();
        return buf;
      }
    } catch {
      // fall through to capture-pane
    }
    const lines = await capturePane();
    return lines.join('\n');
  }
}
