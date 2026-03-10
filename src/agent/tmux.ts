import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

/** Run a raw tmux command. */
export async function tmuxExec(args: string): Promise<string> {
  const { stdout } = await exec(`tmux ${args}`);
  return stdout.trim();
}

/**
 * Capture the visible content of a tmux pane.
 * Returns lines as a string array.
 */
export async function capturePane(session: string, lines = 50): Promise<string[]> {
  const raw = await tmuxExec(`capture-pane -p -t ${session} -S -${lines}`);
  return raw.split('\n');
}

/** Send a string of keys to a tmux pane (newline = Enter). */
export async function sendKeys(session: string, keys: string): Promise<void> {
  const escaped = keys.replace(/'/g, "'\\''");
  await tmuxExec(`send-keys -t ${session} '${escaped}' Enter`);
}

/** Send raw keys without appending Enter (e.g. for Ctrl-C). */
export async function sendKey(session: string, key: string): Promise<void> {
  await tmuxExec(`send-keys -t ${session} ${key}`);
}

export interface NewSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Create a new detached tmux session. Throws if it already exists. */
export async function newSession(name: string, command?: string, opts?: NewSessionOptions): Promise<void> {
  const cwdArg = opts?.cwd ? `-c ${JSON.stringify(opts.cwd)}` : '';
  const envArgs = opts?.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
        .join(' ')
    : '';
  const cmdArg = command ? `-- ${command}` : '';
  await tmuxExec(`new-session -d -s ${name} ${cwdArg} ${envArgs} ${cmdArg}`.trim());
}

/** Kill a tmux session by name. Does not throw if it doesn't exist. */
export async function killSession(name: string): Promise<void> {
  try {
    await tmuxExec(`kill-session -t ${name}`);
  } catch {
    // session may not exist
  }
}

/** List all tmux sessions. Returns session names. */
export async function listSessions(): Promise<string[]> {
  try {
    const raw = await tmuxExec(`list-sessions -F '#{session_name}'`);
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Check if a tmux session exists. */
export async function sessionExists(name: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(name);
}

/** Read the tmux paste buffer (used for CC /copy output). */
export async function showBuffer(): Promise<string> {
  return tmuxExec('show-buffer');
}

/** Delete the tmux paste buffer (clipboard cleanup after CC /copy). */
export async function deleteBuffer(): Promise<void> {
  try {
    await tmuxExec('delete-buffer');
  } catch {
    // buffer may not exist
  }
}
