import { loadStore, flushStore } from '../store/session-store.js';
import { restoreFromStore } from '../agent/session-manager.js';
import { detectMemoryBackend } from '../memory/detector.js';
import { ServerLink } from './server-link.js';
import { loadConfig, type Config } from '../config.js';
import logger from '../util/logger.js';
import type { MemoryBackend } from '../memory/interface.js';

export interface DaemonContext {
  config: Config;
  memory: MemoryBackend | null;
  serverLink: ServerLink | null;
}

let ctx: DaemonContext | null = null;

/** Startup sequence: config → store → memory → sessions → server link */
export async function startup(): Promise<DaemonContext> {
  logger.info('Daemon starting');

  const config = await loadConfig();
  logger.info({ config: config.daemon }, 'Config loaded');

  await loadStore();
  logger.info('Session store loaded');

  const { backend: memory, mode } = await detectMemoryBackend();
  logger.info({ mode }, 'Memory backend selected');

  await restoreFromStore();
  logger.info('Sessions reconciled');

  let serverLink: ServerLink | null = null;
  if (config.cf?.workerUrl && config.cf?.apiKey) {
    serverLink = new ServerLink(config.cf.workerUrl, config.cf.apiKey);
    serverLink.connect().catch((e) => logger.warn({ err: e }, 'Server link connect failed'));
  }

  ctx = { config, memory, serverLink };
  setupSignalHandlers();

  logger.info('Daemon started');
  return ctx;
}

/** Shutdown sequence: flush store, disconnect WS, exit cleanly */
export async function shutdown(exitCode = 0): Promise<void> {
  logger.info('Daemon shutting down');

  try {
    ctx?.serverLink?.disconnect();
    await flushStore();
    logger.info('Store flushed');
  } catch (e) {
    logger.error({ err: e }, 'Error during shutdown');
  }

  // tmux sessions are intentionally NOT killed — they keep running
  logger.info('Daemon stopped (tmux sessions left running)');
  process.exit(exitCode);
}

function setupSignalHandlers(): void {
  const handler = () => shutdown(0);
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    shutdown(1);
  });
}

export function getDaemonContext(): DaemonContext {
  if (!ctx) throw new Error('Daemon not started');
  return ctx;
}
