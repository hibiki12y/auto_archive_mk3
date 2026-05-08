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
import type {
  DiscordTaskRecord,
  DiscordTaskUnarchive,
} from './discord-task-registry.js';
import type { DiscordAccessDecision } from './discord-access-policy.js';
import type {
  ResearchAgendaItem,
  ResearchCadenceRecord,
  ResearchAgendaStatus,
} from './discord-research-agenda.js';
import type { SubagentOperatorResult } from '../runtime/subagent-operator.js';
import type {
  TraitModuleRegistry,
  TraitModuleRegistryEntry,
} from '../core/trait-module-loader.js';
import type { TraitUsageStats } from '../core/trait-usage-telemetry.js';
import type {
  BindingMutationResult,
  DiscordSessionBindingRecord,
} from './discord-session-binding.js';

export interface DiscordMessagePayload {
  content: string;
  allowedMentions?: {
    readonly parse: readonly ('roles' | 'users' | 'everyone')[];
    readonly users?: readonly string[];
    readonly roles?: readonly string[];
    readonly repliedUser?: boolean;
  };
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
    | 'agentHarnessRegistry'
    | 'autonomousResearchEvidence'
    | 'runtimeProviderEvidence'
    | 'liveProofReport'
    | 'peekabooEvidenceReport'
    | 'personaTelemetryReport'
    | 'taskHealthEvidenceReport'
    | 'taskArchiveEvidenceReport'
    | 'subagentOperatorEvidenceReport'
    | 'sessionBindingEvidenceReport'
    | 'controlPlaneOtelLogs'
    | 'planaAdvisorEvents'
    | 'traitSchedulerTickEvidence'
    | 'shellHooksMode'
    | 'shellHookAcceptMode'
    | 'taskHealthObserverEnabled'
    | 'inFlightProblems'
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
    ...payload,
    content,
  }));
}

function buildMessage(lines: string[]): DiscordMessagePayload {
  return {
    content: lines.filter((line) => line.length > 0).join('\n'),
  };
}

function buildNoMentionMessage(lines: string[]): DiscordMessagePayload {
  return {
    ...buildMessage(lines),
    allowedMentions: { parse: [] },
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
  const archiveLine =
    record.archive === undefined
      ? undefined
      : `Archive: archived at ${record.archive.archivedAt} by ${record.archive.archivedBy}${record.archive.reason === undefined ? '' : ` · ${record.archive.reason}`}`;
  if (record.coarseState === 'terminal') {
    return buildMessage([
      renderTerminalResult(record).content,
      `Command: ${record.commandName ?? 'ask'}`,
      archiveLine ?? '',
      renderProgressHint(record),
    ]);
  }

  return buildMessage([
    `Task \`${record.taskId}\` status: ${record.coarseState}.`,
    `Command: ${record.commandName ?? 'ask'}`,
    `Lifecycle: ${record.lastLifecyclePhase}`,
    archiveLine ?? '',
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
      (record) => {
        const archiveSuffix =
          record.archive === undefined
            ? ''
            : ` · archived ${record.archive.archivedAt}`;
        return `- \`${record.taskId}\` [${record.commandName ?? 'ask'}] ${record.coarseState} · ${record.lastLifecyclePhase} · updated ${record.updatedAt}${archiveSuffix}`;
      },
    ),
  ]);
}

function renderTraitScheduleSummary(
  entry: TraitModuleRegistryEntry,
): string {
  const schedule = entry.manifest.schedule;
  return schedule.mode === 'none'
    ? 'schedule=none'
    : `schedule=cron(${schedule.schedules.length})`;
}

function renderTraitRuntimeSummary(
  entry: TraitModuleRegistryEntry,
): string {
  const runtime = entry.manifest.runtime;
  return runtime.hook === 'none'
    ? 'runtime=none'
    : `runtime=${runtime.hook}/${runtime.enforcement}`;
}

function renderTraitAdmissionSummary(
  entry: TraitModuleRegistryEntry,
): string {
  const admission = entry.manifest.admission;
  const defaultState = admission.defaultRequested ? 'default-requested' : 'opt-in';
  const required =
    admission.requiredCapabilityFlags.length === 0
      ? 'required=none'
      : `required=${admission.requiredCapabilityFlags.join(',')}`;
  const forbidden =
    admission.forbiddenCapabilityFlags.length === 0
      ? 'forbidden=none'
      : `forbidden=${admission.forbiddenCapabilityFlags.join(',')}`;
  return `admission=${defaultState}; ${required}; ${forbidden}`;
}

function renderTraitUsageSummary(
  entry: TraitModuleRegistryEntry,
  usageByTraitModuleId: ReadonlyMap<string, TraitUsageStats> | undefined,
): string | undefined {
  if (usageByTraitModuleId === undefined) {
    return undefined;
  }
  const usage = usageByTraitModuleId.get(entry.manifest.id);
  if (usage === undefined) {
    return 'usage=0';
  }
  return [
    `usage=${String(usage.useCount)}`,
    `last=${sanitizeTraitManifestText(usage.lastUsedAt, 40)}`,
    `lastTask=${sanitizeTraitManifestText(usage.lastTaskId, 80)}`,
  ].join(' ');
}

function sanitizeTraitManifestText(value: string, maxLength = 160): string {
  const compact = value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/@/gu, '@\u200B')
    .replace(/`/gu, 'ʼ');
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function renderTraitModuleList(input: {
  readonly registry?: TraitModuleRegistry;
  readonly usageStats?: readonly TraitUsageStats[];
  readonly error?: string;
}): DiscordMessagePayload {
  if (input.error !== undefined && input.error.trim().length > 0) {
    return buildNoMentionMessage([
      'Trait module registry is unavailable for this service instance.',
      `Reason: ${sanitizeTraitManifestText(input.error, 320)}`,
      'No install, enable, or external registry action was attempted.',
    ]);
  }

  const registry = input.registry;
  if (registry === undefined) {
    return buildNoMentionMessage([
      'Trait module registry is not configured for this service instance.',
      'No install, enable, or external registry action was attempted.',
    ]);
  }

  if (registry.entries.length === 0) {
    return buildNoMentionMessage([
      'Trait modules (0, read-only)',
      'No TraitModule manifests were discovered.',
      'No install, enable, or external registry action was attempted.',
    ]);
  }

  const usageByTraitModuleId =
    input.usageStats === undefined
      ? undefined
      : new Map(input.usageStats.map((usage) => [usage.traitModuleId, usage]));

  return buildNoMentionMessage([
    `Trait modules (${registry.entries.length}, read-only)`,
    'Repository/workspace manifest metadata only; no auto-install or auto-enable action was attempted.',
    ...registry.entries.map((entry) =>
      [
        `- \`${entry.registryKey}\` ${sanitizeTraitManifestText(entry.manifest.name)}`,
        `[${entry.manifest.trustBoundary}]`,
        renderTraitRuntimeSummary(entry),
        renderTraitScheduleSummary(entry),
        renderTraitAdmissionSummary(entry),
        renderTraitUsageSummary(entry, usageByTraitModuleId),
        `instructions=${sanitizeTraitManifestText(entry.manifest.instructions.summary)}`,
        `sources=${entry.manifest.sourceMapIds.length}`,
      ].filter((part) => part !== undefined).join(' · '),
    ),
  ]);
}

export function renderTaskArchived(record: DiscordTaskRecord): DiscordMessagePayload {
  return buildMessage([
    `Archived task \`${record.taskId}\`.`,
    `Archived at: ${record.archive?.archivedAt ?? record.updatedAt}`,
    `Archived by: ${record.archive?.archivedBy ?? record.userId}`,
    record.archive?.reason === undefined ? '' : `Reason: ${record.archive.reason}`,
    'It is hidden from `/tasks all|active|terminal`; use `/tasks archived` to list archived records.',
  ]);
}

export function renderTaskAlreadyArchived(
  record: DiscordTaskRecord,
): DiscordMessagePayload {
  return buildMessage([
    `Task \`${record.taskId}\` is already archived.`,
    `Archived at: ${record.archive?.archivedAt ?? record.updatedAt}`,
    record.archive?.reason === undefined ? '' : `Reason: ${record.archive.reason}`,
  ]);
}

export function renderTaskUnarchived(
  record: DiscordTaskRecord,
  unarchive: DiscordTaskUnarchive,
): DiscordMessagePayload {
  return buildMessage([
    `Restored archived task \`${record.taskId}\`.`,
    `Restored at: ${unarchive.unarchivedAt}`,
    `Restored by: ${unarchive.unarchivedBy}`,
    unarchive.reason === undefined ? '' : `Reason: ${unarchive.reason}`,
    'It is visible again in `/tasks all|terminal`; `/tasks archived` no longer lists it.',
  ]);
}

export function renderTaskNotArchived(
  record: DiscordTaskRecord,
): DiscordMessagePayload {
  return buildMessage([
    `Task \`${record.taskId}\` is not archived.`,
    `Status: ${record.coarseState}`,
    'No restore action was applied.',
  ]);
}

export function renderTaskRerunAccepted(
  sourceRecord: DiscordTaskRecord,
  rerunRecord: DiscordTaskRecord,
  note?: string,
): DiscordMessagePayload {
  return buildMessage([
    `Rerun accepted for task \`${sourceRecord.taskId}\` as \`${rerunRecord.taskId}\`.`,
    `Source status: ${sourceRecord.coarseState}`,
    `New task command: /${rerunRecord.commandName ?? 'ask'}`,
    note === undefined ? '' : `Rerun note: ${note}`,
    `Use \`/status task_id:${rerunRecord.taskId}\` to track the fresh run.`,
  ]);
}

export function renderTaskRerunNotTerminal(
  record: DiscordTaskRecord,
): DiscordMessagePayload {
  return buildMessage([
    `Task \`${record.taskId}\` was not rerun.`,
    `Status: ${record.coarseState}`,
    'Only terminal tasks can be rerun; use `/status` to inspect progress or `/cancel` to stop an active task.',
  ]);
}

export function renderTaskOwnerRequired(
  record: DiscordTaskRecord,
  action: string,
): DiscordMessagePayload {
  return buildMessage([
    `Task \`${record.taskId}\` was not changed.`,
    `Requested action: /${action}`,
    `Only the task owner or a Discord admin can use \`/${action}\` on this task.`,
  ]);
}

export function renderTaskArchiveNotTerminal(
  record: DiscordTaskRecord,
): DiscordMessagePayload {
  return buildMessage([
    `Task \`${record.taskId}\` was not archived.`,
    `Status: ${record.coarseState}`,
    'Only terminal tasks can be archived; use `/status` to inspect progress or `/cancel` to stop an active task.',
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

function sanitizeDiscordHistoryText(value: unknown, maxLength = 220): string {
  const raw = typeof value === 'string' ? value : '';
  const compact = raw
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/@/gu, '@\u200B')
    .replace(/`/gu, 'ʼ');
  if (compact.length === 0) {
    return '(empty)';
  }
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function renderTalkHistoryActor(event: ControlPlaneEvent): string {
  if (event.payload['authorIsBot'] === true) {
    return 'bot';
  }
  return event.actor.userId === undefined
    ? event.actor.kind
    : `${event.actor.kind}:${sanitizeDiscordHistoryText(event.actor.userId, 80)}`;
}

export function renderTalkHistory(
  events: readonly ControlPlaneEvent[],
): DiscordMessagePayload {
  const talkEvents = events.filter(
    (event) => event.type === 'conversation.message_observed',
  );
  if (talkEvents.length === 0) {
    return buildNoMentionMessage([
      'No Discord talk history matched that query.',
      'Talk history is read-only and only includes observed conversation messages.',
    ]);
  }
  return buildNoMentionMessage([
    `Discord talk history (${talkEvents.length}, read-only, untrusted)`,
    ...talkEvents.map((event, index) => {
      const channel =
        event.channel?.channelId === undefined
          ? ''
          : ` channel=${sanitizeDiscordHistoryText(event.channel.channelId, 80)}`;
      return `${index + 1}. ${event.timestamp}${channel} ${renderTalkHistoryActor(
        event,
      )}: ${sanitizeDiscordHistoryText(event.payload['content'])}`;
    }),
  ]);
}

export function renderEscalationUnavailable(): DiscordMessagePayload {
  return buildNoMentionMessage([
    'Operator escalation was not recorded.',
    'Control-plane ledger is not configured for this Discord service.',
  ]);
}

export function renderEscalationRequested(input: {
  readonly event: ControlPlaneEvent;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly reason?: string;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    'Operator escalation requested.',
    `Escalation event: ${input.event.eventId}`,
    input.taskId === undefined ? '' : `Task: ${sanitizeDiscordHistoryText(input.taskId, 100)}`,
    input.channelId === undefined
      ? ''
      : `Channel: ${sanitizeDiscordHistoryText(input.channelId, 100)}`,
    input.reason === undefined || input.reason.trim().length === 0
      ? 'Reason: not provided'
      : `Reason: ${sanitizeDiscordHistoryText(input.reason)}`,
    'An operator can inspect `/history`, `/context`, `/status`, or the ledger event before acting.',
  ]);
}

export type DiscordFeedKind = 'all' | 'task' | 'escalation' | 'approval';

function summarizeFeedEvent(event: ControlPlaneEvent): string {
  const task = event.taskId === undefined
    ? ''
    : ` task=${sanitizeDiscordHistoryText(event.taskId, 80)}`;
  const channel =
    event.channel?.channelId === undefined
      ? ''
      : ` channel=${sanitizeDiscordHistoryText(event.channel.channelId, 80)}`;
  const eventId = ` event=${sanitizeDiscordHistoryText(event.eventId, 80)}`;
  const reason =
    typeof event.payload['reason'] === 'string'
      ? ` reason=${sanitizeDiscordHistoryText(event.payload['reason'], 120)}`
      : '';
  const phase =
    typeof event.payload['phase'] === 'string'
      ? ` phase=${sanitizeDiscordHistoryText(event.payload['phase'], 80)}`
      : '';
  return `${event.timestamp} ${event.type}${task}${channel}${phase}${reason}${eventId}`;
}

export function renderControlPlaneFeed(input: {
  readonly events: readonly ControlPlaneEvent[];
  readonly since: string;
  readonly kind: DiscordFeedKind;
  readonly limit: number;
}): DiscordMessagePayload {
  if (input.events.length === 0) {
    return buildNoMentionMessage([
      'No control-plane feed events matched that query.',
      `Filter: kind=${input.kind} since=${sanitizeDiscordHistoryText(input.since, 80)} limit=${input.limit}`,
    ]);
  }
  return buildNoMentionMessage([
    `Control-plane feed (${input.events.length}, read-only, untrusted)`,
    `Filter: kind=${input.kind} since=${sanitizeDiscordHistoryText(input.since, 80)} limit=${input.limit}`,
    ...input.events.map((event, index) =>
      `${index + 1}. ${summarizeFeedEvent(event)}`,
    ),
  ]);
}

export function renderControlPlaneFeedUnavailable(): DiscordMessagePayload {
  return buildNoMentionMessage([
    'Control-plane feed is unavailable.',
    'Control-plane ledger is not configured for this Discord service.',
  ]);
}

export function renderControlPlaneFeedTooLarge(input: {
  readonly sizeBytes: number;
  readonly maxBytes: number;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    'Control-plane feed was not loaded.',
    `Ledger file is too large for bounded Discord feed reads: ${input.sizeBytes} bytes > ${input.maxBytes} bytes.`,
    'Run `/doctor` and rotate or compact the control-plane ledger before using `/feed`.',
  ]);
}

export function renderControlPlaneFeedRateLimited(): DiscordMessagePayload {
  return buildNoMentionMessage([
    'Control-plane feed request was rate-limited.',
    'Limit: 2 `/feed` requests per Discord user per minute.',
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
  readonly agentHarnessRegistry?: DoctorReportInput['agentHarnessRegistry'];
  readonly autonomousResearchEvidence?: DoctorReportInput['autonomousResearchEvidence'];
  readonly runtimeProviderEvidence?: DoctorReportInput['runtimeProviderEvidence'];
  readonly liveProofReport?: DoctorReportInput['liveProofReport'];
  readonly peekabooEvidenceReport?: DoctorReportInput['peekabooEvidenceReport'];
  readonly personaTelemetryReport?: DoctorReportInput['personaTelemetryReport'];
  readonly taskHealthEvidenceReport?: DoctorReportInput['taskHealthEvidenceReport'];
  readonly taskArchiveEvidenceReport?: DoctorReportInput['taskArchiveEvidenceReport'];
  readonly subagentOperatorEvidenceReport?: DoctorReportInput['subagentOperatorEvidenceReport'];
  readonly sessionBindingEvidenceReport?: DoctorReportInput['sessionBindingEvidenceReport'];
  readonly controlPlaneOtelLogs?: DoctorReportInput['controlPlaneOtelLogs'];
  readonly planaAdvisorEvents?: DoctorReportInput['planaAdvisorEvents'];
  readonly traitSchedulerTickEvidence?: DoctorReportInput['traitSchedulerTickEvidence'];
  readonly shellHooksMode?: DoctorReportInput['shellHooksMode'];
  readonly shellHookAcceptMode?: DoctorReportInput['shellHookAcceptMode'];
  readonly taskHealthObserverEnabled?: boolean;
  readonly inFlightProblems?: DoctorReportInput['inFlightProblems'];
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
        agentHarnessRegistry: input.agentHarnessRegistry,
        autonomousResearchEvidence: input.autonomousResearchEvidence,
        runtimeProviderEvidence: input.runtimeProviderEvidence,
        liveProofReport: input.liveProofReport,
        peekabooEvidenceReport: input.peekabooEvidenceReport,
        personaTelemetryReport: input.personaTelemetryReport,
        taskHealthEvidenceReport: input.taskHealthEvidenceReport,
        taskArchiveEvidenceReport: input.taskArchiveEvidenceReport,
        subagentOperatorEvidenceReport:
          input.subagentOperatorEvidenceReport,
        sessionBindingEvidenceReport: input.sessionBindingEvidenceReport,
        controlPlaneOtelLogs: input.controlPlaneOtelLogs,
        planaAdvisorEvents: input.planaAdvisorEvents,
        traitSchedulerTickEvidence: input.traitSchedulerTickEvidence,
        shellHooksMode: input.shellHooksMode,
        shellHookAcceptMode: input.shellHookAcceptMode,
        taskHealthObserverEnabled: input.taskHealthObserverEnabled,
        inFlightProblems: input.inFlightProblems,
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

export interface PersonaConfigViewInput {
  readonly arona: {
    readonly effectiveProvider: string;
    readonly effectiveModel?: string;
    readonly effectiveEffort?: string;
    readonly storedOverride: {
      readonly provider?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly max_turns?: number;
    };
  };
  readonly plana: {
    readonly effectiveProvider: string;
    readonly effectiveModel?: string;
    readonly effectiveMaxCalls?: number;
    readonly storedOverride: {
      readonly provider?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly max_turns?: number;
    };
  };
  readonly storeFilePath: string;
  readonly storeExists: boolean;
}

export function renderPersonaConfigView(
  input: PersonaConfigViewInput,
): DiscordMessagePayload {
  const arona = input.arona;
  const plana = input.plana;
  const aronaPending = describeOverride(arona.storedOverride);
  const planaPending = describeOverride(plana.storedOverride);
  const restartHint =
    arona.storedOverride && Object.keys(arona.storedOverride).length > 0
      ? '⚠️ Stored overrides take effect on the next service restart.'
      : plana.storedOverride && Object.keys(plana.storedOverride).length > 0
        ? '⚠️ Stored overrides take effect on the next service restart.'
        : '';
  return buildNoMentionMessage([
    '**Persona configuration**',
    '',
    '**Arona** (dispatched-task runtime)',
    `- Effective provider: \`${arona.effectiveProvider}\``,
    arona.effectiveModel ? `- Effective model: \`${arona.effectiveModel}\`` : '',
    arona.effectiveEffort
      ? `- Effective effort: \`${arona.effectiveEffort}\``
      : '',
    `- Pending overrides: ${aronaPending}`,
    '',
    '**Plana** (runtime advisor)',
    `- Effective provider: \`${plana.effectiveProvider}\``,
    plana.effectiveModel ? `- Effective model: \`${plana.effectiveModel}\`` : '',
    plana.effectiveMaxCalls !== undefined
      ? `- Effective max calls: \`${plana.effectiveMaxCalls}\``
      : '',
    `- Pending overrides: ${planaPending}`,
    '',
    `Store: \`${input.storeFilePath}\`${input.storeExists ? '' : ' (not yet created)'}`,
    restartHint,
  ]);
}

export function renderPersonaConfigUpdated(
  persona: 'arona' | 'plana',
  key: string,
  value: string | number,
  options: {
    readonly hotSwapApplied?: boolean;
    /**
     * Previous stored value for this `(persona, key)` pair, if any. Used to
     * help operators see whether anything actually changed (e.g. when they
     * re-run the same `/config set ... value:codex` and want to confirm the
     * value was unchanged). Undefined when no prior override existed.
     */
    readonly previousValue?: string | undefined;
    /**
     * Present ONLY when `key === 'provider'`. Surfaces the explicit
     * "next-dispatch" boundary so the operator understands that any
     * currently-in-flight dispatch keeps its current provider until it
     * finishes (Risk 3 from the comprehensive audit / multi-provider-scope.md
     * §1.4 invariant: provider hot-swap never preempts a running dispatch).
     */
    readonly activeProviderInfo?: {
      readonly previous: string | undefined;
      readonly next: string;
      readonly takesEffectOnNextDispatch: boolean;
    };
  } = {},
): DiscordMessagePayload {
  const lines = [
    `Saved \`${persona}.${key}\` = \`${value}\` to the persona settings store.`,
  ];
  if (options.previousValue !== undefined) {
    lines.push(`Previous stored value: \`${options.previousValue}\`.`);
  }
  if (options.hotSwapApplied === true) {
    lines.push(
      '✅ Hot-swap applied — the next dispatch will use the new value (multi-provider-scope.md §1.3-1.4).',
    );
  } else {
    lines.push(
      '⚠️ Restart the service to pick up the change for the next dispatch.',
    );
  }
  if (options.activeProviderInfo !== undefined) {
    const previousLabel =
      options.activeProviderInfo.previous === undefined
        ? 'none'
        : `\`${options.activeProviderInfo.previous}\``;
    lines.push(
      `Active provider for next dispatch: \`${options.activeProviderInfo.next}\` (was: ${previousLabel}). In-flight dispatches keep their current provider until they finish.`,
    );
  }
  return buildNoMentionMessage(lines);
}

export function renderPersonaConfigReset(
  persona: 'arona' | 'plana',
  options: { readonly hotSwapApplied?: boolean } = {},
): DiscordMessagePayload {
  const lines = [`Cleared all stored overrides for \`${persona}\`.`];
  if (options.hotSwapApplied === true) {
    lines.push(
      '✅ Hot-swap applied — the next dispatch will use bootstrap defaults again.',
    );
  } else {
    lines.push(
      '⚠️ Restart the service to revert to env-var defaults for the next dispatch.',
    );
  }
  return buildNoMentionMessage(lines);
}

export function renderPersonaConfigError(
  message: string,
): DiscordMessagePayload {
  return buildNoMentionMessage([`/config rejected: ${message}`]);
}

export function renderResearchPlanAccepted(input: {
  readonly planId: string;
  readonly subTaskCount: number;
  readonly provider: 'codex' | 'claude-agent';
  readonly maxTurns?: number;
}): DiscordMessagePayload {
  const lines = [
    `🧭 Research plan \`${input.planId}\` accepted.`,
    `Sub-tasks queued: **${input.subTaskCount}** (sequential) + 1 synthesis.`,
    `Provider: \`${input.provider}\`${
      input.provider === 'claude-agent' && input.maxTurns !== undefined
        ? ` (max_turns=${input.maxTurns})`
        : ''
    }.`,
    '⚠️ Long plans may exceed Discord\'s ~15-min interaction window — for runs >15 min use `pnpm research:plan:run`.',
  ];
  return buildNoMentionMessage(lines);
}

export function renderResearchPlanProgress(input: {
  readonly planId: string;
  readonly subTaskId: string;
  readonly index: number;
  readonly total: number;
  readonly causeKind: string;
  readonly elapsedMs: number;
  readonly toolUseCount: number;
}): DiscordMessagePayload {
  const elapsedSec = (input.elapsedMs / 1000).toFixed(1);
  const tag =
    input.causeKind === 'success'
      ? '✅'
      : input.causeKind === 'driver-threw'
        ? '💥'
        : '⛔';
  return buildNoMentionMessage([
    `${tag} \`${input.planId}\` sub-task ${input.index}/${input.total} · ` +
      `\`${input.subTaskId}\` · cause=\`${input.causeKind}\` · ` +
      `tools=${input.toolUseCount} · elapsed=${elapsedSec}s`,
  ]);
}

export const DISCORD_MESSAGE_BUDGET = 1900;

/**
 * Render the terminal follow-up for `/research-plan`.
 *
 * Behaviour falls into two branches depending on aggregated-report size:
 *
 * 1. Report fits within {@link DISCORD_MESSAGE_BUDGET} — inline the full
 *    report in a single Discord message (legacy path).
 * 2. Report exceeds the budget — caller is expected to have already
 *    persisted the full report to disk and pass `artifactPath` +
 *    `fullReportSizeBytes`. The rendered message becomes a short summary
 *    (plan id, sub-task count, total elapsed, optional partial-synthesis
 *    flag) plus a pointer to the on-disk artifact. Operator can `cat` it
 *    locally or `scp` it off the runtime host without re-running the
 *    plan.
 *
 * If `artifactPath` is omitted for an oversized report (e.g. because
 * persistence failed), the renderer falls back to the legacy truncated
 * inline form so the operator still gets actionable text instead of a
 * silent drop.
 */
export function renderResearchPlanFinal(input: {
  readonly planId: string;
  readonly aggregatedReport: string;
  readonly totalElapsedMs: number;
  readonly subTaskCount: number;
  readonly stoppedEarly?: boolean;
  readonly partialSynthesis?: boolean;
  readonly artifactPath?: string;
  readonly fullReportSizeBytes?: number;
}): DiscordMessagePayload {
  const elapsedSec = (input.totalElapsedMs / 1000).toFixed(1);
  const header =
    `🧭 Research plan \`${input.planId}\` complete · ` +
    `${input.subTaskCount} sub-tasks + 1 synthesis · ` +
    `total elapsed=${elapsedSec}s`;
  const report = input.aggregatedReport;
  if (report.length <= DISCORD_MESSAGE_BUDGET) {
    return buildNoMentionMessage([header, '', report]);
  }
  if (input.artifactPath !== undefined) {
    const size = input.fullReportSizeBytes ?? report.length;
    const flagLines: string[] = [];
    if (input.partialSynthesis === true) {
      flagLines.push('⚠️ Partial synthesis — one or more sub-tasks were skipped.');
    } else if (input.stoppedEarly === true) {
      flagLines.push('⚠️ Stopped early — synthesis ran on incomplete sub-task set.');
    }
    return buildNoMentionMessage([
      header,
      ...flagLines,
      '',
      `📎 Full report saved to \`${input.artifactPath}\` (${size} chars).`,
      `Run \`cat ${input.artifactPath}\` to read locally, ` +
        'or download via `scp` from the runtime host.',
    ]);
  }
  const truncated = report.slice(0, DISCORD_MESSAGE_BUDGET);
  return buildNoMentionMessage([
    header,
    '',
    truncated,
    '',
    `…(truncated ${report.length - DISCORD_MESSAGE_BUDGET} chars). ` +
      'Re-run via `pnpm research:plan:run --report-out <file>` to capture the full report.',
  ]);
}

export function renderResearchPlanError(
  planId: string,
  message: string,
): DiscordMessagePayload {
  return buildNoMentionMessage([
    `❌ Research plan \`${planId}\` rejected: ${message}`,
  ]);
}

function describeOverride(override: {
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly max_turns?: number;
}): string {
  const parts: string[] = [];
  if (override.provider !== undefined) parts.push(`provider=\`${override.provider}\``);
  if (override.model !== undefined) parts.push(`model=\`${override.model}\``);
  if (override.effort !== undefined) parts.push(`effort=\`${override.effort}\``);
  if (override.max_turns !== undefined)
    parts.push(`max_turns=\`${override.max_turns}\``);
  return parts.length === 0 ? '_none_' : parts.join(', ');
}

export function renderHelp(): DiscordMessagePayload {
  return buildMessage([
    'Mention me at the start of a message to run a task, for example: `<@bot> create results/task-artifacts/example.txt`.',
    'Use `/status task_id:<id>` or ask `status for discord-task-...` to check a tracked task.',
    'Owner/admin only: `/cancel`, `/rerun`, `/archive`, and `/unarchive` can change a tracked task.',
    'Use `/cancel task_id:<id>` or ask `cancel discord-task-...` to request cancellation.',
    'Use `/rerun task_id:<id>` to start a fresh task from terminal evidence without reusing the old artifact root.',
    'Use `/archive task_id:<id>` to hide completed/superseded records from default task lists; `/unarchive task_id:<id>` restores them; `/tasks archived` lists archived records.',
    'Read-only inspection stays available under the broader Discord access policy: `/status`, `/tasks`, `/history`, `/context`, and `/feed` can inspect tracked tasks, including archived records and recent control-plane events.',
    'Use `/history view:talk` or `/history --talk` to inspect sanitized read-only Discord talk history for the channel.',
    'Use `/escalate` to record a Discord-only operator escalation request without mutating the task.',
    'Use `/feed` to inspect a bounded sanitized Discord-only live tail of recent control-plane events.',
    'Read-only discovery: `/traits` lists TraitModule manifests without installing, enabling, or fetching external registries.',
    'Non-mutating readiness: `/doctor` reports service diagnostics without applying fixes.',
    'Admin-only operations: `/auth`, `/approve`, `/deny`, `/subagents`, and `/doctor` require a configured Discord admin.',
    'Use `/tasks`, `/traits`, `/agenda`, `/history`, `/context`, `/research`, `/auth`, and `/doctor` for always-on research service operations.',
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
