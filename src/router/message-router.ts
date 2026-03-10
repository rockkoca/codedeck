/**
 * Route normalized InboundMessages (received from CF Worker via WebSocket) to the correct
 * session based on channel bindings. Manages channel binding state and checks team permissions.
 */
import { parseCommand, fromPlatformCommand } from './command-parser.js';
import type { ParseResult } from './command-parser.js';
import { getSession, listSessions } from '../store/session-store.js';
import logger from '../util/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InboundMessage {
  platform: string;
  channelId: string;
  userId: string;
  content: string;
  messageId?: string;
  isCommand: boolean;
  command?: string;
  args?: string[];
  raw: unknown;
}

export interface ChannelBinding {
  platform: string;
  channelId: string;
  projectName: string;
  boundBy: string;  // userId who bound this channel
  boundAt: number;
  teamId?: string;  // team that owns this binding; all team members can interact
  allowedUserIds?: string[]; // if set, only these users can send messages
}

export type OutboundSender = (channelId: string, platform: string, content: string, replyToId?: string) => Promise<void>;

// ── In-memory binding store (persisted via CF Worker D1 — this is daemon-side cache) ─────

const bindings = new Map<string, ChannelBinding>();

function bindingKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

export function bindChannel(
  platform: string,
  channelId: string,
  projectName: string,
  userId: string,
  opts?: { teamId?: string; allowedUserIds?: string[] },
): void {
  const key = bindingKey(platform, channelId);
  bindings.set(key, {
    platform, channelId, projectName, boundBy: userId, boundAt: Date.now(),
    teamId: opts?.teamId,
    allowedUserIds: opts?.allowedUserIds,
  });
  logger.info({ platform, channelId, projectName, teamId: opts?.teamId }, 'Channel bound to project');
}

export function unbindChannel(platform: string, channelId: string): void {
  const key = bindingKey(platform, channelId);
  bindings.delete(key);
  logger.info({ platform, channelId }, 'Channel unbound');
}

export function getBinding(platform: string, channelId: string): ChannelBinding | undefined {
  return bindings.get(bindingKey(platform, channelId));
}

export function getAllBindings(): ChannelBinding[] {
  return Array.from(bindings.values());
}

// ── Routing ───────────────────────────────────────────────────────────────────

export interface RouterContext {
  sendOutbound: OutboundSender;
  sendToSession: (sessionName: string, text: string) => Promise<void>;
}

export async function routeMessage(msg: InboundMessage, ctx: RouterContext): Promise<void> {
  logger.debug({ platform: msg.platform, channelId: msg.channelId, userId: msg.userId }, 'Routing inbound message');

  // Parse the command
  let parsed: ParseResult;
  if (msg.isCommand && msg.command) {
    parsed = fromPlatformCommand(msg.command, msg.args ?? [], msg.content);
  } else {
    parsed = parseCommand(msg.content);
  }

  // Handle bind command (no binding required for this one)
  if (parsed.isCommand && parsed.command?.name === 'bind') {
    await handleBind(msg, parsed.command.args, ctx);
    return;
  }

  // Handle help command (always available)
  if (parsed.isCommand && parsed.command?.name === 'help') {
    await ctx.sendOutbound(msg.channelId, msg.platform, buildHelpText());
    return;
  }

  // All other commands require a channel binding
  const binding = getBinding(msg.platform, msg.channelId);
  if (!binding) {
    if (parsed.isCommand) {
      await ctx.sendOutbound(
        msg.channelId,
        msg.platform,
        'This channel is not bound to a project. Use /bind <project-name> to get started.',
      );
    }
    // Non-command messages with no binding are silently dropped
    return;
  }

  // Check team-scoped access: if binding has allowedUserIds, verify membership
  if (binding.allowedUserIds && !binding.allowedUserIds.includes(msg.userId)) {
    logger.debug({ userId: msg.userId, channelId: msg.channelId }, 'Access denied: not in allowed team members');
    return; // silently drop — team membership check happens server-side
  }

  if (parsed.isCommand && parsed.command) {
    await handleCommand(msg, parsed.command, binding, ctx);
  } else {
    // Plain text → send to brain session
    await forwardToBrain(msg, binding, ctx);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleBind(
  msg: InboundMessage,
  args: string[],
  ctx: RouterContext,
): Promise<void> {
  if (args.length === 0) {
    await ctx.sendOutbound(msg.channelId, msg.platform, 'Usage: /bind <project-name>');
    return;
  }

  const projectName = args[0];
  const sessions = listSessions();
  const brainSession = sessions.find(
    (s) => s.project === projectName && s.role === 'brain',
  );

  if (!brainSession) {
    await ctx.sendOutbound(
      msg.channelId,
      msg.platform,
      `Project "${projectName}" has no active brain session. Start it first with: chat-cli project start ${projectName}`,
    );
    return;
  }

  bindChannel(msg.platform, msg.channelId, projectName, msg.userId);
  await ctx.sendOutbound(
    msg.channelId,
    msg.platform,
    `Channel bound to project "${projectName}". Send messages here to interact with the brain.`,
  );
}

async function handleCommand(
  msg: InboundMessage,
  command: NonNullable<ParseResult['command']>,
  binding: ChannelBinding,
  ctx: RouterContext,
): Promise<void> {
  const { projectName } = binding;
  const brainSessionName = `rcc_${projectName}_brain`;

  switch (command.name) {
    case 'status': {
      const sessions = listSessions();
      const projectSessions = sessions.filter((s) => s.project === projectName);
      if (projectSessions.length === 0) {
        await ctx.sendOutbound(msg.channelId, msg.platform, `No sessions for project "${projectName}"`);
        return;
      }
      const lines = projectSessions.map(
        (s) => `${s.name}: ${s.state} (${s.agentType})`,
      );
      await ctx.sendOutbound(msg.channelId, msg.platform, lines.join('\n'));
      return;
    }

    case 'list': {
      const sessions = listSessions();
      const names = sessions.map((s) => `${s.project}/${s.role} [${s.state}]`).join('\n');
      await ctx.sendOutbound(msg.channelId, msg.platform, names || 'No active sessions');
      return;
    }

    case 'stop': {
      await ctx.sendToSession(brainSessionName, '@stop');
      await ctx.sendOutbound(msg.channelId, msg.platform, `Stop signal sent to project "${projectName}"`);
      return;
    }

    case 'screen': {
      const sessionName = command.args[0]
        ? `rcc_${projectName}_${command.args[0]}`
        : brainSessionName;
      const session = getSession(sessionName);
      if (!session) {
        await ctx.sendOutbound(msg.channelId, msg.platform, `Session "${sessionName}" not found`);
        return;
      }
      // The response-collector will capture screen and send it; just request it
      await ctx.sendToSession(brainSessionName, `@screen ${sessionName}`);
      return;
    }

    case 'send': {
      if (command.rawArgs) {
        await forwardTextToBrain(brainSessionName, command.rawArgs, ctx);
        await ctx.sendOutbound(msg.channelId, msg.platform, 'Message sent to brain.');
      } else {
        await ctx.sendOutbound(msg.channelId, msg.platform, 'Usage: /send <message>');
      }
      return;
    }

    case 'team': {
      const sub = command.args[0]?.toLowerCase();
      const teamHelpText = [
        '**Team commands:**',
        '/team create <name> — Create a new team',
        '/team invite — Generate an invite link (must be admin/owner)',
        '/team members — List team members',
        '/team role <userId> <role> — Change member role',
        '/team remove <userId> — Remove a member',
        '/team delete — Delete the team (owner only)',
        '',
        'Team management is available at the web UI or via the REST API.',
      ].join('\n');

      if (!sub || sub === 'help') {
        await ctx.sendOutbound(msg.channelId, msg.platform, teamHelpText);
      } else {
        // Forward team management commands to brain as structured request
        const teamCommand = `/team ${command.rawArgs}`;
        await forwardTextToBrain(brainSessionName, teamCommand, ctx);
        await ctx.sendOutbound(
          msg.channelId,
          msg.platform,
          `Team command forwarded to brain: \`${teamCommand}\`. Check the web UI for results.`,
        );
      }
      return;
    }

    case 'help': {
      await ctx.sendOutbound(msg.channelId, msg.platform, buildHelpText());
      return;
    }

    default:
      // Forward unknown/unhandled commands as plain text to brain
      await forwardToBrain(msg, binding, ctx);
  }
}

async function forwardToBrain(
  msg: InboundMessage,
  binding: ChannelBinding,
  ctx: RouterContext,
): Promise<void> {
  const brainSessionName = `rcc_${binding.projectName}_brain`;
  await forwardTextToBrain(brainSessionName, msg.content, ctx);
}

async function forwardTextToBrain(
  brainSessionName: string,
  text: string,
  ctx: RouterContext,
): Promise<void> {
  try {
    await ctx.sendToSession(brainSessionName, text);
  } catch (err) {
    logger.error({ brainSessionName, err }, 'Failed to forward text to brain session');
  }
}

function buildHelpText(): string {
  return [
    '**Available commands:**',
    '/bind <project> — Bind this channel to a project',
    '/status — Show project session status',
    '/list — List all active sessions',
    '/send <message> — Send message to brain',
    '/screen [session] — Get current screen output',
    '/stop — Send stop signal to brain',
    '/team [subcommand] — Team management (create/invite/members/role/remove)',
    '/cron — Cron job management',
    '/autofix — Run the auto-fix pipeline',
    '/help — Show this help',
  ].join('\n');
}
