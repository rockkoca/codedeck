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
import { timelineEmitter } from './timeline-emitter.js';
import { timelineStore } from './timeline-store.js';
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
    case 'session.restart':
      void handleRestart(cmd, serverLink);
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
    case 'terminal.snapshot_request':
      handleSnapshotRequest(cmd);
      break;
    case 'timeline.replay_request':
      handleTimelineReplay(cmd, serverLink);
      break;
    case 'timeline.history_request':
      handleTimelineHistory(cmd, serverLink);
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

async function handleRestart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const project = cmd.project as string | undefined;
  const fresh = cmd.fresh === true;
  if (!project) {
    logger.warn('session.restart: missing project name');
    return;
  }

  const sessions = listSessions(project);
  if (!sessions.length) {
    logger.warn({ project }, 'session.restart: no sessions found for project');
    return;
  }

  const brain = sessions.find((s) => s.role === 'brain');
  if (!brain) {
    logger.warn({ project }, 'session.restart: no brain session found');
    return;
  }

  try {
    await stopProject(project);
    const config: ProjectConfig = {
      name: project,
      dir: brain.projectDir,
      brainType: brain.agentType as ProjectConfig['brainType'],
      workerTypes: sessions
        .filter((s) => s.role !== 'brain')
        .map((s) => s.agentType as ProjectConfig['brainType']),
      fresh,
    };
    await startProject(config);
    logger.info({ project, fresh }, 'Session restarted via web');
  } catch (err) {
    logger.error({ project, err }, 'session.restart failed');
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
    timelineEmitter.emit(sessionName, 'user.message', { text });
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
    // Do NOT catch here — let errors propagate to captureAndBroadcast so it can
    // call onError and clean up the subscription properly.
    send: (diff) => {
      serverLink.send({ type: 'terminal_update', diff });
    },
    sendHistory: (history) => {
      try {
        serverLink.send({ type: 'terminal.history', sessionName: history.sessionName, content: history.content });
      } catch {
        // history is best-effort, don't remove the subscription on failure
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

function handleSnapshotRequest(cmd: Record<string, unknown>): void {
  const sessionName = cmd.sessionName as string | undefined;
  if (!sessionName) return;
  terminalStreamer.requestSnapshot(sessionName);
  logger.debug({ sessionName }, 'Snapshot requested via web');
}

function handleTimelineReplay(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const sessionName = cmd.sessionName as string | undefined;
  const afterSeq = cmd.afterSeq as number | undefined;
  const requestEpoch = cmd.epoch as number | undefined;
  const requestId = cmd.requestId as string | undefined;

  if (!sessionName || afterSeq === undefined || requestEpoch === undefined) {
    logger.warn('timeline.replay_request: missing fields');
    return;
  }

  if (requestEpoch !== timelineEmitter.epoch) {
    // Epoch mismatch — serve current epoch events from file store
    const events = timelineStore.read(sessionName, { epoch: timelineEmitter.epoch });
    try {
      serverLink.send({
        type: 'timeline.replay',
        sessionName,
        requestId,
        events,
        truncated: false,
        epoch: timelineEmitter.epoch,
      });
    } catch { /* not connected */ }
    return;
  }

  const { events, truncated } = timelineEmitter.replay(sessionName, afterSeq);
  try {
    serverLink.send({
      type: 'timeline.replay',
      sessionName,
      requestId,
      events,
      truncated,
      epoch: timelineEmitter.epoch,
    });
  } catch { /* not connected */ }
}

/** Handle timeline.history_request — browser requesting full session history on open. */
function handleTimelineHistory(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const sessionName = cmd.sessionName as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const limit = (cmd.limit as number | undefined) ?? 200;

  if (!sessionName) {
    logger.warn('timeline.history_request: missing sessionName');
    return;
  }

  // Read from file store — current epoch first, fall back to any
  let events = timelineStore.read(sessionName, { epoch: timelineEmitter.epoch, limit });
  if (events.length === 0) {
    events = timelineStore.read(sessionName, { limit });
  }

  try {
    serverLink.send({
      type: 'timeline.history',
      sessionName,
      requestId,
      events,
      epoch: timelineEmitter.epoch,
    });
  } catch { /* not connected */ }
}
