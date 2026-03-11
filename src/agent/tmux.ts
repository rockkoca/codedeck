import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

/** Run a raw tmux command. */
export async function tmuxExec(args: string): Promise<string> {
  const { stdout } = await exec(`tmux ${args}`);
  return stdout.trim();
}

/**
 * Capture the visible content of a tmux pane (scrollback history).
 * Returns lines as a string array.
 */
export async function capturePane(session: string, lines = 50): Promise<string[]> {
  const raw = await tmuxExec(`capture-pane -p -t ${session} -S -${lines}`);
  return raw.split('\n');
}

/**
 * Capture only the currently visible pane with ANSI color codes.
 * Used for terminal streaming — gives exactly the rows the user sees.
 */
export async function capturePaneVisible(session: string): Promise<string> {
  return tmuxExec(`capture-pane -e -p -t ${session}`);
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
  // Quote the command with single quotes so the outer /bin/sh does NOT interpret
  // shell operators (&&, ||, etc.) — tmux receives the full string and runs it
  // via $SHELL -c internally.
  const cmdArg = command ? `-- '${command.replace(/'/g, "'\\''")}'` : '';
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

/** Resize a tmux session window to the given dimensions. */
export async function resizeSession(name: string, cols: number, rows: number): Promise<void> {
  await tmuxExec(`resize-window -t ${name} -x ${cols} -y ${rows}`);
}

/** Get the pane size (cols x rows) of a tmux session. */
export async function getPaneSize(session: string): Promise<{ cols: number; rows: number }> {
  try {
    const raw = await tmuxExec(`display-message -p -t ${session} '#{pane_width} #{pane_height}'`);
    const [cols, rows] = raw.split(' ').map(Number);
    return { cols: cols || 80, rows: rows || 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
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

// Map xterm.js escape sequences → tmux key names
const XTERM_KEY_MAP: Record<string, string> = {
  '\x1b[A': 'Up',   '\x1b[B': 'Down',
  '\x1b[C': 'Right','\x1b[D': 'Left',
  '\x1b[F': 'End',  '\x1b[H': 'Home',
  '\x1b[1~': 'Home','\x1b[3~': 'DC',
  '\x1b[4~': 'End', '\x1b[5~': 'PPage',
  '\x1b[6~': 'NPage','\x1b[2~': 'IC',
  '\x1b[Z': 'BTab',
  '\r': 'Enter',    '\x7f': 'BSpace',
  '\x1b': 'Escape',
  '\x1bOP': 'F1',   '\x1bOQ': 'F2',
  '\x1bOR': 'F3',   '\x1bOS': 'F4',
  '\x1b[15~': 'F5', '\x1b[17~': 'F6',
  '\x1b[18~': 'F7', '\x1b[19~': 'F8',
  '\x1b[20~': 'F9', '\x1b[21~': 'F10',
  '\x1b[23~': 'F11','\x1b[24~': 'F12',
};

/**
 * Send raw terminal input to a tmux session.
 * Maps xterm escape sequences to tmux key names; literal text uses -l flag.
 * Used for keyboard passthrough from the browser terminal.
 */
export async function sendRawInput(session: string, data: string): Promise<void> {
  // Check escape sequence map first
  const tmuxKey = XTERM_KEY_MAP[data];
  if (tmuxKey) {
    await tmuxExec(`send-keys -t ${session} ${tmuxKey}`);
    return;
  }

  // Ctrl+A..Z: \x01..\x1a
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96); // 1→'a', 2→'b', ...
      await tmuxExec(`send-keys -t ${session} C-${letter}`);
      return;
    }
  }

  // Unknown escape sequence — skip
  if (data.startsWith('\x1b')) return;

  // Regular printable text — send literally (no Enter appended)
  const escaped = data.replace(/'/g, "'\\''");
  await tmuxExec(`send-keys -t ${session} -l '${escaped}'`);
}
