/**
 * Handle commands from the web UI and inbound chat messages via ServerLink.
 * Commands arrive as JSON objects with a `type` field.
 */
import { startProject, stopProject, type ProjectConfig } from '../agent/session-manager.js';
import { sendKeys, sendRawInput, resizeSession } from '../agent/tmux.js';
import { listSessions } from '../store/session-store.js';
import { routeMessage, type InboundMessage, type RouterContext } from '../router/message-router.js';
import { terminalStreamer, type StreamSubscriber } from './terminal-streamer.js';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';
import { homedir } from 'os';

function expandTilde(p: string): string {
  return p.startsWith('~/') ? homedir() + p.slice(1) : p === '~' ? homedir() : p;
}

// Track active terminal subscriptions for proper cleanup
const activeSubscriptions = new Map<string, { subscriber: StreamSubscriber; unsubscribe: () => void }>();

let routerCtx: RouterContext | null = null;

/** Set the router context for handling inbound chat messages. Must be called before messages arrive. */
export function setRouterContext(ctx: RouterContext): void {
  routerCtx = ctx;
}

export function handleWebCommand(msg: unknown, serverLink: ServerLink): void {
  if (!msg || typeof msg !== 'object') return;
  const cmd = msg as Record<string, unknown>;

  switch (cmd.type) {
    case 'inbound':
      void handleInbound(cmd);
      break;
    case 'session.start':
      void handleStart(cmd, serverLink);
      break;
    case 'session.stop':
      void handleStop(cmd);
      break;
    case 'session.send':
      void handleSend(cmd);
      break;
    case 'session.input':
      void handleInput(cmd);
      break;
    case 'session.resize':
      void handleResize(cmd);
      break;
    case 'get_sessions':
      handleGetSessions(serverLink);
      break;
    case 'terminal.subscribe':
      handleSubscribe(cmd, serverLink);
      break;
    case 'terminal.unsubscribe':
      handleUnsubscribe(cmd);
      break;
    case 'auth_ok':
    case 'heartbeat':
    case 'ping':
    case 'pong':
      // Expected internal messages, ignore silently
      break;
    default:
      if (typeof cmd.type === 'string') {
        logger.warn({ type: cmd.type }, 'Unknown web command type');
      }
  }
}

async function handleInbound(cmd: Record<string, unknown>): Promise<void> {
  const msg = cmd.msg as InboundMessage | undefined;
  if (!msg) {
    logger.warn('inbound: missing msg payload');
    return;
  }
  if (!routerCtx) {
    logger.warn('inbound: router context not set, dropping message');
    return;
  }
  try {
    await routeMessage(msg, routerCtx);
  } catch (err) {
    logger.error({ err, platform: msg.platform, channelId: msg.channelId }, 'inbound: routeMessage failed');
  }
}

async function handleStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const project = cmd.project as string | undefined;
  const agentType = (cmd.agentType as string) || 'claude-code';
  const dir = expandTilde((cmd.dir as string) || '~');

  if (!project) {
    logger.warn('session.start: missing project name');
    return;
  }

  try {
    const config: ProjectConfig = {
      name: project,
      dir,
      brainType: agentType as ProjectConfig['brainType'],
      workerTypes: [],
    };
    await startProject(config);
    logger.info({ project }, 'Session started via web');
  } catch (err) {
    logger.error({ project, err }, 'session.start failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleStop(cmd: Record<string, unknown>): Promise<void> {
  const project = cmd.project as string | undefined;
  if (!project) {
    logger.warn('session.stop: missing project name');
    return;
  }

  try {
    await stopProject(project);
    logger.info({ project }, 'Session stopped via web');
  } catch (err) {
    logger.error({ project, err }, 'session.stop failed');
  }
}

async function handleSend(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = (cmd.sessionName ?? cmd.session) as string | undefined;
  const text = cmd.text as string | undefined;

  if (!sessionName || !text) {
    logger.warn('session.send: missing sessionName or text');
    return;
  }

  try {
    await sendKeys(sessionName, text);
  } catch (err) {
    logger.error({ sessionName, err }, 'session.send failed');
  }
}

async function handleInput(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const data = cmd.data as string | undefined;

  if (!sessionName || data === undefined) return;

  try {
    await sendRawInput(sessionName, data);
    // Wake up the capture loop immediately so the screen reflects the keystroke
    terminalStreamer.nudge(sessionName);
  } catch (err) {
    logger.error({ sessionName, err }, 'session.input failed');
  }
}

async function handleResize(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const cols = cmd.cols as number | undefined;
  const rows = cmd.rows as number | undefined;
  if (!sessionName || !cols || !rows) return;
  try {
    await resizeSession(sessionName, Math.max(cols, 40), Math.max(rows, 10));
    terminalStreamer.invalidateSize(sessionName);
    terminalStreamer.nudge(sessionName);
  } catch (err) {
    logger.error({ sessionName, cols, rows, err }, 'session.resize failed');
  }
}

function handleGetSessions(serverLink: ServerLink): void {
  const sessions = listSessions().map((s) => ({
    name: s.name,
    project: s.projectName,
    role: s.role,
    agentType: s.agentType,
    state: s.state,
  }));
  try {
    serverLink.send({ type: 'session_list', sessions });
  } catch {
    // not connected
  }
}

function handleSubscribe(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const session = cmd.session as string | undefined;
  if (!session) return;

  // Clean up any existing subscription for this session first
  const existing = activeSubscriptions.get(session);
  if (existing) {
    existing.unsubscribe();
    activeSubscriptions.delete(session);
  }

  const subscriber: StreamSubscriber = {
    sessionName: session,
    send: (diff) => {
      try {
        serverLink.send({ type: 'terminal_update', diff });
      } catch {
        // not connected — will be cleaned up by onError
      }
    },
    onError: () => {
      activeSubscriptions.delete(session);
    },
  };

  const unsubscribe = terminalStreamer.subscribe(subscriber);
  activeSubscriptions.set(session, { subscriber, unsubscribe });
  logger.debug({ session }, 'Terminal subscribed via web');
}

function handleUnsubscribe(cmd: Record<string, unknown>): void {
  const session = cmd.session as string | undefined;
  if (!session) return;

  const entry = activeSubscriptions.get(session);
  if (entry) {
    entry.unsubscribe();
    activeSubscriptions.delete(session);
    logger.debug({ session }, 'Terminal unsubscribed via web');
  }
}
