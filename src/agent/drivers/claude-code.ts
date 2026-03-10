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

// Startup dialogs to auto-dismiss after launch
const STARTUP_PROMPTS: Array<{
  pattern: RegExp;
  keys: string[]; // tmux key names to send in sequence
  label: string;
}> = [
  // "Do you trust the files in this folder?" — Enter to accept (Yes is default)
  { pattern: /trust.*folder|do you trust/i, keys: ['Enter'], label: 'trust-folder' },
  // Update available / Press enter to continue
  { pattern: /update available|press enter to continue/i, keys: ['Enter'], label: 'update' },
  // Bypass Permissions dialog — cursor is on "No, exit", need Down to reach "Yes, I accept"
  { pattern: /bypass permissions/i, keys: ['Down', 'Enter'], label: 'bypass-perms' },
  // Settings error — cursor is on "Exit and fix manually", need Down to reach "Continue without these settings"
  { pattern: /settings.*error|error.*settings/i, keys: ['Down', 'Enter'], label: 'settings-error' },
  // Generic "[Y/n]" confirmation — Enter for default yes
  { pattern: /\[Y\/n\]/i, keys: ['Enter'], label: 'confirm' },
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

  async postLaunch(
    capturePane: () => Promise<string[]>,
    sendKey: (key: string) => Promise<void>,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 1_500;
    const MAX_POLLS = 12; // up to 18 seconds total

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let lines: string[];
      try {
        lines = await capturePane();
      } catch {
        continue; // session may not be ready yet
      }

      const screen = lines.join('\n');

      // Check if agent is ready (idle prompt visible) — stop polling
      if (screen.includes(this.promptChar)) return;

      // Try each startup prompt pattern
      let handled = false;
      for (const { pattern, keys } of STARTUP_PROMPTS) {
        if (pattern.test(screen)) {
          for (const key of keys) {
            await sendKey(key);
            await new Promise((r) => setTimeout(r, 200));
          }
          handled = true;
          break;
        }
      }

      // If idle prompt appeared after handling, stop
      if (handled) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const refreshed = await capturePane();
          if (refreshed.join('\n').includes(this.promptChar)) return;
        } catch { /* continue polling */ }
      }
    }
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
