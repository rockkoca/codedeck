/**
 * Generic project-memory injection for agent session startup.
 *
 * Reads project context files (CLAUDE.md → AGENTS.md → agent.md → README.md)
 * and returns the content suitable for injecting into a new agent session file.
 * In the future this can be extended to pull from external memory systems.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import logger from '../util/logger.js';

const CONTEXT_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'agent.md', 'README.md'];

/**
 * Read the first available project context file from the given directory.
 * Returns the content prefixed with a header, or null if none found.
 */
export async function readProjectMemory(cwd: string): Promise<string | null> {
  for (const name of CONTEXT_CANDIDATES) {
    try {
      const content = await readFile(join(cwd, name), 'utf8');
      if (content.trim()) {
        logger.debug({ cwd, file: name }, 'memory-inject: loaded project context');
        return `# Project context (${name})\n\n${content.trim()}`;
      }
    } catch { /* file not found or unreadable, try next */ }
  }
  return null;
}

/**
 * Build a Codex rollout JSONL entry injecting memory as a user message.
 * This uses the `response_item` format from real Codex rollout files.
 */
export function buildCodexMemoryEntry(memory: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: memory }],
    },
  });
}
