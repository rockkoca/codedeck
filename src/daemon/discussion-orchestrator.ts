/**
 * Multi-agent discussion orchestrator.
 * Manages 2-3 agent sub-sessions in a structured multi-round discussion with a final verdict.
 */

import { sessionExists, sendKeys } from '../agent/tmux.js';
import { startSubSession, stopSubSession, readSubSessionResponse } from './subsession-manager.js';
import { writeFile, readFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import logger from '../util/logger.js';
import type { AgentType } from '../agent/detect.js';

const DISCUSS_DIR = path.join(tmpdir(), 'codedeck-discuss');
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
    label: '批判者',
    prompt:
      '你是严格的批判者。专注于发现方案中的漏洞、风险和不合理之处。对每个观点提出质疑，不轻易认同。如果发现安全隐患、性能问题或架构缺陷，务必指出。',
  },
  pragmatist: {
    label: '实用主义者',
    prompt:
      '你是务实的工程师。关注方案的可行性、实现成本和时间线。评估技术选型是否成熟、团队是否有能力执行、是否有更简单的替代方案。避免过度设计。',
  },
  innovator: {
    label: '创新者',
    prompt:
      '你是富有创意的思考者。从不同角度审视问题，提出非常规的解决思路。关注用户体验、长期演进和技术趋势。挑战现有假设，但建议必须可落地。',
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
  fileContent: string,
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
      'Discussion topic and context:',
      '',
      '---',
      fileContent,
      '---',
      '',
      'Give your perspective based on your role. Be specific, constructive, under 500 words.',
    ].join('\n');
  }

  return [
    `Multi-agent discussion, round ${round}/${maxRounds}.`,
    '',
    roleBlock,
    '',
    'Full discussion so far:',
    '',
    '---',
    fileContent,
    '---',
    '',
    'Respond to previous participants:',
    '- What do you agree/disagree with and why?',
    '- New insights or concerns?',
    'Under 500 words.',
  ].join('\n');
}

function buildVerdictPrompt(fileContent: string, judge: DiscussionParticipant): string {
  return [
    'You are the final arbiter of this multi-agent discussion.',
    `Your perspective: ${judge.roleLabel} — ${judge.rolePrompt}`,
    '',
    'Full discussion transcript:',
    '',
    '---',
    fileContent,
    '---',
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

      const fileContent = await readFile(d.filePath, 'utf8');
      const prompt = buildRoundPrompt(fileContent, participant, round, d.maxRounds);

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

  const fileContent = await readFile(d.filePath, 'utf8');
  const verdictPrompt = buildVerdictPrompt(fileContent, judge);

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
  await mkdir(DISCUSS_DIR, { recursive: true });

  const filePath = path.join(DISCUSS_DIR, `${opts.id}.md`);
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

  await writeFile(filePath, buildFileHeader(discussion), 'utf8');

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
