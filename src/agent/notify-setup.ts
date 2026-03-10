/**
 * Setup idle signal hooks for Codex and OpenCode agents.
 *
 * - Codex: writes `notify` config to project config.toml
 * - OpenCode: writes .opencode/plugin/idle-signal.ts to project dir
 */

import { promises as fs } from 'fs';
import path from 'path';
import { SIGNAL_DIR } from './signal.js';

// ─── Codex notify setup ────────────────────────────────────────────────────────

/**
 * Write Codex notify config to <projectDir>/config.toml.
 * Uses `agent-turn-complete` event to write idle signal.
 */
export async function setupCodexNotify(
  projectDir: string,
  sessionName: string
): Promise<void> {
  const configPath = path.join(projectDir, 'config.toml');
  const signalFile = path.join(SIGNAL_DIR, `${sessionName}.idle.json`);
  const tmpFile = `${signalFile}.tmp`;

  const notifyScript = `#!/bin/bash
mkdir -p "${SIGNAL_DIR}"
echo '{"session":"${sessionName}","timestamp":"'$(date +%s%3N)'","agentType":"codex"}' > "${tmpFile}"
mv "${tmpFile}" "${signalFile}"`;

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    // file may not exist
  }

  // Only add if not already configured
  if (!existing.includes('agent-turn-complete')) {
    const notifyBlock = `
[notify]
"agent-turn-complete" = """
${notifyScript}
"""
`;
    await fs.appendFile(configPath, notifyBlock);
  }
}

// ─── OpenCode plugin setup ─────────────────────────────────────────────────────

/**
 * Write .opencode/plugin/idle-signal.ts to <projectDir>.
 * Handles `session.idle` event to write idle signal.
 */
export async function setupOpenCodePlugin(
  projectDir: string,
  sessionName: string
): Promise<void> {
  const pluginDir = path.join(projectDir, '.opencode', 'plugin');
  await fs.mkdir(pluginDir, { recursive: true });

  const pluginPath = path.join(pluginDir, 'idle-signal.ts');
  const signalFile = path.join(SIGNAL_DIR, `${sessionName}.idle.json`);
  const tmpFile = `${signalFile}.tmp`;

  const pluginContent = `// OpenCode idle signal plugin for remote-chat-cli
import { writeFileSync, mkdirSync, renameSync } from 'fs';

export default {
  name: 'idle-signal',
  events: {
    'session.idle': () => {
      const signalDir = '${SIGNAL_DIR}';
      mkdirSync(signalDir, { recursive: true });
      const payload = JSON.stringify({
        session: '${sessionName}',
        timestamp: Date.now(),
        agentType: 'opencode',
      });
      writeFileSync('${tmpFile}', payload);
      renameSync('${tmpFile}', '${signalFile}');
    },
  },
};
`;

  await fs.writeFile(pluginPath, pluginContent);
}
