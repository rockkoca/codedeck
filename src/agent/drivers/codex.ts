import type { AgentDriver, LaunchOptions } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

export class CodexDriver implements AgentDriver {
  readonly type = 'codex' as const;
  readonly promptChar = '›';
  readonly spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    if (opts?.fresh) {
      return `${cwd}codex -s danger-full-access`;
    }
    // Default: resume last session; fall back to fresh if no history
    return `${cwd}codex -s danger-full-access resume --last || codex -s danger-full-access`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    return this.buildLaunchCommand(_sessionName, opts);
  }

  detectStatus(lines: string[]): AgentStatus {
    return detectStatus(lines, 'codex');
  }

  isOverlay(lines: string[]): boolean {
    // Codex shows context menu overlays when mid-action
    const tail = lines.slice(-5).join('\n');
    return /\[ESC\]|\[q\]/.test(tail);
  }

  async captureLastResponse(
    capturePane: () => Promise<string[]>,
    _sendKeys: (keys: string) => Promise<void>,
    _showBuffer: () => Promise<string>,
  ): Promise<string> {
    // Codex has no /copy equivalent — always use capture-pane
    const lines = await capturePane();
    return lines.join('\n');
  }
}
