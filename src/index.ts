#!/usr/bin/env node
import { Command } from 'commander';
import { startup, shutdown } from './daemon/lifecycle.js';
import { startProject, stopProject, sessionName } from './agent/session-manager.js';
import { loadStore, listSessions } from './store/session-store.js';
import { sendKeys } from './agent/tmux.js';
import { bindFlow } from './bind/bind-flow.js';
import logger from './util/logger.js';

const program = new Command()
  .name('codedeck')
  .description('Remote AI coding agent controller')
  .version('0.1.0');

program
  .command('start')
  .description('Start the daemon (connect to CF server, restore sessions)')
  .action(async () => {
    await startup();
    logger.info('Daemon running. Press Ctrl+C to stop.');
    // Keep process alive — signal handlers in lifecycle.ts handle exit
    await new Promise(() => {});
  });

program
  .command('stop')
  .description('Stop the daemon gracefully')
  .action(async () => {
    await shutdown(0);
  });

program
  .command('project')
  .description('Manage projects')
  .addCommand(
    new Command('start')
      .description('Start brain + workers for a project')
      .argument('<name>', 'Project name')
      .argument('<dir>', 'Project directory')
      .option('--brain <type>', 'Brain agent type', 'claude-code')
      .option('--workers <types>', 'Comma-separated worker types', 'claude-code')
      .action(async (name: string, dir: string, opts: { brain: string; workers: string }) => {
        const workerTypes = opts.workers.split(',').map((t) => t.trim()) as ('claude-code' | 'codex' | 'opencode')[];
        await loadStore();
        await startProject({ name, dir, brainType: opts.brain as 'claude-code' | 'codex' | 'opencode', workerTypes });
        console.log(`Started project ${name}: brain + ${workerTypes.length} worker(s)`);
      }),
  )
  .addCommand(
    new Command('stop')
      .description('Stop all sessions for a project')
      .argument('<name>', 'Project name')
      .action(async (name: string) => {
        await loadStore();
        await stopProject(name);
        console.log(`Stopped project ${name}`);
      }),
  );

program
  .command('status')
  .description('Show all active sessions')
  .option('--project <name>', 'Filter by project')
  .action(async (opts: { project?: string }) => {
    await loadStore();
    const sessions = listSessions(opts.project);
    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }
    for (const s of sessions) {
      console.log(`${s.name}  ${s.agentType.padEnd(12)}  ${s.state}  restarts=${s.restarts}`);
    }
  });

program
  .command('send')
  .description('Send a message to a session')
  .argument('<session>', 'Session name (e.g. deck_myapp_brain) or project:role (e.g. myapp:w1)')
  .argument('<message...>', 'Message text')
  .action(async (session: string, messageParts: string[]) => {
    const message = messageParts.join(' ');
    // Support shorthand "project:role"
    const name = session.includes(':')
      ? sessionName(session.split(':')[0], session.split(':')[1] as 'brain' | `w${number}`)
      : session;
    await sendKeys(name, message);
    console.log(`Sent to ${name}`);
  });

program
  .command('bind')
  .description('Bind this machine to Codedeck')
  .argument('<url>', 'Bind URL from the Codedeck dashboard (https://app.codedeck.cc/bind/<api-key>)')
  .argument('[device-name]', 'Friendly name for this device (default: hostname)')
  .action(async (url: string, deviceName?: string) => {
    await bindFlow(url, deviceName);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
