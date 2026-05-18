import type { VetoPath } from '../contracts/veto.js';
import type { TerminalCause } from '../contracts/terminal-cause.js';
import {
  projectRestartRecipeSnapshot,
  type RestartRecipeSnapshot,
} from '../contracts/restart-recipe-snapshot.js';
import {
  AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH,
  AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH,
  buildDoctorReport,
  renderDoctorReport,
  type DoctorReportInput,
} from '../core/doctor.js';
import {
  LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES,
  LIVE_PROOF_SURFACES,
  buildLiveProofManifestTemplateFromCliOptions,
  type LiveProofSurface,
} from '../core/live-proof-report-cli.js';
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
import type { SubagentDescriptor } from '../contracts/subagent-roster.js';
import type {
  TraitModuleRegistry,
  TraitModuleRegistryEntry,
} from '../core/trait-module-loader.js';
import type { TraitUsageStats } from '../core/trait-usage-telemetry.js';
import type {
  BindingMutationResult,
  DiscordSessionBindingRecord,
} from './discord-session-binding.js';

/**
 * P3-def-2: lightweight description of a file attachment that the
 * production discord.js adapter materializes into an `AttachmentBuilder`
 * (or the equivalent `{ attachment, name }` shape that discord.js's
 * `MessagePayload` accepts). The adapter reads bytes from `path` on
 * demand — there is no preemptive read on the renderer side.
 *
 * Adapters that lack attachment support MAY ignore this field, but MUST
 * NOT throw if it is present. The fake test adapter in
 * `tests/helpers/discord.ts` records the shape verbatim, which lets
 * tests assert on attachment metadata without coupling to discord.js.
 */
export interface DiscordAttachment {
  /** Filename shown to the user in Discord. */
  readonly name: string;
  /** Absolute path on disk; the production adapter reads bytes from here. */
  readonly path: string;
}

/**
 * UX-14 (cycle 7): transport-agnostic Discord interactive component
 * shape. The renderer builds these as plain data; the production
 * adapter (`toDiscordJsPayload` in `discord-bot.ts`) translates them
 * into discord.js `ActionRowBuilder<ButtonBuilder>`. Renderers and
 * tests stay free of any direct discord.js dependency.
 *
 * Limits mirror the Discord API: at most 5 components per row, and at
 * most 5 rows per message. The renderer enforces these caps; the
 * production adapter trusts them.
 *
 * `customId` carries the action target encoded as
 * `subagents:<verb>:<subagentId>`; the bot's button-interaction
 * listener parses this format. The shape is opaque to the renderer.
 */
export type DiscordButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface DiscordButtonDescriptor {
  readonly kind: 'button';
  readonly customId: string;
  readonly label: string;
  readonly style: DiscordButtonStyle;
}

export interface DiscordActionRowDescriptor {
  readonly kind: 'action-row';
  readonly components: ReadonlyArray<DiscordButtonDescriptor>;
}

export interface DiscordMessagePayload {
  content: string;
  allowedMentions?: {
    readonly parse: readonly ('roles' | 'users' | 'everyone')[];
    readonly users?: readonly string[];
    readonly roles?: readonly string[];
    readonly repliedUser?: boolean;
  };
  /**
   * P3-def-2: optional file attachments. The production adapter maps
   * these to discord.js `files: AttachmentBuilder[]`; the fake adapter
   * records the shape verbatim. When a payload is split across multiple
   * Discord messages by {@link splitDiscordMessagePayload}, attachments
   * only ride the FIRST chunk (Discord limitation: chunked sequences
   * cannot all carry the same files; only the leading message in the
   * sequence carries them).
   */
  readonly attachments?: ReadonlyArray<DiscordAttachment>;
  /**
   * UX-14 (cycle 7): optional interactive button rows. When set, the
   * production adapter renders these as discord.js action rows. When
   * a payload is split by {@link splitDiscordMessagePayload}, only the
   * first chunk carries the components (mirrors the attachment rule).
   */
  readonly components?: ReadonlyArray<DiscordActionRowDescriptor>;
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
  const chunks = chunkDiscordContentBySentence(payload.content, limit);
  return chunks.map((content, index) => {
    if (index === 0) {
      // First chunk inherits everything — attachments included.
      return { ...payload, content };
    }
    // Subsequent chunks: strip attachments AND components. Discord only
    // attaches files / interactive component rows to the leading message
    // of a chunked sequence; duplicating on follow-ups would re-upload
    // / trigger discord.js errors. Components are also actionable —
    // duplicating buttons across follow-ups would mean a single click
    // fires N parallel back-end actions.
    const { attachments: _attachments, components: _components, ...rest } = payload;
    return { ...rest, content };
  });
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

  const outcome = deriveOutcomeFromCause(evidence.cause);
  const causeKind = (evidence.cause as { kind?: string }).kind;
  // UX-21: humanize the cause kind on a separate line so operators
  // see operator-language alongside the implementation outcome label.
  // The legacy `outcome` derivation (success / failure / timeout /
  // operator-cancel / abort) keeps its UX-stable surface; the new
  // `Cause` line adds the granular machine-readable kind translated
  // through the same `humanizeResearchPlanCauseKind` table that
  // /research-plan progress uses.
  const causeLine =
    typeof causeKind === 'string' && causeKind !== 'success'
      ? `Cause: ${humanizeResearchPlanCauseKind(causeKind)} (\`${causeKind}\`)`
      : undefined;
  // UX-21: append a next-step hint for non-success terminals so
  // operators see what to try next instead of only an outcome label.
  const hint =
    typeof causeKind === 'string'
      ? buildTerminalNextStepHint(causeKind, record.taskId)
      : undefined;
  const lines: string[] = [
    `Task \`${record.taskId}\` finished with \`${outcome}\`.`,
  ];
  if (causeLine !== undefined) {
    lines.push(causeLine);
  }
  lines.push(
    `Reason: ${evidence.reason}`,
    `Provenance: ${evidence.provenance}`,
    ...renderTerminalCauseDiagnosticLines(evidence.cause),
    evidence.artifactLocation
      ? `Artifact: ${evidence.artifactLocation}`
      : 'Artifact: none',
  );
  if (hint !== undefined) {
    lines.push(`💡 ${hint}`);
  }
  return buildMessage(lines);
}

/**
 * UX-21 — operator next-step guidance for non-success terminal tasks.
 *
 * Mirrors `buildResearchPlanEarlyStopHint` (cycle 2) but for the broader
 * Discord task surface (`/status`, async terminal follow-ups). Returns
 * `undefined` for `success` and unknown cause kinds so the renderer
 * falls back to no hint.
 *
 * Design parity:
 *  - `provider-failure` → /doctor + /rerun
 *  - `runtime-veto` → /doctor (advisor health)
 *  - `timeout` → raise wallTime / split task
 *  - `external-cancel` → operator already knows; no hint
 *  - `success` → no hint (success line already carries the message)
 *  - other → generic /rerun + /doctor guidance
 */
export function buildTerminalNextStepHint(
  causeKind: string,
  taskId: string,
): string | undefined {
  if (causeKind === 'success') {
    return undefined;
  }
  const rerunCmd = `\`/rerun task_id:${taskId}\``;
  if (causeKind === 'provider-failure') {
    return `Provider error — try ${rerunCmd}, or check \`/doctor\` for provider/auth readiness if the failure repeats.`;
  }
  if (causeKind === 'runtime-veto') {
    return 'Advisor vetoed the task — check `/doctor` for advisor health and adjust persona settings or the task instruction before re-running.';
  }
  if (causeKind === 'timeout') {
    return 'Task hit its wallTime budget — raise `runtimeSettings.wallTimeSec` or split the task before re-running.';
  }
  if (causeKind === 'external-cancel') {
    return undefined;
  }
  return `Re-run via ${rerunCmd}, or check \`/doctor\` for service readiness if the failure repeats.`;
}

export function renderRestartRecipeSummary(
  cause: TerminalCause | undefined,
): string | undefined {
  if (cause === undefined) {
    return undefined;
  }
  const recipe = projectRestartRecipeSnapshot(cause);
  return formatRestartRecipeSummary(recipe);
}

function formatRestartRecipeSummary(recipe: RestartRecipeSnapshot): string {
  const parts = [
    `retryability=\`${recipe.retryability}\``,
    `action=\`${recipe.recommendedAction}\``,
    `operatorActionRequired=\`${String(recipe.operatorActionRequired)}\``,
  ];
  if (recipe.providerFailureClassification !== undefined) {
    parts.push(
      `providerFailure=\`${recipe.providerFailureClassification}\``,
    );
  }
  return `Restart recipe: ${parts.join(', ')}.`;
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

/**
 * UX-20 — graceful Discord-friendly reply when an operator invokes a
 * task-scoped slash command without supplying the required `task_id`
 * option. Replaces a raw `throw new Error('task_id is required for
 * /<action>')` — which Discord renders as a generic "interaction
 * failed" — with an editReply payload that tells the operator both
 * what was missing and where to find a valid task id.
 *
 * Used by /status, /cancel, /rerun, /archive, /unarchive, /context,
 * and /focus when their `task_id` option is absent or empty.
 */
export function renderTaskOptionRequired(
  action: string,
): DiscordMessagePayload {
  return buildMessage([
    `\`/${action}\` requires a \`task_id\` option.`,
    '💡 Use `/tasks` to see currently visible tracked tasks (each row begins with the task id), or copy the id from a recent task notification message.',
  ]);
}

export function renderTaskList(
  records: readonly DiscordTaskRecord[],
  options: { readonly archivedView?: boolean } = {},
): DiscordMessagePayload {
  if (records.length === 0) {
    // UX-9: tell the user what to do next instead of a single dead-end
    // sentence. Different next-step guidance for the default (active)
    // vs the explicit archived view.
    if (options.archivedView === true) {
      return buildMessage([
        'No archived Discord tasks.',
        '💡 `/tasks` (no `archived` argument) lists currently visible tracked tasks. Archive a terminal task with `/archive task_id:<id>` to see it here.',
      ]);
    }
    return buildMessage([
      'No visible Discord tasks match that query.',
      '💡 Mention the bot to start a task (e.g. `<@bot> create results/task-artifacts/example.txt`), or run `/tasks archived` to see archived records.',
    ]);
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
    .replace(/<#/gu, '<#\u200B')
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
  const restartRecipe = renderRestartRecipeSummary(
    sourceRecord.terminalEvidence?.cause,
  );
  return buildMessage([
    `Rerun accepted for task \`${sourceRecord.taskId}\` as \`${rerunRecord.taskId}\`.`,
    `Source status: ${sourceRecord.coarseState}`,
    restartRecipe ?? 'Restart recipe: unavailable — no retained TerminalEvidence cause.',
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

/**
 * UX-14 (cycle 7): Discord caps each message at 5 action rows. We use
 * one row per descriptor (Kill + Log buttons), so we can show buttons
 * for at most this many subagents in a single `/subagents list` reply.
 * Beyond the cap, the renderer adds a hint pointing to the slash form.
 */
export const SUBAGENTS_LIST_BUTTON_ROW_LIMIT = 5;

/**
 * UX-14 (cycle 7): build per-descriptor button rows for a `/subagents
 * list` ok-result. Each subagent gets one row with [Kill] [Log]
 * buttons. The customId encoding is `subagents:<verb>:<subagentId>`
 * (parsed by `discord-bot.ts` button interaction listener).
 *
 * Returns `undefined` when the descriptor list is empty or absent
 * (no buttons to attach).
 */
export function buildSubagentActionRows(
  descriptors: readonly SubagentDescriptor[] | undefined,
): readonly DiscordActionRowDescriptor[] | undefined {
  if (descriptors === undefined || descriptors.length === 0) {
    return undefined;
  }
  const rows: DiscordActionRowDescriptor[] = [];
  for (const descriptor of descriptors.slice(0, SUBAGENTS_LIST_BUTTON_ROW_LIMIT)) {
    rows.push({
      kind: 'action-row',
      components: [
        {
          kind: 'button',
          customId: `subagents:kill:${descriptor.subagentId}`,
          label: `Kill ${descriptor.subagentId}`.slice(0, 80),
          style: 'danger',
        },
        {
          kind: 'button',
          customId: `subagents:log:${descriptor.subagentId}`,
          label: `Log ${descriptor.subagentId}`.slice(0, 80),
          style: 'secondary',
        },
      ],
    });
  }
  return rows;
}

export function renderSubagentOperatorResult(
  result: SubagentOperatorResult,
): DiscordMessagePayload {
  if (result.status === 'ok') {
    const lines: string[] = [
      'Subagents',
      result.message.length > 1_800
        ? `${result.message.slice(0, 1_800)}\n[truncated]`
        : result.message,
    ];
    // UX-14 (cycle 7): when descriptors are present (the `list` /
    // `info` shapes), attach interactive Kill/Log buttons. The slash
    // form (`/subagents kill <id>`, `/subagents log <id>`) keeps
    // working unchanged — buttons are an additive convenience layer.
    const rows = buildSubagentActionRows(result.descriptors);
    if (
      rows !== undefined &&
      result.descriptors !== undefined &&
      result.descriptors.length > SUBAGENTS_LIST_BUTTON_ROW_LIMIT
    ) {
      lines.push(
        `💡 Showing buttons for the first ${SUBAGENTS_LIST_BUTTON_ROW_LIMIT} of ${result.descriptors.length} subagents. Use \`/subagents kill <id>\` or \`/subagents log <id>\` for the rest.`,
      );
    }
    const payload: DiscordMessagePayload = {
      content: lines.filter((line) => line.length > 0).join('\n'),
    };
    if (rows !== undefined) {
      return { ...payload, components: rows };
    }
    return payload;
  }
  // UX-3: actionable next-step hint per (status × reason). The reason
  // text continues to ride the message verbatim so operators can replay
  // it; the hint translates the implementation-shape reason into
  // operator language.
  const hint = buildSubagentOperatorActionHint(result.status, result.reason);
  const lines: string[] = [
    'Subagent operator request was not applied.',
    `Status: ${result.status}`,
    `Reason: ${result.reason}`,
  ];
  if (hint !== undefined) {
    lines.push(`💡 ${hint}`);
  }
  return buildMessage(lines);
}

/**
 * UX-3 — translate `/subagents` denial / not-found reasons into one-line
 * operator guidance. The implementation-shape reason still rides the
 * message verbatim above; this hint gives the operator the next concrete
 * action (list / log / inspect rather than retry the same call).
 *
 * Returns `undefined` for shapes where no specific guidance applies; the
 * renderer omits the hint line in that case.
 */
export function buildSubagentOperatorActionHint(
  status: 'denied' | 'not-found',
  reason: string,
): string | undefined {
  if (status === 'not-found') {
    return 'Use `/subagents list` to see the subagents currently tracked, or check the id for typos.';
  }
  // status === 'denied'
  if (
    reason.includes('mid-flight injection is not supported') ||
    reason.includes('send/steer')
  ) {
    return 'Mid-flight provider injection is not supported. Use `/subagents kill <id>` then re-dispatch the parent task with adjusted instructions.';
  }
  if (
    reason.includes('not in an active dispatch state') ||
    reason.includes('not active')
  ) {
    return 'The subagent has already terminated. Use `/subagents log <id>` to inspect its retained evidence, or `/subagents list` to see what is still active.';
  }
  if (reason.includes('subagent-approval-not-routed')) {
    return 'Approval routing for sub-task children is not yet wired. The current dispatch will not consume an approval — run the parent without an approval prompt or use the CLI runner.';
  }
  return 'Use `/subagents list` to see what is currently tracked.';
}

export function renderSubagentOperatorUnavailable(): DiscordMessagePayload {
  return buildMessage([
    'Subagent operator surface is not configured for this service instance.',
    // UX-22: import the env-var name from doctor.ts so a future rename
    // fails the typecheck instead of silently leaving operators with a
    // stale hint pointing at a non-existent variable.
    `💡 Set \`${AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH}\` and re-deploy to enable retained evidence + operator commands. Live operator surface still requires the bot to be wired with a roster registry (default in \`bootstrapDiscordService\`).`,
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

export type ResearchMissionPlanStepState = 'complete' | 'current' | 'pending';

export interface ResearchMissionSummaryPlanStep {
  readonly label: string;
  readonly state: ResearchMissionPlanStepState;
}

export interface ResearchMissionSummaryClaimCounts {
  readonly supported: number;
  readonly uncertain: number;
  readonly challenged: number;
}

export interface ResearchMissionSummaryProofCounts {
  readonly pass: number;
  readonly warn: number;
  readonly fail?: number;
}

export interface ResearchMissionSummaryProofReport {
  readonly reportStatus: 'complete' | 'warn' | 'fail' | 'no-proof' | 'failed';
  readonly completeProofCount: number;
  readonly warnProofCount: number;
  readonly failProofCount: number;
  readonly missingRequiredArtifactCount: number;
  readonly sourceLabel: string;
}

export interface ResearchMissionSubagentRoleState {
  readonly role: string;
  readonly reserved: number;
  readonly spawning: number;
  readonly active: number;
  readonly terminating: number;
  readonly terminated: number;
  readonly failed: number;
}

export interface ResearchMissionSubagentSummary {
  readonly total: number;
  readonly roles: readonly ResearchMissionSubagentRoleState[];
}

export interface ResearchMissionSummaryAction {
  readonly verb: string;
  readonly label: string;
  readonly style?: DiscordButtonStyle;
}

export interface RenderResearchMissionSummaryInput {
  readonly missionId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly owner: string;
  readonly threadLabel: string;
  readonly plan: readonly ResearchMissionSummaryPlanStep[];
  readonly evidenceCount: number;
  readonly claims: ResearchMissionSummaryClaimCounts;
  readonly proof: ResearchMissionSummaryProofCounts;
  readonly proofReport?: ResearchMissionSummaryProofReport;
  readonly subagents?: ResearchMissionSubagentSummary;
  readonly nextActions?: readonly ResearchMissionSummaryAction[];
}

const RESEARCH_MISSION_ACTION_ROW_LIMIT = 5;
const RESEARCH_MISSION_ACTIONS_PER_ROW = 5;
const RESEARCH_MISSION_CUSTOM_ID_PART_LIMITS = {
  verb: 32,
  missionId: 48,
} as const;

function renderResearchMissionPlanMarker(
  state: ResearchMissionPlanStepState,
): string {
  switch (state) {
    case 'complete':
      return '✓';
    case 'current':
      return '▶';
    case 'pending':
      return '□';
  }
  const exhaustive: never = state;
  return exhaustive;
}

function encodeResearchCustomIdPart(
  value: string,
  fallback: string,
  maxLength: number,
): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, maxLength);
  return normalized.length === 0 ? fallback : normalized;
}

function buildResearchMissionActionCustomId(
  missionId: string,
  action: ResearchMissionSummaryAction,
): string {
  const verb = encodeResearchCustomIdPart(
    action.verb,
    'action',
    RESEARCH_MISSION_CUSTOM_ID_PART_LIMITS.verb,
  );
  const id = encodeResearchCustomIdPart(
    missionId,
    'mission',
    RESEARCH_MISSION_CUSTOM_ID_PART_LIMITS.missionId,
  );
  return `research-mission:${verb}:${id}`;
}

function buildResearchMissionActionRows(
  missionId: string,
  actions: readonly ResearchMissionSummaryAction[] | undefined,
): readonly DiscordActionRowDescriptor[] | undefined {
  if (actions === undefined || actions.length === 0) {
    return undefined;
  }

  const visibleActions = actions.slice(
    0,
    RESEARCH_MISSION_ACTION_ROW_LIMIT * RESEARCH_MISSION_ACTIONS_PER_ROW,
  );
  const rows: DiscordActionRowDescriptor[] = [];

  for (
    let index = 0;
    index < visibleActions.length;
    index += RESEARCH_MISSION_ACTIONS_PER_ROW
  ) {
    const chunk = visibleActions.slice(index, index + RESEARCH_MISSION_ACTIONS_PER_ROW);
    rows.push({
      kind: 'action-row',
      components: chunk.map((action) => ({
        kind: 'button',
        customId: buildResearchMissionActionCustomId(missionId, action),
        label: action.label.slice(0, 80),
        style: action.style ?? 'secondary',
      })),
    });
  }

  return rows;
}

function renderResearchMissionSubagentRoleState(
  state: ResearchMissionSubagentRoleState,
): string {
  const parts: string[] = [];
  if (state.active > 0) parts.push(`${state.active} active`);
  if (state.spawning > 0) parts.push(`${state.spawning} spawning`);
  if (state.reserved > 0) parts.push(`${state.reserved} reserved`);
  if (state.terminating > 0) parts.push(`${state.terminating} terminating`);
  const terminal = state.terminated + state.failed;
  if (terminal > 0) parts.push(`${terminal} terminal`);
  return `${sanitizeDiscordHistoryText(state.role, 80)} ${
    parts.length === 0 ? '0' : parts.join(', ')
  }`;
}

function renderResearchMissionSubagentLines(
  subagents: ResearchMissionSubagentSummary | undefined,
): readonly string[] {
  if (subagents === undefined) {
    return [];
  }
  if (subagents.total === 0 || subagents.roles.length === 0) {
    return [
      'Subagents: none matched for this mission',
      'Subagent roles: use `/subagents action:spawn mission_id:<id> role:<role> text:<task>` for the role envelope preflight, then `/subagents action:tree mission_id:<id>` after live dispatch.',
    ];
  }
  return [
    `Subagents: ${subagents.total} mission match${
      subagents.total === 1 ? '' : 'es'
    }`,
    `Subagent roles: ${subagents.roles
      .map(renderResearchMissionSubagentRoleState)
      .join('; ')}`,
  ];
}

export function renderResearchMissionSummary(
  input: RenderResearchMissionSummaryInput,
): DiscordMessagePayload {
  const proofReportLines =
    input.proofReport === undefined
      ? []
      : [
          `Proof report: ${sanitizeDiscordHistoryText(input.proofReport.reportStatus, 40)} (${sanitizeDiscordHistoryText(input.proofReport.sourceLabel, 160)})`,
          `Proof report counts: ${input.proofReport.completeProofCount} complete, ${input.proofReport.warnProofCount}/${input.proofReport.failProofCount} warn/fail, ${input.proofReport.missingRequiredArtifactCount} missing artifact token${input.proofReport.missingRequiredArtifactCount === 1 ? '' : 's'}`,
        ];
  const lines: string[] = [
    `Research Mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    `Title: ${sanitizeDiscordHistoryText(input.title, 400)}`,
    `Status: ${sanitizeDiscordHistoryText(input.status, 80)}`,
    `Phase: ${sanitizeDiscordHistoryText(input.phase, 160)}`,
    `Owner: ${sanitizeDiscordHistoryText(input.owner, 120)}`,
    `Thread: ${sanitizeDiscordHistoryText(input.threadLabel, 220)}`,
    'Plan:',
    ...input.plan.map(
      (step, index) =>
        `${renderResearchMissionPlanMarker(step.state)} ${index + 1}. ${sanitizeDiscordHistoryText(step.label, 220)}`,
    ),
    `Evidence: ${input.evidenceCount} item${input.evidenceCount === 1 ? '' : 's'}`,
    `Claims: ${input.claims.supported} supported, ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged`,
    `Proof: ${input.proof.pass} PASS, ${input.proof.warn} WARN${
      input.proof.fail === undefined ? '' : `, ${input.proof.fail} FAIL`
    }`,
    ...renderResearchMissionSubagentLines(input.subagents),
    ...proofReportLines,
  ];

  const rows = buildResearchMissionActionRows(input.missionId, input.nextActions);
  const visibleActions =
    input.nextActions?.slice(
      0,
      RESEARCH_MISSION_ACTION_ROW_LIMIT * RESEARCH_MISSION_ACTIONS_PER_ROW,
    ) ?? [];
  lines.push(
    visibleActions.length === 0
      ? 'Next: none queued.'
      : `Next: ${visibleActions
          .map((action) => `[${sanitizeDiscordHistoryText(action.label, 80)}]`)
          .join(' ')}`,
  );

  const payload: DiscordMessagePayload = buildNoMentionMessage(lines);
  return rows === undefined ? payload : { ...payload, components: rows };
}

function summarizeResearchMissionPlanProgress(
  plan: readonly ResearchMissionSummaryPlanStep[],
): {
  readonly completed: number;
  readonly total: number;
  readonly currentLabel: string;
} {
  return {
    completed: plan.filter((step) => step.state === 'complete').length,
    total: plan.length,
    currentLabel: plan.find((step) => step.state === 'current')?.label ?? 'none',
  };
}

export function renderResearchMissionPinnedSummary(
  input: RenderResearchMissionSummaryInput,
): DiscordMessagePayload {
  const progress = summarizeResearchMissionPlanProgress(input.plan);
  const visibleActions = input.nextActions?.slice(0, RESEARCH_MISSION_ACTIONS_PER_ROW) ?? [];
  const proofReportSuffix =
    input.proofReport === undefined
      ? ''
      : ` · Report: ${sanitizeDiscordHistoryText(input.proofReport.reportStatus, 40)}, ${input.proofReport.missingRequiredArtifactCount} missing`;
  const subagentSuffix =
    input.subagents === undefined || input.subagents.total === 0
      ? ''
      : ` · Subagents: ${input.subagents.roles
          .map(renderResearchMissionSubagentRoleState)
          .join('; ')}`;
  const lines: string[] = [
    `📌 Research Mission Pin \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    `Title: ${sanitizeDiscordHistoryText(input.title, 240)}`,
    `Status: ${sanitizeDiscordHistoryText(input.status, 80)} · Phase: ${sanitizeDiscordHistoryText(input.phase, 160)}`,
    `Thread: ${sanitizeDiscordHistoryText(input.threadLabel, 220)}`,
    `Progress: ${progress.completed}/${progress.total} plan steps complete`,
    `Current: ${sanitizeDiscordHistoryText(progress.currentLabel, 220)}`,
    `Evidence: ${input.evidenceCount} item${input.evidenceCount === 1 ? '' : 's'} · Claims: ${input.claims.supported} supported, ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged · Proof: ${input.proof.pass} PASS, ${input.proof.warn} WARN${
      input.proof.fail === undefined ? '' : `, ${input.proof.fail} FAIL`
    }${proofReportSuffix}${subagentSuffix}`,
    visibleActions.length === 0
      ? 'Next: none queued.'
      : `Next: ${visibleActions
          .map((action) => `[${sanitizeDiscordHistoryText(action.label, 80)}]`)
          .join(' ')}`,
  ];

  const rows = buildResearchMissionActionRows(input.missionId, visibleActions);
  const payload: DiscordMessagePayload = buildNoMentionMessage(lines);
  return rows === undefined ? payload : { ...payload, components: rows };
}

export function renderResearchMissionOptionRequired(input: {
  readonly action: string;
  readonly option: string;
  readonly hint: string;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    `\`/research action:${sanitizeDiscordHistoryText(input.action, 40)}\` requires option \`${sanitizeDiscordHistoryText(input.option, 40)}\`.`,
    `💡 ${sanitizeDiscordHistoryText(input.hint, 320)}`,
  ]);
}

export function renderResearchMissionNotFound(
  missionId: string,
): DiscordMessagePayload {
  return buildNoMentionMessage([
    `Research mission \`${sanitizeDiscordHistoryText(missionId, 80)}\` is not tracked by this Discord service instance.`,
    '💡 Use `/research action:new instruction:<goal>` to create a draft mission, or copy the mission id from a recent mission summary.',
  ]);
}

export function renderResearchMissionOwnerRequired(input: {
  readonly missionId: string;
  readonly action: string;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    `Research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\` was not changed.`,
    `Requested action: /research action:${sanitizeDiscordHistoryText(input.action, 40)}`,
    'Only the mission owner or a Discord admin can change this mission lifecycle state.',
  ]);
}

export function renderResearchMissionChannelRequired(): DiscordMessagePayload {
  return buildNoMentionMessage([
    '`/research action:new` needs a Discord channel context so the mission can retain a current-channel binding.',
    'Try again from the target research channel or thread.',
  ]);
}

export function renderResearchMissionPlanUnavailable(input: {
  readonly planId: string;
  readonly reason: string;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    `Research plan \`${sanitizeDiscordHistoryText(input.planId, 80)}\` could not be loaded for mission approval.`,
    `Reason: ${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(input.reason), 360)}`,
    '💡 Create or fix the plan under `runtime-state/research-plans/`, then retry `/research action:approve mission_id:<id> plan_id:<id>`.',
  ]);
}

export interface RenderResearchEvidenceItemInput {
  readonly evidenceId: string;
  readonly summary: string;
  readonly source: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface RenderResearchClaimInput {
  readonly claimId: string;
  readonly text: string;
  readonly status: string;
  readonly supportEvidenceIds: readonly string[];
  readonly challengeEvidenceIds: readonly string[];
}

const RESEARCH_EVIDENCE_LIST_LIMIT = 10;
const RESEARCH_CLAIM_LIST_LIMIT = 10;

export function renderResearchStateOptionRequired(input: {
  readonly command: 'evidence' | 'claim' | 'critique';
  readonly action: string;
  readonly option: string;
  readonly hint: string;
}): DiscordMessagePayload {
  const commandPrefix =
    input.command === 'critique'
      ? '/critique'
      : `/${input.command} action:${sanitizeDiscordHistoryText(input.action, 40)}`;
  return buildNoMentionMessage([
    `\`${commandPrefix}\` requires option \`${sanitizeDiscordHistoryText(input.option, 40)}\`.`,
    `💡 ${sanitizeDiscordHistoryText(input.hint, 320)}`,
  ]);
}

export function renderResearchEvidenceAdded(input: {
  readonly missionId: string;
  readonly evidence: RenderResearchEvidenceItemInput;
  readonly evidenceCount: number;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    `Evidence \`${sanitizeDiscordHistoryText(input.evidence.evidenceId, 80)}\` added to research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\`.`,
    `Summary: ${sanitizeDiscordHistoryText(input.evidence.summary, 420)}`,
    `Source: ${sanitizeDiscordHistoryText(input.evidence.source, 180)}`,
    `Mission evidence count: ${input.evidenceCount}`,
    'Next: use `/claim action:support mission_id:<id> claim_id:<id> evidence_id:<id>` or `/evidence action:list mission_id:<id>`.',
  ]);
}

export function renderResearchEvidenceList(input: {
  readonly missionId: string;
  readonly evidence: readonly RenderResearchEvidenceItemInput[];
}): DiscordMessagePayload {
  const visibleEvidence = input.evidence.slice(0, RESEARCH_EVIDENCE_LIST_LIMIT);
  const lines: string[] = [
    `Evidence for research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
  ];
  if (visibleEvidence.length === 0) {
    lines.push('No evidence items recorded yet.');
  } else {
    lines.push(
      ...visibleEvidence.map(
        (item, index) =>
          `${index + 1}. \`${sanitizeDiscordHistoryText(item.evidenceId, 80)}\` — ${sanitizeDiscordHistoryText(item.summary, 260)} (${sanitizeDiscordHistoryText(item.source, 120)})`,
      ),
    );
    if (input.evidence.length > visibleEvidence.length) {
      lines.push(`… ${input.evidence.length - visibleEvidence.length} more item(s) omitted.`);
    }
  }
  return buildNoMentionMessage(lines);
}

export function renderResearchClaimAdded(input: {
  readonly missionId: string;
  readonly claim: RenderResearchClaimInput;
  readonly claims: ResearchMissionSummaryClaimCounts;
}): DiscordMessagePayload {
  return buildNoMentionMessage([
    `Claim \`${sanitizeDiscordHistoryText(input.claim.claimId, 80)}\` added to research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\`.`,
    `Status: ${sanitizeDiscordHistoryText(input.claim.status, 80)}`,
    `Claim: ${sanitizeDiscordHistoryText(input.claim.text, 420)}`,
    `Mission claims: ${input.claims.supported} supported, ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged`,
    'Next: connect evidence with `/claim action:support` or `/claim action:challenge`.',
  ]);
}

export function renderResearchClaimLinked(input: {
  readonly missionId: string;
  readonly claim: RenderResearchClaimInput;
  readonly evidenceId: string;
  readonly mode: 'support' | 'challenge';
  readonly claims: ResearchMissionSummaryClaimCounts;
}): DiscordMessagePayload {
  const verb = input.mode === 'support' ? 'supports' : 'challenges';
  return buildNoMentionMessage([
    `Evidence \`${sanitizeDiscordHistoryText(input.evidenceId, 80)}\` now ${verb} claim \`${sanitizeDiscordHistoryText(input.claim.claimId, 80)}\` in research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\`.`,
    `Claim status: ${sanitizeDiscordHistoryText(input.claim.status, 80)}`,
    `Claim: ${sanitizeDiscordHistoryText(input.claim.text, 420)}`,
    `Mission claims: ${input.claims.supported} supported, ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged`,
  ]);
}

export function renderResearchClaimLinkFailed(input: {
  readonly missionId: string;
  readonly claimId?: string;
  readonly evidenceId?: string;
  readonly reason: 'claim-not-found' | 'evidence-not-found';
}): DiscordMessagePayload {
  const reason =
    input.reason === 'claim-not-found'
      ? `Claim \`${sanitizeDiscordHistoryText(input.claimId ?? 'unknown', 80)}\` is not tracked for this mission.`
      : `Evidence \`${sanitizeDiscordHistoryText(input.evidenceId ?? 'unknown', 80)}\` is not tracked for this mission.`;
  return buildNoMentionMessage([
    `Could not link claim/evidence for research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\`.`,
    reason,
    '💡 Use `/claim action:list mission_id:<id>` and `/evidence action:list mission_id:<id>` to copy current ids.',
  ]);
}

export function renderResearchClaimList(input: {
  readonly missionId: string;
  readonly claims: readonly RenderResearchClaimInput[];
}): DiscordMessagePayload {
  const visibleClaims = input.claims.slice(0, RESEARCH_CLAIM_LIST_LIMIT);
  const lines: string[] = [
    `Claims for research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
  ];
  if (visibleClaims.length === 0) {
    lines.push('No claims recorded yet.');
  } else {
    lines.push(
      ...visibleClaims.map((claim, index) => {
        const support = claim.supportEvidenceIds.length;
        const challenge = claim.challengeEvidenceIds.length;
        return `${index + 1}. \`${sanitizeDiscordHistoryText(claim.claimId, 80)}\` [${sanitizeDiscordHistoryText(claim.status, 80)}] — ${sanitizeDiscordHistoryText(claim.text, 260)} (support:${support}, challenge:${challenge})`;
      }),
    );
    if (input.claims.length > visibleClaims.length) {
      lines.push(`… ${input.claims.length - visibleClaims.length} more claim(s) omitted.`);
    }
  }
  return buildNoMentionMessage(lines);
}

export type ResearchCritiqueLens =
  | 'methodology'
  | 'evidence'
  | 'counterargument'
  | 'reproducibility';

export interface RenderResearchCritiquePreflightInput {
  readonly missionId: string;
  readonly lens: ResearchCritiqueLens;
  readonly missionStatus: string;
  readonly phase: string;
  readonly evidenceCount: number;
  readonly claims: ResearchMissionSummaryClaimCounts;
  readonly latestSynthesisId?: string;
  readonly warnings: readonly string[];
}

export interface RenderResearchMissionDoctorInput {
  readonly missionId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly owner: string;
  readonly threadLabel: string;
  readonly threadBound: boolean;
  readonly planId?: string;
  readonly evidenceCount: number;
  readonly claims: ResearchMissionSummaryClaimCounts;
  readonly proof: ResearchMissionSummaryProofCounts;
  readonly latestSynthesisId?: string;
  readonly runtimeProviderScope: DoctorReportInput['runtimeProviderScope'];
  readonly activeRuntimeProvider?: DoctorReportInput['activeRuntimeProvider'];
  readonly liveProofReport?: DoctorReportInput['liveProofReport'];
}

function renderResearchCritiqueLensFocus(
  lens: ResearchCritiqueLens,
): readonly string[] {
  switch (lens) {
    case 'methodology':
      return [
        'Check whether the plan, evidence, and synthesis method match the research question.',
        'Look for missing baselines, invalid comparisons, or over-broad conclusions.',
      ];
    case 'evidence':
      return [
        'Check whether each important claim has retained evidence and clear provenance.',
        'Look for stale, ambiguous, or unsupported evidence links before closeout.',
      ];
    case 'counterargument':
      return [
        'Stress-test supported claims with plausible alternatives and failure modes.',
        'Look for unaddressed challenged/uncertain claims before archive closeout.',
      ];
    case 'reproducibility':
      return [
        'Check whether another operator can reproduce the evidence, tests, and proof path.',
        'Look for missing artifacts, unrecorded commands, or operator-only assumptions.',
      ];
  }
  const exhaustive: never = lens;
  return [exhaustive];
}

export function renderResearchCritiquePreflight(
  input: RenderResearchCritiquePreflightInput,
): DiscordMessagePayload {
  const warnings = input.warnings.map(
    (warning) => `! ${sanitizeDiscordHistoryText(warning, 180)}`,
  );
  const focus = renderResearchCritiqueLensFocus(input.lens).map(
    (item) => `- ${sanitizeDiscordHistoryText(item, 220)}`,
  );
  return buildNoMentionMessage([
    `Critique preflight for research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    `Lens: ${sanitizeDiscordHistoryText(input.lens, 80)}`,
    `Mission: ${sanitizeDiscordHistoryText(input.missionStatus, 80)} · ${sanitizeDiscordHistoryText(input.phase, 160)}`,
    `Evidence: ${input.evidenceCount} item${input.evidenceCount === 1 ? '' : 's'}`,
    `Claims: ${input.claims.supported} supported, ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged`,
    `Synthesis: ${
      input.latestSynthesisId === undefined
        ? 'missing'
        : `\`${sanitizeDiscordHistoryText(input.latestSynthesisId, 80)}\``
    }`,
    'Lens focus:',
    ...focus,
    'Preflight warnings:',
    ...(warnings.length === 0 ? ['- none'] : warnings),
    'Boundary: read-only preflight only; no external critic invoked and no evidence, claim, proof, GitLab, or archive state mutated.',
    'Next: fix warnings, then run a future critique execution slice or record reviewer findings as `/evidence` and `/claim` updates.',
  ]);
}

function renderResearchMissionDoctorMarker(complete: boolean): string {
  return complete ? '✓' : '!';
}

function renderResearchMissionDoctorProofLine(
  liveProof: DoctorReportInput['liveProofReport'] | undefined,
): {
  readonly complete: boolean;
  readonly text: string;
} {
  if (liveProof === undefined) {
    return {
      complete: false,
      text: 'global proof report not configured',
    };
  }
  if (liveProof.error !== undefined) {
    return {
      complete: false,
      text: `global proof report failed: ${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(liveProof.error), 180)}`,
    };
  }
  const reportStatus = liveProof.reportStatus ?? 'no-proof';
  const complete = liveProof.completeProofCount ?? 0;
  const warn = liveProof.warnProofCount ?? 0;
  const fail = liveProof.failProofCount ?? 0;
  const missing = liveProof.missingRequiredArtifactCount ?? 0;
  const proofComplete =
    reportStatus === 'complete' && warn === 0 && fail === 0 && missing === 0;
  return {
    complete: proofComplete,
    text: `global proof report ${reportStatus}: ${complete} complete, ${warn}/${fail} warn/fail, ${missing} missing artifact token${missing === 1 ? '' : 's'}`,
  };
}

function buildResearchMissionDoctorNextAction(
  input: RenderResearchMissionDoctorInput,
): string {
  const mission = sanitizeDiscordHistoryText(input.missionId, 80);
  const unresolvedClaims = input.claims.uncertain + input.claims.challenged;
  const proofLine = renderResearchMissionDoctorProofLine(input.liveProofReport);
  if (input.planId === undefined) {
    return `/research action:approve mission_id:${mission} plan_id:<id>`;
  }
  if (input.evidenceCount === 0) {
    return `/evidence action:add mission_id:${mission}`;
  }
  if (input.latestSynthesisId === undefined) {
    return `/research action:synthesize mission_id:${mission}`;
  }
  if (unresolvedClaims > 0) {
    return `/critique mission_id:${mission} lens:counterargument`;
  }
  if (!proofLine.complete) {
    return `/proof action:status mission_id:${mission}`;
  }
  return `/research action:archive mission_id:${mission}`;
}

export function renderResearchMissionDoctor(
  input: RenderResearchMissionDoctorInput,
): DiscordMessagePayload {
  const providerKnown =
    input.activeRuntimeProvider !== undefined &&
    `${input.activeRuntimeProvider}`.trim().length > 0;
  const synthesisExists = input.latestSynthesisId !== undefined;
  const unresolvedClaims = input.claims.uncertain + input.claims.challenged;
  const proofLine = renderResearchMissionDoctorProofLine(input.liveProofReport);
  const missionProofFail = input.proof.fail ?? 0;
  return buildNoMentionMessage([
    `Research Mission Doctor \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    `Title: ${sanitizeDiscordHistoryText(input.title, 240)}`,
    `Status: ${sanitizeDiscordHistoryText(input.status, 80)} · Phase: ${sanitizeDiscordHistoryText(input.phase, 160)}`,
    `Owner: ${sanitizeDiscordHistoryText(input.owner, 120)}`,
    `Thread: ${sanitizeDiscordHistoryText(input.threadLabel, 220)}`,
    'Runtime:',
    `${renderResearchMissionDoctorMarker(providerKnown)} provider: ${
      providerKnown
        ? sanitizeDiscordHistoryText(input.activeRuntimeProvider, 80)
        : 'unknown'
    } (scope: ${sanitizeDiscordHistoryText(input.runtimeProviderScope, 80)})`,
    `${renderResearchMissionDoctorMarker(input.threadBound)} mission thread: ${
      input.threadBound ? 'bound' : 'current channel only'
    }`,
    'Research integrity:',
    `${renderResearchMissionDoctorMarker(input.planId !== undefined)} plan approved: ${
      input.planId === undefined
        ? 'missing'
        : sanitizeDiscordHistoryText(input.planId, 120)
    }`,
    `${renderResearchMissionDoctorMarker(synthesisExists)} synthesis: ${
      synthesisExists
        ? sanitizeDiscordHistoryText(input.latestSynthesisId, 120)
        : 'missing'
    }`,
    `${renderResearchMissionDoctorMarker(input.evidenceCount > 0)} evidence retained: ${input.evidenceCount} item${input.evidenceCount === 1 ? '' : 's'}`,
    `${renderResearchMissionDoctorMarker(unresolvedClaims === 0)} claims unresolved: ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged`,
    'Proof:',
    `${renderResearchMissionDoctorMarker(proofLine.complete)} ${proofLine.text}`,
    `Mission-local proof: ${input.proof.pass} PASS, ${input.proof.warn} WARN, ${missionProofFail} FAIL`,
    `Recommended next action: ${buildResearchMissionDoctorNextAction(input)}`,
    'Boundary: read-only mission doctor; no proof files are read or written here, no GitLab write or live service contact occurs, and mission state is not mutated.',
  ]);
}

export interface RenderResearchSynthesisInput {
  readonly missionId: string;
  readonly synthesisId: string;
  readonly body: string;
  readonly evidenceCount: number;
  readonly claims: ResearchMissionSummaryClaimCounts;
  readonly createdBy: string;
  readonly createdAt: string;
}

const RESEARCH_SYNTHESIS_BODY_LINE_LIMIT = 12;

export function renderResearchSynthesis(
  input: RenderResearchSynthesisInput,
): DiscordMessagePayload {
  const bodyLines = input.body
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const visibleBodyLines = bodyLines
    .slice(0, RESEARCH_SYNTHESIS_BODY_LINE_LIMIT)
    .map((line) => sanitizeDiscordHistoryText(line, 340));
  let omittedLineCount = bodyLines.length - visibleBodyLines.length;
  const buildLines = (): string[] => {
    const lines: string[] = [
      `Synthesis draft \`${sanitizeDiscordHistoryText(input.synthesisId, 80)}\` for research mission \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
      `Generated by: ${sanitizeDiscordHistoryText(input.createdBy, 120)} at ${sanitizeDiscordHistoryText(input.createdAt, 120)}`,
      `Evidence basis: ${input.evidenceCount} item${input.evidenceCount === 1 ? '' : 's'}`,
      `Claims: ${input.claims.supported} supported, ${input.claims.uncertain} uncertain, ${input.claims.challenged} challenged`,
      'Draft:',
      ...visibleBodyLines,
    ];
    if (omittedLineCount > 0) {
      lines.push(`… ${omittedLineCount} more synthesis line(s) omitted.`);
    }
    lines.push(
      'Next: review with `/claim action:list` or `/evidence action:list`; archive closeout is a later slice.',
    );
    return lines;
  };
  let lines = buildLines();
  while (
    buildMessage(lines).content.length > DISCORD_MESSAGE_LIMIT &&
    visibleBodyLines.length > 0
  ) {
    visibleBodyLines.pop();
    omittedLineCount += 1;
    lines = buildLines();
  }
  return buildNoMentionMessage(lines);
}

export interface RenderProofStatusInput {
  readonly missionId?: string;
  readonly mission?: {
    readonly missionId: string;
    readonly status: string;
    readonly phase: string;
    readonly proof: ResearchMissionSummaryProofCounts;
    readonly proofLinkCount?: number;
  };
  readonly liveProofReport?: DoctorReportInput['liveProofReport'];
}

export type RenderProofLinkStatus = 'pass' | 'warn' | 'fail';

export type RenderProofLinkResultInput =
  | {
      readonly status: 'linked';
      readonly missionId: string;
      readonly proofId: string;
      readonly surface: string;
      readonly proofStatus: RenderProofLinkStatus;
      readonly artifactTokens: readonly string[];
      readonly summary: string;
    }
  | {
      readonly status: 'missing-option';
      readonly option: 'mission_id' | 'surface' | 'proof_id' | 'status';
    }
  | {
      readonly status: 'invalid-surface';
      readonly surface: string;
    }
  | {
      readonly status: 'invalid-status';
      readonly proofStatus?: string;
    }
  | {
      readonly status: 'mission-not-found';
      readonly missionId: string;
    };

export interface RenderProofExportTemplateInput {
  readonly missionId?: string;
  readonly surface?: string;
  readonly generatedAt?: string;
}

export interface RenderProofCapturePreflightInput {
  readonly missionId?: string;
  readonly surface?: string;
}

export interface RenderProofStartPreflightInput {
  readonly missionId?: string;
  readonly surface?: string;
}

export function renderProofStatus(input: RenderProofStatusInput): DiscordMessagePayload {
  const lines: string[] = ['Proof status'];
  if (input.mission !== undefined) {
    const missionProofFail = input.mission.proof.fail ?? 0;
    lines.push(
      `Mission: ${sanitizeDiscordHistoryText(input.mission.missionId, 80)} (${sanitizeDiscordHistoryText(input.mission.status, 40)} · ${sanitizeDiscordHistoryText(input.mission.phase, 120)})`,
    );
    lines.push(
      `Mission-local proof: ${input.mission.proof.pass} PASS, ${input.mission.proof.warn} WARN, ${missionProofFail} FAIL`,
    );
    lines.push(
      `Mission proof links: ${input.mission.proofLinkCount ?? 0} linked artifact${(input.mission.proofLinkCount ?? 0) === 1 ? '' : 's'}.`,
    );
  } else if (input.missionId !== undefined && input.missionId.trim().length > 0) {
    lines.push(
      `Mission: ${sanitizeDiscordHistoryText(input.missionId, 80)} (global manifest status; mission not tracked for local proof links)`,
    );
  }

  const liveProof = input.liveProofReport;
  if (liveProof === undefined) {
    return buildNoMentionMessage([
      ...lines,
      'Configured manifest: none',
      'Report status: no-proof',
      `Next: configure \`${AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH}\` or run \`pnpm live:proof:report -- --print-template --surface <surface> --pretty\` to create an operator-owned skeleton.`,
      'Boundary: read-only Discord status; no proof files are read here, no live services are contacted, and raw proof summaries/correlation ids are not rendered.',
    ]);
  }

  lines.push(`Manifest: ${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(liveProof.proofPath), 160)}`);
  lines.push(`Max proof bytes: ${liveProof.maxProofBytes}`);
  if (liveProof.error !== undefined) {
    lines.push(
      `Report status: failed (${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(liveProof.error), 240)})`,
    );
    lines.push(
      'Next: fix the configured manifest path or byte guard, then rerun `/proof action:status`.',
    );
  } else {
    const reportStatus = liveProof.reportStatus ?? 'no-proof';
    lines.push(`Report status: ${reportStatus}`);
    lines.push(`Proof records: ${liveProof.proofRecordCount ?? 0}`);
    lines.push(`Complete proofs: ${liveProof.completeProofCount ?? 0}`);
    lines.push(`Warn/fail proofs: ${liveProof.warnProofCount ?? 0}/${liveProof.failProofCount ?? 0}`);
    lines.push(`Operator-approved proofs: ${liveProof.operatorApprovedCount ?? 0}`);
    lines.push(`Unsafe boundaries: ${liveProof.unsafeBoundaryCount ?? 0}`);
    lines.push(`Missing artifact tokens: ${liveProof.missingRequiredArtifactCount ?? 0}`);
    lines.push(`Quality score: ${liveProof.qualityScore ?? 0}/${liveProof.qualityScoreMax ?? 100}`);
    lines.push('Raw summaries: not rendered');
    lines.push('Raw correlation ids: not rendered');
    lines.push('Live service contact: none');
    if (liveProof.recommendation !== undefined) {
      lines.push(
        `Next: ${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(liveProof.recommendation), 320)}`,
      );
    } else if (reportStatus === 'complete') {
      lines.push('Next: proof artifact gate is complete for the configured manifest.');
    }
  }
  return buildNoMentionMessage(lines);
}

export function renderProofLinkResult(
  input: RenderProofLinkResultInput,
): DiscordMessagePayload {
  const lines: string[] = ['Proof link'];
  if (input.status === 'linked') {
    const artifactTokenLine =
      input.artifactTokens.length === 0
        ? 'Artifact tokens: none'
        : `Artifact tokens: ${input.artifactTokens.length} (${input.artifactTokens
            .map((token) => sanitizeDiscordHistoryText(token, 80))
            .join(', ')})`;
    return buildNoMentionMessage([
      ...lines,
      'Status: linked',
      `Mission: ${sanitizeDiscordHistoryText(input.missionId, 80)}`,
      `Surface: ${sanitizeDiscordHistoryText(input.surface, 80)}`,
      `Proof: ${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(input.proofId), 120)} [${input.proofStatus}]`,
      artifactTokenLine,
      `Summary: ${sanitizeDiscordHistoryText(redactDiscordFilesystemPaths(input.summary).replace(/@\u200B+/gu, '@'), 240)}`,
      'Boundary: operator-owned metadata link only; no proof files are read or written, no manifests are mutated, no live services are contacted, and raw proof artifacts/correlation ids are not rendered.',
    ]);
  }
  if (input.status === 'missing-option') {
    return buildNoMentionMessage([
      ...lines,
      'Status: rejected',
      `Reason: /proof action:link requires \`${input.option}\`.`,
      'Next: rerun `/proof action:link mission_id:<id> surface:<surface> proof_id:<id> status:<pass|warn|fail>` after operator-owned proof scoring.',
      'Boundary: no mission proof state was mutated.',
    ]);
  }
  if (input.status === 'invalid-surface') {
    return buildNoMentionMessage([
      ...lines,
      'Status: rejected',
      `Surface: invalid (${sanitizeDiscordHistoryText(input.surface, 80)})`,
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: no mission proof state was mutated.',
    ]);
  }
  if (input.status === 'invalid-status') {
    return buildNoMentionMessage([
      ...lines,
      'Status: rejected',
      `Proof status: invalid (${sanitizeDiscordHistoryText(input.proofStatus ?? 'missing', 40)})`,
      'Known statuses: pass, warn, fail',
      'Boundary: no mission proof state was mutated.',
    ]);
  }
  return buildNoMentionMessage([
    ...lines,
    'Status: rejected',
    `Mission: ${sanitizeDiscordHistoryText(input.missionId, 80)} not tracked.`,
    'Next: create the mission first with `/research action:new`, then rerun `/proof action:link`.',
    'Boundary: no mission proof state was mutated.',
  ]);
}

export function renderProofExportTemplate(
  input: RenderProofExportTemplateInput,
): DiscordMessagePayload {
  const lines: string[] = ['Proof export template'];
  if (input.missionId !== undefined && input.missionId.trim().length > 0) {
    lines.push(
      `Mission: ${sanitizeDiscordHistoryText(input.missionId, 80)} (header context only; proof records remain operator-owned)`,
    );
  }

  const rawSurface = input.surface?.trim();
  if (rawSurface === undefined || rawSurface.length === 0) {
    return buildNoMentionMessage([
      ...lines,
      'Surface: missing',
      'Next: rerun `/proof action:export surface:<surface>` with one live-proof matrix surface.',
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: template-only Discord export; no proof files are read or written and no live services are contacted.',
    ]);
  }
  if (!isLiveProofSurface(rawSurface)) {
    return buildNoMentionMessage([
      ...lines,
      `Surface: invalid (${sanitizeDiscordHistoryText(rawSurface, 80)})`,
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: template-only Discord export; no proof files are read or written and no live services are contacted.',
    ]);
  }

  const manifest = buildLiveProofManifestTemplateFromCliOptions({
    proofPaths: [],
    surfaces: [rawSurface],
    maxProofBytes: LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES,
    pretty: true,
    printTemplate: true,
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
  });
  const manifestJson = JSON.stringify(manifest, null, 2);
  return buildNoMentionMessage([
    ...lines,
    `Surface: ${rawSurface}`,
    'Status: template-only WARN; replace placeholders with redacted operator-owned live proof before promotion.',
    `Compatibility: save the JSON as a manifest and run \`pnpm live:proof:report -- --proof <path> --surface ${rawSurface} --pretty\`.`,
    'Boundary: no proof files read/written, no live services contacted, raw summaries/correlation ids not rendered.',
    '```json',
    manifestJson,
    '```',
  ]);
}

export function renderProofCapturePreflight(
  input: RenderProofCapturePreflightInput,
): DiscordMessagePayload {
  const lines: string[] = ['Proof capture preflight'];
  if (input.missionId !== undefined && input.missionId.trim().length > 0) {
    lines.push(
      `Mission: ${sanitizeDiscordHistoryText(input.missionId, 80)} (header context only; proof records remain operator-owned)`,
    );
  }

  const rawSurface = input.surface?.trim();
  if (rawSurface === undefined || rawSurface.length === 0) {
    return buildNoMentionMessage([
      ...lines,
      'Surface: missing',
      'Next: rerun `/proof action:capture surface:<surface>` with one live-proof matrix surface.',
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: operator-capture preflight only; no proof files are read or written, no manifests are mutated, and no live services are contacted.',
    ]);
  }
  if (!isLiveProofSurface(rawSurface)) {
    return buildNoMentionMessage([
      ...lines,
      `Surface: invalid (${sanitizeDiscordHistoryText(rawSurface, 80)})`,
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: operator-capture preflight only; no proof files are read or written, no manifests are mutated, and no live services are contacted.',
    ]);
  }

  return buildNoMentionMessage([
    ...lines,
    `Surface: ${rawSurface}`,
    'Status: operator-capture preflight; no live proof artifact has been captured by Discord.',
    'Operator steps:',
    '1. Run or collect the live proof for this surface outside Discord.',
    '2. Save only redacted artifact references/summaries; exclude secrets, raw prompts, raw responses, credentials, and private artifact contents.',
    `3. Create or update the manifest with \`pnpm live:proof:report -- --print-template --surface ${rawSurface} --pretty\`, replace placeholders with operator-owned evidence, then score it with \`pnpm live:proof:report -- --proof <path> --surface ${rawSurface} --pretty\`.`,
    'Next: rerun `/proof action:status` after the operator-owned manifest is configured.',
    'Boundary: preflight guidance only; no proof files are read/written, no live services contacted, no manifest mutation performed, and no mission proof link is created.',
  ]);
}

export function renderProofStartPreflight(
  input: RenderProofStartPreflightInput,
): DiscordMessagePayload {
  const lines: string[] = ['Proof start preflight'];
  if (input.missionId !== undefined && input.missionId.trim().length > 0) {
    lines.push(
      `Mission: ${sanitizeDiscordHistoryText(input.missionId, 80)} (header context only; proof records remain operator-owned)`,
    );
  }

  const rawSurface = input.surface?.trim();
  if (rawSurface === undefined || rawSurface.length === 0) {
    return buildNoMentionMessage([
      ...lines,
      'Surface: missing',
      'Next: rerun `/proof action:start surface:<surface>` with one live-proof matrix surface.',
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: start preflight only; no proof process is spawned, no proof files are read or written, no manifests are mutated, and no live services are contacted.',
    ]);
  }
  if (!isLiveProofSurface(rawSurface)) {
    return buildNoMentionMessage([
      ...lines,
      `Surface: invalid (${sanitizeDiscordHistoryText(rawSurface, 80)})`,
      `Known surfaces: ${LIVE_PROOF_SURFACES.join(', ')}`,
      'Boundary: start preflight only; no proof process is spawned, no proof files are read or written, no manifests are mutated, and no live services are contacted.',
    ]);
  }

  return buildNoMentionMessage([
    ...lines,
    `Surface: ${rawSurface}`,
    'Status: operator-start preflight; Discord has not executed live proof.',
    'Start plan:',
    '1. Confirm the surface checklist in `specs/CURRENT/live-proof-matrix.md`.',
    '2. Collect the live evidence outside Discord under operator control.',
    `3. Use \`/proof action:export surface:${rawSurface}\` for the manifest skeleton.`,
    `4. Use \`/proof action:capture surface:${rawSurface}\` for redaction and scoring steps.`,
    `5. Score the redacted manifest with \`pnpm live:proof:report -- --proof <path> --surface ${rawSurface} --pretty\`.`,
    `Next: run \`/proof action:capture surface:${rawSurface}\` when the operator is ready to record evidence.`,
    'Boundary: preflight guidance only; no proof process is spawned, no proof files are read/written, no manifests are mutated, no live services contacted, and no mission proof link is created.',
  ]);
}

export function renderProofActionUnsupported(action: string): DiscordMessagePayload {
  return buildNoMentionMessage([
    `Proof action \`${sanitizeDiscordHistoryText(action, 40)}\` is not implemented yet.`,
    'Supported actions in this slice: `/proof action:status`, `/proof action:start surface:<surface>`, `/proof action:export surface:<surface>`, `/proof action:capture surface:<surface>`, and `/proof action:link mission_id:<id> surface:<surface> proof_id:<id> status:<pass|warn|fail>`.',
    'Future proof execution slices must still avoid promoting static status/templates/preflight cards to live proof.',
  ]);
}

function isLiveProofSurface(value: string): value is LiveProofSurface {
  return (LIVE_PROOF_SURFACES as readonly string[]).includes(value);
}

function redactDiscordFilesystemPaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s`'")\]]+/gu, '[path]')
    .replace(/(^|[\s("'=])\/[^\s`'")\]]+/gu, '$1[path]');
}

export interface ResearchSubtaskCardRecentEvent {
  readonly text: string;
}

export interface ResearchSubtaskCardAction {
  readonly verb: string;
  readonly label: string;
  readonly style?: DiscordButtonStyle;
}

export interface RenderResearchSubtaskCardInput {
  readonly subtaskId: string;
  readonly index: number;
  readonly total: number;
  readonly title: string;
  readonly status: string;
  readonly role: string;
  readonly provider: string;
  readonly startedAt: string;
  readonly recentEvents?: readonly ResearchSubtaskCardRecentEvent[];
  readonly actions?: readonly ResearchSubtaskCardAction[];
}

const RESEARCH_SUBTASK_ACTION_ROW_LIMIT = 5;
const RESEARCH_SUBTASK_ACTIONS_PER_ROW = 5;
const RESEARCH_SUBTASK_RECENT_EVENT_DISPLAY_LIMIT = 3;
const RESEARCH_SUBTASK_ACTION_LABEL_DISPLAY_LIMIT = 4;
const RESEARCH_SUBTASK_CUSTOM_ID_PART_LIMITS = {
  verb: 32,
  subtaskId: 48,
} as const;

function buildResearchSubtaskActionCustomId(
  subtaskId: string,
  action: ResearchSubtaskCardAction,
): string {
  const verb = encodeResearchCustomIdPart(
    action.verb,
    'action',
    RESEARCH_SUBTASK_CUSTOM_ID_PART_LIMITS.verb,
  );
  const id = encodeResearchCustomIdPart(
    subtaskId,
    'subtask',
    RESEARCH_SUBTASK_CUSTOM_ID_PART_LIMITS.subtaskId,
  );
  return `research-subtask:${verb}:${id}`;
}

function buildResearchSubtaskActionRows(
  subtaskId: string,
  actions: readonly ResearchSubtaskCardAction[] | undefined,
): readonly DiscordActionRowDescriptor[] | undefined {
  if (actions === undefined || actions.length === 0) {
    return undefined;
  }

  const visibleActions = actions.slice(
    0,
    RESEARCH_SUBTASK_ACTION_ROW_LIMIT * RESEARCH_SUBTASK_ACTIONS_PER_ROW,
  );
  const rows: DiscordActionRowDescriptor[] = [];

  for (
    let index = 0;
    index < visibleActions.length;
    index += RESEARCH_SUBTASK_ACTIONS_PER_ROW
  ) {
    const chunk = visibleActions.slice(index, index + RESEARCH_SUBTASK_ACTIONS_PER_ROW);
    rows.push({
      kind: 'action-row',
      components: chunk.map((action) => ({
        kind: 'button',
        customId: buildResearchSubtaskActionCustomId(subtaskId, action),
        label: action.label.slice(0, 80),
        style: action.style ?? 'secondary',
      })),
    });
  }

  return rows;
}

export function renderResearchSubtaskCard(
  input: RenderResearchSubtaskCardInput,
): DiscordMessagePayload {
  const recentEvents = input.recentEvents ?? [];
  const displayedRecentEvents = recentEvents.slice(
    0,
    RESEARCH_SUBTASK_RECENT_EVENT_DISPLAY_LIMIT,
  );
  const visibleActions =
    input.actions?.slice(
      0,
      RESEARCH_SUBTASK_ACTION_ROW_LIMIT * RESEARCH_SUBTASK_ACTIONS_PER_ROW,
    ) ?? [];
  const visibleActionLabels = visibleActions.slice(
    0,
    RESEARCH_SUBTASK_ACTION_LABEL_DISPLAY_LIMIT,
  );
  const lines: string[] = [
    `Subtask ${input.index}/${input.total}: ${sanitizeDiscordHistoryText(input.title, 240)}`,
    `Status: ${sanitizeDiscordHistoryText(input.status, 80)}`,
    `Role: ${sanitizeDiscordHistoryText(input.role, 80)}`,
    `Provider: ${sanitizeDiscordHistoryText(input.provider, 80)}`,
    `Started: ${sanitizeDiscordHistoryText(input.startedAt, 120)}`,
    'Recent events:',
    ...(recentEvents.length === 0
      ? ['- none yet']
      : displayedRecentEvents.map(
          (event) => `- ${sanitizeDiscordHistoryText(event.text, 240)}`,
        )),
  ];
  if (recentEvents.length > displayedRecentEvents.length) {
    lines.push(
      `- … ${recentEvents.length - displayedRecentEvents.length} more event${
        recentEvents.length - displayedRecentEvents.length === 1 ? '' : 's'
      } omitted`,
    );
  }
  lines.push(
    visibleActions.length === 0
      ? 'Actions: none queued.'
      : `Actions: ${visibleActionLabels
          .map((action) => `[${sanitizeDiscordHistoryText(action.label, 80)}]`)
          .join(' ')}${
          visibleActions.length > visibleActionLabels.length
            ? ` (+${visibleActions.length - visibleActionLabels.length} more actions)`
            : ''
        }`,
  );

  const rows = buildResearchSubtaskActionRows(input.subtaskId, input.actions);
  const payload: DiscordMessagePayload = buildNoMentionMessage(lines);
  return rows === undefined ? payload : { ...payload, components: rows };
}

export interface ResearchSubagentRoleGuide {
  readonly role: string;
  readonly purpose: string;
}

export interface RenderResearchSubagentTreeInput {
  readonly missionId: string;
  readonly operatorConfigured: boolean;
  readonly descriptors?: readonly SubagentDescriptor[];
}

export interface RenderResearchSubagentSpawnPreflightInput {
  readonly missionId: string;
  readonly role: string;
  readonly task: string;
  readonly operatorConfigured: boolean;
}

const RESEARCH_SUBAGENT_ROLE_GUIDES: readonly ResearchSubagentRoleGuide[] = [
  {
    role: 'planner',
    purpose: 'decompose the research question into reviewable subtasks',
  },
  {
    role: 'collector',
    purpose: 'collect sources, artifacts, and retained evidence candidates',
  },
  {
    role: 'experimenter',
    purpose: 'run bounded repo analysis or tests and report executable evidence',
  },
  {
    role: 'critic',
    purpose: 'challenge claims and surface missing evidence or counterarguments',
  },
  {
    role: 'synthesizer',
    purpose: 'turn supported claims and evidence into a synthesis draft',
  },
  {
    role: 'archivist',
    purpose: 'prepare closeout evidence, proof status, and archive handoff notes',
  },
] as const;

const RESEARCH_SUBAGENT_TREE_ROLE_DISPLAY_LIMIT = 6;
const RESEARCH_SUBAGENT_TREE_DESCRIPTOR_DISPLAY_LIMIT = 5;

function findResearchSubagentRoleGuide(
  role: string,
): ResearchSubagentRoleGuide | undefined {
  return RESEARCH_SUBAGENT_ROLE_GUIDES.find((guide) => guide.role === role);
}

function renderResearchSubagentDescriptorLine(
  descriptor: SubagentDescriptor,
): string {
  return [
    `- ${sanitizeDiscordHistoryText(descriptor.subagentId, 80)}`,
    `role=${sanitizeDiscordHistoryText(descriptor.role, 80)}`,
    `state=${sanitizeDiscordHistoryText(descriptor.state, 40)}`,
    `parent=${sanitizeDiscordHistoryText(
      `${descriptor.parent.taskId}/${descriptor.parent.instanceId}`,
      140,
    )}`,
  ].join(' ');
}

export function renderResearchSubagentTreePreflight(
  input: RenderResearchSubagentTreeInput,
): DiscordMessagePayload {
  const descriptors = input.descriptors ?? [];
  const visibleDescriptors = descriptors.slice(
    0,
    RESEARCH_SUBAGENT_TREE_DESCRIPTOR_DISPLAY_LIMIT,
  );
  const visibleRoles = RESEARCH_SUBAGENT_ROLE_GUIDES.slice(
    0,
    RESEARCH_SUBAGENT_TREE_ROLE_DISPLAY_LIMIT,
  );
  const lines: string[] = [
    `Research subagent tree preflight for \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    'Status: read-only role map; no subagents are spawned, steered, killed, or contacted.',
    'Research roles:',
    ...visibleRoles.map(
      (guide) =>
        `- ${guide.role}: ${sanitizeDiscordHistoryText(guide.purpose, 160)}`,
    ),
    'Expected child output: summary, claims, evidence, uncertainties, recommendedNextSteps.',
    'Active mission matches:',
  ];
  if (!input.operatorConfigured) {
    lines.push('- unavailable: subagent operator surface is not configured for this service instance.');
  } else if (descriptors.length === 0) {
    lines.push(
      '- none matched; approve a research plan with roster support enabled, then rerun `/subagents action:tree mission_id:<id>`.',
    );
  } else {
    lines.push(...visibleDescriptors.map(renderResearchSubagentDescriptorLine));
    if (descriptors.length > visibleDescriptors.length) {
      lines.push(
        `- … ${descriptors.length - visibleDescriptors.length} more subagent${
          descriptors.length - visibleDescriptors.length === 1 ? '' : 's'
        } omitted`,
      );
    }
  }
  lines.push(
    'Boundary: tree/role preflight only; no spawn, kill, steer, log read, no proof mutation, no archive mutation, no GitLab write, and no live service contact is performed.',
  );

  return buildNoMentionMessage(lines);
}

export function renderResearchSubagentSpawnPreflight(
  input: RenderResearchSubagentSpawnPreflightInput,
): DiscordMessagePayload {
  const guide = findResearchSubagentRoleGuide(input.role);
  const rolePurpose =
    guide === undefined
      ? 'custom research role envelope'
      : sanitizeDiscordHistoryText(guide.purpose, 160);
  const lines: string[] = [
    `Research subagent spawn preflight for \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    'Status: role envelope preview only; no subagent is spawned or contacted.',
    `Role: ${sanitizeDiscordHistoryText(input.role, 40)} — ${rolePurpose}`,
    `Task: ${sanitizeDiscordHistoryText(input.task, 280)}`,
    `Operator surface: ${
      input.operatorConfigured
        ? 'configured (preflight only; live spawn wiring pending).'
        : 'not configured; live spawn is unavailable in this service instance.'
    }`,
    'Depth policy (informational; no spawn occurs here): depth 1 root-owned only; nested spawn remains disabled by default.',
    'Planned child output schema (when later wired): summary, claims[], evidence[], uncertainties[], recommendedNextSteps[].',
    'Evidence policy: return artifact refs/summaries only; no secrets, raw prompts/responses, or private artifact contents.',
    'Next: use roster-backed `/research-plan` dispatch for live children today, then `/subagents action:tree mission_id:<id>` to inspect active role state.',
    'Boundary: spawn preflight only; no provider session, no subagent spawn, no steering, no log read, no proof/archive mutation, no GitLab write, and no live service contact is performed.',
  ];

  return buildNoMentionMessage(lines);
}

export type ResearchCloseoutChecklistItemState =
  | 'complete'
  | 'warning'
  | 'pending';

export interface ResearchCloseoutChecklistItem {
  readonly text: string;
  readonly state: ResearchCloseoutChecklistItemState;
}

export interface ResearchCloseoutAction {
  readonly verb: string;
  readonly label: string;
  readonly style?: DiscordButtonStyle;
}

export interface RenderResearchCloseoutChecklistInput {
  readonly missionId: string;
  readonly preflight?: boolean;
  readonly required: readonly ResearchCloseoutChecklistItem[];
  readonly recommended?: readonly string[];
  readonly actions?: readonly ResearchCloseoutAction[];
}

const RESEARCH_CLOSEOUT_REQUIRED_DISPLAY_LIMIT = 5;
const RESEARCH_CLOSEOUT_RECOMMENDED_DISPLAY_LIMIT = 3;
const RESEARCH_CLOSEOUT_ACTION_LABEL_DISPLAY_LIMIT = 3;
const RESEARCH_CLOSEOUT_ACTION_ROW_LIMIT = 5;
const RESEARCH_CLOSEOUT_ACTIONS_PER_ROW = 5;
const RESEARCH_CLOSEOUT_CUSTOM_ID_PART_LIMITS = {
  verb: 32,
  missionId: 48,
} as const;

function renderResearchCloseoutChecklistMarker(
  state: ResearchCloseoutChecklistItemState,
): string {
  switch (state) {
    case 'complete':
      return '✓';
    case 'warning':
      return '!';
    case 'pending':
      return '□';
  }
  const exhaustive: never = state;
  return exhaustive;
}

function buildResearchCloseoutActionCustomId(
  missionId: string,
  action: ResearchCloseoutAction,
): string {
  const verb = encodeResearchCustomIdPart(
    action.verb,
    'action',
    RESEARCH_CLOSEOUT_CUSTOM_ID_PART_LIMITS.verb,
  );
  const id = encodeResearchCustomIdPart(
    missionId,
    'mission',
    RESEARCH_CLOSEOUT_CUSTOM_ID_PART_LIMITS.missionId,
  );
  return `research-closeout:${verb}:${id}`;
}

function buildResearchCloseoutActionRows(
  missionId: string,
  actions: readonly ResearchCloseoutAction[] | undefined,
): readonly DiscordActionRowDescriptor[] | undefined {
  if (actions === undefined || actions.length === 0) {
    return undefined;
  }

  const visibleActions = actions.slice(
    0,
    RESEARCH_CLOSEOUT_ACTION_ROW_LIMIT * RESEARCH_CLOSEOUT_ACTIONS_PER_ROW,
  );
  const rows: DiscordActionRowDescriptor[] = [];

  for (
    let index = 0;
    index < visibleActions.length;
    index += RESEARCH_CLOSEOUT_ACTIONS_PER_ROW
  ) {
    const chunk = visibleActions.slice(
      index,
      index + RESEARCH_CLOSEOUT_ACTIONS_PER_ROW,
    );
    rows.push({
      kind: 'action-row',
      components: chunk.map((action) => ({
        kind: 'button',
        customId: buildResearchCloseoutActionCustomId(missionId, action),
        label: action.label.slice(0, 80),
        style: action.style ?? 'secondary',
      })),
    });
  }

  return rows;
}

export function renderResearchCloseoutChecklist(
  input: RenderResearchCloseoutChecklistInput,
): DiscordMessagePayload {
  const displayedRequired = input.required.slice(
    0,
    RESEARCH_CLOSEOUT_REQUIRED_DISPLAY_LIMIT,
  );
  const recommended = input.recommended ?? [];
  const displayedRecommended = recommended.slice(
    0,
    RESEARCH_CLOSEOUT_RECOMMENDED_DISPLAY_LIMIT,
  );
  const visibleActions =
    input.actions?.slice(
      0,
      RESEARCH_CLOSEOUT_ACTION_ROW_LIMIT * RESEARCH_CLOSEOUT_ACTIONS_PER_ROW,
    ) ?? [];
  const visibleActionLabels = visibleActions.slice(
    0,
    RESEARCH_CLOSEOUT_ACTION_LABEL_DISPLAY_LIMIT,
  );
  const heading = input.preflight === true ? 'Closeout preflight for' : 'Closeout for';

  const lines: string[] = [
    `${heading} \`${sanitizeDiscordHistoryText(input.missionId, 80)}\``,
    'Required:',
    ...(displayedRequired.length === 0
      ? ['□ no required checks supplied']
      : displayedRequired.map(
          (item) =>
            `${renderResearchCloseoutChecklistMarker(item.state)} ${sanitizeDiscordHistoryText(item.text, 160)}`,
        )),
  ];
  if (input.required.length > displayedRequired.length) {
    lines.push(
      `□ … ${input.required.length - displayedRequired.length} more required check${
        input.required.length - displayedRequired.length === 1 ? '' : 's'
      } omitted`,
    );
  }

  lines.push(
    'Recommended:',
    ...(displayedRecommended.length === 0
      ? ['- none']
      : displayedRecommended.map(
          (item) => `- ${sanitizeDiscordHistoryText(item, 160)}`,
        )),
  );
  if (recommended.length > displayedRecommended.length) {
    lines.push(
      `- … ${recommended.length - displayedRecommended.length} more recommendation${
        recommended.length - displayedRecommended.length === 1 ? '' : 's'
      } omitted`,
    );
  }

  lines.push(
    visibleActions.length === 0
      ? 'Actions: none queued.'
      : `Actions: ${visibleActionLabels
          .map((action) => `[${sanitizeDiscordHistoryText(action.label, 60)}]`)
          .join(' ')}${
          visibleActions.length > visibleActionLabels.length
            ? ` (+${visibleActions.length - visibleActionLabels.length} more actions)`
            : ''
        }`,
  );

  const rows = buildResearchCloseoutActionRows(input.missionId, input.actions);
  const payload: DiscordMessagePayload = buildNoMentionMessage(lines);
  return rows === undefined ? payload : { ...payload, components: rows };
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
    .replace(/<#/gu, '<#\u200B')
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
  // UX-8: translate the access-policy reason kind into operator-facing
  // guidance so users don't see only "admin-required" / "user-not-allowed"
  // and have to guess the remediation. The implementation-shape reason
  // continues to ride the message verbatim so admins can replay it.
  const hint = buildAccessDeniedHint(decision.reason);
  const lines: string[] = [
    `Discord request denied for \`${action}\`.`,
    `Reason: ${decision.reason}`,
  ];
  if (hint !== undefined) {
    lines.push(`💡 ${hint}`);
  }
  return buildMessage(lines);
}

/**
 * UX-8 — translate `DiscordAccessPolicy` denial reasons into one-line
 * operator next-step guidance. The reason values come from
 * `src/discord/discord-access-policy.ts` and currently cover six shapes:
 * `bot-authors-disabled`, `dm-disabled`, `guild-not-allowed`,
 * `channel-not-allowed`, `admin-required`, `user-not-allowed`.
 *
 * Returns `undefined` for reasons we do not recognise so the renderer
 * falls back to the bare wording (no fabricated hint).
 */
export function buildAccessDeniedHint(reason: string): string | undefined {
  switch (reason) {
    case 'admin-required':
      return 'This command is admin-only. Ask a Discord admin to add you via `/auth add user_id:<your-id>` (admin-only) or use a non-mutating alternative like `/status` / `/tasks`.';
    case 'user-not-allowed':
      return 'Your Discord user is not on the allow-list. Ask an admin to add you via `/auth add user_id:<your-id>` (admin-only).';
    case 'guild-not-allowed':
      return 'This Discord server is not allow-listed. Ask an admin to add it via `/auth add guild_id:<id>` (admin-only) or run the command from an allow-listed server.';
    case 'channel-not-allowed':
      return 'This channel is not allow-listed. Ask an admin to add it via `/auth add channel_id:<id>` (admin-only) or move to an allow-listed channel.';
    case 'dm-disabled':
      return 'Direct messages to the bot are disabled by policy. Run the command in an allow-listed Discord server channel instead.';
    case 'bot-authors-disabled':
      return 'Messages from other bots are disabled by policy. Use a real Discord user account to invoke this command.';
    default:
      return undefined;
  }
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
  // UX-19: derive an actionable hint per (status × reason) shape so
  // operators get a recovery path instead of a bare implementation
  // status. The implementation-shape `status` and `reason` continue
  // to ride the message verbatim.
  const hint = buildApprovalResolutionHint(input.status, input.reason);
  const lines: string[] = [
    `Approval \`${input.approvalId}\` was not resolved.`,
    `Status: ${input.status}`,
    `Reason: ${input.reason}`,
  ];
  if (hint !== undefined) {
    lines.push(`💡 ${hint}`);
  }
  return buildMessage(lines);
}

/**
 * UX-19 — translate `RuntimeApprovalRegistry` resolution-failure
 * statuses into one-line operator next-step guidance. The runtime
 * registry surfaces three non-success shapes — `unknown` (no such
 * approval), `duplicate` (already resolved), and `expired`/other
 * — and the bare reason text rarely tells the operator what to do
 * next.
 *
 * Returns `undefined` for shapes we do not recognise so the renderer
 * falls back to the bare wording rather than fabricate a hint.
 */
export function buildApprovalResolutionHint(
  status: string,
  reason: string,
): string | undefined {
  if (status === 'unknown') {
    return 'No such approval id. Use `/feed kind:approval` to inspect pending approvals, or copy the id from the most recent prompt that needs your decision.';
  }
  if (status === 'duplicate' || /already.*resolv/i.test(reason)) {
    return 'This approval was already resolved. Use `/feed kind:approval` to see the recent approval history, or wait for the next prompt.';
  }
  if (status === 'expired' || /expired/i.test(reason)) {
    return 'This approval expired before you responded. The originating task has likely already proceeded with the fail-open default; use `/status task_id:<id>` to inspect the outcome.';
  }
  return undefined;
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
  /**
   * UX-6 — surface the orchestrator's retry policy on the accepted reply
   * so operators know upfront whether transient failures will recover
   * automatically. When omitted or 0, no retry hint is shown.
   */
  readonly retryAttempts?: number;
  /**
   * UX-6 — when true, signal that `/research-plan` opted into the
   * subagent roster path so operators know `/subagents list` /
   * `/subagents kill` will see this dispatch's sub-tasks live.
   */
  readonly subagentRosterActive?: boolean;
}): DiscordMessagePayload {
  const lines = [
    `🧭 Research plan \`${sanitizeDiscordHistoryText(input.planId, 120)}\` accepted.`,
    `Sub-tasks queued: **${input.subTaskCount}** (sequential) + 1 synthesis.`,
    `Provider: \`${input.provider}\`${
      input.provider === 'claude-agent' && input.maxTurns !== undefined
        ? ` (max_turns=${input.maxTurns})`
        : ''
    }.`,
  ];
  // UX-6: announce that real-time progress will arrive so operators
  // expect per-sub-task follow-ups instead of one batch at the end.
  // Mention the retry policy when it's non-zero so operators know
  // transient failures will auto-recover up to the configured budget.
  const progressLine =
    input.retryAttempts !== undefined && input.retryAttempts > 0
      ? `Per-sub-task progress will follow as each completes; transient failures auto-retry up to ${input.retryAttempts}×.`
      : 'Per-sub-task progress will follow as each completes.';
  lines.push(progressLine);
  if (input.subagentRosterActive === true) {
    lines.push(
      'Subagent roster is active — use `/subagents list` to see in-flight sub-tasks, `/subagents kill <id>` to cancel one.',
    );
  }
  lines.push(
    "⚠️ Long plans may exceed Discord's ~15-min interaction window — for runs >15 min use `pnpm research:plan:run`.",
  );
  return buildNoMentionMessage(lines);
}

/**
 * UX-11 — render an in-flight tool-use heartbeat for `/research-plan`.
 *
 * The orchestrator already tags every `item.completed` runtime event
 * with one of four "tool" types (`command_execution`, `file_change`,
 * `mcp_tool_call`, `web_search`) plus the special `agent_message`
 * type. Without this surface, Discord operators see silence for the
 * full duration of each sub-task and cannot distinguish "still
 * working" from "stuck".
 *
 * The heartbeat is deliberately throttled by the caller (one nudge
 * per N tool uses or per M seconds since the last nudge). The
 * renderer only formats the per-tool-class breakdown into a one-line
 * message — throttling, batching, and ordering are the dispatcher's
 * job.
 *
 * Inspired by:
 *  - Claude Code's per-tool-call visibility (every tool lands in the
 *    conversation as it happens).
 *  - Codex CLI's `approval-on-request` policy (operator sees the
 *    next command before it runs).
 * See `specs/CURRENT/ux-comparison-2026-05-09.md` §3.1 for the gap
 * analysis that motivated this surface.
 */
export function renderResearchPlanHeartbeat(input: {
  readonly planId: string;
  readonly subTaskId: string;
  readonly index: number;
  readonly total: number;
  readonly toolCounts: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
}): DiscordMessagePayload {
  const elapsedSec = (input.elapsedMs / 1000).toFixed(1);
  const breakdown = Object.entries(input.toolCounts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
  const breakdownText = breakdown.length === 0 ? 'no tool use yet' : breakdown;
  return buildNoMentionMessage([
    `🔧 \`${input.planId}\` ${input.index}/${input.total} · ` +
      `\`${input.subTaskId}\` · ${breakdownText} · ${elapsedSec}s elapsed`,
  ]);
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
  // UX-5: humanize the cause label so the most common case (success)
  // reads naturally and failure cases get a short verb instead of the
  // raw `provider-failure`/`runtime-veto`/`driver-threw` shape.
  const outcomeLabel =
    input.causeKind === 'success'
      ? 'done'
      : humanizeResearchPlanCauseKind(input.causeKind);
  return buildNoMentionMessage([
    `${tag} \`${input.planId}\` ${input.index}/${input.total} · ` +
      `\`${input.subTaskId}\` · ${outcomeLabel} · ` +
      `${input.toolUseCount} tool use${input.toolUseCount === 1 ? '' : 's'} · ${elapsedSec}s`,
  ]);
}

/**
 * UX-5 — render a `/research-plan` retry / fast-fail follow-up.
 *
 * Fired by the dispatcher when the orchestrator's `onRetry` hook
 * reports a transient failure that will be retried, or a permanent
 * failure that fast-failed. Without this surface, operators saw silence
 * during retries and were surprised when the elapsed time of a sub-task
 * was 2-3× the typical run.
 *
 * Two shapes:
 *  - `kind: 'retry'` — a transient failure that the orchestrator will
 *    retry; tells the operator "we saw the failure, we are trying
 *    again, it's attempt N of M".
 *  - `kind: 'fast-fail'` — a permanent classification that the
 *    orchestrator will NOT retry; tells the operator the cause was
 *    permanent so further retries would not help.
 */
export function renderResearchPlanRetry(input: {
  readonly planId: string;
  readonly subTaskId: string;
  readonly kind: 'retry' | 'fast-fail';
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly previousCauseKind: string;
  readonly previousCauseClassification?: string;
  readonly previousDriverThrew?: string;
}): DiscordMessagePayload {
  const causeLabel = humanizeResearchPlanCauseKind(input.previousCauseKind);
  const classificationSuffix =
    input.previousCauseClassification !== undefined
      ? ` (${input.previousCauseClassification})`
      : '';
  if (input.kind === 'fast-fail') {
    return buildNoMentionMessage([
      `🛑 \`${input.planId}\` sub-task \`${input.subTaskId}\` ` +
        `fast-failed: ${causeLabel}${classificationSuffix} — classification is permanent, no retry.`,
    ]);
  }
  // Retry shape: keep it concise so a long-running plan doesn't drown
  // the channel. Optional driver-throw message preview helps operators
  // distinguish transient SDK 502s from quota / network issues.
  const driverHint =
    input.previousDriverThrew !== undefined
      ? ` (${truncateForRetryHint(input.previousDriverThrew)})`
      : '';
  return buildNoMentionMessage([
    `🔁 \`${input.planId}\` sub-task \`${input.subTaskId}\` ` +
      `retry ${input.attempt}/${input.maxAttempts} after ${causeLabel}${classificationSuffix}${driverHint}.`,
  ]);
}

/**
 * UX-5 helper — translate a research-plan cause kind (or the synthetic
 * `'driver-threw'` orchestrator label) into a short human label suitable
 * for inline progress / retry messages.
 */
export function humanizeResearchPlanCauseKind(causeKind: string): string {
  switch (causeKind) {
    case 'success':
      return 'success';
    case 'provider-failure':
      return 'provider error';
    case 'runtime-veto':
      return 'advisor veto';
    case 'external-cancel':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'driver-threw':
      return 'driver threw';
    default:
      return causeKind;
  }
}

function truncateForRetryHint(s: string): string {
  const ONE_LINE_LIMIT = 120;
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length > ONE_LINE_LIMIT
    ? `${compact.slice(0, ONE_LINE_LIMIT - 1)}…`
    : compact;
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
 *    flag) plus a pointer to the on-disk artifact. When `attachmentIncluded`
 *    is true (P3-def-2: caller will attach the report file to the
 *    follow-up via `DiscordMessagePayload.attachments`), the message
 *    text references both the in-Discord attachment and the on-disk
 *    fallback path so operators know they have two recovery routes.
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
  /**
   * P3-def-2: signals that the caller is also attaching the persisted
   * report file to the same follow-up payload. Changes the message text
   * so the operator knows the attachment exists in addition to the
   * disk-path fallback. Defaults to `false` for backwards compatibility.
   */
  readonly attachmentIncluded?: boolean;
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
    if (input.attachmentIncluded === true) {
      return buildNoMentionMessage([
        header,
        ...flagLines,
        '',
        `📎 Full report attached above; also at \`${input.artifactPath}\` (${size} chars).`,
        `Download the attachment in Discord, or run \`cat ${input.artifactPath}\` ` +
          'on the runtime host as a fallback.',
      ]);
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

/**
 * UX-2 — render a `/research-plan` error follow-up.
 *
 * Callers may pass an optional `hint` describing the next operator
 * action so users see actionable guidance rather than a bare error.
 * Examples:
 *  - early-stop after a transient sub-task failure → "재시도 권장; ..."
 *  - driver-threw → "/doctor 점검 후 재시도"
 *  - load/validation errors keep their existing actionable wording in
 *    the `message` argument (no hint needed).
 */
export function renderResearchPlanError(
  planId: string,
  message: string,
  hint?: string,
): DiscordMessagePayload {
  const lines = [`❌ Research plan \`${planId}\` rejected: ${message}`];
  if (hint !== undefined && hint.length > 0) {
    lines.push(`💡 ${hint}`);
  }
  return buildNoMentionMessage(lines);
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

/**
 * UX-7 — `/help` reply, reorganized into discoverability-friendly
 * sections. Previous form was a 14-bullet flat list that mixed
 * everyday user actions with admin-only ops; this layout groups
 * commands by who uses them and what state they touch so a new user
 * can scan to the section that matches their need without parsing
 * every bullet.
 *
 * Sections:
 *  - Quickstart: mention the bot to start a task; `/status` to check.
 *  - Read-only inspection: list / search / inspect tracked state and
 *    bounded live tails. Available under the broad Discord access
 *    policy.
 *  - Owner / admin task changes: cancel / rerun / archive / unarchive
 *    / escalate (mutate a tracked task; gated to owner or admin).
 *  - Long-running research: research / research-plan / agenda /
 *    insights (initiate or inspect long-running work).
 *  - Admin-only ops: auth / approve / deny / subagents / doctor / proof /
 *    config (require Discord admin in the auth database).
 */
export function renderHelp(): DiscordMessagePayload {
  return buildMessage([
    '__**Quickstart**__',
    '• Mention the bot at the start of a message to run a task — e.g. `<@bot> create results/task-artifacts/example.txt`.',
    '• `/status task_id:<id>` (or `status for discord-task-…`) checks a tracked task.',
    '',
    '__**Read-only inspection**__ (broad access policy)',
    '• `/tasks` — list visible tracked tasks; `/tasks archived` includes archived records.',
    '• `/history task_id:<id>` — event timeline for a task. `/history view:talk` shows sanitized Discord talk history for the channel.',
    '• `/context task_id:<id>` — summary of artifacts and evidence for a task.',
    '• `/feed` — bounded sanitized live tail of recent control-plane events.',
    '• `/follow task_id:<id>` — single-task live tail; posts new control-plane events here as they land (auto-stops on terminal or 14 min idle).',
    '• `/traits` — list TraitModule manifests (no install / enable / external fetch).',
    '• `/insights` — read-only insight ledger snapshot.',
    '',
    '__**Owner / admin task changes**__',
    '• `/cancel task_id:<id>` (or `cancel discord-task-…`) — request cancellation.',
    '• `/rerun task_id:<id>` — start a fresh task from terminal evidence (new artifact root).',
    '• `/archive task_id:<id>` — hide completed / superseded records from default lists; `/unarchive task_id:<id>` restores.',
    '• `/escalate` — record a Discord-only operator escalation request without mutating the task.',
    '',
    '__**Long-running research**__',
    '• `/research action:new instruction:<goal>` — create a draft Research Mission summary. `/research action:pin mission_id:<id>` renders the pin-ready status card. Omit `action` to dispatch a legacy long-running research task.',
    '• `/evidence action:add|list mission_id:<id>` and `/claim action:add|list|support|challenge mission_id:<id>` — build the mission evidence/claim ledger from Discord.',
    '• `/critique mission_id:<id> lens:<methodology|evidence|counterargument|reproducibility>` — render a read-only critique preflight before reviewer execution.',
    '• `/research-plan plan-id:<id>` — dispatch a multi-sub-task plan from `runtime-state/research-plans/`. Per-sub-task progress streams as each completes.',
    '• `/agenda` — list / add / done items in the research agenda; `/agenda cadence` inspects per-conversation cadence.',
    '',
    '__**Admin-only ops**__ (requires Discord admin in the auth database)',
    '• `/doctor [mission_id:<id>]` — non-mutating service diagnostics, or mission quality diagnostics when a mission id is provided.',
    '• `/proof action:status|start|export|capture|link` — show the configured live-proof scorecard, render operator start/capture preflight, export a one-surface manifest template, or link redacted proof metadata without raw proof content.',
    '• `/auth` — list / add / remove allow-listed users, channels, guilds.',
    '• `/approve approval_id:<id>` / `/deny approval_id:<id>` — resolve an outstanding approval prompt.',
    '• `/subagents` — list / info / kill / log root-owned subagents, `/subagents action:tree mission_id:<id>` for the role tree, or `/subagents action:spawn mission_id:<id> role:<role> text:<task>` for a research-role spawn preflight.',
    '• `/config view|set|reset` — inspect / mutate persona settings (next-dispatch hot-swap).',
  ]);
}

export interface RenderQuickstartInput {
  readonly recentTerminalTaskIds: readonly string[];
  readonly recentActiveTaskIds: readonly string[];
}

export function renderQuickstart(
  input: RenderQuickstartInput,
): DiscordMessagePayload {
  const recentTerminalLine =
    input.recentTerminalTaskIds.length === 0
      ? '• Recent terminal tasks: (none yet — mention the bot to start one)'
      : `• Recent terminal tasks: ${input.recentTerminalTaskIds
          .slice(0, 3)
          .map((id) => `\`${id}\``)
          .join(', ')}`;
  const recentActiveLine =
    input.recentActiveTaskIds.length === 0
      ? '• In flight: (none — your next dispatch will appear in `/tasks`)'
      : `• In flight: ${input.recentActiveTaskIds
          .slice(0, 3)
          .map((id) => `\`${id}\``)
          .join(', ')}`;
  return buildMessage([
    '__**Quickstart — first 60 seconds**__',
    '1. Mention the bot at the start of a message to dispatch a task — e.g. `<@bot> create results/task-artifacts/example.txt`.',
    '2. `/tasks` lists currently visible tracked tasks. Each row begins with a `discord-task-…` id you can pass to `/status`, `/cancel`, `/rerun`, etc.',
    '3. `/status task_id:<id>` is the fastest way to check progress without scrolling the channel.',
    '4. `/research action:new instruction:<goal>` creates a draft mission summary; `/evidence` + `/claim` capture the evidence ledger; `/research-plan plan-id:<id>` still dispatches a multi-sub-task plan.',
    '',
    '__**Right now in this service**__',
    recentActiveLine,
    recentTerminalLine,
    '',
    '__**Most-used inspection**__',
    '• `/tasks` · `/status task_id:<id>` · `/history task_id:<id>` · `/feed`',
    '',
    '__**Most-used controls**__',
    '• `/cancel task_id:<id>` · `/rerun task_id:<id>` · `/archive task_id:<id>`',
    '',
    '💡 `/help` lists the full command surface grouped by category.',
  ]);
}

/**
 * UX-26 (cycle 12) — chat-only reply for a mention that is NOT a task.
 * Brief acknowledgement + pointer to how the operator can escalate to
 * a task without re-typing the message.
 */
export function renderMentionChatReply(input: {
  readonly originalInstruction: string;
}): DiscordMessagePayload {
  const preview =
    input.originalInstruction.length > 80
      ? `${input.originalInstruction.slice(0, 80)}…`
      : input.originalInstruction;
  return {
    content: [
      `메시지 받았습니다: "${preview}"`,
      '💡 task로 처리하시려면 `task: <메시지>` 형식이나 `<@bot> 처리해줘`로 다시 보내주세요. 단순 대화는 그대로 남겨두면 됩니다.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

/**
 * UX-26 (cycle 12) — chat reply WITH a task-escalation hint. The
 * message looks like work the bot could dispatch; we ask the operator
 * to confirm before paying the task lifecycle cost.
 */
export function renderMentionChatWithTaskHint(input: {
  readonly originalInstruction: string;
  readonly ttlSeconds: number;
}): DiscordMessagePayload {
  const preview =
    input.originalInstruction.length > 80
      ? `${input.originalInstruction.slice(0, 80)}…`
      : input.originalInstruction;
  return {
    content: [
      `메시지 받았습니다: "${preview}"`,
      '🤔 이 작업은 task로 처리하는 게 좋아 보입니다.',
      `\`<@bot> 진행\` 또는 \`<@bot> yes\`로 답하시면 task로 dispatch합니다 (${Math.round(input.ttlSeconds / 60)}분 안에 답해주세요).`,
      '단순 대화로 남기시려면 그냥 무시하시면 됩니다.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

/**
 * UX-26 (cycle 12) — Acknowledgement when an operator confirms a task
 * escalation. The handler dispatches the original instruction as a
 * fresh task; this is the brief "ok, escalating" reply.
 */
export function renderMentionTaskEscalated(input: {
  readonly originalInstruction: string;
}): DiscordMessagePayload {
  const preview =
    input.originalInstruction.length > 80
      ? `${input.originalInstruction.slice(0, 80)}…`
      : input.originalInstruction;
  return {
    content: [
      `🚀 Task로 dispatch 합니다: "${preview}"`,
      '진행 상황은 이 채널과 자동 생성될 thread에서 in-place로 업데이트됩니다.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
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
