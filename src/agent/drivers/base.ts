import type { AgentStatus, AgentType } from '../detect.js';

export type DeleteBufferFn = () => Promise<void>;

export interface LaunchOptions {
  cwd?: string;
  resumeFirst?: boolean; // try to resume before starting fresh
}

export interface AgentDriver {
  readonly type: AgentType;
  /** Primary idle prompt character(s) */
  readonly promptChar: string;
  /** Spinner characters used while active */
  readonly spinnerChars: string[];

  /** Build the shell command to launch the agent (fresh start). */
  buildLaunchCommand(sessionName: string, opts?: LaunchOptions): string;

  /**
   * Build the shell command to resume the most recent session.
   * Returns null if this agent does not support resume.
   */
  buildResumeCommand(sessionName: string, opts?: LaunchOptions): string | null;

  /**
   * Detect the current status from captured pane lines.
   * May use agent-specific heuristics on top of the shared detect.ts logic.
   */
  detectStatus(lines: string[]): AgentStatus;

  /**
   * Returns true if the pane is currently showing an overlay (e.g. CC permission dialog,
   * Codex context menu). When true, the agent is not idle.
   */
  isOverlay(lines: string[]): boolean;

  /**
   * Capture the last agent response cleanly.
   * CC: send /copy and read tmux buffer. Others: use capture-pane.
   * @param capturePane - function to get current pane lines
   * @param sendKeys - function to send keys to the session
   * @param showBuffer - function to read tmux paste buffer
   */
  /**
   * @param deleteBuffer - optional fn to clear tmux buffer after reading (task 12.15 clipboard cleanup)
   */
  captureLastResponse(
    capturePane: () => Promise<string[]>,
    sendKeys: (keys: string) => Promise<void>,
    showBuffer: () => Promise<string>,
    deleteBuffer?: DeleteBufferFn,
  ): Promise<string>;
}
