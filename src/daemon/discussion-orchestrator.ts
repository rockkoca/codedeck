/**
 * Multi-agent discussion orchestrator.
 * Manages 2-3 agent sub-sessions in a structured multi-round discussion with a final verdict.
 */

import { sessionExists, sendKeys } from '../agent/tmux.js';
import { startSubSession, stopSubSession, readSubSessionResponse } from './subsession-manager.js';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import logger from '../util/logger.js';
import type { AgentType } from '../agent/detect.js';

const IDLE_TIMEOUT = 120_000;
const IDLE_POLL_INTERVAL = 3_000;

// Model strength ranking (for auto-selecting the verdict participant)
const MODEL_STRENGTH: Record<string, number> = {
  opus: 100,
  sonnet: 80,
  codex: 50,
  gemini: 50,
};

const BUILTIN_ROLES: Record<string, { label: string; prompt: string }> = {
  critic: {
    label: 'Critic',
    prompt:
      'You are a rigorous critic. Focus on finding flaws, risks, and inconsistencies in the proposal. Challenge every point and do not agree easily. If you spot security vulnerabilities, performance issues, or architectural defects, call them out.',
  },
  pragmatist: {
    label: 'Pragmatist',
    prompt:
      'You are a pragmatic engineer. Focus on feasibility, implementation cost, and timeline. Evaluate whether the technology choices are mature, whether the team can execute, and whether simpler alternatives exist. Avoid over-engineering.',
  },
  innovator: {
    label: 'Innovator',
    prompt:
      'You are a creative thinker. Examine problems from different angles and propose unconventional solutions. Focus on user experience, long-term evolution, and technology trends. Challenge existing assumptions, but keep suggestions actionable.',
  },
};

// ── Types ─────────────────────────────────────────────────────────────────

type DiscussionState = 'setup' | 'running' | 'verdict' | 'done' | 'failed';

interface DiscussionParticipant {
  subSessionId: string;
  sessionName: string;
  agentType: AgentType;
  model?: string;
  roleId: string;
  roleLabel: string;
  rolePrompt: string;
  reused: boolean;
}

interface Discussion {
  id: string;
  serverId: string;
  topic: string;
  cwd: string;
  state: DiscussionState;
  participants: DiscussionParticipant[];
  currentRound: number;
  maxRounds: number;
  filePath: string;
  currentSpeakerIdx: number;
  verdictParticipantIdx: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

// ── State ──────────────────────────────────────────────────────────────────

const discussions = new Map<string, Discussion>();

// ── Helpers ────────────────────────────────────────────────────────────────

function participantStrength(p: DiscussionParticipant): number {
  if (p.model) return MODEL_STRENGTH[p.model] ?? 40;
  if (p.agentType === 'claude-code') return 80; // default sonnet
  return 40;
}

function buildFileHeader(d: Discussion): string {
  const lines = [`# Discussion: ${d.topic}\n`];
  lines.push(`Started: ${new Date(d.startedAt).toISOString()}`);
  lines.push(`Max Rounds: ${d.maxRounds}\n`);
  lines.push('Participants:');
  for (const p of d.participants) {
    const modelTag = p.model ? ` / ${p.model}` : '';
    lines.push(`- ${p.roleLabel} (${p.agentType}${modelTag})`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildRoundPrompt(
  discussionFilePath: string,
  participant: DiscussionParticipant,
  round: number,
  maxRounds: number,
): string {
  const roleBlock = [`Your role: ${participant.roleLabel}`, participant.rolePrompt].join('\n');

  if (round === 1) {
    return [
      `You are participating in a multi-agent discussion. Round ${round}/${maxRounds}.`,
      '',
      roleBlock,
      '',
      `Read the discussion file at: ${discussionFilePath}`,
      'It contains the topic and context for this discussion.',
      '',
      'Give your perspective based on your role. Be specific, constructive, under 500 words.',
    ].join('\n');
  }

  return [
    `Multi-agent discussion, round ${round}/${maxRounds}.`,
    '',
    roleBlock,
    '',
    `Read the full discussion so far at: ${discussionFilePath}`,
    '',
    'Respond to previous participants:',
    '- What do you agree/disagree with and why?',
    '- New insights or concerns?',
    'Under 500 words.',
  ].join('\n');
}

function buildVerdictPrompt(discussionFilePath: string, judge: DiscussionParticipant): string {
  return [
    'You are the final arbiter of this multi-agent discussion.',
    `Your perspective: ${judge.roleLabel} — ${judge.rolePrompt}`,
    '',
    `Read the full discussion transcript at: ${discussionFilePath}`,
    '',
    'Deliver a final verdict:',
    '1. Summarize the key points of agreement and disagreement',
    '2. Evaluate the strongest arguments from each participant',
    '3. Make a clear, actionable final decision or recommendation',
    '',
    'Be decisive. This is the final word.',
  ].join('\n');
}

async function waitForIdle(sessionName: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await readSubSessionResponse(sessionName).catch(() => ({ status: 'working' as const }));
    if (result.status === 'idle') return;
    await new Promise<void>((r) => setTimeout(r, IDLE_POLL_INTERVAL));
  }
  throw new Error(`Timed out waiting for ${sessionName} to become idle`);
}

async function waitAllReady(d: Discussion, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (const p of d.participants) {
    while (Date.now() - start < timeoutMs) {
      if (await sessionExists(p.sessionName)) break;
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
    if (!await sessionExists(p.sessionName)) {
      throw new Error(`Timed out waiting for ${p.sessionName} to start`);
    }
  }
}

// ── Title generation ──────────────────────────────────────────────────────

async function generateTitle(sessionName: string, topic: string): Promise<string> {
  const prompt = [
    'Generate a short filename title (max 20 characters) for a discussion document.',
    'Use the SAME LANGUAGE as the topic below. Output ONLY the title text, nothing else.',
    'No quotes, no file extension, no explanation.',
    '',
    `Topic: ${topic}`,
  ].join('\n');

  await sendKeys(sessionName, prompt);
  await waitForIdle(sessionName, 30_000);

  const result = await readSubSessionResponse(sessionName);
  const raw = (result.response ?? '').trim().split('\n')[0]; // first line only

  const cleaned = raw
    .replace(/['""`「」『』]/g, '')
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 20)
    .replace(/-$/g, '')
    .trim();

  return cleaned || topic.slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, '-');
}

// ── Discussion runner ──────────────────────────────────────────────────────

async function runDiscussion(
  d: Discussion,
  onUpdate: (msg: Record<string, unknown>) => void,
): Promise<void> {
  // 1. Prepare sub-sessions for each participant
  for (const p of d.participants) {
    if (p.reused) {
      logger.info({ sessionName: p.sessionName }, 'Reusing existing sub-session for discussion');
    } else {
      await startSubSession({
        id: p.subSessionId,
        type: p.agentType,
        cwd: d.cwd || null,
        ccSessionId: p.agentType === 'claude-code' ? crypto.randomUUID() : null,
        codexModel: p.agentType === 'codex' && p.model ? p.model : null,
      });
    }
  }

  await waitAllReady(d, 60_000);

  // Switch CC model if specified
  for (const p of d.participants) {
    if (p.agentType === 'claude-code' && p.model) {
      await sendKeys(p.sessionName, `/model ${p.model}`);
      await waitForIdle(p.sessionName, 15_000).catch(() => {
        logger.warn({ sessionName: p.sessionName, model: p.model }, 'Model switch idle timeout, continuing anyway');
      });
      logger.info({ sessionName: p.sessionName, model: p.model }, 'Switched CC model');
    }
  }

  // 2. Generate semantic title via LLM, then create discussion file
  const titleAgent = d.participants[d.verdictParticipantIdx];
  const title = await generateTitle(titleAgent.sessionName, d.topic);
  const planDir = path.join(d.cwd, 'docs', 'plan');
  await mkdir(planDir, { recursive: true });
  d.filePath = path.join(planDir, `${title}.md`);
  await writeFile(d.filePath, buildFileHeader(d), 'utf8');
  logger.info({ discussionId: d.id, filePath: d.filePath, title }, 'Discussion file created');

  d.state = 'running';

  const isStopped = () => (d.state as string) === 'failed';

  // 2. Multi-round discussion
  for (let round = 1; round <= d.maxRounds; round++) {
    if (isStopped()) return;
    d.currentRound = round;

    await appendFile(d.filePath, `\n---\n\n## Round ${round}\n`);

    for (let i = 0; i < d.participants.length; i++) {
      if (isStopped()) return;
      const participant = d.participants[i];
      d.currentSpeakerIdx = i;
      d.updatedAt = Date.now();

      onUpdate({
        type: 'discussion.update',
        discussionId: d.id,
        state: d.state,
        currentRound: round,
        maxRounds: d.maxRounds,
        currentSpeaker: participant.roleLabel,
      });

      const prompt = buildRoundPrompt(d.filePath, participant, round, d.maxRounds);

      await sendKeys(participant.sessionName, prompt);
      await waitForIdle(participant.sessionName, IDLE_TIMEOUT);

      const result = await readSubSessionResponse(participant.sessionName);
      const response = result.response ?? '(no response)';

      const modelTag = participant.model ? ` / ${participant.model}` : '';
      await appendFile(
        d.filePath,
        `\n### ${participant.roleLabel} (${participant.agentType}${modelTag})\n\n${response}\n`,
      );

      onUpdate({
        type: 'discussion.update',
        discussionId: d.id,
        state: d.state,
        currentRound: round,
        maxRounds: d.maxRounds,
        currentSpeaker: participant.roleLabel,
        lastResponse: response.slice(0, 200),
      });
    }
  }

  // 3. Verdict
  d.state = 'verdict';
  const judge = d.participants[d.verdictParticipantIdx];
  const modelTag = judge.model ? ` / ${judge.model}` : '';

  await appendFile(d.filePath, `\n---\n\n## Verdict (by ${judge.roleLabel}${modelTag})\n`);

  const verdictPrompt = buildVerdictPrompt(d.filePath, judge);

  await sendKeys(judge.sessionName, verdictPrompt);
  await waitForIdle(judge.sessionName, IDLE_TIMEOUT);

  const verdictResult = await readSubSessionResponse(judge.sessionName);
  const verdict = verdictResult.response ?? '(no verdict)';

  await appendFile(d.filePath, `\n${verdict}\n`);

  // 4. Done
  d.state = 'done';
  d.updatedAt = Date.now();

  onUpdate({
    type: 'discussion.done',
    discussionId: d.id,
    filePath: d.filePath,
    conclusion: verdict.slice(0, 500),
  });

  // Only clean up newly created sessions; reused ones stay
  for (const p of d.participants) {
    if (!p.reused) {
      await stopSubSession(p.sessionName).catch(() => {});
    }
  }

  logger.info({ discussionId: d.id, rounds: d.maxRounds }, 'Discussion completed');
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startDiscussion(
  opts: {
    id: string;
    serverId: string;
    topic: string;
    cwd: string;
    participants: Array<{
      agentType: string;
      model?: string;
      roleId: string;
      roleLabel?: string;
      rolePrompt?: string;
      sessionName?: string;
    }>;
    maxRounds?: number;
    verdictIdx?: number;
  },
  onUpdate: (msg: Record<string, unknown>) => void,
): Promise<Discussion> {
  // filePath is set later in runDiscussion after LLM generates the title
  const filePath = '';
  const participants: DiscussionParticipant[] = opts.participants.map((p, i) => {
    const reused = !!p.sessionName;
    const subId = reused
      ? p.sessionName!.replace('deck_sub_', '')
      : `discuss_${opts.id.slice(0, 6)}_${i}`;
    const builtin = BUILTIN_ROLES[p.roleId];
    return {
      subSessionId: subId,
      sessionName: reused ? p.sessionName! : `deck_sub_${subId}`,
      agentType: p.agentType as AgentType,
      model: p.model,
      roleId: p.roleId,
      roleLabel: p.roleLabel ?? builtin?.label ?? p.roleId,
      rolePrompt: p.rolePrompt ?? builtin?.prompt ?? `You are: ${p.roleId}`,
      reused,
    };
  });

  // Auto-select verdict participant: user-specified > strongest model
  let verdictIdx = opts.verdictIdx ?? -1;
  if (verdictIdx < 0 || verdictIdx >= participants.length) {
    verdictIdx = 0;
    let maxStrength = 0;
    participants.forEach((p, i) => {
      const s = participantStrength(p);
      if (s > maxStrength) {
        maxStrength = s;
        verdictIdx = i;
      }
    });
  }

  const discussion: Discussion = {
    id: opts.id,
    serverId: opts.serverId,
    topic: opts.topic,
    cwd: opts.cwd,
    state: 'setup',
    participants,
    currentRound: 0,
    maxRounds: opts.maxRounds ?? 3,
    filePath,
    currentSpeakerIdx: 0,
    verdictParticipantIdx: verdictIdx,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  discussions.set(opts.id, discussion);

  void runDiscussion(discussion, onUpdate).catch((e) => {
    discussion.state = 'failed';
    discussion.error = e instanceof Error ? e.message : String(e);
    onUpdate({ type: 'discussion.error', discussionId: discussion.id, error: discussion.error });
    logger.error({ err: e, discussionId: discussion.id }, 'Discussion failed');
  });

  return discussion;
}

export function getDiscussion(id: string): Discussion | undefined {
  return discussions.get(id);
}

export async function stopDiscussion(id: string): Promise<void> {
  const d = discussions.get(id);
  if (!d) return;
  d.state = 'failed';
  d.error = 'stopped by user';
  for (const p of d.participants) {
    await stopSubSession(p.sessionName).catch(() => {});
  }
  discussions.delete(id);
}
