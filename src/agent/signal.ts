/**
 * Idle signal file detection — port of ucc.py check_idle_signal_fn pattern.
 *
 * Each agent writes to /tmp/codedeck/signals/<session-name>.idle.json
 * via atomic rename (write to .tmp, then mv) to prevent partial reads.
 * Reading the file also deletes it to prevent duplicate triggers.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const SIGNAL_DIR = '/tmp/codedeck/signals';

export interface IdleSignal {
  session: string;
  timestamp: number;
  agentType?: string;
}

/** Ensure the signal directory exists. Call on daemon startup. */
export async function ensureSignalDir(): Promise<void> {
  await fs.mkdir(SIGNAL_DIR, { recursive: true });
}

function signalPath(sessionName: string): string {
  return path.join(SIGNAL_DIR, `${sessionName}.idle.json`);
}

/**
 * Check if an idle signal file exists for the given session.
 * If it does, read it, delete it, and return the signal.
 * Returns null if no signal.
 */
export async function checkIdleSignal(sessionName: string): Promise<IdleSignal | null> {
  const filePath = signalPath(sessionName);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Consume immediately
    await fs.unlink(filePath).catch(() => {});
    return JSON.parse(raw) as IdleSignal;
  } catch {
    return null;
  }
}

/**
 * Write an idle signal file atomically (write to .tmp, then rename).
 * Used by hook scripts and test helpers.
 */
export async function writeIdleSignal(signal: IdleSignal): Promise<void> {
  await ensureSignalDir();
  const filePath = signalPath(signal.session);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(signal));
  await fs.rename(tmpPath, filePath);
}

// ─── CC Stop Hook setup ───────────────────────────────────────────────────────

const CC_HOOK_SCRIPT_NAME = 'cc_stop_hook.sh';
const CC_HOOK_SCRIPT_PATH = path.join(os.homedir(), '.codedeck', CC_HOOK_SCRIPT_NAME);
const CC_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Ensure ~/.claude/settings.json has a Stop hook pointing to cc_stop_hook.sh.
 * The hook script writes a per-session signal file on idle.
 */
export async function setupCCStopHook(): Promise<void> {
  // Write the hook script
  await fs.mkdir(path.dirname(CC_HOOK_SCRIPT_PATH), { recursive: true });
  await fs.writeFile(
    CC_HOOK_SCRIPT_PATH,
    `#!/bin/bash
# CC Stop hook — writes idle signal for codedeck
SESSION_NAME="$1"
if [ -z "$SESSION_NAME" ]; then
  SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || echo "unknown")
fi
SIGNAL_DIR="${SIGNAL_DIR}"
mkdir -p "$SIGNAL_DIR"
TMP_FILE="$SIGNAL_DIR/$SESSION_NAME.idle.json.tmp"
SIGNAL_FILE="$SIGNAL_DIR/$SESSION_NAME.idle.json"
echo '{"session":"'"$SESSION_NAME"'","timestamp":'"$(date +%s%3N)"',"agentType":"claude-code"}' > "$TMP_FILE"
mv "$TMP_FILE" "$SIGNAL_FILE"
`
  );
  await fs.chmod(CC_HOOK_SCRIPT_PATH, 0o755);

  // Update ~/.claude/settings.json
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CC_SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // file may not exist
  }

  const hooks = (settings['hooks'] as Record<string, unknown[]> | undefined) ?? {};
  const stopHooks = (hooks['Stop'] as Array<{ type: string; command: string }> | undefined) ?? [];

  const hookEntry = { type: 'command', command: CC_HOOK_SCRIPT_PATH };
  const alreadySet = stopHooks.some((h) => h.command === CC_HOOK_SCRIPT_PATH);

  if (!alreadySet) {
    hooks['Stop'] = [...stopHooks, hookEntry];
    settings['hooks'] = hooks;

    await fs.mkdir(path.dirname(CC_SETTINGS_PATH), { recursive: true });
    await fs.writeFile(CC_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  }
}
