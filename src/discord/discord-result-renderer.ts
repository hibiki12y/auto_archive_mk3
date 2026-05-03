import type { VetoPath } from '../contracts/veto.js';
import {
  buildDoctorReport,
  renderDoctorReport,
  type DoctorReportInput,
} from '../core/doctor.js';
import type { InsightSnapshot } from '../runtime/insights-engine.js';
// WU-V Phase 6: `deriveOutcomeFromCause` is the canonical helper for
// producing human-facing outcome labels from a `TerminalCause`. The
// Discord renderer uses it to preserve the exact UX-stable label
// strings (success / failure / timeout / operator-cancel / abort)
// that users see today.
import { deriveOutcomeFromCause } from '../core/derive-outcome.js';
import type { CancellationReceipt } from '../core/dispatcher.js';
import type { ControlPlaneEvent } from '../control/control-plane-ledger.js';
import type { DiscordTaskRecord } from './discord-task-registry.js';
import type { DiscordAccessDecision } from './discord-access-policy.js';
import type {
  ResearchAgendaItem,
  ResearchCadenceRecord,
  ResearchAgendaStatus,
} from './discord-research-agenda.js';
import type { SubagentOperatorResult } from '../runtime/subagent-operator.js';
import type {
  BindingMutationResult,
  DiscordSessionBindingRecord,
} from './discord-session-binding.js';

export interface DiscordMessagePayload {
  content: string;
}

export const DISCORD_MESSAGE_LIMIT = 2000;

export type DiscordDoctorStatus = Partial<
  Pick<
    DoctorReportInput,
    | 'runtimeProviderScope'
    | 'activeRuntimeProvider'
    | 'computeMode'
    | 'modelOverride'
    | 'messageContentIntent'
    | 'anthropicAuthSource'
    | 'anthropicCliPath'
    | 'claudeModelOverride'
    | 'planaAdvisorProvider'
    | 'planaAdvisorModel'
    | 'planaAdvisorMaxCalls'
  >
>;

type SentenceSegment = {
  readonly segment: string;
};

type SentenceSegmenter = {
  segment(input: string): Iterable<SentenceSegment>;
};

type SentenceSegmenterConstructor = new (
  locale: string,
  options: { granularity: 'sentence' },
) => SentenceSegmenter;

const SENTENCE_BOUNDARY_FALLBACK =
  /[^.!?。？！\n]+[.!?。？！]+(?:["'”’)\]]+)?\s*|[^.!?。？！\n]+(?:\s+|$)/gu;

function getSentenceSegmenter(): SentenceSegmenter | undefined {
  const segmenter = (
    Intl as typeof Intl & {
      Segmenter?: SentenceSegmenterConstructor;
    }
  ).Segmenter;
  return segmenter === undefined
    ? undefined
    : new segmenter('ko', { granularity: 'sentence' });
}

function splitSentences(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }

  const segmenter = getSentenceSegmenter();
  if (segmenter !== undefined) {
    return [...segmenter.segment(text)].map((entry) => entry.segment);
  }

  const segments = [...text.matchAll(SENTENCE_BOUNDARY_FALLBACK)].map(
    (match) => match[0],
  );
  return segments.length === 0 ? [text] : segments;
}

function splitByNewlineThenSentence(content: string): readonly string[] {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/\n+/gu)) {
    const index = match.index;
    if (index > cursor) {
      parts.push(...splitSentences(content.slice(cursor, index)));
    }
    parts.push(match[0]);
    cursor = index + match[0].length;
  }
  if (cursor < content.length) {
    parts.push(...splitSentences(content.slice(cursor)));
  }
  return parts.filter((part) => part.length > 0);
}

function hardSplitContent(content: string, limit: number): readonly string[] {
  const chunks: string[] = [];
  for (let cursor = 0; cursor < content.length; cursor += limit) {
    chunks.push(content.slice(cursor, cursor + limit));
  }
  return chunks;
}

export function chunkDiscordContentBySentence(
  content: string,
  limit = DISCORD_MESSAGE_LIMIT,
): readonly string[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('Discord message chunk limit must be a positive integer.');
  }

  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  let current = '';

  const flushCurrent = (): void => {
    const trimmed = current.trimEnd();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
    current = '';
  };

  for (const rawPart of splitByNewlineThenSentence(content)) {
    const part = current.length === 0 ? rawPart.trimStart() : rawPart;
    if (part.length === 0) {
      continue;
    }

    if (part.length > limit) {
      flushCurrent();
      chunks.push(...hardSplitContent(part, limit));
      continue;
    }

    if (current.length + part.length > limit) {
      flushCurrent();
      current = part.trimStart();
      continue;
    }

    current += part;
  }

  flushCurrent();
  return chunks.length === 0 ? [''] : chunks;
}

export function splitDiscordMessagePayload(
  payload: DiscordMessagePayload,
  limit = DISCORD_MESSAGE_LIMIT,
): readonly DiscordMessagePayload[] {
  return chunkDiscordContentBySentence(payload.content, limit).map((content) => ({
    content,
  }));
}

function buildMessage(lines: string[]): DiscordMessagePayload {
  return {
    content: lines.filter((line) => line.length > 0).join('\n'),
  };
}

export function renderAskVeto(taskId: string, veto: VetoPath): DiscordMessagePayload {
  return buildMessage([
    `Dispatch vetoed for task \`${taskId}\`.`,
    `Reason: ${veto.reason}`,
    `Provenance: ${veto.provenance}`,
  ]);
}

export function renderAskAccepted(record: DiscordTaskRecord): DiscordMessagePayload {
  return buildMessage([
    `Accepted task \`${record.taskId}\`.`,
    `Status: ${record.coarseState}`,
    `Use \`/status task_id:${record.taskId}\` to check progress.`,
  ]);
}

export function renderRunningUpdate(record: DiscordTaskRecord): DiscordMessagePayload {
  return buildMessage([
    `Task \`${record.taskId}\` is running.`,
    `Lifecycle: ${record.lastLifecyclePhase}`,
  ]);
}


function renderTerminalCauseDiagnosticLines(
  cause: NonNullable<DiscordTaskRecord['terminalEvidence']>['cause'],
): readonly string[] {
  if (cause.kind === 'driver-failure') {
    return [
      `Driver phase: ${cause.phase}`,
      `Driver message: ${cause.message}`,
    ];
  }
  if (cause.kind === 'provider-failure') {
    return [
      `Provider failure: ${cause.provider}/${cause.classification}`,
    ];
  }
  return [];
}

export function renderTerminalResult(record: DiscordTaskRecord): DiscordMessagePayload {
  const evidence = record.terminalEvidence;
  if (!evidence) {
    return buildMessage([
      `Task \`${record.taskId}\` is terminal.`,
      'Terminal evidence is not available yet.',
    ]);
  }

  return buildMessage([
    `Task \`${record.taskId}\` finished with \`${deriveOutcomeFromCause(evidence.cause)}\`.`,
    `Reason: ${evidence.reason}`,
    `Provenance: ${evidence.provenance}`,
    ...renderTerminalCauseDiagnosticLines(evidence.cause),
    evidence.artifactLocation
      ? `Artifact: ${evidence.artifactLocation}`
      : 'Artifact: none',
  ]);
}

export function renderStatus(record: DiscordTaskRecord): DiscordMessagePayload {
  if (record.coarseState === 'terminal') {
    return buildMessage([
      renderTerminalResult(record).content,
      `Command: ${record.commandName ?? 'ask'}`,
      renderProgressHint(record),
    ]);
  }

  return buildMessage([
    `Task \`${record.taskId}\` status: ${record.coarseState}.`,
    `Command: ${record.commandName ?? 'ask'}`,
    `Lifecycle: ${record.lastLifecyclePhase}`,
    renderProgressHint(record),
  ]);
}

export function renderUnknownTask(taskId: string): DiscordMessagePayload {
  return buildMessage([`Task \`${taskId}\` is not tracked by the Discord adapter.`]);
}

export function renderTaskList(records: readonly DiscordTaskRecord[]): DiscordMessagePayload {
  if (records.length === 0) {
    return buildMessage(['No visible Discord tasks match that query.']);
  }
  return buildMessage([
    `Tasks (${records.length})`,
    ...records.map(
      (record) =>
        `- \`${record.taskId}\` [${record.commandName ?? 'ask'}] ${record.coarseState} · ${record.lastLifecyclePhase} · updated ${record.updatedAt}`,
    ),
  ]);
}

export function renderSubagentOperatorResult(
  result: SubagentOperatorResult,
): DiscordMessagePayload {
  if (result.status === 'ok') {
    return buildMessage([
      'Subagents',
      result.message.length > 1_800
        ? `${result.message.slice(0, 1_800)}\n[truncated]`
        : result.message,
    ]);
  }
  return buildMessage([
    'Subagent operator request was not applied.',
    `Status: ${result.status}`,
    `Reason: ${result.reason}`,
  ]);
}

export function renderSubagentOperatorUnavailable(): DiscordMessagePayload {
  return buildMessage([
    'Subagent operator surface is not configured for this service instance.',
  ]);
}

export function renderFocusCreated(
  binding: DiscordSessionBindingRecord,
): DiscordMessagePayload {
  return buildMessage([
    `Focused task \`${binding.taskId}\` for this channel/thread.`,
    binding.subagentId === undefined ? '' : `Subagent: \`${binding.subagentId}\``,
    `Binding: \`${binding.bindingId}\``,
    `Expires: ${binding.expiresAt}`,
  ]);
}

export function renderFocusReleased(
  result: BindingMutationResult,
): DiscordMessagePayload {
  if (result.status === 'ok') {
    return buildMessage([
      `Focus released for task \`${result.binding.taskId}\`.`,
      `Binding: \`${result.binding.bindingId}\``,
    ]);
  }
  return buildMessage([
    'Focus was not released.',
    `Status: ${result.status}`,
    `Reason: ${result.reason}`,
  ]);
}

export function renderResearchAgendaList(input: {
  readonly items: readonly ResearchAgendaItem[];
  readonly status: ResearchAgendaStatus | 'all';
  readonly cadence?: ResearchCadenceRecord;
}): DiscordMessagePayload {
  const cadenceLine =
    input.cadence === undefined
      ? 'Cadence: not set'
      : `Cadence: ${input.cadence.cadence} · updated ${input.cadence.updatedAt}`;
  if (input.items.length === 0) {
    return buildMessage([
      `Research agenda (${input.status})`,
      cadenceLine,
      'No research agenda items match that query.',
    ]);
  }
  return buildMessage([
    `Research agenda (${input.status}, ${input.items.length})`,
    cadenceLine,
    ...input.items.map(
      (item) =>
        `- \`${item.agendaId}\` [${item.status}] ${item.title} · updated ${item.updatedAt}`,
    ),
  ]);
}

export function renderResearchAgendaMutation(input: {
  readonly action: 'added' | 'completed';
  readonly item: ResearchAgendaItem;
}): DiscordMessagePayload {
  return buildMessage([
    `Research agenda item ${input.action}: \`${input.item.agendaId}\`.`,
    `Status: ${input.item.status}`,
    `Title: ${input.item.title}`,
  ]);
}

export function renderUnknownResearchAgendaItem(
  agendaId: string,
): DiscordMessagePayload {
  return buildMessage([
    `Research agenda item \`${agendaId}\` is not tracked by the Discord adapter.`,
  ]);
}

export function renderResearchCadence(
  cadence: ResearchCadenceRecord,
): DiscordMessagePayload {
  return buildMessage([
    `Research cadence set for conversation \`${cadence.conversationId}\`.`,
    `Cadence: ${cadence.cadence}`,
    `Updated: ${cadence.updatedAt}`,
  ]);
}

function renderProgressHint(record: DiscordTaskRecord): string {
  const commandName = record.commandName ?? 'ask';
  if (commandName === 'research') {
    switch (record.coarseState) {
      case 'accepted':
        return 'Research progress: accepted; next step is runtime start and evidence gathering.';
      case 'running':
        return 'Research progress: running; next step is synthesis, artifact capture, or user steering.';
      case 'terminal':
        return 'Research progress: terminal; next step is review `/context` and `/history` for follow-up planning.';
    }
  }

  switch (record.coarseState) {
    case 'accepted':
      return 'Task progress: accepted; waiting for runtime start.';
    case 'running':
      return 'Task progress: running; wait for terminal evidence or request cancellation if needed.';
    case 'terminal':
      return 'Task progress: terminal; inspect the result or artifact path.';
  }
}

export function renderHistory(events: readonly ControlPlaneEvent[]): DiscordMessagePayload {
  if (events.length === 0) {
    return buildMessage(['No control-plane history matched that query.']);
  }
  return buildMessage([
    `History (${events.length})`,
    ...events.map((event) => {
      const task = event.taskId === undefined ? '' : ` task=${event.taskId}`;
      const channel =
        event.channel?.channelId === undefined
          ? ''
          : ` channel=${event.channel.channelId}`;
      return `- ${event.timestamp} ${event.type}${task}${channel}`;
    }),
  ]);
}

export function renderContextSummary(record: DiscordTaskRecord): DiscordMessagePayload {
  const hasEnvelope = record.instruction.includes('[Discord instruction envelope]');
  const contextLines = record.instruction
    .split('\n')
    .filter((line) => line.includes('UNTRUSTED ') || line.includes('[Current task instruction]'));
  return buildMessage([
    `Context for task \`${record.taskId}\``,
    hasEnvelope
      ? 'Instruction envelope: present; context history is marked UNTRUSTED.'
      : 'Instruction envelope: not present; legacy instruction shape.',
    ...contextLines.slice(0, 12),
  ]);
}

export function renderAccessDenied(
  action: string,
  decision: Exclude<DiscordAccessDecision, { status: 'allowed' }>,
): DiscordMessagePayload {
  return buildMessage([
    `Discord request denied for \`${action}\`.`,
    `Reason: ${decision.reason}`,
  ]);
}

export function renderApprovalResolved(input: {
  readonly approvalId: string;
  readonly decision: 'approved' | 'denied';
  readonly note?: string;
}): DiscordMessagePayload {
  return buildMessage([
    `Approval \`${input.approvalId}\` ${input.decision}.`,
    input.note === undefined || input.note.trim().length === 0
      ? ''
      : `Note: ${input.note.trim()}`,
  ]);
}

export function renderApprovalResolutionFailed(input: {
  readonly approvalId: string;
  readonly status: string;
  readonly reason: string;
}): DiscordMessagePayload {
  return buildMessage([
    `Approval \`${input.approvalId}\` was not resolved.`,
    `Status: ${input.status}`,
    `Reason: ${input.reason}`,
  ]);
}

export function renderDoctor(input: {
  readonly ledgerEnabled: boolean;
  readonly accessPolicyEnabled: boolean;
  readonly authDatabaseEnabled?: boolean;
  readonly runtimeProviderScope: DoctorReportInput['runtimeProviderScope'];
  readonly activeRuntimeProvider?: DoctorReportInput['activeRuntimeProvider'];
  readonly computeMode?: string;
  readonly modelOverride?: string;
  readonly messageContentIntent?: boolean;
  readonly approvalRegistryEnabled?: boolean;
  readonly anthropicAuthSource?: DoctorReportInput['anthropicAuthSource'];
  readonly anthropicCliPath?: string;
  readonly claudeModelOverride?: string;
  readonly planaAdvisorProvider?: DoctorReportInput['planaAdvisorProvider'];
  readonly planaAdvisorModel?: string;
  readonly planaAdvisorMaxCalls?: number;
}): DiscordMessagePayload {
  return {
    content: renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: input.ledgerEnabled,
        accessPolicyEnabled: input.accessPolicyEnabled,
        authDatabaseEnabled: input.authDatabaseEnabled,
        runtimeProviderScope: input.runtimeProviderScope,
        activeRuntimeProvider: input.activeRuntimeProvider,
        computeMode: input.computeMode,
        modelOverride: input.modelOverride,
        messageContentIntent: input.messageContentIntent,
        approvalRegistryEnabled: input.approvalRegistryEnabled,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        subagentMaxSpawnDepth: 1,
        anthropicAuthSource: input.anthropicAuthSource,
        anthropicCliPath: input.anthropicCliPath,
        claudeModelOverride: input.claudeModelOverride,
        planaAdvisorProvider: input.planaAdvisorProvider,
        planaAdvisorModel: input.planaAdvisorModel,
        planaAdvisorMaxCalls: input.planaAdvisorMaxCalls,
      }),
    ),
  };
}

export function renderCancelAccepted(
  taskId: string,
  receipt: CancellationReceipt,
): DiscordMessagePayload {
  if (receipt.status === 'not-active') {
    return buildMessage([
      `Cancellation was not applied for task \`${taskId}\`.`,
      'The task is no longer active.',
    ]);
  }

  return buildMessage([
    `Cancellation requested for task \`${taskId}\`.`,
    `Reason: ${receipt.reason}`,
    `Provenance: ${receipt.provenance}`,
  ]);
}

export function renderAlreadyTerminal(record: DiscordTaskRecord): DiscordMessagePayload {
  const evidence = record.terminalEvidence;
  return buildMessage([
    `Task \`${record.taskId}\` is already terminal.`,
    evidence ? `Outcome: ${deriveOutcomeFromCause(evidence.cause)}` : `Lifecycle: ${record.lastLifecyclePhase}`,
    evidence ? `Reason: ${evidence.reason}` : '',
  ]);
}

export function renderHelp(): DiscordMessagePayload {
  return buildMessage([
    'Mention me at the start of a message to run a task, for example: `<@bot> create results/task-artifacts/example.txt`.',
    'Use `/status task_id:<id>` or ask `status for discord-task-...` to check a tracked task.',
    'Use `/cancel task_id:<id>` or ask `cancel discord-task-...` to request cancellation.',
    'Use `/tasks`, `/agenda`, `/history`, `/context`, `/research`, `/auth`, and `/doctor` for always-on research service operations.',
  ]);
}

export function renderAuthDatabaseNotConfigured(): DiscordMessagePayload {
  return buildMessage(['Discord auth database is not configured for this service.']);
}

export function renderAuthList(input: {
  readonly allowedGuildIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  readonly adminUserIds: readonly string[];
}): DiscordMessagePayload {
  const format = (label: string, ids: readonly string[]): string =>
    `${label}: ${ids.length === 0 ? '(none)' : ids.join(', ')}`;
  return buildMessage([
    'Discord auth database entries',
    format('Allowed guilds', input.allowedGuildIds),
    format('Allowed users', input.allowedUserIds),
    format('Allowed channels', input.allowedChannelIds),
    format('Admin users', input.adminUserIds),
  ]);
}

export function renderAuthMutation(input: {
  readonly action: string;
  readonly subjectId: string;
  readonly scope: string;
}): DiscordMessagePayload {
  return buildMessage([
    `Discord auth database updated: ${input.action}.`,
    `Scope: ${input.scope}`,
    `Subject: ${input.subjectId}`,
  ]);
}

export function renderAuthRejected(reason: string): DiscordMessagePayload {
  return buildMessage([
    'Discord auth database update rejected.',
    `Reason: ${reason}`,
  ]);
}

export function renderInsights(snapshot: InsightSnapshot): DiscordMessagePayload {
  const successPct =
    Number.isNaN(snapshot.successRate)
      ? 'n/a'
      : `${(snapshot.successRate * 100).toFixed(1)}%`;
  const avgDuration =
    snapshot.averageDurationMs === undefined
      ? 'n/a'
      : `${(snapshot.averageDurationMs / 1000).toFixed(1)}s`;
  const causeLines = Object.entries(snapshot.causeBreakdown)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `  ${kind}: ${count}`);
  const topReasonLines =
    snapshot.topFailureReasons.length === 0
      ? ['  (none)']
      : snapshot.topFailureReasons.map(
          ({ reason, count }) =>
            `  ${reason.slice(0, 60)}${reason.length > 60 ? '…' : ''}: ${count}`,
        );
  return buildMessage([
    `Insights (${snapshot.windowStart.slice(0, 10)} → ${snapshot.windowEnd.slice(0, 10)})`,
    `Tasks dispatched: ${snapshot.totalTasks}`,
    `Success rate: ${successPct}`,
    `Avg duration: ${avgDuration}`,
    causeLines.length > 0 ? `Cause breakdown:\n${causeLines.join('\n')}` : 'Cause breakdown: (no terminal events)',
    `Top failure reasons:\n${topReasonLines.join('\n')}`,
  ]);
}
