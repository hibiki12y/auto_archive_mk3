import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import type { LifecyclePhaseObservation } from '../contracts/dispatch-lifecycle.js';
import {
  InsightsEngine,
  type InsightWindow,
} from '../runtime/insights-engine.js';
import type { PlanningResourceEnvelopeInput } from '../contracts/resource-envelope.js';
import type { RuntimeSettingsInput } from '../contracts/runtime-settings.js';
import type { Arona } from '../core/arona.js';
import type { Dispatcher } from '../core/dispatcher.js';
import type { RuntimeApprovalRegistry } from '../core/runtime-approval-registry.js';
import type { TraitModuleRegistry } from '../core/trait-module-loader.js';
import type { TraitUsageTelemetryPort } from '../core/trait-usage-telemetry.js';
import type { SubagentOperatorSurface } from '../runtime/subagent-operator.js';
import {
  createDiscordSessionBindingAudit,
  type DiscordSessionBindingManager,
} from './discord-session-binding.js';
import type { DispatchPlan, TaskRequest } from '../core/task.js';
import { createTerminalEvidence } from '../contracts/terminal-evidence.js';
import { projectResearchMissionEvalSnapshot } from '../contracts/research-mission-eval-snapshot.js';
import {
  filterControlPlaneEvents,
  isControlPlaneLedgerTooLargeError,
  type ControlPlaneLedgerPort,
} from '../control/control-plane-ledger.js';
import type { DiscordAccessPolicy } from './discord-access-policy.js';
import {
  type DiscordAuthDatabase,
  type DiscordAuthScope,
} from './discord-auth-database.js';
import {
  renderAccessDenied,
  renderAlreadyTerminal,
  renderApprovalResolved,
  renderApprovalResolutionFailed,
  renderAuthDatabaseNotConfigured,
  renderAuthList,
  renderAuthMutation,
  renderAuthRejected,
  renderAskAccepted,
  renderAskVeto,
  renderCancelAccepted,
  renderContextSummary,
  renderControlPlaneFeed,
  renderControlPlaneFeedRateLimited,
  renderControlPlaneFeedTooLarge,
  renderControlPlaneFeedUnavailable,
  renderDoctor,
  renderEscalationRequested,
  renderEscalationUnavailable,
  renderFocusCreated,
  renderFocusReleased,
  renderHelp,
  renderQuickstart,
  renderPersonaConfigError,
  renderPersonaConfigReset,
  renderPersonaConfigUpdated,
  renderPersonaConfigView,
  renderResearchPlanAccepted,
  renderResearchPlanError,
  renderResearchPlanFinal,
  renderResearchPlanHeartbeat,
  renderResearchPlanProgress,
  renderResearchPlanRetry,
  DISCORD_MESSAGE_BUDGET,
  renderHistory,
  renderInsights,
  renderResearchAgendaList,
  renderResearchAgendaMutation,
  renderResearchCadence,
  renderResearchClaimAdded,
  renderResearchClaimLinkFailed,
  renderResearchClaimLinked,
  renderResearchClaimList,
  renderResearchConstraintReportRecordFailed,
  renderResearchConstraintReportRecorded,
  renderResearchCritiquePreflight,
  renderResearchEvidenceAdded,
  renderResearchEvidenceList,
  renderResearchCloseoutChecklist,
  renderResearchMissionChannelRequired,
  renderResearchMissionDoctor,
  renderResearchMissionNotFound,
  renderResearchMissionOptionRequired,
  renderResearchMissionOwnerRequired,
  renderResearchMissionPinnedSummary,
  renderResearchMissionPlanUnavailable,
  renderResearchMissionSummary,
  renderResearchSubagentSpawnPreflight,
  renderResearchSubagentTreePreflight,
  renderResearchStateOptionRequired,
  renderResearchSynthesis,
  renderProofActionUnsupported,
  renderProofCapturePreflight,
  renderProofExportTemplate,
  renderProofLinkResult,
  renderProofStartPreflight,
  renderProofStatus,
  renderRunningUpdate,
  renderStatus,
  renderSubagentOperatorResult,
  renderSubagentOperatorUnavailable,
  renderTalkHistory,
  renderTaskAlreadyArchived,
  renderTaskArchiveNotTerminal,
  renderTaskArchived,
  renderTaskNotArchived,
  renderTaskOwnerRequired,
  renderTaskRerunAccepted,
  renderTaskRerunNotTerminal,
  renderTaskUnarchived,
  renderTraitModuleList,
  renderTaskList,
  renderTerminalResult,
  renderUnknownResearchAgendaItem,
  renderTaskOptionRequired,
  renderUnknownTask,
  type DiscordFeedKind,
  splitDiscordMessagePayload,
  type DiscordDoctorStatus,
  type DiscordMessagePayload,
  type ResearchCritiqueLens,
  type RenderResearchCloseoutChecklistInput,
  type RenderResearchMissionSummaryInput,
  type ResearchMissionSubagentRoleState,
  type ResearchMissionSubagentSummary,
} from './discord-result-renderer.js';
import {
  DiscordResearchAgenda,
  type ResearchAgendaStatus,
} from './discord-research-agenda.js';
import {
  DiscordResearchMissionStore,
  type ResearchMissionProofLinkStatus,
  type ResearchMissionStatus,
  type ResearchMissionRecord,
} from './discord-research-mission.js';
import { LIVE_PROOF_SURFACES } from '../core/live-proof-report-cli.js';
import type { DiscordResearchPlanStore } from './discord-research-plan-store.js';
import {
  DISCORD_ESCALATION_REASON_MAX_LENGTH,
  type DiscordFirstSliceCommandName,
} from './discord-command-registry.js';
import {
  coerceSettingValue,
  loadPersonaSettings,
  savePersonaSettings,
  validatePersonaName,
  validateSettingKey,
  withPersonaReset,
  withPersonaSetting,
  type PersonaName,
  type PersonaSettingKey,
} from './persona-settings-store.js';
import type { InMemoryRuntimePersonaSettingsProvider } from '../runtime/runtime-persona-settings-provider.js';
import {
  ResearchPlanLoaderError,
  loadResearchPlan,
} from './research-plan-loader.js';
import {
  runResearchPlan,
  type ResearchPlanApprovalGate,
  type ResearchPlanApprovalGateOutcome,
  type ResearchSubTaskOutcome,
} from '../core/research-plan-orchestrator.js';
import { createResourceEnvelope } from '../contracts/resource-envelope.js';
import { createRuntimeSettingsBundle } from '../contracts/runtime-settings.js';
import type { RosterEvent } from '../contracts/subagent-roster-event.js';
import type { TerminalCause } from '../contracts/terminal-cause.js';
import { createSubagentRoster, type SubagentRoster } from '../runtime/subagent-roster.js';
import { createResearchPlanRunChild } from '../runtime/research-plan-roster-helpers.js';
import type { SubagentEvidenceLedgerSink } from '../runtime/agent-runtime.js';
import type { SubagentPolicyEnforcer } from '../runtime/subagent-policy-enforcer.js';
import type { SubagentRosterRegistry } from '../runtime/subagent-roster-registry.js';
import {
  renderFollowAlreadyFollowing,
  renderFollowCapReached,
  renderFollowStarted,
  renderFollowUnavailable,
} from './discord-follow-controller.js';
import { classifyMentionTaskIntent } from './discord-mention-intent-classifier.js';
import {
  renderMentionChatReply,
  renderMentionChatWithTaskHint,
  renderMentionTaskEscalated,
} from './discord-result-renderer.js';

export const DEFAULT_PERSONA_SETTINGS_PATH =
  'runtime-state/persona-settings.json';

export function resolvePersonaSettingsPath(custom: string | undefined): string {
  return resolvePath(custom ?? DEFAULT_PERSONA_SETTINGS_PATH);
}
import {
  DiscordTaskRegistry,
  type DiscordTaskAuditUpdateInput,
  type DiscordTaskCommandName,
  type DiscordTaskRecord,
} from './discord-task-registry.js';
import {
  buildDiscordIdempotencyKey,
  DiscordDeliveryQueue,
  type DiscordDeliveryEventType,
  type DiscordDeliveryOperation,
  type DiscordDeliveryQueueOptions,
  type DiscordDeliveryRequest,
} from './delivery/index.js';
import {
  CONVERSATIONAL_PERSONA_EVENT_TYPES,
  findMissingPersonaProtectedTokens,
  isPersonaEventTypeTransformable,
  isValidAronaPlanaDuetOutput,
  type PersonaStyleTransformer,
} from '../persona/persona-style-transformer.js';
import type { DiscordSessionLogThreadRouter } from './discord-session-log-thread-router.js';

export type { DiscordFirstSliceCommandName } from './discord-command-registry.js';

function normalizeEscalationReason(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= DISCORD_ESCALATION_REASON_MAX_LENGTH
    ? trimmed
    : trimmed.slice(0, DISCORD_ESCALATION_REASON_MAX_LENGTH);
}

/**
 * UX-24 (cycle 9) — transport-agnostic handle for a Discord message
 * the bot just posted. The production adapter wraps a discord.js
 * `Message`; tests pass a fake. The only operation we need is
 * `startThread` so a per-task thread can be opened off the accept
 * message in the source channel.
 */
export interface DiscordTaskThreadHandle {
  readonly id: string;
  send(payload: DiscordMessagePayload): Promise<unknown>;
}

export interface DiscordTaskMessageHandle {
  startThread(options: {
    readonly name: string;
    readonly autoArchiveDurationMinutes?: number;
  }): Promise<DiscordTaskThreadHandle>;
}

export interface DiscordCommandInteractionAdapter {
  readonly commandName: DiscordFirstSliceCommandName;
  readonly userId: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly authorIsBot?: boolean;
  readonly source?: 'slash-command' | 'natural-language' | 'slash-text';
  getString(name: string, required?: boolean): string | null;
  deferReply(options?: { ephemeral?: boolean }): Promise<unknown>;
  editReply(payload: DiscordMessagePayload): Promise<unknown>;
  followUp(payload: DiscordMessagePayload): Promise<unknown>;
  /**
   * UX-24 (cycle 9) — optional: returns a handle to the bot's most
   * recent reply in the source channel so the handler can start a
   * per-task thread on it. Adapters that cannot expose this (e.g. the
   * synthetic button-press adapter, the natural-language message
   * adapter) leave it `undefined`; the handler treats that case as
   * thread-disabled and proceeds with channel-only delivery.
   */
  fetchReply?(): Promise<DiscordTaskMessageHandle | null | undefined>;
  /**
   * UX-25 (cycle 11) — optional: extract a Discord message id from the
   * value returned by editReply / followUp. Production adapters return
   * the message id of the bot reply that just landed; the deliver
   * path appends it to the control ledger as a `task.delivery_observed`
   * event so automated tests can verify in-place edit (same id across
   * editReply ops) without a Discord REST fetch (which the Auto Mode
   * classifier blocks as bot-token credential use). Adapters that
   * cannot expose this leave it `undefined`; the ledger event still
   * records the operation + eventType + sequence.
   */
  extractMessageId?(replyResult: unknown): string | undefined;
}

export interface DiscordTaskRequestSeed {
  instruction: string;
  userId: string;
  channelId?: string;
}

export interface DiscordTaskRequestFactory {
  createAskTaskRequest(seed: DiscordTaskRequestSeed): TaskRequest;
}

export interface DefaultDiscordTaskRequestFactoryOptions {
  resources: PlanningResourceEnvelopeInput;
  runtimeSettings: RuntimeSettingsInput;
  artifactLocation?: string;
  scopeArtifactLocationByTaskId?: boolean;
  taskIdPrefix?: string;
  taskIdFactory?: () => string;
}

function clonePlanningResources(
  resources: PlanningResourceEnvelopeInput,
): PlanningResourceEnvelopeInput {
  return {
    requested: { ...resources.requested },
    ...(resources.effective === undefined
      ? {}
      : { effective: { ...resources.effective } }),
  };
}

function cloneRuntimeSettingsInput(
  runtimeSettings: RuntimeSettingsInput,
): RuntimeSettingsInput {
  return {
    networkProfile: runtimeSettings.networkProfile,
    sandboxMode: runtimeSettings.sandboxMode,
    approvalPolicy: runtimeSettings.approvalPolicy,
    ...(runtimeSettings.workingDirectory === undefined
      ? {}
      : { workingDirectory: runtimeSettings.workingDirectory }),
    ...(runtimeSettings.deadlineMs === undefined
      ? {}
      : { deadlineMs: runtimeSettings.deadlineMs }),
  };
}

function joinArtifactLocation(baseLocation: string, taskId: string): string {
  return `${baseLocation.replace(/[\\/]+$/u, '')}/${taskId}`;
}

const RESEARCH_PLAN_REPORT_FALLBACK_ROOT = 'results/task-artifacts';
const RESEARCH_PLAN_REPORT_SUBDIR = 'research-plan-reports';

/**
 * Resolve the on-disk root under which oversized research-plan reports
 * are persisted. Order of precedence:
 *
 * 1. Explicit handler option `researchPlanArtifactRoot` (operator-set).
 * 2. The plan's `synthesis.artifactLocation` (most specific to the
 *    final report).
 * 3. The plan-level `runtimeSettings.workingDirectory`.
 * 4. The static fallback `results/task-artifacts` (matches the
 *    default request-factory artifact root used elsewhere).
 *
 * Relative paths are resolved against `cwd` (which mirrors the
 * orchestrator working directory). Absolute paths are returned as-is.
 */
export function resolveResearchPlanReportRoot(input: {
  readonly explicitRoot?: string | undefined;
  readonly plan: import('../core/research-plan-orchestrator.js').ResearchPlan;
  readonly cwd: string;
}): string {
  const candidate =
    input.explicitRoot ??
    input.plan.synthesis.artifactLocation ??
    input.plan.runtimeSettings.workingDirectory ??
    RESEARCH_PLAN_REPORT_FALLBACK_ROOT;
  return isAbsolute(candidate) ? candidate : resolvePath(input.cwd, candidate);
}

/**
 * Format an ISO-8601 UTC timestamp safe for filesystem use (no colons).
 * Example: `2026-05-08T01-23-45Z`.
 */
function formatReportTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/u, 'Z')
    .replace(/:/g, '-');
}

/**
 * Persist an oversized aggregated research-plan report (and a small
 * JSON sidecar with run statistics) under
 * `{root}/research-plan-reports/{planId}-{timestamp}.md`. Returns the
 * absolute path to the markdown report and its byte size, or
 * `undefined` when persistence fails — callers fall back to the legacy
 * inline-truncated rendering on `undefined`.
 */
export function persistResearchPlanReport(input: {
  readonly root: string;
  readonly planId: string;
  readonly aggregatedReport: string;
  readonly totalElapsedMs: number;
  readonly subTaskCount: number;
  readonly stoppedEarly: boolean;
  readonly partialSynthesis: boolean;
  readonly skippedSubTaskIds: readonly string[];
  readonly now?: () => Date;
}): { readonly artifactPath: string; readonly fileSize: number } | undefined {
  const now = input.now ?? (() => new Date());
  const timestamp = formatReportTimestamp(now());
  const dir = resolvePath(input.root, RESEARCH_PLAN_REPORT_SUBDIR);
  const fileName = `${input.planId}-${timestamp}.md`;
  const artifactPath = resolvePath(dir, fileName);
  const metaPath = resolvePath(dir, `${input.planId}-${timestamp}.meta.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(artifactPath, input.aggregatedReport, 'utf8');
    const fileSize = Buffer.byteLength(input.aggregatedReport, 'utf8');
    const meta = {
      planId: input.planId,
      totalElapsedMs: input.totalElapsedMs,
      subTaskCount: input.subTaskCount,
      stoppedEarly: input.stoppedEarly,
      partialSynthesis: input.partialSynthesis,
      skippedSubTaskIds: input.skippedSubTaskIds,
      fileSize,
      writtenAt: now().toISOString(),
    };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return { artifactPath, fileSize };
  } catch (cause) {
    console.warn(
      `[discord-research-plan] failed to persist oversized report for plan=${input.planId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return undefined;
  }
}

function renderManagedArtifactInstruction(taskId: string, artifactLocation: string): string {
  return [
    '',
    '---',
    'AUTO_ARCHIVE MANAGED ARTIFACT OUTPUT',
    '',
    `Task ID: ${taskId}`,
    `Artifact root: ${artifactLocation}`,
    '',
    'Write every durable deliverable for this task under the artifact root above.',
    'Do not write task deliverables directly into the repository source tree unless the user explicitly asks for source changes.',
    'Do not call GitLab directly for artifact publication; Auto Archive will publish this artifact root to the assigned GitLab project after terminal completion.',
    'If the user named an additional run marker or subdirectory, create it under this artifact root.',
    '---',
  ].join('\n');
}

function appendManagedArtifactInstruction(
  instruction: string,
  taskId: string,
  artifactLocation: string | undefined,
): string {
  return artifactLocation === undefined
    ? instruction
    : `${instruction.trimEnd()}${renderManagedArtifactInstruction(
        taskId,
        artifactLocation,
      )}`;
}

export class DefaultDiscordTaskRequestFactory implements DiscordTaskRequestFactory {
  private readonly taskIdPrefix: string;
  private readonly taskIdFactory: () => string;

  constructor(private readonly options: DefaultDiscordTaskRequestFactoryOptions) {
    this.taskIdPrefix = options.taskIdPrefix ?? 'discord-task';
    this.taskIdFactory = options.taskIdFactory ?? (() => randomUUID().slice(0, 8));
  }

  createAskTaskRequest(seed: DiscordTaskRequestSeed): TaskRequest {
    const taskId = `${this.taskIdPrefix}-${this.taskIdFactory()}`;
    const artifactLocation =
      this.options.artifactLocation === undefined
        ? undefined
        : this.options.scopeArtifactLocationByTaskId === false
          ? this.options.artifactLocation
          : joinArtifactLocation(this.options.artifactLocation, taskId);
    return {
      taskId,
      instruction: appendManagedArtifactInstruction(
        seed.instruction,
        taskId,
        artifactLocation,
      ),
      resources: clonePlanningResources(this.options.resources),
      runtimeSettings: cloneRuntimeSettingsInput(this.options.runtimeSettings),
      ...(artifactLocation === undefined ? {} : { artifactLocation }),
    };
  }
}

export interface DiscordCommandHandlersOptions {
  arona: Arona;
  dispatcher: Dispatcher;
  taskRegistry?: DiscordTaskRegistry;
  researchAgenda?: DiscordResearchAgenda;
  researchMissions?: DiscordResearchMissionStore;
  researchPlans?: DiscordResearchPlanStore;
  controlLedger?: ControlPlaneLedgerPort;
  accessPolicy?: DiscordAccessPolicy;
  authDatabase?: DiscordAuthDatabase;
  requestFactory: DiscordTaskRequestFactory;
  cancelProvenance?: string;
  doctorStatus?: DiscordDoctorStatus;
  /**
   * Path to the persona settings JSON store consulted by the `/config`
   * command. When unset, `/config` operates on the default
   * `runtime-state/persona-settings.json` path (created on first write).
   */
  personaSettingsPath?: string;
  /**
   * Optional in-memory persona settings provider shared with the runtime
   * driver. When supplied, `/config set` and `/config reset` synchronously
   * update this provider so the next `RuntimeDriver.run()` reads the new
   * model/effort/maxTurns without a service restart
   * (multi-provider-scope.md §1.3.0). When omitted, mutations remain
   * file-only and only apply on the next service restart.
   */
  runtimePersonaSettingsProvider?: InMemoryRuntimePersonaSettingsProvider;
  /**
   * Set of providers the bootstrap successfully authenticated. Discord
   * `/config set persona:arona key:provider value:<v>` is rejected if `<v>`
   * is not in this set so an unreachable provider intent never enters the
   * persona-settings store (multi-provider-scope.md §1.4.0). When omitted,
   * provider validation falls back to the static enum (any known provider
   * is accepted, even if it can't actually run).
   */
  bootstrapAvailableProviders?: ReadonlySet<'codex' | 'claude-agent'>;
  /**
   * Bare RuntimeDriver used by `/research-plan` to dispatch sub-tasks via the
   * decomposition orchestrator. Routed around AgentRuntime so the orchestrator
   * gets to drive each sub-task as a fresh thread (avoiding the Codex compact
   * 502 ceiling that single-shot ultra-deep research hits at ~17 min wall).
   * When omitted, `/research-plan` is rejected at command time with a clear
   * error so the operator can fall back to the `pnpm research:plan:run` CLI.
   * The driver routes per-call by `arona.provider` persona setting, so
   * provider hot-swap (multi-provider-scope.md §1.4) applies between
   * sub-tasks naturally.
   */
  researchPlanRuntimeDriver?: import('../contracts/runtime-driver.js').RuntimeDriver;
  /**
   * Optional working directory for `/research-plan` plan-loader and
   * orchestrator dispatches. Defaults to `process.cwd()`.
   */
  researchPlanWorkingDirectory?: string;
  /**
   * Optional artifact root for persisted research-plan reports that
   * exceed the Discord per-message budget (~1900 chars). The handler
   * writes oversized aggregated reports under
   * `{root}/research-plan-reports/{planId}-{timestamp}.md` plus a
   * sibling `.meta.json` and posts the on-disk path to Discord instead
   * of truncating the inline message. When omitted, falls back per
   * `resolveResearchPlanReportRoot` (synthesis.artifactLocation →
   * plan.runtimeSettings.workingDirectory → `results/task-artifacts`).
   */
  researchPlanArtifactRoot?: string;
  /**
   * P4 Stage 4-6 Commit 3 — when both `researchPlanSubagentPolicyEnforcer`
   * AND `researchPlanUseSubagentRoster: true` are supplied, the
   * `/research-plan` Discord handler builds a per-dispatch
   * `SubagentRoster` for each invocation and routes every sub-task
   * through `roster.spawnAndRun(...)`. The roster shares the plan's
   * resource envelope and runtime settings (mirroring the CLI runner
   * at `scripts/research-plan-runner.mjs:178-203`) and is constructed
   * fresh per dispatch so multiple concurrent `/research-plan`
   * invocations remain isolated.
   *
   * Default OFF — when omitted or `false`, the handler keeps the
   * legacy `runResearchPlan(driver, plan, { onEvent })` path
   * bit-for-bit so existing operators see no behavior change.
   *
   * Wired by `src/discord/discord-service-bootstrap.ts` from
   * `AUTO_ARCHIVE_DISCORD_RESEARCH_PLAN_USE_SUBAGENT_ROSTER=on`.
   */
  researchPlanSubagentPolicyEnforcer?: SubagentPolicyEnforcer;
  researchPlanUseSubagentRoster?: boolean;
  /**
   * Optional service-scope registry for `/research-plan`-owned rosters.
   *
   * `AgentRuntime` dispatches already register their rosters through this
   * surface. `/research-plan` builds a roster directly at the orchestrator
   * layer, so it must explicitly register/unregister when the production
   * roster path is enabled; otherwise `/subagents list` cannot see the
   * in-flight research-plan children even though the accepted reply tells
   * operators to use that command.
   */
  researchPlanSubagentRosterRegistry?: SubagentRosterRegistry;
  /**
   * Optional retained evidence sink for `/research-plan` roster lifecycle
   * events. Mirrors `AgentRuntime`'s subagentEvidenceLedgerSink wiring so the
   * live `/research-plan` production caller can produce the same redacted
   * `subagent.spawned` / terminal / `roster.progress` ledger expected by the
   * subagent operator live-proof surface.
   */
  researchPlanSubagentEvidenceLedgerSink?: SubagentEvidenceLedgerSink;
  approvalRegistry?: RuntimeApprovalRegistry;
  subagentOperator?: SubagentOperatorSurface;
  /**
   * UX-15 (cycle 7) — optional `/follow task_id:<id>` controller. When
   * supplied, the handler can register a per-task live tail of the
   * control-plane ledger (one followUp per batch of new events,
   * unsubscribing on terminal). When omitted, the `/follow` command
   * replies with an "unavailable on this service" message.
   */
  followController?: import('./discord-follow-controller.js').DiscordFollowController;
  /**
   * UX-26 (cycle 12) — optional per-channel chat-hint state for the
   * mention-default chat-by-default flow. When supplied, mention-driven
   * `handleAsk` calls classify the instruction as task-explicit /
   * task-confirm / chat-with-task-hint / chat-only and may short-
   * circuit the task dispatch lifecycle. When omitted (default), every
   * mention takes the legacy task path (cycles 1-11 behavior preserved).
   *
   * Wired by the service bootstrap from
   * `AUTO_ARCHIVE_DISCORD_MENTION_DEFAULT_CHAT=on`.
   */
  mentionChatHintState?: import(
    './discord-mention-intent-classifier.js'
  ).MentionChatHintState;
  mentionChatHintTtlMs?: number;
  sessionBindings?: DiscordSessionBindingManager;
  traitModuleRegistry?: TraitModuleRegistry;
  traitModuleRegistryError?: string;
  traitUsageTelemetry?: TraitUsageTelemetryPort;
  /** Optional pre-constructed delivery queue (DI for tests). */
  deliveryQueue?: DiscordDeliveryQueue;
  /** Options used when constructing the default delivery queue. */
  deliveryQueueOptions?: DiscordDeliveryQueueOptions;
  /**
   * Optional persona-style transformer. When supplied, conversational
   * Discord payloads (`ask-accepted`, `running-update`, `status-reply`,
   * `cancel-ack`, `access-denied`) are rewritten by the transformer
   * before being chunked. Structured listings (`tasks-reply`, `traits-reply`,
   * `agenda-reply`, `history-reply`, `context-reply`, `escalate-reply`, `feed-reply`,
   * `auth-reply`, `doctor-reply`, `help-reply`) and terminal/control replies bypass the
   * transformer by default to preserve verbatim shape.
   *
   * Fail-open: a transformer that throws or returns empty leaves the
   * original payload intact and the warning is logged via `console.warn`.
   */
  personaTransformer?: PersonaStyleTransformer;
  /**
   * Optional Discord session-log thread router. When supplied, every lifecycle
   * `followUp` payload is offered to the router first, which routes it into a
   * per-Task thread inside a Discord text channel instead of replying to
   * the source chat channel. The router is fail-open: routing failures fall
   * back to the original `interaction.followUp` path. The initial accepted
   * `editReply` is unaffected. See specs/ARCHIVE/discord-session-log-thread.md.
   */
  sessionLogThreadRouter?: DiscordSessionLogThreadRouter;
  /**
   * M5b — Tier-2 Discord command intercept hooks. Each binding is consulted
   * BEFORE the dispatch table runs. A binding may return null (admit) or
   * a {status:'denied', reason} object to deny the command. Throwing hooks
   * are contained: they admit by default.
   */
  commandInterceptHooks?: ReadonlyArray<{
    readonly moduleId: string;
    readonly moduleVersion: string;
    readonly commandIntercept: import('../contracts/trait-runtime-hook.js').TraitCommandInterceptHook;
  }>;
  /**
   * M5c — Tier-3 doctor probe observe hooks. Fired (fire-and-forget,
   * error-contained) every time `/doctor` renders a probe snapshot.
   */
  doctorProbeHooks?: ReadonlyArray<{
    readonly moduleId: string;
    readonly moduleVersion: string;
    readonly doctorProbeObserve: import('../contracts/trait-runtime-hook.js').TraitDoctorProbeObserveHook;
  }>;
}

function createCompletionRejectionEvidence(
  plan: DispatchPlan,
  error: unknown,
) {
  const observedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const runtimeInstanceId = `discord-completion-${plan.taskId}`;
  return createTerminalEvidence({
    taskId: plan.taskId,
    runtimeInstanceId,
    reason: `Dispatch completion rejected: ${message}`,
    provenance: 'discord-command-handler',
    executionContext: {
      planCreatedAt: plan.createdAt,
      runtimeSettings: plan.runtimeSettings,
      ...(plan.executionCheckpoint === undefined
        ? {}
        : { executionCheckpoint: plan.executionCheckpoint }),
    },
    resourceEnvelope: plan.resourceEnvelope,
    startedAt: plan.createdAt,
    endedAt: observedAt,
    ...(plan.artifactLocation === undefined
      ? {}
      : { artifactLocation: plan.artifactLocation }),
    cause: {
      kind: 'driver-failure',
      taskId: plan.taskId,
      runtimeInstanceId,
      observedAt,
      provenance: 'discord-command-handler',
      phase: 'dispatch-completion-observer',
      message,
      requestContext: { taskId: plan.taskId },
    },
  });
}

const MANAGED_ARTIFACT_INSTRUCTION_MARKER =
  '\n---\nAUTO_ARCHIVE MANAGED ARTIFACT OUTPUT';

/**
 * UX-24 (cycle 9): build a per-task thread name. Discord caps thread
 * names at 100 chars; we keep the command name + truncated taskId so
 * operators can scan the side-bar by-task at a glance.
 */
export function buildTaskThreadName(
  taskId: string,
  commandName: string,
): string {
  const candidate = `${commandName}: ${taskId}`;
  return candidate.length <= 100 ? candidate : candidate.slice(0, 100);
}

const DISCORD_FEED_DEFAULT_SINCE_MS = 5 * 60 * 1000;
const DISCORD_FEED_MIN_SINCE_MS = 60 * 1000;
const DISCORD_FEED_MAX_SINCE_MS = 24 * 60 * 60 * 1000;
const DISCORD_FEED_MAX_EVENTS = 50;
const DISCORD_FEED_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DISCORD_FEED_RATE_LIMIT_MAX = 2;

function parseFeedSinceDuration(raw: string | null): number {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return DISCORD_FEED_DEFAULT_SINCE_MS;
  }
  const match = normalized.match(/^(?<amount>\d{1,4})(?<unit>[smhd])$/u);
  if (match === null) {
    return DISCORD_FEED_DEFAULT_SINCE_MS;
  }
  const amount = Number.parseInt(match.groups?.amount ?? '', 10);
  const unit = match.groups?.unit;
  const multiplier =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60 * 1000
        : unit === 'h'
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  const durationMs = amount * multiplier;
  return Math.min(
    DISCORD_FEED_MAX_SINCE_MS,
    Math.max(DISCORD_FEED_MIN_SINCE_MS, durationMs),
  );
}

function parseFeedKind(raw: string | null): DiscordFeedKind {
  const normalized = raw?.trim().toLowerCase();
  return normalized === 'task' ||
    normalized === 'escalation' ||
    normalized === 'approval'
    ? normalized
    : 'all';
}

function feedKindTypePrefix(kind: DiscordFeedKind): `${string}.` | undefined {
  return kind === 'all' ? undefined : `${kind}.`;
}

function stripManagedArtifactInstruction(instruction: string): string {
  const markerIndex = instruction.indexOf(MANAGED_ARTIFACT_INSTRUCTION_MARKER);
  return (markerIndex < 0 ? instruction : instruction.slice(0, markerIndex))
    .trimEnd();
}

function rerunSourceInstruction(record: DiscordTaskRecord): string {
  const explicit = record.requestedInstruction?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  return stripManagedArtifactInstruction(record.instruction).trim();
}

function appendRerunNote(
  instruction: string,
  sourceTaskId: string,
  note: string | undefined,
): string {
  const trimmedNote = note?.trim();
  if (trimmedNote === undefined || trimmedNote.length === 0) {
    return instruction;
  }
  return [
    instruction.trimEnd(),
    '',
    '[Auto Archive rerun note]',
    `Source task: ${sourceTaskId}`,
    trimmedNote,
  ].join('\n');
}

function isResearchCritiqueLens(
  value: string | undefined,
): value is ResearchCritiqueLens {
  return (
    value === 'methodology' ||
    value === 'evidence' ||
    value === 'counterargument' ||
    value === 'reproducibility'
  );
}

function isResearchMissionPlanParentTask(
  parentTaskId: string,
  missionId: string,
): boolean {
  const expectedPrefix = `discord-research-mission-plan-${missionId}-`;
  if (!parentTaskId.startsWith(expectedPrefix)) {
    return false;
  }
  const runSuffix = parentTaskId.slice(expectedPrefix.length);
  return /^[0-9]+$/u.test(runSuffix);
}

const RESEARCH_SUBAGENT_ROLES = [
  'planner',
  'collector',
  'experimenter',
  'critic',
  'synthesizer',
  'archivist',
] as const;

type ResearchSubagentRole = (typeof RESEARCH_SUBAGENT_ROLES)[number];

function isResearchSubagentRole(
  value: string | undefined,
): value is ResearchSubagentRole {
  return RESEARCH_SUBAGENT_ROLES.some((role) => role === value);
}

function isLiveProofSurface(value: string | undefined): value is string {
  return (
    value !== undefined && (LIVE_PROOF_SURFACES as readonly string[]).includes(value)
  );
}

function isResearchMissionProofLinkStatus(
  value: string | undefined,
): value is ResearchMissionProofLinkStatus {
  return value === 'pass' || value === 'warn' || value === 'fail';
}

function parseProofArtifactTokens(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 20);
}

// NOTE: `safelySend` was removed by WU-disc. Every Discord send now flows
// through `DiscordDeliveryQueue` which provides at-least-once delivery with
// idempotency, exponential backoff, a circuit breaker, and a DLQ that records
// exhausted-retry messages with full context. Failures are observable via
// `commandHandlers.deliveryQueue.dlq.list()`.

export class DiscordCommandHandlers {
  readonly taskRegistry: DiscordTaskRegistry;
  readonly researchAgenda: DiscordResearchAgenda;
  readonly researchMissions: DiscordResearchMissionStore;
  readonly researchPlans: DiscordResearchPlanStore | undefined;
  readonly deliveryQueue: DiscordDeliveryQueue;

  private readonly cancelProvenance: string;
  private statusReplySeq = 0;
  private cancelAckSeq = 0;
  private rerunReplySeq = 0;
  private archiveReplySeq = 0;
  private unarchiveReplySeq = 0;
  private helpReplySeq = 0;
  private quickstartReplySeq = 0;
  private followReplySeq = 0;
  private followFollowUpSeq = 0;
  private mentionChatReplySeq = 0;
  /**
   * UX-24 (cycle 9): per-task thread cache. Populated when
   * `dispatchInstructionTask` opens a thread off the accept message;
   * the background terminal observer reads from this cache so it can
   * post the final state into the same thread. Evicted on terminal so
   * the bot's memory stays bounded for long-lived deployments.
   */
  private readonly taskThreadByTaskId = new Map<string, DiscordTaskThreadHandle>();
  private tasksReplySeq = 0;
  private traitsReplySeq = 0;
  private agendaReplySeq = 0;
  private historyReplySeq = 0;
  private contextReplySeq = 0;
  private escalateReplySeq = 0;
  private feedReplySeq = 0;
  private doctorReplySeq = 0;
  private proofReplySeq = 0;
  private subagentReplySeq = 0;
  private focusReplySeq = 0;
  private authReplySeq = 0;
  private configReplySeq = 0;
  private researchMissionReplySeq = 0;
  private researchEvidenceReplySeq = 0;
  private researchClaimReplySeq = 0;
  private researchCritiqueReplySeq = 0;
  private researchPlanReplySeq = 0;
  private insightsReplySeq = 0;
  private accessDeniedReplySeq = 0;
  private readonly feedRequestTimestampsByUser = new Map<string, number[]>();

  constructor(private readonly options: DiscordCommandHandlersOptions) {
    this.taskRegistry = options.taskRegistry ?? new DiscordTaskRegistry();
    this.researchAgenda =
      options.researchAgenda ??
      new DiscordResearchAgenda({ ledger: options.controlLedger });
    this.researchMissions =
      options.researchMissions ??
      new DiscordResearchMissionStore({ ledger: options.controlLedger });
    this.researchPlans = options.researchPlans;
    this.cancelProvenance = options.cancelProvenance ?? 'discord-interface';
    this.deliveryQueue =
      options.deliveryQueue ??
      new DiscordDeliveryQueue(options.deliveryQueueOptions);
  }

  recordObservedMarkerAudit(
    taskId: string,
    auditUpdate: DiscordTaskAuditUpdateInput,
  ): DiscordTaskRecord {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0) {
      throw new Error('taskId is required to record marker audit observations');
    }
    if (auditUpdate.observedAt.trim().length === 0) {
      throw new Error('observedAt is required to record marker audit observations');
    }
    const record = this.taskRegistry.recordMarkerAudit(normalizedTaskId, auditUpdate);
    if (record === undefined) {
      throw new Error(`Task \`${normalizedTaskId}\` is not tracked.`);
    }
    return record;
  }

  private withConfiguredLiveProofReport(
    summary: RenderResearchMissionSummaryInput,
  ): RenderResearchMissionSummaryInput {
    const liveProof = this.options.doctorStatus?.liveProofReport;
    if (liveProof === undefined) {
      return summary;
    }
    return {
      ...summary,
      proofReport: {
        reportStatus:
          liveProof.error === undefined
            ? (liveProof.reportStatus ?? 'no-proof')
            : 'failed',
        completeProofCount: liveProof.completeProofCount ?? 0,
        warnProofCount: liveProof.warnProofCount ?? 0,
        failProofCount: liveProof.failProofCount ?? 0,
        missingRequiredArtifactCount: liveProof.missingRequiredArtifactCount ?? 0,
        sourceLabel:
          'configured live-proof manifest (global; mission links are tracked separately)',
      },
    };
  }

  private withResearchMissionSubagentSummary(
    summary: RenderResearchMissionSummaryInput,
  ): RenderResearchMissionSummaryInput {
    const subagentSummary = this.buildResearchMissionSubagentSummary(
      summary.missionId,
    );
    return subagentSummary === undefined
      ? summary
      : { ...summary, subagents: subagentSummary };
  }

  private withResearchMissionSummaryContext(
    summary: RenderResearchMissionSummaryInput,
  ): RenderResearchMissionSummaryInput {
    return this.withConfiguredLiveProofReport(
      this.withResearchMissionSubagentSummary(summary),
    );
  }

  private buildResearchMissionSubagentSummary(
    missionId: string,
  ): ResearchMissionSubagentSummary | undefined {
    const operator = this.options.subagentOperator;
    if (operator === undefined) {
      return undefined;
    }
    const result = operator.list();
    if (result.status !== 'ok') {
      return undefined;
    }
    const descriptors = (result.descriptors ?? []).filter((descriptor) =>
      isResearchMissionPlanParentTask(descriptor.parent.taskId, missionId),
    );
    const byRole = new Map<string, ResearchMissionSubagentRoleState>();
    const emptyRoleState = (role: string): ResearchMissionSubagentRoleState => ({
      role,
      reserved: 0,
      spawning: 0,
      active: 0,
      terminating: 0,
      terminated: 0,
      failed: 0,
    });
    for (const descriptor of descriptors) {
      const role = descriptor.role;
      const current = byRole.get(role) ?? emptyRoleState(role);
      byRole.set(role, {
        ...current,
        [descriptor.state]: current[descriptor.state] + 1,
      });
    }
    return {
      total: descriptors.length,
      roles: [...byRole.values()].sort((left, right) =>
        left.role.localeCompare(right.role),
      ),
    };
  }

  private buildDeliveryRequest(
    interaction: DiscordCommandInteractionAdapter,
    operation: DiscordDeliveryOperation,
    eventType: DiscordDeliveryEventType,
    taskId: string,
    sequence: number,
    payload: DiscordMessagePayload,
  ): DiscordDeliveryRequest {
    return {
      idempotencyKey: buildDiscordIdempotencyKey({
        taskId,
        eventType,
        sequence,
      }),
      operation,
      payload,
      context: {
        taskId,
        userId: interaction.userId,
        ...(interaction.channelId === undefined
          ? {}
          : { channelId: interaction.channelId }),
        eventType,
      },
    };
  }

  private async deliver(
    interaction: DiscordCommandInteractionAdapter,
    request: DiscordDeliveryRequest,
  ): Promise<unknown> {
    const personaApplied = await this.applyPersonaStyle(request);
    const payloads = splitDiscordMessagePayload(personaApplied.payload);
    const results: unknown[] = [];
    for (const [index, payload] of payloads.entries()) {
      const chunkRequest: DiscordDeliveryRequest =
        index === 0
          ? { ...personaApplied, payload }
          : {
              ...personaApplied,
              idempotencyKey: `${personaApplied.idempotencyKey}:chunk-${index}`,
              operation: 'followUp',
              payload,
            };
      // UX-25 (cycle 11): capture the message id of the Discord reply
      // so automated tests can read the ledger and verify cycle 8/10
      // in-place edit (same id across editReply ops) without needing
      // bot-token Discord REST access (which the Auto Mode classifier
      // blocks as credential use).
      let capturedMessageId: string | undefined;
      results.push(
        await this.deliveryQueue.enqueue(chunkRequest, async (req) => {
          if (req.operation === 'editReply') {
            const replyResult = await interaction.editReply(req.payload);
            capturedMessageId = interaction.extractMessageId?.(replyResult);
            return;
          }
          const router = this.options.sessionLogThreadRouter;
          const taskId = req.context?.taskId;
          if (router !== undefined && taskId !== undefined) {
            const outcome = await router.routeFollowUp({
              taskId,
              payload: req.payload,
              ...(req.context?.eventType === undefined
                ? {}
                : { eventType: req.context.eventType }),
            });
            if (outcome.delivered === 'thread') {
              return;
            }
            console.warn(
              'discord-session-log-thread-fallback',
              JSON.stringify({
                taskId,
                eventType: req.context?.eventType,
                fallbackReason: outcome.fallbackReason,
              }),
            );
          }
          const followUpResult = await interaction.followUp(req.payload);
          capturedMessageId = interaction.extractMessageId?.(followUpResult);
        }),
      );
      this.recordDeliveryObserved(interaction, chunkRequest, capturedMessageId);
    }
    return results;
  }

  /**
   * UX-25 (cycle 11): emit a `task.delivery_observed` ledger event so
   * automated tests have a Discord-REST-free way to verify cycle-8/10
   * in-place edit and cycle-9 thread routing. Fail-open: ledger
   * absence or append errors are silenced — the deliver path must not
   * regress for an observability concern.
   */
  private recordDeliveryObserved(
    interaction: DiscordCommandInteractionAdapter,
    request: DiscordDeliveryRequest,
    messageId: string | undefined,
  ): void {
    const ledger = this.options.controlLedger;
    if (ledger === undefined) {
      return;
    }
    const taskId = request.context?.taskId;
    if (taskId === undefined) {
      return;
    }
    try {
      ledger.append({
        type: 'task.delivery_observed',
        actor: { kind: 'system' },
        channel: {
          kind: 'discord',
          ...(interaction.guildId === undefined
            ? {}
            : { guildId: interaction.guildId }),
          ...(interaction.channelId === undefined
            ? {}
            : { channelId: interaction.channelId }),
        },
        taskId,
        trust: { source: 'system', inputTrust: 'trusted' },
        payload: {
          operation: request.operation,
          eventType: request.context?.eventType ?? 'unknown',
          idempotencyKey: request.idempotencyKey,
          ...(messageId === undefined ? {} : { messageId }),
        },
      });
    } catch {
      // ledger append failure is intentionally silenced — observability
      // must not break the deliver path.
    }
  }

  /**
   * Run the persona transformer over the pre-chunk payload when one is
   * configured and the event type is conversational. Fail-open: any
   * transformer error or empty result leaves the original payload intact.
   */
  private async applyPersonaStyle(
    request: DiscordDeliveryRequest,
  ): Promise<DiscordDeliveryRequest> {
    const transformer = this.options.personaTransformer;
    if (transformer === undefined) {
      return request;
    }
    const eventType = request.context?.eventType;
    const allowedEventTypes =
      transformer.eventTypes ?? CONVERSATIONAL_PERSONA_EVENT_TYPES;
    if (!isPersonaEventTypeTransformable(eventType, allowedEventTypes)) {
      return request;
    }
    const original = request.payload.content;
    if (original.length === 0) {
      return request;
    }
    try {
      const transformed = await transformer.transform({
        text: original,
        eventType: eventType as DiscordDeliveryEventType,
        ...(request.context?.taskId === undefined
          ? {}
          : { taskId: request.context.taskId }),
      });
      const trimmed = typeof transformed === 'string' ? transformed.trim() : '';
      if (trimmed.length === 0) {
        return request;
      }
      const missingProtectedTokens = findMissingPersonaProtectedTokens(
        original,
        trimmed,
      );
      if (missingProtectedTokens.length > 0) {
        console.warn(
          'discord-persona-transform-invariant-miss',
          JSON.stringify({
            eventType,
            taskId: request.context?.taskId,
            missingCount: missingProtectedTokens.length,
          }),
        );
        return request;
      }
      if (!isValidAronaPlanaDuetOutput(trimmed)) {
        console.warn(
          'discord-persona-transform-shape-miss',
          JSON.stringify({
            eventType,
            taskId: request.context?.taskId,
          }),
        );
        return request;
      }
      return {
        ...request,
        payload: { ...request.payload, content: trimmed },
      };
    } catch (error) {
      console.warn(
        'discord-persona-transform-throw',
        JSON.stringify({
          eventType,
          taskId: request.context?.taskId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return request;
    }
  }

  async handleInteraction(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    // M5b — Run command-intercept hooks first. A hook returning a 'denied'
    // veto aborts dispatch with an access-denied response. Throws are
    // contained (admit-by-default).
    const interceptHooks = this.options.commandInterceptHooks ?? [];
    for (const binding of interceptHooks) {
      try {
        const decision = await binding.commandIntercept(
          {
            moduleId: binding.moduleId as never,
            moduleVersion: binding.moduleVersion,
            observedAt: new Date().toISOString(),
          },
          {
            commandName: interaction.commandName,
            userId: interaction.userId,
            ...(interaction.channelId === undefined
              ? {}
              : { channelId: interaction.channelId }),
            ...(interaction.source === undefined
              ? {}
              : { source: interaction.source }),
          },
        );
        if (decision !== null && decision?.status === 'denied') {
          await interaction.deferReply({ ephemeral: true });
          await interaction.editReply({
            content: `Command \`/${interaction.commandName}\` denied by trait \`${binding.moduleId}\`: ${decision.reason}`,
          });
          return;
        }
      } catch (error) {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'commandIntercept',
            moduleId: binding.moduleId,
            commandName: interaction.commandName,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    const dispatch = DISCORD_COMMAND_DISPATCH[interaction.commandName];
    await dispatch(this, interaction);
  }

  /**
   * UX-26 (cycle 12) — chat-by-default routing for natural-language
   * mentions. Returns `true` when the mention was handled as chat /
   * task-confirm and the caller should NOT proceed with the task
   * dispatch lifecycle. Returns `false` to fall through to the
   * existing task path (task-explicit or unknown classification).
   */
  private async maybeRouteMentionAsChat(
    interaction: DiscordCommandInteractionAdapter,
    instruction: string,
  ): Promise<boolean> {
    const hintState = this.options.mentionChatHintState;
    if (hintState === undefined || interaction.channelId === undefined) {
      return false;
    }
    const channelId = interaction.channelId;
    const userId = interaction.userId;
    const hasPriorChatHint = hintState.getActiveHint(channelId, userId) !== undefined;
    const intent = classifyMentionTaskIntent({ instruction, hasPriorChatHint });

    if (intent.kind === 'task-explicit') {
      // Operator typed an explicit task keyword — clear any stale
      // hint and fall through to the task path so the existing
      // dispatchInstructionTask flow runs.
      hintState.clearHint(channelId, userId);
      return false;
    }

    if (intent.kind === 'task-confirm') {
      const consumed = hintState.consumeHint(channelId, userId);
      if (consumed === undefined) {
        // Race: the hint expired between getActiveHint and consumeHint.
        // Treat as chat-only.
        await this.deliverMentionChatReply(interaction, instruction);
        return true;
      }
      // Re-dispatch the original instruction as a fresh task. We
      // briefly acknowledge then enter the standard task path (which
      // will use the original instruction, not the bare confirm word).
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'mention-task-escalated',
          `discord-mention-escalate-${userId}`,
          this.mentionChatReplySeq++,
          renderMentionTaskEscalated({
            originalInstruction: consumed.originalInstruction,
          }),
        ),
      );
      // Now dispatch using the ORIGINAL instruction (the one the
      // operator actually wanted run, not the "yes" confirm word).
      await this.dispatchInstructionTask(interaction, {
        dispatchInstruction: consumed.originalInstruction,
        ledgerInstruction: consumed.originalInstruction,
        requestedInstruction: consumed.originalInstruction,
        recordCommandName: 'ask',
        ledgerCommandName: 'ask',
        acceptedEventType: 'ask-accepted',
        acceptedSequence: 0,
        renderAccepted: (record) => renderAskAccepted(record),
        // UX-26H: this confirmation branch already deferred and edited
        // the interaction with `mention-task-escalated` above. Do not
        // defer a second time inside the shared task dispatcher; real
        // Discord interactions reject double defer/reply even though the
        // unit-test adapter records it harmlessly.
        deferReply: false,
      });
      return true;
    }

    if (intent.kind === 'chat-with-task-hint') {
      const ttlMs = this.options.mentionChatHintTtlMs ?? 5 * 60 * 1_000;
      hintState.recordHint({
        channelId,
        userId,
        originalInstruction: instruction,
      });
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'mention-chat-with-task-hint',
          `discord-mention-chat-${userId}`,
          this.mentionChatReplySeq++,
          renderMentionChatWithTaskHint({
            originalInstruction: instruction,
            ttlSeconds: Math.round(ttlMs / 1_000),
          }),
        ),
      );
      return true;
    }

    // chat-only
    await this.deliverMentionChatReply(interaction, instruction);
    return true;
  }

  private async deliverMentionChatReply(
    interaction: DiscordCommandInteractionAdapter,
    instruction: string,
  ): Promise<void> {
    await interaction.deferReply();
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'mention-chat-reply',
        `discord-mention-chat-${interaction.userId}`,
        this.mentionChatReplySeq++,
        renderMentionChatReply({ originalInstruction: instruction }),
      ),
    );
  }

  async handleAsk(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const instruction = interaction.getString('instruction', true);
    if (instruction === null) {
      throw new Error('instruction is required for /ask');
    }

    // UX-26 (cycle 12): mention-driven natural-language path can take a
    // chat-by-default branch when AUTO_ARCHIVE_DISCORD_MENTION_DEFAULT_CHAT=on
    // is wired and the message classifies as chat. Slash commands stay
    // on the task path unconditionally — they are explicit by shape.
    if (
      interaction.source === 'natural-language' &&
      this.options.mentionChatHintState !== undefined
    ) {
      const handled = await this.maybeRouteMentionAsChat(interaction, instruction);
      if (handled) {
        return;
      }
    }

    const activeFocus =
      interaction.channelId === undefined
        ? undefined
        : this.options.sessionBindings?.active({
            channelId: interaction.channelId,
            ownerUserId: interaction.userId,
          });
    const focusedInstruction =
      activeFocus === undefined
        ? instruction
        : `${instruction}\n\n[Auto Archive focus binding]\nBound task: ${activeFocus.taskId}${activeFocus.subagentId === undefined ? '' : `\\nBound subagent: ${activeFocus.subagentId}`}\nTreat this as operator steering context. Preserve currentInstruction as the only executable user instruction; prior task history remains untrusted supplemental context.`;
    if (activeFocus !== undefined) {
      this.options.controlLedger?.append({
        type: 'steering.submitted',
        actor: { kind: 'discord-user', userId: interaction.userId },
        channel: {
          kind: 'discord',
          ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId }),
          ...(interaction.channelId === undefined ? {} : { channelId: interaction.channelId }),
        },
        conversationId: interaction.channelId,
        taskId: activeFocus.taskId,
        correlationId: activeFocus.bindingId,
        trust: { source: 'discord', inputTrust: 'untrusted' },
        payload: {
          bindingAudit: createDiscordSessionBindingAudit(
            'steering.submitted',
            activeFocus,
            new Date().toISOString(),
          ),
        },
      });
    }

    await this.dispatchInstructionTask(interaction, {
      dispatchInstruction: focusedInstruction,
      ledgerInstruction: instruction,
      requestedInstruction: focusedInstruction,
      recordCommandName: interaction.commandName === 'research' ? 'research' : 'ask',
      ledgerCommandName: interaction.commandName,
      acceptedEventType: 'ask-accepted',
      acceptedSequence: 0,
      renderAccepted: (record) => renderAskAccepted(record),
    });
  }

  async handleResearch(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const action = interaction.getString('action')?.trim();
    if (action === undefined || action.length === 0) {
      const instruction = interaction.getString('instruction')?.trim();
      if (instruction !== undefined && instruction.length > 0) {
        await this.handleAsk(interaction);
        return;
      }
      if (await this.denyIfUnauthorized(interaction)) {
        return;
      }
      await interaction.deferReply();
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action: 'new',
          option: 'instruction',
          hint: 'Use /research action:new instruction:<mission goal>, or omit action and provide instruction:<task> for the legacy task-dispatch path.',
        }),
      );
      return;
    }

    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();

    switch (action) {
      case 'new':
        await this.handleResearchMissionNew(interaction);
        return;
      case 'show':
      case 'status':
        await this.handleResearchMissionShow(interaction, action);
        return;
      case 'pin':
        await this.handleResearchMissionPin(interaction);
        return;
      case 'approve':
        await this.handleResearchMissionApprove(interaction);
        return;
      case 'pause':
      case 'resume':
      case 'complete':
        await this.handleResearchMissionStatusTransition(interaction, action);
        return;
      case 'synthesize':
        await this.handleResearchMissionSynthesize(interaction);
        return;
      case 'archive':
        await this.handleResearchMissionArchivePreflight(interaction);
        return;
      default:
        await this.deliverResearchMissionReply(
          interaction,
          `research-mission-${interaction.userId}`,
          renderResearchMissionOptionRequired({
            action,
            option: 'action',
            hint: 'Supported research mission actions are new, show, approve, status, pause, resume, complete, pin, synthesize, and archive.',
          }),
        );
    }
  }

  async handleEvidence(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    const action = interaction.getString('action')?.trim();
    if (action === undefined || action.length === 0) {
      await this.deliverResearchEvidenceReply(
        interaction,
        `research-evidence-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'evidence',
          action: 'add',
          option: 'action',
          hint: 'Supported evidence actions are add and list.',
        }),
      );
      return;
    }
    switch (action) {
      case 'add':
        await this.handleEvidenceAdd(interaction);
        return;
      case 'list':
        await this.handleEvidenceList(interaction);
        return;
      default:
        await this.deliverResearchEvidenceReply(
          interaction,
          `research-evidence-${interaction.userId}`,
          renderResearchStateOptionRequired({
            command: 'evidence',
            action,
            option: 'action',
            hint: 'Supported evidence actions are add and list.',
          }),
        );
    }
  }

  async handleClaim(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    const action = interaction.getString('action')?.trim();
    if (action === undefined || action.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        `research-claim-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'claim',
          action: 'add',
          option: 'action',
          hint: 'Supported claim actions are add, list, support, and challenge.',
        }),
      );
      return;
    }
    switch (action) {
      case 'add':
        await this.handleClaimAdd(interaction);
        return;
      case 'list':
        await this.handleClaimList(interaction);
        return;
      case 'support':
      case 'challenge':
        await this.handleClaimEvidenceLink(interaction, action);
        return;
      default:
        await this.deliverResearchClaimReply(
          interaction,
          `research-claim-${interaction.userId}`,
          renderResearchStateOptionRequired({
            command: 'claim',
            action,
            option: 'action',
            hint: 'Supported claim actions are add, list, support, and challenge.',
          }),
        );
    }
  }

  async handleCritique(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    const action = interaction.getString('action')?.trim() || 'preflight';
    if (action !== 'preflight' && action !== 'record') {
      await this.deliverResearchCritiqueReply(
        interaction,
        `research-critique-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'critique',
          action,
          option: 'action',
          hint: 'Supported critique actions are preflight and record.',
        }),
      );
      return;
    }
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchCritiqueReply(
        interaction,
        `research-critique-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'critique',
          action: 'preflight',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const rawLens = interaction.getString('lens')?.trim();
    if (!isResearchCritiqueLens(rawLens)) {
      await this.deliverResearchCritiqueReply(
        interaction,
        missionId,
        renderResearchStateOptionRequired({
          command: 'critique',
          action: 'preflight',
          option: 'lens',
          hint: 'Supported critique lenses are methodology, evidence, counterargument, and reproducibility.',
        }),
      );
      return;
    }
    const mission = this.researchMissions.get(missionId);
    if (mission === undefined) {
      await this.deliverResearchCritiqueReply(
        interaction,
        missionId,
        renderResearchMissionNotFound(missionId),
      );
      return;
    }
    if (action === 'record') {
      const result = this.researchMissions.recordConstraintReport({
        missionId: mission.missionId,
        lens: rawLens,
        claimId: interaction.getString('claim_id')?.trim() || undefined,
        actorId: interaction.userId,
      });
      await this.deliverResearchCritiqueReply(
        interaction,
        missionId,
        result.status === 'recorded'
          ? renderResearchConstraintReportRecorded({
              missionId,
              report: result.constraintReport,
              constraintReportCount: result.mission.constraintReportCount,
            })
          : result.status === 'mission-not-found'
            ? renderResearchMissionNotFound(missionId)
            : renderResearchConstraintReportRecordFailed({
                missionId,
                claimId: result.claimId,
                reason: 'claim-not-found',
              }),
      );
      return;
    }
    await this.deliverResearchCritiqueReply(
      interaction,
      missionId,
      renderResearchCritiquePreflight({
        missionId: mission.missionId,
        lens: rawLens,
        missionStatus: mission.status,
        phase: mission.phase,
        evidenceCount: mission.evidenceItemCount,
        claims: mission.claims,
        latestSynthesisId: mission.latestSynthesisId,
        warnings: this.buildResearchCritiqueWarnings(mission, rawLens),
      }),
    );
  }

  private buildResearchCritiqueWarnings(
    mission: ResearchMissionRecord,
    lens: ResearchCritiqueLens,
  ): readonly string[] {
    const warnings: string[] = [];
    if (mission.evidenceItemCount === 0) {
      warnings.push('no retained evidence items recorded yet');
    }
    if (mission.latestSynthesisId === undefined) {
      warnings.push('no synthesis draft generated yet');
    }
    if (mission.claims.uncertain > 0) {
      warnings.push(`${mission.claims.uncertain} uncertain claim(s) need review`);
    }
    if (mission.claims.challenged > 0) {
      warnings.push(`${mission.claims.challenged} challenged claim(s) need counterargument review`);
    }
    if (lens === 'evidence' && mission.claims.supported > mission.evidenceItemCount) {
      warnings.push('supported claims may outnumber retained evidence items');
    }
    if (
      lens === 'reproducibility' &&
      mission.proof.pass === 0 &&
      mission.proof.warn === 0 &&
      (mission.proof.fail ?? 0) === 0
    ) {
      warnings.push('mission-local proof counters are empty');
    }
    return warnings;
  }

  private async handleResearchMissionNew(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const goal = interaction.getString('instruction')?.trim();
    if (goal === undefined || goal.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action: 'new',
          option: 'instruction',
          hint: 'Provide the mission goal as instruction:<goal> so the draft plan can be generated.',
        }),
      );
      return;
    }
    if (interaction.channelId === undefined || interaction.channelId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionChannelRequired(),
      );
      return;
    }

    const title = interaction.getString('title')?.trim();
    const mission = this.researchMissions.createDraft({
      goal,
      ...(title === undefined || title.length === 0 ? {} : { title }),
      ownerId: interaction.userId,
      discordChannelId: interaction.channelId,
    });
    await this.deliverResearchMissionReply(
      interaction,
      mission.missionId,
      renderResearchMissionSummary(
        this.withResearchMissionSummaryContext(
          this.researchMissions.toSummaryInput(mission.missionId) ?? {
            missionId: mission.missionId,
            title: mission.title,
            status: mission.status,
            phase: mission.phase,
            owner: `@${mission.ownerId}`,
            threadLabel: mission.discordChannelId,
            plan: mission.planDraft,
            evidenceCount: mission.evidenceItemCount,
            claims: mission.claims,
            proof: mission.proof,
          },
        ),
      ),
    );
  }

  private async handleResearchMissionShow(
    interaction: DiscordCommandInteractionAdapter,
    action: 'show' | 'status',
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action,
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const summary = this.researchMissions.toSummaryInput(missionId);
    await this.deliverResearchMissionReply(
      interaction,
      missionId,
      summary === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchMissionSummary(this.withResearchMissionSummaryContext(summary)),
    );
  }

  private async handleResearchMissionPin(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action: 'pin',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary to render the pin-ready status card.',
        }),
      );
      return;
    }
    const summary = this.researchMissions.toSummaryInput(missionId);
    await this.deliverResearchMissionReply(
      interaction,
      missionId,
      summary === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchMissionPinnedSummary(this.withResearchMissionSummaryContext(summary)),
    );
  }

  private async handleResearchMissionApprove(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action: 'approve',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const planId = interaction.getString('plan_id')?.trim();
    if (planId === undefined || planId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        missionId,
        renderResearchMissionOptionRequired({
          action: 'approve',
          option: 'plan_id',
          hint: 'Provide the existing research-plan id that /research-plan should dispatch next.',
        }),
      );
      return;
    }
    const planLookup = this.researchPlans?.inspect(planId);
    if (planLookup?.status === 'unavailable') {
      await this.deliverResearchMissionReply(
        interaction,
        missionId,
        renderResearchMissionPlanUnavailable({
          planId,
          reason: planLookup.reason,
        }),
      );
      return;
    }

    const approved = this.researchMissions.approve({
      missionId,
      planId,
      actorId: interaction.userId,
    });
    const summary =
      approved === undefined ? undefined : this.researchMissions.toSummaryInput(missionId);
    await this.deliverResearchMissionReply(
      interaction,
      missionId,
      summary === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchMissionSummary(this.withResearchMissionSummaryContext(summary)),
    );
    if (approved !== undefined && planLookup?.status === 'found') {
      await this.dispatchApprovedResearchMissionPlan(
        interaction,
        missionId,
        planId,
        planLookup.plan,
      );
    }
  }

  private async handleResearchMissionStatusTransition(
    interaction: DiscordCommandInteractionAdapter,
    action: 'pause' | 'resume' | 'complete',
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action,
          option: 'mission_id',
          hint: `Copy the mission id from a recent Research Mission summary to ${action} the mission lifecycle.`,
        }),
      );
      return;
    }

    const transition: {
      readonly status: ResearchMissionStatus;
      readonly phase: string;
    } =
      action === 'pause'
        ? { status: 'blocked', phase: 'paused by operator' }
        : action === 'resume'
          ? { status: 'running', phase: 'running' }
          : { status: 'completed', phase: 'completed closeout-ready' };

    const mission = this.researchMissions.get(missionId);
    if (mission === undefined) {
      await this.deliverResearchMissionReply(
        interaction,
        missionId,
        renderResearchMissionNotFound(missionId),
      );
      return;
    }
    if (
      await this.denyIfNotResearchMissionOwnerOrAdmin({
        interaction,
        mission,
        action,
      })
    ) {
      return;
    }

    const updated = this.researchMissions.setStatus({
      missionId,
      status: transition.status,
      phase: transition.phase,
      actorId: interaction.userId,
    });
    const summary =
      updated === undefined ? undefined : this.researchMissions.toSummaryInput(missionId);
    await this.deliverResearchMissionReply(
      interaction,
      missionId,
      summary === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchMissionSummary(this.withResearchMissionSummaryContext(summary)),
    );
  }

  private async denyIfNotResearchMissionOwnerOrAdmin(input: {
    readonly interaction: DiscordCommandInteractionAdapter;
    readonly mission: ResearchMissionRecord;
    readonly action: 'pause' | 'resume' | 'complete';
  }): Promise<boolean> {
    if (
      input.mission.ownerId === input.interaction.userId ||
      this.options.accessPolicy?.isAdminUser(input.interaction.userId) === true
    ) {
      return false;
    }
    await this.deliverResearchMissionReply(
      input.interaction,
      input.mission.missionId,
      renderResearchMissionOwnerRequired({
        missionId: input.mission.missionId,
        action: input.action,
      }),
    );
    return true;
  }

  private async handleResearchMissionSynthesize(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action: 'synthesize',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary to build a claim/evidence synthesis draft.',
        }),
      );
      return;
    }
    const result = this.researchMissions.generateSynthesis({
      missionId,
      actorId: interaction.userId,
    });
    await this.deliverResearchMissionReply(
      interaction,
      missionId,
      result === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchSynthesis({
            missionId,
            synthesisId: result.synthesis.synthesisId,
            body: result.synthesis.body,
            evidenceCount: result.synthesis.evidence.length,
            claims: result.mission.claims,
            createdBy: result.synthesis.createdBy,
            createdAt: result.synthesis.createdAt,
          }),
    );
  }

  private buildResearchCloseoutChecklistInput(
    mission: ResearchMissionRecord,
  ): RenderResearchCloseoutChecklistInput {
    const latestSynthesis = this.researchMissions.getLatestSynthesis(
      mission.missionId,
    );
    const liveProof = this.options.doctorStatus?.liveProofReport;
    const unresolvedClaimCount = mission.claims.uncertain + mission.claims.challenged;
    const evalSnapshot = projectResearchMissionEvalSnapshot({
      acceptanceChecks: mission.planDraft.map((step) => ({
        state: step.state === 'current' ? 'warning' : step.state,
      })),
      claims: mission.claims,
      proof: mission.proof,
      constraintReportCount: mission.constraintReportCount,
      constraintReportProvenance: 'mission-ledger',
      liveProofReportStatus: liveProof?.reportStatus,
    });
    const required: RenderResearchCloseoutChecklistInput['required'] = [
      {
        text:
          mission.planId === undefined
            ? 'research plan approval missing'
            : `research plan approved (${mission.planId})`,
        state: mission.planId === undefined ? 'warning' : 'complete',
      },
      {
        text:
          latestSynthesis === undefined
            ? 'synthesis report missing'
            : `synthesis report exists (${latestSynthesis.synthesisId})`,
        state: latestSynthesis === undefined ? 'warning' : 'complete',
      },
      {
        text:
          mission.evidenceItemCount === 0
            ? 'evidence ledger has no retained items'
            : `evidence ledger retained (${mission.evidenceItemCount} item${
                mission.evidenceItemCount === 1 ? '' : 's'
              })`,
        state: mission.evidenceItemCount === 0 ? 'warning' : 'complete',
      },
      {
        text:
          unresolvedClaimCount === 0
            ? 'claims resolved'
            : `${mission.claims.uncertain} uncertain and ${mission.claims.challenged} challenged claim(s) remain`,
        state: unresolvedClaimCount === 0 ? 'complete' : 'warning',
      },
      this.buildResearchCloseoutProofCheck(mission),
    ];
    const recommended = [
      latestSynthesis === undefined
        ? `Run /research action:synthesize mission_id:${mission.missionId}`
        : undefined,
      unresolvedClaimCount === 0
        ? undefined
        : 'Run /critique lens:counterargument before archive closeout',
      mission.constraintReportCount === 0
        ? `Run /critique action:record mission_id:${mission.missionId} lens:counterargument before archive closeout`
        : undefined,
      this.buildResearchCloseoutProofRecommendation(liveProof),
      'Record GitLab closeout after operator approval/proof is ready',
    ].filter((item): item is string => item !== undefined);

    return {
      missionId: mission.missionId,
      preflight: true,
      required,
      evalSignals: [
        {
          text:
            evalSnapshot.acceptanceCheckCoverage.total === 0
              ? 'acceptance coverage unavailable (no plan steps recorded)'
              : `acceptance coverage ${evalSnapshot.acceptanceCheckCoverage.complete}/${evalSnapshot.acceptanceCheckCoverage.total} plan step${
                  evalSnapshot.acceptanceCheckCoverage.total === 1 ? '' : 's'
                } complete`,
          state:
            evalSnapshot.acceptanceCheckCoverage.coverage === 'complete'
              ? 'complete'
              : 'warning',
        },
        {
          text: `unresolved claims ${evalSnapshot.unresolvedClaims.total} (${evalSnapshot.unresolvedClaims.uncertain} uncertain, ${evalSnapshot.unresolvedClaims.challenged} challenged)`,
          state: evalSnapshot.unresolvedClaims.total === 0 ? 'complete' : 'warning',
        },
        {
          text: `constraint reports ${evalSnapshot.constraintReports.count} recorded (${evalSnapshot.constraintReports.provenance})`,
          state: evalSnapshot.constraintReports.count > 0 ? 'complete' : 'warning',
        },
        this.buildResearchCloseoutProofLinkEval(evalSnapshot),
      ],
      recommended,
      actions: [
        { verb: 'archive-anyway', label: 'Archive anyway', style: 'danger' },
        { verb: 'run-missing-proof', label: 'Run missing proof', style: 'primary' },
        { verb: 'cancel', label: 'Cancel' },
      ],
    };
  }

  private buildResearchCloseoutProofLinkEval(
    evalSnapshot: ReturnType<typeof projectResearchMissionEvalSnapshot>,
  ): NonNullable<RenderResearchCloseoutChecklistInput['evalSignals']>[number] {
    const pass = evalSnapshot.liveProofLinkage.missionProofPass;
    const warn = evalSnapshot.liveProofLinkage.missionProofWarn;
    const fail = evalSnapshot.liveProofLinkage.missionProofFail;
    const total = pass + warn + fail;
    return {
      text:
        total === 0
          ? 'live-proof linkage 0 mission-local proof links'
          : `live-proof linkage ${total} mission-local proof link${
              total === 1 ? '' : 's'
            } (${pass} PASS, ${warn} WARN, ${fail} FAIL)`,
      state: total > 0 && fail === 0 ? 'complete' : 'warning',
    };
  }

  private buildResearchCloseoutProofCheck(
    mission: ResearchMissionRecord,
  ): RenderResearchCloseoutChecklistInput['required'][number] {
    const liveProof = this.options.doctorStatus?.liveProofReport;
    if (liveProof === undefined) {
      return {
        text: `proof report not configured; mission proof counts ${mission.proof.pass} PASS/${mission.proof.warn} WARN`,
        state: 'warning',
      };
    }
    if (liveProof.error !== undefined) {
      return {
        text: 'proof report failed; run /proof action:status for the redacted error',
        state: 'warning',
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
      text: `proof report ${reportStatus}: ${complete} complete, ${warn}/${fail} warn/fail, ${missing} missing artifact token${
        missing === 1 ? '' : 's'
      }`,
      state: proofComplete ? 'complete' : 'warning',
    };
  }

  private buildResearchCloseoutProofRecommendation(
    liveProof: DiscordDoctorStatus['liveProofReport'] | undefined,
  ): string | undefined {
    if (liveProof === undefined || liveProof.error !== undefined) {
      return 'Run /proof action:status and configure a redacted live-proof manifest';
    }
    const reportStatus = liveProof.reportStatus ?? 'no-proof';
    const warn = liveProof.warnProofCount ?? 0;
    const fail = liveProof.failProofCount ?? 0;
    const missing = liveProof.missingRequiredArtifactCount ?? 0;
    if (
      reportStatus === 'complete' &&
      warn === 0 &&
      fail === 0 &&
      missing === 0
    ) {
      return undefined;
    }
    return 'Run /proof action:status and capture missing live-proof artifacts';
  }

  private async handleResearchMissionArchivePreflight(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchMissionReply(
        interaction,
        `research-mission-${interaction.userId}`,
        renderResearchMissionOptionRequired({
          action: 'archive',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary to render the closeout checklist.',
        }),
      );
      return;
    }
    const mission = this.researchMissions.get(missionId);
    await this.deliverResearchMissionReply(
      interaction,
      missionId,
      mission === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchCloseoutChecklist(
            this.buildResearchCloseoutChecklistInput(mission),
          ),
    );
  }

  private async dispatchApprovedResearchMissionPlan(
    interaction: DiscordCommandInteractionAdapter,
    missionId: string,
    planId: string,
    plan: import('../core/research-plan-orchestrator.js').ResearchPlan,
  ): Promise<void> {
    const driver = this.options.researchPlanRuntimeDriver;
    if (driver === undefined) {
      return;
    }
    const taskId = `discord-research-mission-plan-${missionId}-${Date.now()}`;
    const inferredProvider: 'codex' | 'claude-agent' =
      process.env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim() === 'claude-agent'
        ? 'claude-agent'
        : 'codex';
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'followUp',
        'research-plan-accepted',
        taskId,
        this.researchPlanReplySeq++,
        renderResearchPlanAccepted({
          planId,
          subTaskCount: plan.subTasks.length,
          provider: inferredProvider,
          subagentRosterActive:
            this.options.researchPlanUseSubagentRoster === true &&
            this.options.researchPlanSubagentPolicyEnforcer !== undefined,
        }),
      ),
    );
    void this.dispatchResearchPlan(interaction, taskId, planId, plan, driver, {
      missionId,
      actorId: interaction.userId,
    });
  }

  private recordResearchPlanSubTaskEvidence(input: {
    readonly missionId: string;
    readonly planId: string;
    readonly outcome: ResearchSubTaskOutcome;
    readonly actorId: string;
  }): void {
    const finalText = input.outcome.finalText.trim();
    const resultReason = input.outcome.result?.reason?.trim();
    const driverThrew = input.outcome.driverThrew?.trim();
    const evidenceSummary =
      finalText.length > 0
        ? `Research-plan sub-task ${input.outcome.subTaskId} completed with ${input.outcome.causeKind}: ${finalText}`
        : `Research-plan sub-task ${input.outcome.subTaskId} completed with ${input.outcome.causeKind}: ${
            resultReason !== undefined && resultReason.length > 0
              ? resultReason
              : driverThrew !== undefined && driverThrew.length > 0
                ? driverThrew
                : 'no final text emitted'
          }`;
    this.researchMissions.addEvidence({
      missionId: input.missionId,
      summary: evidenceSummary,
      source: `research-plan:${input.planId}/${input.outcome.subTaskId}`,
      actorId: input.actorId,
    });
  }

  private async handleEvidenceAdd(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchEvidenceReply(
        interaction,
        `research-evidence-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'evidence',
          action: 'add',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const summary = interaction.getString('summary')?.trim();
    if (summary === undefined || summary.length === 0) {
      await this.deliverResearchEvidenceReply(
        interaction,
        missionId,
        renderResearchStateOptionRequired({
          command: 'evidence',
          action: 'add',
          option: 'summary',
          hint: 'Summarize the observation, artifact, terminal result, or source.',
        }),
      );
      return;
    }
    const result = this.researchMissions.addEvidence({
      missionId,
      summary,
      source: interaction.getString('source')?.trim() || undefined,
      actorId: interaction.userId,
    });
    await this.deliverResearchEvidenceReply(
      interaction,
      missionId,
      result === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchEvidenceAdded({
            missionId,
            evidence: result.evidence,
            evidenceCount: result.mission.evidenceItemCount,
          }),
    );
  }

  private async handleEvidenceList(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchEvidenceReply(
        interaction,
        `research-evidence-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'evidence',
          action: 'list',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const evidence = this.researchMissions.listEvidence(missionId);
    await this.deliverResearchEvidenceReply(
      interaction,
      missionId,
      evidence === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchEvidenceList({ missionId, evidence }),
    );
  }

  private async handleClaimAdd(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        `research-claim-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'claim',
          action: 'add',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const text = interaction.getString('text')?.trim();
    if (text === undefined || text.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        missionId,
        renderResearchStateOptionRequired({
          command: 'claim',
          action: 'add',
          option: 'text',
          hint: 'Provide the claim or hypothesis that evidence should support or challenge.',
        }),
      );
      return;
    }
    const result = this.researchMissions.addClaim({
      missionId,
      text,
      actorId: interaction.userId,
    });
    await this.deliverResearchClaimReply(
      interaction,
      missionId,
      result === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchClaimAdded({
            missionId,
            claim: result.claim,
            claims: result.mission.claims,
          }),
    );
  }

  private async handleClaimList(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        `research-claim-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'claim',
          action: 'list',
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const claims = this.researchMissions.listClaims(missionId);
    await this.deliverResearchClaimReply(
      interaction,
      missionId,
      claims === undefined
        ? renderResearchMissionNotFound(missionId)
        : renderResearchClaimList({ missionId, claims }),
    );
  }

  private async handleClaimEvidenceLink(
    interaction: DiscordCommandInteractionAdapter,
    action: 'support' | 'challenge',
  ): Promise<void> {
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId === undefined || missionId.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        `research-claim-${interaction.userId}`,
        renderResearchStateOptionRequired({
          command: 'claim',
          action,
          option: 'mission_id',
          hint: 'Copy the mission id from a recent Research Mission summary.',
        }),
      );
      return;
    }
    const claimId = interaction.getString('claim_id')?.trim();
    if (claimId === undefined || claimId.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        missionId,
        renderResearchStateOptionRequired({
          command: 'claim',
          action,
          option: 'claim_id',
          hint: 'Use `/claim action:list mission_id:<id>` to copy a claim id.',
        }),
      );
      return;
    }
    const evidenceId = interaction.getString('evidence_id')?.trim();
    if (evidenceId === undefined || evidenceId.length === 0) {
      await this.deliverResearchClaimReply(
        interaction,
        missionId,
        renderResearchStateOptionRequired({
          command: 'claim',
          action,
          option: 'evidence_id',
          hint: 'Use `/evidence action:list mission_id:<id>` to copy an evidence id.',
        }),
      );
      return;
    }
    const result = this.researchMissions.linkEvidenceToClaim({
      missionId,
      claimId,
      evidenceId,
      mode: action,
      actorId: interaction.userId,
    });
    await this.deliverResearchClaimReply(
      interaction,
      missionId,
      result.status === 'mission-not-found'
        ? renderResearchMissionNotFound(missionId)
        : result.status === 'linked'
          ? renderResearchClaimLinked({
              missionId,
              claim: result.claim,
              evidenceId,
              mode: action,
              claims: result.mission.claims,
            })
          : renderResearchClaimLinkFailed({
              missionId,
              claimId,
              evidenceId,
              reason: result.status,
            }),
    );
  }

  private async deliverResearchMissionReply(
    interaction: DiscordCommandInteractionAdapter,
    correlationId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'research-mission-reply',
        correlationId,
        this.researchMissionReplySeq++,
        payload,
      ),
    );
  }

  private async deliverResearchEvidenceReply(
    interaction: DiscordCommandInteractionAdapter,
    correlationId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'research-evidence-reply',
        correlationId,
        this.researchEvidenceReplySeq++,
        payload,
      ),
    );
  }

  private async deliverResearchClaimReply(
    interaction: DiscordCommandInteractionAdapter,
    correlationId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'research-claim-reply',
        correlationId,
        this.researchClaimReplySeq++,
        payload,
      ),
    );
  }

  private async deliverResearchCritiqueReply(
    interaction: DiscordCommandInteractionAdapter,
    correlationId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'research-critique-reply',
        correlationId,
        this.researchCritiqueReplySeq++,
        payload,
      ),
    );
  }

  private async dispatchInstructionTask(
    interaction: DiscordCommandInteractionAdapter,
    input: {
      readonly dispatchInstruction: string;
      readonly ledgerInstruction: string;
      readonly requestedInstruction: string;
      readonly recordCommandName: DiscordTaskCommandName;
      readonly ledgerCommandName: DiscordFirstSliceCommandName;
      readonly rerunOfTaskId?: string;
      readonly acceptedEventType: DiscordDeliveryEventType;
      readonly acceptedSequence: number;
      readonly renderAccepted: (record: DiscordTaskRecord) => DiscordMessagePayload;
      /**
       * Defaults to true. Set false only when the caller already
       * deferred this same interaction before entering the shared task
       * dispatch lifecycle.
       */
      readonly deferReply?: boolean;
    },
  ): Promise<void> {
    const request = this.options.requestFactory.createAskTaskRequest({
      instruction: input.dispatchInstruction,
      userId: interaction.userId,
      channelId: interaction.channelId,
    });
    this.options.controlLedger?.append({
      type: 'task.requested',
      actor: {
        kind: 'discord-user',
        userId: interaction.userId,
      },
      channel: {
        kind: 'discord',
        ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId }),
        ...(interaction.channelId === undefined
          ? {}
          : { channelId: interaction.channelId }),
      },
      conversationId: interaction.channelId,
      taskId: request.taskId,
      trust: {
        source: 'discord',
        inputTrust: 'untrusted',
      },
      payload: {
        commandName: input.ledgerCommandName,
        instruction: input.ledgerInstruction,
        ...(input.rerunOfTaskId === undefined
          ? {}
          : { rerunOfTaskId: input.rerunOfTaskId }),
      },
    });
    const pendingObservations: LifecyclePhaseObservation[] = [];
    const bufferedMessages: Array<{
      payload: DiscordMessagePayload;
      eventType: DiscordDeliveryEventType;
      sequence: number;
    }> = [];
    let initialReplySent = false;
    let runningUpdateSeq = 0;
    // UX-24 (cycle 9): a per-task thread, lazily started off the bot's
    // own accept message in the source channel after the initial
    // editReply lands. `taskThreadHandle` stays `undefined` when the
    // adapter does not expose `fetchReply` (button-press / NL message
    // paths), the channel is a DM, or thread creation throws (missing
    // permission, rate-limited, archived parent). Channel-only
    // delivery still proceeds in those cases.
    let taskThreadHandle: DiscordTaskThreadHandle | undefined;
    const sendToTaskThreadSafely = async (
      payload: DiscordMessagePayload,
    ): Promise<void> => {
      if (taskThreadHandle === undefined) {
        return;
      }
      try {
        await taskThreadHandle.send(payload);
      } catch (error) {
        console.warn(
          'discord-task-thread-send-error',
          JSON.stringify({
            taskId: request.taskId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };

    // UX-23 (cycle 8): lifecycle updates land via `editReply` instead of
    // `followUp` so a single Discord message is updated in-place across
    // the accept → running → terminal sequence. The user complaint
    // (channel noise + unintuitive `/status` re-fetch) collapses when
    // the entire lifecycle stays on one message. The Discord interaction
    // token's 15-min validity bounds the in-place lifetime; once the
    // message overflows the 2 000-char limit, `deliver` falls trailing
    // chunks back to followUp by design.
    //
    // UX-24 (cycle 9): when a per-task thread is open (see below), the
    // same payload is also `thread.send(...)`-ed so the thread carries
    // a Discord-native progressive history of the task while the source
    // channel keeps the in-place summary. Thread.send failures are
    // swallowed — losing a thread message is preferable to losing the
    // channel update.
    const queueFollowUp = (payload: DiscordMessagePayload): void => {
      const seq = runningUpdateSeq++;
      if (!initialReplySent) {
        bufferedMessages.push({
          payload,
          eventType: 'running-update',
          sequence: seq,
        });
        return;
      }
      const deliveryRequest = this.buildDeliveryRequest(
        interaction,
        'editReply',
        'running-update',
        request.taskId,
        seq,
        payload,
      );
      // Fire-and-record: the queue itself never throws; failures land in DLQ.
      void this.deliver(interaction, deliveryRequest);
      void sendToTaskThreadSafely(payload);
    };

    const applyObservation = (observation: LifecyclePhaseObservation): void => {
      const lifecycleUpdate = this.taskRegistry.observeLifecycle(observation);

      if (
        !lifecycleUpdate ||
        !lifecycleUpdate.coarseStateChanged ||
        lifecycleUpdate.record.coarseState !== 'running'
      ) {
        return;
      }

      queueFollowUp(renderRunningUpdate(lifecycleUpdate.record));
    };

    if (input.deferReply !== false) {
      await interaction.deferReply();
    }

    const result = await this.options.arona.requestDispatch(request, {
      lifecycleObserver: (observation) => {
        pendingObservations.push(observation);
        if (this.taskRegistry.get(observation.taskId) !== undefined) {
          applyObservation(observation);
        }
      },
    });

    if (result.kind === 'vetoed') {
      initialReplySent = true;
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'ask-veto',
          request.taskId,
          0,
          renderAskVeto(request.taskId, result.veto),
        ),
      );
      return;
    }

    const record = this.taskRegistry.registerTask({
      taskId: result.plan.taskId,
      commandName: input.recordCommandName,
      instruction: result.plan.instruction,
      requestedInstruction: input.requestedInstruction,
      ...(input.rerunOfTaskId === undefined
        ? {}
        : { rerunOfTaskId: input.rerunOfTaskId }),
      userId: interaction.userId,
      channelId: interaction.channelId,
      acceptance: result.submission.acceptance,
    });

    for (const observation of pendingObservations) {
      applyObservation(observation);
    }

    // Terminal-result follow-up. Was previously wrapped in `safelySend` and
    // failures were silently dropped; now routed through the delivery queue
    // so exhausted retries surface in the DLQ.
    void (async () => {
      let evidence: Awaited<typeof result.submission.completion>;
      try {
        evidence = await result.submission.completion;
      } catch (error) {
        console.warn(
          'discord-terminal-completion-rejected',
          JSON.stringify({
            taskId: result.plan.taskId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        evidence = createCompletionRejectionEvidence(result.plan, error);
      } finally {
        this.options.sessionBindings?.releaseTask(result.plan.taskId);
      }
      const terminalRecord = this.taskRegistry.markTerminal(
        result.plan.taskId,
        evidence,
      );
      if (terminalRecord) {
        // UX-23: terminal lands via `editReply` so the same message
        // that started life as `Accepted task …` ends as the final
        // terminal result. Single channel artifact per task.
        const terminalPayload = renderTerminalResult(terminalRecord);
        await this.deliver(
          interaction,
          this.buildDeliveryRequest(
            interaction,
            'editReply',
            'terminal-result',
            result.plan.taskId,
            0,
            terminalPayload,
          ),
        );
        // UX-24 (cycle 9): also mirror the terminal into the per-task
        // thread so its progressive history closes with the final
        // outcome. The cache is then evicted so the bot's memory does
        // not grow unboundedly.
        const cachedThread = this.taskThreadByTaskId.get(result.plan.taskId);
        if (cachedThread !== undefined) {
          try {
            await cachedThread.send(terminalPayload);
          } catch (error) {
            console.warn(
              'discord-task-thread-terminal-send-error',
              JSON.stringify({
                taskId: result.plan.taskId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
          this.taskThreadByTaskId.delete(result.plan.taskId);
        }
      }
    })().catch((error) => {
      console.warn(
        'discord-terminal-result-followup-error',
        JSON.stringify({
          taskId: result.plan.taskId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });

    const acceptedPayload = input.renderAccepted(record);
    initialReplySent = true;
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        input.acceptedEventType,
        result.plan.taskId,
        input.acceptedSequence,
        acceptedPayload,
      ),
    );

    // UX-24 (cycle 9): now that the accept message exists in the source
    // channel, try to start a per-task thread off it. Failures are
    // swallowed (channel-only delivery continues). The per-handler
    // `taskThreadByTaskId` cache is updated so the terminal observer
    // (which runs in a separate microtask) can also reach the thread.
    if (typeof interaction.fetchReply === 'function') {
      try {
        const messageHandle = await interaction.fetchReply();
        if (messageHandle !== null && messageHandle !== undefined) {
          taskThreadHandle = await messageHandle.startThread({
            name: buildTaskThreadName(result.plan.taskId, input.recordCommandName),
            autoArchiveDurationMinutes: 1_440,
          });
          this.taskThreadByTaskId.set(result.plan.taskId, taskThreadHandle);
          await sendToTaskThreadSafely(acceptedPayload);
        }
      } catch (error) {
        console.warn(
          'discord-task-thread-create-error',
          JSON.stringify({
            taskId: result.plan.taskId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    for (const buffered of bufferedMessages) {
      // UX-23: buffered lifecycle observations that fired before the
      // initial editReply also flow through editReply so the same
      // single channel message stays in-place.
      // UX-24: same payloads are mirrored to the per-task thread.
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          buffered.eventType,
          result.plan.taskId,
          buffered.sequence,
          buffered.payload,
        ),
      );
      await sendToTaskThreadSafely(buffered.payload);
    }
  }

  async handleRerun(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? null;
    if (taskId === null || taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of a raw throw
      // (which Discord renders as a generic "interaction failed").
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'rerun-reply',
          `discord-missing-task-id-${interaction.userId}`,
          this.rerunReplySeq++,
          renderTaskOptionRequired('rerun'),
        ),
      );
      return;
    }
    const note = interaction.getString('note')?.trim() || undefined;
    const sourceRecord = this.taskRegistry.get(taskId);

    if (sourceRecord === undefined) {
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'rerun-reply',
          taskId,
          this.rerunReplySeq++,
          renderUnknownTask(taskId),
        ),
      );
      return;
    }

    if (
      await this.denyIfNotTaskOwnerOrAdmin({
        interaction,
        record: sourceRecord,
        action: 'rerun',
        eventType: 'rerun-reply',
        taskId,
        sequence: this.rerunReplySeq++,
        replyAlreadyDeferred: false,
      })
    ) {
      return;
    }

    if (sourceRecord.coarseState !== 'terminal') {
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'rerun-reply',
          taskId,
          this.rerunReplySeq++,
          renderTaskRerunNotTerminal(sourceRecord),
        ),
      );
      return;
    }

    const baseInstruction = rerunSourceInstruction(sourceRecord);
    const rerunInstruction = appendRerunNote(baseInstruction, taskId, note);
    await this.dispatchInstructionTask(interaction, {
      dispatchInstruction: rerunInstruction,
      ledgerInstruction: rerunInstruction,
      requestedInstruction: rerunInstruction,
      recordCommandName: sourceRecord.commandName ?? 'ask',
      ledgerCommandName: 'rerun',
      rerunOfTaskId: taskId,
      acceptedEventType: 'rerun-reply',
      acceptedSequence: this.rerunReplySeq++,
      renderAccepted: (record) =>
        renderTaskRerunAccepted(sourceRecord, record, note),
    });
  }

  async handleStatus(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? null;
    if (taskId === null || taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of raw throw.
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'status-reply',
          `discord-missing-task-id-${interaction.userId}`,
          this.statusReplySeq++,
          renderTaskOptionRequired('status'),
        ),
      );
      return;
    }

    await interaction.deferReply();

    const record = this.taskRegistry.get(taskId);
    const payload = record ? renderStatus(record) : renderUnknownTask(taskId);
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'status-reply',
        taskId,
        this.statusReplySeq++,
        payload,
      ),
    );
  }

  async handleCancel(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? null;
    if (taskId === null || taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of raw throw.
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'cancel-ack',
          `discord-missing-task-id-${interaction.userId}`,
          this.cancelAckSeq++,
          renderTaskOptionRequired('cancel'),
        ),
      );
      return;
    }

    const reason =
      interaction.getString('reason') ?? 'cancel requested from Discord /cancel';
    await interaction.deferReply();

    const record = this.taskRegistry.get(taskId);
    if (!record) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'cancel-ack',
          taskId,
          this.cancelAckSeq++,
          renderUnknownTask(taskId),
        ),
      );
      return;
    }

    if (
      await this.denyIfNotTaskOwnerOrAdmin({
        interaction,
        record,
        action: 'cancel',
        eventType: 'cancel-ack',
        taskId,
        sequence: this.cancelAckSeq++,
        replyAlreadyDeferred: true,
      })
    ) {
      return;
    }

    if (record.coarseState === 'terminal') {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'cancel-ack',
          taskId,
          this.cancelAckSeq++,
          renderAlreadyTerminal(record),
        ),
      );
      return;
    }

    const receipt = this.options.dispatcher.cancel(
      taskId,
      reason,
      this.cancelProvenance,
    );
    const trackedRecord =
      receipt.status === 'accepted'
        ? this.taskRegistry.recordCancellation(taskId, receipt)
        : undefined;

    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'cancel-ack',
        taskId,
        this.cancelAckSeq++,
        trackedRecord
          ? renderCancelAccepted(trackedRecord.taskId, receipt)
          : renderCancelAccepted(taskId, receipt),
      ),
    );
  }

  async handleArchive(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? null;
    if (taskId === null || taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of raw throw.
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'archive-reply',
          `discord-missing-task-id-${interaction.userId}`,
          this.archiveReplySeq++,
          renderTaskOptionRequired('archive'),
        ),
      );
      return;
    }
    const reason = interaction.getString('reason')?.trim() || undefined;

    await interaction.deferReply();

    const record = this.taskRegistry.get(taskId);
    if (!record) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'archive-reply',
          taskId,
          this.archiveReplySeq++,
          renderUnknownTask(taskId),
        ),
      );
      return;
    }

    if (
      await this.denyIfNotTaskOwnerOrAdmin({
        interaction,
        record,
        action: 'archive',
        eventType: 'archive-reply',
        taskId,
        sequence: this.archiveReplySeq++,
        replyAlreadyDeferred: true,
      })
    ) {
      return;
    }

    if (record.archive !== undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'archive-reply',
          taskId,
          this.archiveReplySeq++,
          renderTaskAlreadyArchived(record),
        ),
      );
      return;
    }

    if (record.coarseState !== 'terminal') {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'archive-reply',
          taskId,
          this.archiveReplySeq++,
          renderTaskArchiveNotTerminal(record),
        ),
      );
      return;
    }

    const archived = this.taskRegistry.archiveTask({
      taskId,
      archivedAt: new Date().toISOString(),
      archivedBy: interaction.userId,
      reason,
    });

    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'archive-reply',
        taskId,
        this.archiveReplySeq++,
        archived ? renderTaskArchived(archived) : renderUnknownTask(taskId),
      ),
    );
  }

  async handleUnarchive(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? null;
    if (taskId === null || taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of raw throw.
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'unarchive-reply',
          `discord-missing-task-id-${interaction.userId}`,
          this.unarchiveReplySeq++,
          renderTaskOptionRequired('unarchive'),
        ),
      );
      return;
    }
    const reason = interaction.getString('reason')?.trim() || undefined;

    await interaction.deferReply();

    const record = this.taskRegistry.get(taskId);
    if (!record) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'unarchive-reply',
          taskId,
          this.unarchiveReplySeq++,
          renderUnknownTask(taskId),
        ),
      );
      return;
    }

    if (
      await this.denyIfNotTaskOwnerOrAdmin({
        interaction,
        record,
        action: 'unarchive',
        eventType: 'unarchive-reply',
        taskId,
        sequence: this.unarchiveReplySeq++,
        replyAlreadyDeferred: true,
      })
    ) {
      return;
    }

    if (record.archive === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'unarchive-reply',
          taskId,
          this.unarchiveReplySeq++,
          renderTaskNotArchived(record),
        ),
      );
      return;
    }

    const unarchive = {
      unarchivedAt: new Date().toISOString(),
      unarchivedBy: interaction.userId,
      ...(reason === undefined ? {} : { reason }),
    };
    const restored = this.taskRegistry.unarchiveTask({
      taskId,
      ...unarchive,
    });

    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'unarchive-reply',
        taskId,
        this.unarchiveReplySeq++,
        restored
          ? renderTaskUnarchived(restored, unarchive)
          : renderUnknownTask(taskId),
      ),
    );
  }

  async handleHelp(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'help-reply',
        `discord-help-${interaction.userId}`,
        this.helpReplySeq++,
        renderHelp(),
      ),
    );
  }

  async handleFollow(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? '';
    if (taskId.length === 0) {
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'follow-reply',
          `discord-follow-${interaction.userId}`,
          this.followReplySeq++,
          renderTaskOptionRequired('follow'),
        ),
      );
      return;
    }
    await interaction.deferReply();
    const controller = this.options.followController;
    if (controller === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'follow-reply',
          `discord-follow-${interaction.userId}`,
          this.followReplySeq++,
          renderFollowUnavailable(),
        ),
      );
      return;
    }
    const followSeq = this.followFollowUpSeq;
    const followUpDeliver = {
      followUp: async (payload: DiscordMessagePayload): Promise<unknown> => {
        // The controller posts batches and terminal/idle messages
        // through this port; we wrap each one through the existing
        // deliver pipeline so persona transformer + delivery queue
        // see the same shape they would for any other followUp.
        const eventType: import(
          './delivery/discord-delivery-types.js'
        ).DiscordDeliveryEventType = (
          payload.content.startsWith('📡')
            ? 'follow-event-batch'
            : payload.content.startsWith('⏸️')
              ? 'follow-idle-stop'
              : 'follow-terminal'
        );
        await this.deliver(
          interaction,
          this.buildDeliveryRequest(
            interaction,
            'followUp',
            eventType,
            `discord-follow-${interaction.userId}-${taskId}`,
            this.followFollowUpSeq++,
            payload,
          ),
        );
        return undefined;
      },
    };
    void followSeq;
    const result = controller.start({
      taskId,
      userId: interaction.userId,
      deliver: followUpDeliver,
    });
    let payload: DiscordMessagePayload;
    if (result.status === 'started') {
      payload = renderFollowStarted({
        taskId,
        pollIntervalMs: 5_000,
        idleTimeoutMs: 14 * 60 * 1_000,
      });
    } else if (result.status === 'already-following') {
      payload = renderFollowAlreadyFollowing(taskId);
    } else {
      payload = renderFollowCapReached(result.cap);
    }
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'follow-reply',
        `discord-follow-${interaction.userId}`,
        this.followReplySeq++,
        payload,
      ),
    );
  }

  async handleQuickstart(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    const recentTerminal = this.taskRegistry
      .list({ state: 'terminal', limit: 3 })
      .map((record) => record.taskId);
    const recentActive = this.taskRegistry
      .list({ state: 'active', limit: 3 })
      .map((record) => record.taskId);
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'quickstart-reply',
        `discord-quickstart-${interaction.userId}`,
        this.quickstartReplySeq++,
        renderQuickstart({
          recentTerminalTaskIds: recentTerminal,
          recentActiveTaskIds: recentActive,
        }),
      ),
    );
  }

  async handleTasks(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const rawState = interaction.getString('state')?.trim();
    const state =
      rawState === 'accepted' ||
      rawState === 'running' ||
      rawState === 'terminal' ||
      rawState === 'archived' ||
      rawState === 'active' ||
      rawState === 'all'
        ? rawState
        : 'all';
    const limit = parseOptionalLimit(interaction.getString('limit'), 10);
    await interaction.deferReply();
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'tasks-reply',
        `discord-tasks-${interaction.userId}`,
        this.tasksReplySeq++,
        renderTaskList(
          this.taskRegistry.list({
            channelId: interaction.channelId,
            state,
            limit,
          }),
          // UX-9: distinguish archived view so the empty-state hint
          // points the operator at `/tasks` (default view) instead of
          // suggesting they archive a task that does not exist.
          { archivedView: state === 'archived' },
        ),
      ),
    );
  }

  async handleTraits(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'traits-reply',
        `discord-traits-${interaction.userId}`,
        this.traitsReplySeq++,
        renderTraitModuleList({
          ...(this.options.traitModuleRegistry === undefined
            ? {}
            : { registry: this.options.traitModuleRegistry }),
          ...(this.options.traitUsageTelemetry === undefined
            ? {}
            : { usageStats: this.options.traitUsageTelemetry.snapshot() }),
          ...(this.options.traitModuleRegistryError === undefined
            ? {}
            : { error: this.options.traitModuleRegistryError }),
        }),
      ),
    );
  }

  async handleAgenda(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const action = parseAgendaAction(interaction.getString('action'));
    const limit = parseOptionalLimit(interaction.getString('limit'), 10);

    await interaction.deferReply();

    if (action === 'add') {
      const title = interaction.getString('text', true)?.trim() ?? '';
      if (title.length === 0) {
        throw new Error('text is required for agenda add');
      }
      const item = this.researchAgenda.addItem({
        title,
        userId: interaction.userId,
        channelId: interaction.channelId,
      });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'agenda-reply',
          item.agendaId,
          this.agendaReplySeq++,
          renderResearchAgendaMutation({ action: 'added', item }),
        ),
      );
      return;
    }

    if (action === 'done') {
      const agendaId = interaction.getString('item_id', true)?.trim() ?? '';
      if (agendaId.length === 0) {
        throw new Error('item_id is required for agenda done');
      }
      const item = this.researchAgenda.completeItem({
        agendaId,
        userId: interaction.userId,
        channelId: interaction.channelId,
      });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'agenda-reply',
          agendaId,
          this.agendaReplySeq++,
          item === undefined
            ? renderUnknownResearchAgendaItem(agendaId)
            : renderResearchAgendaMutation({ action: 'completed', item }),
        ),
      );
      return;
    }

    if (action === 'cadence') {
      const cadenceText = interaction.getString('text')?.trim();
      const existing = this.researchAgenda.getCadence(interaction.channelId);
      const cadence =
        cadenceText === undefined || cadenceText.length === 0
          ? existing
          : this.researchAgenda.setCadence({
              cadence: cadenceText,
              userId: interaction.userId,
              conversationId: interaction.channelId ?? interaction.userId,
              channelId: interaction.channelId,
            });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'agenda-reply',
          `discord-agenda-${interaction.userId}`,
          this.agendaReplySeq++,
          cadence === undefined
            ? renderResearchAgendaList({
                items: [],
                status: 'open',
              })
            : renderResearchCadence(cadence),
        ),
      );
      return;
    }

    const status = parseAgendaStatus(interaction.getString('status'));
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'agenda-reply',
        `discord-agenda-${interaction.userId}`,
        this.agendaReplySeq++,
        renderResearchAgendaList({
          items: this.researchAgenda.list({
            channelId: interaction.channelId,
            status,
            limit,
          }),
          status,
          cadence: this.researchAgenda.getCadence(interaction.channelId),
        }),
      ),
    );
  }

  async handleHistory(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id')?.trim() || undefined;
    const limit = parseOptionalLimit(interaction.getString('limit'), 10);
    const view = parseHistoryView(interaction.getString('view'));
    const taskRecord =
      taskId === undefined ? undefined : this.taskRegistry.get(taskId);
    const scopedChannelId =
      view === 'talk'
        ? (taskRecord?.channelId ?? interaction.channelId)
        : interaction.channelId;
    const events =
      this.options.controlLedger === undefined
        ? []
        : filterControlPlaneEvents(this.options.controlLedger.loadAll(), {
            ...(view === 'events' && taskId !== undefined ? { taskId } : {}),
            ...(view === 'talk'
              ? { type: 'conversation.message_observed' as const }
              : {}),
            ...((view === 'talk' || taskId === undefined) &&
            scopedChannelId !== undefined
              ? { channelId: scopedChannelId }
              : {}),
            limit,
          });
    await interaction.deferReply();
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'history-reply',
        taskId ?? `discord-history-${interaction.userId}`,
        this.historyReplySeq++,
        view === 'talk' ? renderTalkHistory(events) : renderHistory(events),
      ),
    );
  }

  async handleContext(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? null;
    if (taskId === null || taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of raw throw.
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'context-reply',
          `discord-missing-task-id-${interaction.userId}`,
          this.contextReplySeq++,
          renderTaskOptionRequired('context'),
        ),
      );
      return;
    }
    const record = this.taskRegistry.get(taskId);
    await interaction.deferReply();
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'context-reply',
        taskId,
        this.contextReplySeq++,
        record ? renderContextSummary(record) : renderUnknownTask(taskId),
      ),
    );
  }

  async handleEscalate(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id')?.trim() || undefined;
    const reason = normalizeEscalationReason(interaction.getString('reason'));
    await interaction.deferReply();

    const record = taskId === undefined ? undefined : this.taskRegistry.get(taskId);
    if (taskId !== undefined && record === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'escalate-reply',
          taskId,
          this.escalateReplySeq++,
          renderUnknownTask(taskId),
        ),
      );
      return;
    }

    if (this.options.controlLedger === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'escalate-reply',
          taskId ?? `discord-escalation-${interaction.userId}`,
          this.escalateReplySeq++,
          renderEscalationUnavailable(),
        ),
      );
      return;
    }

    const channelId = record?.channelId ?? interaction.channelId;
    const event = this.options.controlLedger.append({
      type: 'escalation.requested',
      actor: {
        kind: 'discord-user',
        userId: interaction.userId,
      },
      channel: {
        kind: 'discord',
        ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId }),
        ...(channelId === undefined ? {} : { channelId }),
      },
      conversationId: channelId,
      ...(taskId === undefined ? {} : { taskId }),
      trust: {
        source: 'discord',
        inputTrust: 'untrusted',
      },
      payload: {
        commandName: 'escalate',
        scope: taskId === undefined ? 'channel' : 'task',
        requestedByUserId: interaction.userId,
        ...(reason === undefined ? {} : { reason }),
      },
    });

    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'escalate-reply',
        taskId ?? event.eventId,
        this.escalateReplySeq++,
        renderEscalationRequested({
          event,
          ...(taskId === undefined ? {} : { taskId }),
          ...(channelId === undefined ? {} : { channelId }),
          ...(reason === undefined ? {} : { reason }),
        }),
      ),
    );
  }

  async handleFeed(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();

    if (!this.admitFeedRequest(interaction.userId, Date.now())) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'feed-reply',
          `discord-feed-${interaction.userId}`,
          this.feedReplySeq++,
          renderControlPlaneFeedRateLimited(),
        ),
      );
      return;
    }

    const ledger = this.options.controlLedger;
    if (ledger === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'feed-reply',
          `discord-feed-${interaction.userId}`,
          this.feedReplySeq++,
          renderControlPlaneFeedUnavailable(),
        ),
      );
      return;
    }

    const durationMs = parseFeedSinceDuration(interaction.getString('since'));
    const since = new Date(Date.now() - durationMs).toISOString();
    const kind = parseFeedKind(interaction.getString('kind'));

    try {
      const events = ledger
        .loadSince(since, DISCORD_FEED_MAX_EVENTS, {
          ...(feedKindTypePrefix(kind) === undefined
            ? {}
            : { typePrefix: feedKindTypePrefix(kind) }),
        });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'feed-reply',
          `discord-feed-${interaction.userId}`,
          this.feedReplySeq++,
          renderControlPlaneFeed({
            events,
            since,
            kind,
            limit: DISCORD_FEED_MAX_EVENTS,
          }),
        ),
      );
    } catch (error) {
      if (!isControlPlaneLedgerTooLargeError(error)) {
        throw error;
      }
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'feed-reply',
          `discord-feed-${interaction.userId}`,
          this.feedReplySeq++,
          renderControlPlaneFeedTooLarge({
            sizeBytes: error.sizeBytes,
            maxBytes: error.maxBytes,
          }),
        ),
      );
    }
  }

  private admitFeedRequest(userId: string, nowMs: number): boolean {
    const windowStart = nowMs - DISCORD_FEED_RATE_LIMIT_WINDOW_MS;
    const recent = (this.feedRequestTimestampsByUser.get(userId) ?? []).filter(
      (timestamp) => timestamp >= windowStart,
    );
    if (recent.length >= DISCORD_FEED_RATE_LIMIT_MAX) {
      this.feedRequestTimestampsByUser.set(userId, recent);
      return false;
    }
    recent.push(nowMs);
    this.feedRequestTimestampsByUser.set(userId, recent);
    return true;
  }

  async handleApproval(
    interaction: DiscordCommandInteractionAdapter,
    decision: 'approved' | 'denied',
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const approvalId = interaction.getString('approval_id', true)?.trim() ?? null;
    if (approvalId === null || approvalId.length === 0) {
      throw new Error('approval_id is required for approval resolution');
    }
    const note =
      decision === 'approved'
        ? interaction.getString('note') ?? undefined
        : interaction.getString('reason') ?? undefined;
    const resolution =
      this.options.approvalRegistry?.resolve({
        approvalId,
        decision,
        resolvedByUserId: interaction.userId,
        reason: note,
        provenance:
          interaction.source === 'natural-language'
            ? 'discord-natural-language'
            : 'discord-slash',
      });
    this.options.controlLedger?.append({
      type: 'approval.resolved',
      actor: {
        kind: 'discord-user',
        userId: interaction.userId,
      },
      channel: {
        kind: 'discord',
        ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId }),
        ...(interaction.channelId === undefined
          ? {}
          : { channelId: interaction.channelId }),
      },
      conversationId: interaction.channelId,
      correlationId: approvalId,
      trust: {
        source: 'discord',
        inputTrust: 'operator-approved',
      },
      payload: {
        approvalId,
        decision,
        ...(resolution === undefined ? {} : { result: resolution.status }),
        ...(note === undefined ? {} : { note }),
      },
    });
    await interaction.deferReply({ ephemeral: true });
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'approval-reply',
        `discord-approval-${approvalId}`,
        0,
        resolution === undefined || resolution.status === 'resolved'
          ? renderApprovalResolved({ approvalId, decision, note })
          : renderApprovalResolutionFailed({
              approvalId,
              status: resolution.status,
              reason: resolution.reason,
            }),
      ),
    );
  }

  async handleDoctor(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const doctorPayload = {
      ledgerEnabled: this.options.controlLedger !== undefined,
      accessPolicyEnabled: this.options.accessPolicy !== undefined,
      authDatabaseEnabled: this.options.authDatabase !== undefined,
      runtimeProviderScope:
        this.options.doctorStatus?.runtimeProviderScope ?? 'unknown',
      activeRuntimeProvider: this.options.doctorStatus?.activeRuntimeProvider,
      computeMode: this.options.doctorStatus?.computeMode,
      modelOverride: this.options.doctorStatus?.modelOverride,
      messageContentIntent: this.options.doctorStatus?.messageContentIntent,
      approvalRegistryEnabled: this.options.approvalRegistry !== undefined,
      anthropicAuthSource: this.options.doctorStatus?.anthropicAuthSource,
      anthropicCliPath: this.options.doctorStatus?.anthropicCliPath,
      claudeModelOverride: this.options.doctorStatus?.claudeModelOverride,
      planaAdvisorProvider: this.options.doctorStatus?.planaAdvisorProvider,
      planaAdvisorModel: this.options.doctorStatus?.planaAdvisorModel,
      planaAdvisorMaxCalls: this.options.doctorStatus?.planaAdvisorMaxCalls,
      agentHarnessRegistry: this.options.doctorStatus?.agentHarnessRegistry,
      autonomousResearchEvidence:
        this.options.doctorStatus?.autonomousResearchEvidence,
      runtimeProviderEvidence:
        this.options.doctorStatus?.runtimeProviderEvidence,
      liveProofReport: this.options.doctorStatus?.liveProofReport,
      peekabooEvidenceReport:
        this.options.doctorStatus?.peekabooEvidenceReport,
      personaTelemetryReport:
        this.options.doctorStatus?.personaTelemetryReport,
      taskHealthEvidenceReport:
        this.options.doctorStatus?.taskHealthEvidenceReport,
      taskArchiveEvidenceReport:
        this.options.doctorStatus?.taskArchiveEvidenceReport,
      subagentOperatorEvidenceReport:
        this.options.doctorStatus?.subagentOperatorEvidenceReport,
      sessionBindingEvidenceReport:
        this.options.doctorStatus?.sessionBindingEvidenceReport,
      controlPlaneOtelLogs: this.options.doctorStatus?.controlPlaneOtelLogs,
      planaAdvisorEvents: this.options.doctorStatus?.planaAdvisorEvents,
      traitSchedulerTickEvidence:
        this.options.doctorStatus?.traitSchedulerTickEvidence,
      shellHooksMode: this.options.doctorStatus?.shellHooksMode,
      shellHookAcceptMode: this.options.doctorStatus?.shellHookAcceptMode,
      taskHealthObserverEnabled:
        this.options.doctorStatus?.taskHealthObserverEnabled,
      inFlightProblems: this.options.doctorStatus?.inFlightProblems,
    };
    this.fireDoctorProbeHooks(doctorPayload);
    const missionId = interaction.getString('mission_id')?.trim();
    if (missionId !== undefined && missionId.length > 0) {
      const mission = this.researchMissions.get(missionId);
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'doctor-reply',
          `discord-doctor-${interaction.userId}`,
          this.doctorReplySeq++,
          mission === undefined
            ? renderResearchMissionNotFound(missionId)
            : renderResearchMissionDoctor({
                missionId: mission.missionId,
                title: mission.title,
                status: mission.status,
                phase: mission.phase,
                owner: `@${mission.ownerId}`,
                threadLabel:
                  mission.discordThreadId === undefined
                    ? mission.discordChannelId
                    : `${mission.discordChannelId} / ${mission.discordThreadId}`,
                threadBound: mission.discordThreadId !== undefined,
                ...(mission.planId === undefined ? {} : { planId: mission.planId }),
                evidenceCount: mission.evidenceItemCount,
                claims: mission.claims,
                proof: mission.proof,
                ...(() => {
                  const latestSynthesisId =
                    this.researchMissions.getLatestSynthesis(mission.missionId)
                      ?.synthesisId ?? mission.latestSynthesisId;
                  return latestSynthesisId === undefined
                    ? {}
                    : { latestSynthesisId };
                })(),
                runtimeProviderScope: doctorPayload.runtimeProviderScope,
                ...(doctorPayload.activeRuntimeProvider === undefined
                  ? {}
                  : { activeRuntimeProvider: doctorPayload.activeRuntimeProvider }),
                ...(doctorPayload.liveProofReport === undefined
                  ? {}
                  : { liveProofReport: doctorPayload.liveProofReport }),
              }),
        ),
      );
      return;
    }
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'doctor-reply',
        `discord-doctor-${interaction.userId}`,
        this.doctorReplySeq++,
        renderDoctor(doctorPayload),
      ),
    );
  }

  async handleProof(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const action = interaction.getString('action')?.trim() || 'status';
    const missionId = interaction.getString('mission_id')?.trim() || undefined;
    const surface = interaction.getString('surface')?.trim() || undefined;
    const proofId = interaction.getString('proof_id')?.trim() || undefined;
    const proofStatus = interaction.getString('status')?.trim().toLowerCase();
    const artifactTokens = parseProofArtifactTokens(
      interaction.getString('artifact_tokens')?.trim() || undefined,
    );
    const summary = interaction.getString('summary')?.trim() || undefined;
    const mission =
      action === 'status' && missionId !== undefined
        ? this.researchMissions.get(missionId)
        : undefined;
    const payload =
      action === 'status'
        ? renderProofStatus({
            missionId,
            mission:
              mission === undefined
                ? undefined
                : {
                    missionId: mission.missionId,
                    status: mission.status,
                    phase: mission.phase,
                    proof: mission.proof,
                    proofLinkCount: mission.proofLinks.length,
                  },
            liveProofReport: this.options.doctorStatus?.liveProofReport,
          })
        : action === 'start'
          ? renderProofStartPreflight({ missionId, surface })
          : action === 'export'
            ? renderProofExportTemplate({ missionId, surface })
            : action === 'capture'
              ? renderProofCapturePreflight({ missionId, surface })
              : action === 'link'
                ? (() => {
                    if (missionId === undefined) {
                      return renderProofLinkResult({
                        status: 'missing-option',
                        option: 'mission_id',
                      });
                    }
                    if (surface === undefined) {
                      return renderProofLinkResult({
                        status: 'missing-option',
                        option: 'surface',
                      });
                    }
                    if (!isLiveProofSurface(surface)) {
                      return renderProofLinkResult({
                        status: 'invalid-surface',
                        surface,
                      });
                    }
                    if (proofId === undefined) {
                      return renderProofLinkResult({
                        status: 'missing-option',
                        option: 'proof_id',
                      });
                    }
                    if (proofStatus === undefined || proofStatus.length === 0) {
                      return renderProofLinkResult({
                        status: 'missing-option',
                        option: 'status',
                      });
                    }
                    if (!isResearchMissionProofLinkStatus(proofStatus)) {
                      return renderProofLinkResult({
                        status: 'invalid-status',
                        proofStatus,
                      });
                    }
                    const result = this.researchMissions.linkProof({
                      missionId,
                      surface,
                      proofId,
                      status: proofStatus,
                      artifactTokens,
                      ...(summary === undefined ? {} : { summary }),
                      actorId: interaction.userId,
                    });
                    return result.status === 'mission-not-found'
                      ? renderProofLinkResult({
                          status: 'mission-not-found',
                          missionId,
                        })
                      : renderProofLinkResult({
                          status: 'linked',
                          missionId: result.mission.missionId,
                          proofId: result.proofLink.proofId,
                          surface: result.proofLink.surface,
                          proofStatus: result.proofLink.status,
                          artifactTokens: result.proofLink.artifactTokens,
                          summary: result.proofLink.summary,
                        });
                  })()
                : renderProofActionUnsupported(action);
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'proof-reply',
        `discord-proof-${interaction.userId}`,
        this.proofReplySeq++,
        payload,
      ),
    );
  }

  private fireDoctorProbeHooks(probe: {
    readonly ledgerEnabled: boolean;
    readonly accessPolicyEnabled: boolean;
    readonly authDatabaseEnabled: boolean;
    readonly runtimeProviderScope: string;
    readonly activeRuntimeProvider?: string;
    readonly approvalRegistryEnabled: boolean;
    readonly taskHealthObserverEnabled?: boolean;
    readonly inFlightProblems?: ReadonlyArray<{ readonly kind: 'stall' }>;
  }): void {
    const hooks = this.options.doctorProbeHooks ?? [];
    if (hooks.length === 0) return;
    const observedAt = new Date().toISOString();
    const probeResults: ReadonlyArray<{
      readonly probeName: string;
      readonly status: 'ok' | 'warn' | 'fail' | 'unknown';
      readonly detail?: string;
    }> = [
      {
        probeName: 'control-ledger',
        status: probe.ledgerEnabled ? 'ok' : 'warn',
      },
      {
        probeName: 'access-policy',
        status: probe.accessPolicyEnabled ? 'ok' : 'warn',
      },
      {
        probeName: 'auth-database',
        status: probe.authDatabaseEnabled ? 'ok' : 'warn',
      },
      {
        probeName: 'approval-registry',
        status: probe.approvalRegistryEnabled ? 'ok' : 'warn',
      },
      {
        probeName: 'runtime-provider',
        status: probe.activeRuntimeProvider !== undefined ? 'ok' : 'unknown',
        detail: probe.activeRuntimeProvider ?? probe.runtimeProviderScope,
      },
      ...(probe.taskHealthObserverEnabled === undefined
        ? []
        : [
            {
              probeName: 'task-health',
              status:
                probe.taskHealthObserverEnabled && probe.inFlightProblems?.length
                  ? 'warn'
                  : probe.taskHealthObserverEnabled
                    ? 'ok'
                    : 'warn',
              detail: probe.taskHealthObserverEnabled
                ? `in-flight problems: ${probe.inFlightProblems?.length ?? 0}`
                : 'observer disabled',
            } as const,
          ]),
    ];
    for (const binding of hooks) {
      for (const result of probeResults) {
        Promise.resolve()
          .then(() =>
            binding.doctorProbeObserve(
              {
                moduleId: binding.moduleId as never,
                moduleVersion: binding.moduleVersion,
                observedAt,
              },
              {
                probeName: result.probeName,
                status: result.status,
                ...(result.detail === undefined ? {} : { detail: result.detail }),
              },
            ),
          )
          .catch((error: unknown) => {
            console.warn(
              'trait-runtime-hook-threw',
              JSON.stringify({
                hook: 'doctorProbeObserve',
                moduleId: binding.moduleId,
                probeName: result.probeName,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          });
      }
    }
  }

  async handleSubagents(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const action = interaction.getString('action')?.trim() || 'list';
    const missionId = interaction.getString('mission_id')?.trim() || undefined;
    const target = interaction.getString('target')?.trim() || undefined;
    const text = interaction.getString('text')?.trim() || undefined;
    const role = interaction.getString('role')?.trim() || undefined;
    const operator = this.options.subagentOperator;
    if (action === 'spawn') {
      const payload =
        missionId === undefined
          ? renderSubagentOperatorResult({
              status: 'denied',
              reason: 'mission_id is required for spawn',
            })
          : !isResearchSubagentRole(role)
            ? renderSubagentOperatorResult({
                status: 'denied',
                reason: `role must be one of ${RESEARCH_SUBAGENT_ROLES.join(', ')}`,
              })
            : text === undefined
              ? renderSubagentOperatorResult({
                  status: 'denied',
                  reason: 'text is required for spawn task',
                })
              : this.researchMissions.get(missionId) === undefined
                ? renderResearchMissionNotFound(missionId)
                : renderResearchSubagentSpawnPreflight({
                    missionId,
                    role,
                    task: text,
                    operatorConfigured: operator !== undefined,
                  });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'subagents-reply',
          `discord-subagents-${interaction.userId}`,
          this.subagentReplySeq++,
          payload,
        ),
      );
      return;
    }
    if (action === 'tree') {
      const payload =
        missionId === undefined
          ? renderSubagentOperatorResult({
              status: 'denied',
              reason: 'mission_id is required for tree',
            })
          : this.researchMissions.get(missionId) === undefined
            ? renderResearchMissionNotFound(missionId)
            : renderResearchSubagentTreePreflight({
                missionId,
                operatorConfigured: operator !== undefined,
                descriptors:
                  operator === undefined
                    ? []
                    : (() => {
                        const result = operator.list();
                        if (result.status !== 'ok') {
                          return [];
                        }
                        return (result.descriptors ?? []).filter((descriptor) =>
                          isResearchMissionPlanParentTask(
                            descriptor.parent.taskId,
                            missionId,
                          ),
                        );
                      })(),
              });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'subagents-reply',
          `discord-subagents-${interaction.userId}`,
          this.subagentReplySeq++,
          payload,
        ),
      );
      return;
    }
    const payload =
      operator === undefined
        ? renderSubagentOperatorUnavailable()
        : renderSubagentOperatorResult(
            await (async () => {
              switch (action) {
                case 'list':
                  return operator.list();
                case 'info':
                  return target === undefined
                    ? { status: 'denied' as const, reason: 'target is required for info' }
                    : operator.info(target);
                case 'kill':
                  return target === undefined
                    ? { status: 'denied' as const, reason: 'target is required for kill' }
                    : operator.kill(target, text ?? 'operator kill requested');
                case 'log':
                  return target === undefined
                    ? { status: 'denied' as const, reason: 'target is required for log' }
                    : operator.log(target);
                case 'send':
                  return target === undefined || text === undefined
                    ? { status: 'denied' as const, reason: 'target and text are required for send' }
                    : operator.send(target, text);
                case 'steer':
                  return target === undefined || text === undefined
                    ? { status: 'denied' as const, reason: 'target and text are required for steer' }
                    : operator.steer(target, text);
                default:
                  return {
                    status: 'denied' as const,
                    reason:
                      'action must be one of list, info, kill, log, send, steer, tree, spawn',
                  };
              }
            })(),
          );
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'subagents-reply',
        `discord-subagents-${interaction.userId}`,
        this.subagentReplySeq++,
        payload,
      ),
    );
  }

  async handleFocus(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const taskId = interaction.getString('task_id', true)?.trim() ?? '';
    if (taskId.length === 0) {
      // UX-20: graceful Discord-friendly reply instead of raw throw.
      await interaction.deferReply();
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'focus-reply',
          `discord-missing-task-id-${interaction.userId}`,
          this.focusReplySeq++,
          renderTaskOptionRequired('focus'),
        ),
      );
      return;
    }
    await interaction.deferReply();
    const record = this.taskRegistry.get(taskId);
    if (record === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'focus-reply',
          taskId,
          this.focusReplySeq++,
          renderUnknownTask(taskId),
        ),
      );
      return;
    }
    if (record.userId !== interaction.userId) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'focus-reply',
          taskId,
          this.focusReplySeq++,
          renderFocusReleased({ status: 'denied', reason: 'Only the task owner can focus this task.' }),
        ),
      );
      return;
    }
    if (record.coarseState === 'terminal') {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'focus-reply',
          taskId,
          this.focusReplySeq++,
          renderAlreadyTerminal(record),
        ),
      );
      return;
    }
    if (interaction.channelId === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'focus-reply',
          taskId,
          this.focusReplySeq++,
          renderFocusReleased({ status: 'denied', reason: 'Focus requires a Discord channel id.' }),
        ),
      );
      return;
    }
    const manager = this.options.sessionBindings;
    if (manager === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'focus-reply',
          taskId,
          this.focusReplySeq++,
          renderFocusReleased({ status: 'denied', reason: 'Session binding manager is not configured.' }),
        ),
      );
      return;
    }
    const binding = manager.focus({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      taskId,
      ownerUserId: interaction.userId,
    });
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'focus-reply',
        taskId,
        this.focusReplySeq++,
        renderFocusCreated(binding),
      ),
    );
  }

  async handleUnfocus(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();
    const result =
      interaction.channelId === undefined || this.options.sessionBindings === undefined
        ? ({ status: 'denied', reason: 'No focus binding manager/channel is available.' } as const)
        : this.options.sessionBindings.release({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            ownerUserId: interaction.userId,
          });
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'focus-reply',
        `discord-unfocus-${interaction.userId}`,
        this.focusReplySeq++,
        renderFocusReleased(result),
      ),
    );
  }

  async handleInsights(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    const rawPeriod = interaction.getString('period')?.trim();
    const period: InsightWindow =
      rawPeriod === '1d' ||
      rawPeriod === '7d' ||
      rawPeriod === '30d' ||
      rawPeriod === 'all'
        ? rawPeriod
        : '7d';
    const ledger = this.options.controlLedger;
    await interaction.deferReply();
    const engine =
      ledger === undefined ? undefined : new InsightsEngine(ledger);
    const snapshot =
      engine === undefined
        ? undefined
        : engine.snapshot(period);
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'insights-reply',
        `discord-insights-${interaction.userId}`,
        this.insightsReplySeq++,
        snapshot === undefined
          ? { content: 'Control-plane ledger is not configured; cannot generate insights.' }
          : renderInsights(snapshot),
      ),
    );
  }

  async handleAuth(interaction: DiscordCommandInteractionAdapter): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const authDatabase = this.options.authDatabase;
    if (authDatabase === undefined) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'auth-reply',
          `discord-auth-${interaction.userId}`,
          this.authReplySeq++,
          renderAuthDatabaseNotConfigured(),
        ),
      );
      return;
    }

    const action = interaction.getString('action', true)?.trim() ?? '';
    if (action === 'list') {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'auth-reply',
          `discord-auth-${interaction.userId}`,
          this.authReplySeq++,
          renderAuthList({
            allowedGuildIds: authDatabase.list('allowed-guild'),
            allowedUserIds: authDatabase.list('allowed-user'),
            allowedChannelIds: authDatabase.list('allowed-channel'),
            adminUserIds: authDatabase.list('admin-user'),
          }),
        ),
      );
      return;
    }

    const operation = parseAuthMutationAction(action);
    const subjectId = interaction.getString('subject_id')?.trim() ?? '';
    if (operation === undefined || subjectId.length === 0) {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'auth-reply',
          `discord-auth-${interaction.userId}`,
          this.authReplySeq++,
          renderAuthRejected(
            'Provide action=list or a valid mutation action plus subject_id.',
          ),
        ),
      );
      return;
    }

    if (operation.kind === 'add') {
      authDatabase.add(operation.scope, subjectId);
    } else {
      authDatabase.remove(operation.scope, subjectId);
    }

    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'auth-reply',
        `discord-auth-${interaction.userId}`,
        this.authReplySeq++,
        renderAuthMutation({
          action,
          scope: operation.scope,
          subjectId,
        }),
      ),
    );
  }

  async handleConfig(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const filePath = resolvePersonaSettingsPath(
      this.options.personaSettingsPath,
    );
    const action = (interaction.getString('action', true) ?? '').trim();
    const personaRaw = interaction.getString('persona')?.trim();
    const keyRaw = interaction.getString('key')?.trim();
    const valueRaw = interaction.getString('value')?.trim();

    const replyError = (message: string) =>
      this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'config-reply',
          `discord-config-${interaction.userId}`,
          this.configReplySeq++,
          renderPersonaConfigError(message),
        ),
      );

    if (action === 'view') {
      const stored = loadPersonaSettings(filePath);
      const status = this.options.doctorStatus;
      const view = renderPersonaConfigView({
        arona: {
          effectiveProvider: status?.activeRuntimeProvider ?? 'unknown',
          ...(status?.modelOverride !== undefined && status.modelOverride.length > 0
            ? { effectiveModel: status.modelOverride }
            : {}),
          storedOverride: stored.arona,
        },
        plana: {
          effectiveProvider: status?.planaAdvisorProvider ?? 'none',
          ...(status?.planaAdvisorModel !== undefined &&
          status.planaAdvisorModel.length > 0
            ? { effectiveModel: status.planaAdvisorModel }
            : {}),
          ...(status?.planaAdvisorMaxCalls !== undefined
            ? { effectiveMaxCalls: status.planaAdvisorMaxCalls }
            : {}),
          storedOverride: stored.plana,
        },
        storeFilePath: filePath,
        storeExists: existsSync(filePath),
      });
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'config-reply',
          `discord-config-${interaction.userId}`,
          this.configReplySeq++,
          view,
        ),
      );
      return;
    }

    if (action === 'reset') {
      if (personaRaw === undefined || personaRaw.length === 0) {
        await replyError('reset requires the persona option (arona or plana).');
        return;
      }
      let persona: PersonaName;
      try {
        persona = validatePersonaName(personaRaw);
      } catch (err) {
        await replyError(
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      const stored = loadPersonaSettings(filePath);
      const next = withPersonaReset(stored, persona);
      savePersonaSettings(filePath, next);
      const hotSwapApplied =
        this.options.runtimePersonaSettingsProvider !== undefined;
      this.options.runtimePersonaSettingsProvider?.apply(next);
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'config-reply',
          `discord-config-${interaction.userId}`,
          this.configReplySeq++,
          renderPersonaConfigReset(persona, { hotSwapApplied }),
        ),
      );
      return;
    }

    if (action === 'set') {
      if (
        personaRaw === undefined ||
        keyRaw === undefined ||
        valueRaw === undefined ||
        valueRaw.length === 0
      ) {
        await replyError(
          'set requires persona, key, and value options.',
        );
        return;
      }
      let persona: PersonaName;
      let key: PersonaSettingKey;
      let coerced: ReturnType<typeof coerceSettingValue>;
      try {
        persona = validatePersonaName(personaRaw);
        key = validateSettingKey(keyRaw);
        coerced = coerceSettingValue(persona, key, valueRaw);
      } catch (err) {
        await replyError(err instanceof Error ? err.message : String(err));
        return;
      }
      // Provider hot-swap validation (spec §1.4.0 / §1.5.0): only providers
      // that the bootstrap successfully authenticated may be set. Both Arona
      // (dispatch driver) and Plana (advisor) hot-swap require both auths to
      // be bootstrap-ready; we reject targets that would fail at run() time so
      // the store never persists an unreachable intent.
      if (key === 'provider') {
        const available = this.options.bootstrapAvailableProviders;
        if (
          available !== undefined &&
          !available.has(coerced as 'codex' | 'claude-agent')
        ) {
          await replyError(
            `provider ${JSON.stringify(coerced)} is not bootstrap-authenticated; ` +
              `available providers: ${[...available].join(', ') || 'none'}. ` +
              'Configure auth env vars and restart so the multi-provider driver can instantiate both.',
          );
          return;
        }
      }
      const stored = loadPersonaSettings(filePath);
      // Capture the previous override BEFORE we apply the change so the
      // reply can communicate what the operator just replaced (P2-B / Risk 3:
      // "did anything change? what was the prior provider?"). When no prior
      // override existed, this is undefined and the renderer omits the field.
      const previousStored = stored[persona];
      const previousValueRaw = previousStored[key];
      const previousValue =
        previousValueRaw === undefined ? undefined : String(previousValueRaw);
      const next = withPersonaSetting(stored, persona, key, coerced);
      savePersonaSettings(filePath, next);
      const hotSwapApplied =
        this.options.runtimePersonaSettingsProvider !== undefined;
      this.options.runtimePersonaSettingsProvider?.apply(next);
      const coercedString =
        typeof coerced === 'number' ? String(coerced) : String(coerced);
      // Only the `provider` key carries the next-dispatch boundary message.
      // For `model` / `effort` / `max_turns` the existing rendering is
      // unchanged.
      const activeProviderInfo =
        key === 'provider'
          ? {
              previous: previousValue,
              next: coercedString,
              takesEffectOnNextDispatch: true,
            }
          : undefined;
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'config-reply',
          `discord-config-${interaction.userId}`,
          this.configReplySeq++,
          renderPersonaConfigUpdated(
            persona,
            key,
            typeof coerced === 'number' ? coerced : String(coerced),
            {
              hotSwapApplied,
              previousValue,
              ...(activeProviderInfo === undefined ? {} : { activeProviderInfo }),
            },
          ),
        ),
      );
      return;
    }

    await replyError(`unknown action ${JSON.stringify(action)}; expected view, set, or reset.`);
  }

  async handleResearchPlan(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<void> {
    if (await this.denyIfUnauthorized(interaction)) {
      return;
    }
    await interaction.deferReply();

    const planIdRaw = interaction.getString('plan-id', true);
    const planId = planIdRaw?.trim();
    const taskId = `discord-research-plan-${interaction.userId}-${Date.now()}`;

    const replyError = async (message: string): Promise<void> => {
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'editReply',
          'research-plan-error',
          taskId,
          this.researchPlanReplySeq++,
          renderResearchPlanError(planId ?? '<missing>', message),
        ),
      );
    };

    if (planId === undefined || planId.length === 0) {
      await replyError('plan-id is required.');
      return;
    }

    const driver = this.options.researchPlanRuntimeDriver;
    if (driver === undefined) {
      await replyError(
        'runtime driver is not wired in this deployment. Use `pnpm research:plan:run` from the operator shell instead.',
      );
      return;
    }

    let plan;
    try {
      plan = loadResearchPlan(
        planId,
        process.env,
        this.options.researchPlanWorkingDirectory ?? process.cwd(),
      );
    } catch (err) {
      await replyError(
        err instanceof ResearchPlanLoaderError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
      return;
    }

    // Edit-reply the acceptance summary and dispatch the plan in the background.
    // Per-sub-task progress is posted via follow-ups inside the dispatcher.
    const inferredProvider: 'codex' | 'claude-agent' =
      process.env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim() === 'claude-agent'
        ? 'claude-agent'
        : 'codex';
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'research-plan-accepted',
        taskId,
        this.researchPlanReplySeq++,
        renderResearchPlanAccepted({
          planId,
          subTaskCount: plan.subTasks.length,
          provider: inferredProvider,
          // UX-6: signal subagent-roster activation upfront so operators
          // know `/subagents list` will see this dispatch's sub-tasks
          // live. The boolean mirrors the env-flag check inside
          // dispatchResearchPlan (researchPlanUseSubagentRoster +
          // researchPlanSubagentPolicyEnforcer both required).
          subagentRosterActive:
            this.options.researchPlanUseSubagentRoster === true &&
            this.options.researchPlanSubagentPolicyEnforcer !== undefined,
        }),
      ),
    );

    void this.dispatchResearchPlan(interaction, taskId, planId, plan, driver);
  }

  /**
   * UX-16 — opt-in pre-dispatch approval gate factory. When the
   * `AUTO_ARCHIVE_RESEARCH_PLAN_APPROVAL_ON_REQUEST` env flag is
   * set to `on` AND a `RuntimeApprovalRegistry` is wired, returns a
   * gate that registers a fresh `PendingRuntimeApproval`, posts the
   * approval id back to the operator (so they know what to `/approve`
   * or `/deny`), and awaits the resolution. Otherwise returns
   * `undefined` and the orchestrator runs without a gate (legacy
   * behaviour, bit-for-bit).
   */
  private buildResearchPlanApprovalGate(input: {
    readonly interaction: DiscordCommandInteractionAdapter;
    readonly taskId: string;
    readonly planId: string;
  }): ResearchPlanApprovalGate | undefined {
    const enabled =
      (process.env['AUTO_ARCHIVE_RESEARCH_PLAN_APPROVAL_ON_REQUEST'] ?? '')
        .trim()
        .toLowerCase() === 'on';
    const registry = this.options.approvalRegistry;
    if (!enabled || registry === undefined) {
      return undefined;
    }
    return {
      requestApproval: async (
        request,
      ): Promise<ResearchPlanApprovalGateOutcome> => {
        const approvalId = `discord-research-plan-${input.taskId}`;
        const requestedAt = new Date().toISOString();
        // 24-hour ceiling — long enough that an operator answering after
        // a coffee break still resolves the approval, short enough that
        // an unattended request is reaped by the registry's expire path
        // instead of pinning a Promise indefinitely.
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        try {
          registry.register({
            approvalId,
            taskId: input.taskId,
            runtimeInstanceId: `discord-research-plan-${input.taskId}-gate`,
            turnSequence: 0,
            commandKind: 'compute-node',
            canonicalCwd: '.',
            envDigest: 'sha256:research-plan-pre-dispatch',
            requestedAt,
            expiresAt,
            reason:
              `Approval requested before dispatching /research-plan ` +
              `plan-id:${input.planId} ` +
              `(${request.planSubTaskCount} sub-task` +
              `${request.planSubTaskCount === 1 ? '' : 's'} + synthesis ` +
              `\`${request.synthesisTaskId}\`). ` +
              `Use \`/approve approval_id:${approvalId}\` or ` +
              `\`/deny approval_id:${approvalId}\`.`,
          });
        } catch (err) {
          // Registry refused (duplicate id collision is the only realistic
          // path here). Treat as denied so the run halts cleanly instead
          // of wedging on a Promise that never resolves.
          return {
            status: 'denied',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        // Surface the approval id to the operator via a follow-up so
        // they don't have to dig through `/feed kind:approval` to find
        // the id we just minted. Fire-and-forget — failure to deliver
        // the notification must not block the gate.
        try {
          await this.deliver(
            input.interaction,
            this.buildDeliveryRequest(
              input.interaction,
              'followUp',
              'research-plan-progress',
              input.taskId,
              this.researchPlanReplySeq++,
              {
                content:
                  `🔒 Approval required before \`/research-plan plan-id:${input.planId}\` ` +
                  `dispatches its first sub-task. ` +
                  `Use \`/approve approval_id:${approvalId}\` to proceed, or ` +
                  `\`/deny approval_id:${approvalId}\` to halt.`,
              },
            ),
          );
        } catch (deliveryErr) {
          console.warn(
            `[discord-research-plan] failed to surface approval-id ${approvalId}: ` +
              (deliveryErr instanceof Error
                ? deliveryErr.message
                : String(deliveryErr)),
          );
        }
        const decision = await registry.waitForDecision(approvalId);
        if (decision.status === 'approved') {
          return { status: 'approved' };
        }
        // ApprovalHookDecision.rejected covers both deny + expiry. We
        // do a best-effort discriminator: if the reason mentions
        // "expired", surface as expired; otherwise treat as a deny.
        const reason = decision.reason ?? 'denied';
        if (reason.toLowerCase().includes('expired')) {
          return { status: 'expired', reason };
        }
        return { status: 'denied', reason };
      },
    };
  }

  private async dispatchResearchPlan(
    interaction: DiscordCommandInteractionAdapter,
    taskId: string,
    planId: string,
    plan: import('../core/research-plan-orchestrator.js').ResearchPlan,
    driver: import('../contracts/runtime-driver.js').RuntimeDriver,
    missionEvidenceContext?: {
      readonly missionId: string;
      readonly actorId: string;
    },
  ): Promise<void> {
    const subTaskTotal = plan.subTasks.length;
    let subTaskIndex = 0;
    const start = Date.now();
    // UX-16 — opt-in pre-dispatch approval gate. Returns undefined when
    // the env-flag is off OR no approval registry is wired (legacy
    // behaviour, bit-for-bit). The gate is awaited inside runResearchPlan
    // BEFORE any sub-task dispatches; on deny / expiry the orchestrator
    // returns a clean stoppedEarly result with no sub-tasks attempted.
    const approvalGate = this.buildResearchPlanApprovalGate({
      interaction,
      taskId,
      planId,
    });
    // P4 Stage 4-6 Commit 3 — opt-in production caller wiring. When the
    // operator opts in via env, the handler routes every sub-task through
    // `roster.spawnAndRun(...)` so `/subagents list` shows live sub-task
    // surfaces and the operator surface can `kill` an in-flight child.
    // Mirrors `scripts/research-plan-runner.mjs:178-203` per-dispatch
    // construction (the roster lifetime equals one `/research-plan`
    // invocation; concurrent invocations stay isolated by construction).
    const subagentRosterInstanceId =
      this.options.researchPlanUseSubagentRoster === true &&
      this.options.researchPlanSubagentPolicyEnforcer !== undefined
        ? `discord-research-plan-${taskId}-${Date.now()}`
        : undefined;
    const subagentRoster =
      subagentRosterInstanceId !== undefined &&
      this.options.researchPlanUseSubagentRoster === true &&
      this.options.researchPlanSubagentPolicyEnforcer !== undefined
        ? createSubagentRoster({
            taskId,
            instanceId: subagentRosterInstanceId,
            envelope: createResourceEnvelope({
              requested: plan.resources.requested,
              ...(plan.resources.effective !== undefined
                ? { effective: plan.resources.effective }
                : {}),
            }),
            runtimeSettings: createRuntimeSettingsBundle(plan.runtimeSettings),
            spawnAuthority: 'root',
            parentDepth: 0,
            policyEnforcer: this.options.researchPlanSubagentPolicyEnforcer,
            runChild: createResearchPlanRunChild(driver),
          })
        : undefined;
    const subagentRosterRegistry = this.options.researchPlanSubagentRosterRegistry;
    let subagentRosterRegistered = false;
    if (
      subagentRoster !== undefined &&
      subagentRosterInstanceId !== undefined &&
      subagentRosterRegistry !== undefined
    ) {
      subagentRosterRegistry.register({
        taskId,
        instanceId: subagentRosterInstanceId,
        roster: subagentRoster,
      });
      subagentRosterRegistered = true;
    }
    const subagentRosterEventConsumer =
      subagentRoster === undefined
        ? undefined
        : this.attachResearchPlanSubagentEvidenceConsumer(subagentRoster);
    // UX-11 — per-sub-task tool-use heartbeat throttle state. Reset on
    // every onSubTaskCompleted so each sub-task gets a fresh budget.
    // The shape `{ subTaskId, started, lastPostMs, toolCounts }` is
    // updated inline by the onEvent observer; the throttle gate fires
    // a heartbeat post only when EITHER the per-sub-task tool-use
    // counter crosses HEARTBEAT_TOOL_THRESHOLD OR more than
    // HEARTBEAT_TIME_THRESHOLD_MS have elapsed since the last post (or
    // sub-task start). See specs/ARCHIVE/ux-comparison-2026-05-09.md
    // §3.1 for the activity-stream gap that motivated this surface.
    const HEARTBEAT_TOOL_THRESHOLD = 5;
    const HEARTBEAT_TIME_THRESHOLD_MS = 60_000;
    let heartbeatState: {
      subTaskId: string;
      startedMs: number;
      lastPostMs: number;
      toolCounts: Record<string, number>;
      toolUseCountAtLastPost: number;
    } | undefined;
    try {
      // UX-1: stream per-sub-task progress via the orchestrator's
      // `onSubTaskCompleted` hook so operators see each sub-task land as
      // it finishes instead of waiting for the whole plan to complete
      // before any progress is delivered. For a 12-sub-task audit
      // running 60+ minutes, this is the difference between 13 lines
      // trickling in vs. 13 lines arriving in a single burst at the end.
      const result = await runResearchPlan(driver, plan, {
        onEvent: ({ subTaskId, event }) => {
          // UX-11: classify the event into one of the five tracked
          // tool/agent classes and decide whether the per-sub-task
          // throttle gate has been crossed.
          if (event.kind !== 'item.completed') {
            return;
          }
          const itemAny = (event as { item?: { type?: unknown } }).item;
          const t =
            typeof itemAny?.type === 'string' ? itemAny.type : undefined;
          if (t === undefined) {
            return;
          }
          // Match the orchestrator's toolUseCount taxonomy (plus
          // `agent_message` for visibility) so the breakdown stays
          // aligned with renderResearchPlanProgress's final count.
          const trackedKinds = [
            'command_execution',
            'file_change',
            'mcp_tool_call',
            'web_search',
            'agent_message',
          ];
          if (!trackedKinds.includes(t)) {
            return;
          }
          // (Re)initialize per-sub-task heartbeat state on first event
          // for this sub-task. The orchestrator dispatches sub-tasks
          // sequentially so a single mutable slot is sufficient.
          if (
            heartbeatState === undefined ||
            heartbeatState.subTaskId !== subTaskId
          ) {
            heartbeatState = {
              subTaskId,
              startedMs: Date.now(),
              lastPostMs: Date.now(),
              toolCounts: {},
              toolUseCountAtLastPost: 0,
            };
          }
          heartbeatState.toolCounts[t] =
            (heartbeatState.toolCounts[t] ?? 0) + 1;
          // Total tool-uses-this-sub-task = sum of tracked kinds
          // EXCLUDING agent_message, so the throttle gate matches the
          // orchestrator's toolUseCount semantics.
          const toolUseTotal =
            (heartbeatState.toolCounts['command_execution'] ?? 0) +
            (heartbeatState.toolCounts['file_change'] ?? 0) +
            (heartbeatState.toolCounts['mcp_tool_call'] ?? 0) +
            (heartbeatState.toolCounts['web_search'] ?? 0);
          const sinceLastPostMs = Date.now() - heartbeatState.lastPostMs;
          const toolGate =
            toolUseTotal - heartbeatState.toolUseCountAtLastPost >=
            HEARTBEAT_TOOL_THRESHOLD;
          const timeGate = sinceLastPostMs >= HEARTBEAT_TIME_THRESHOLD_MS;
          if (!toolGate && !timeGate) {
            return;
          }
          heartbeatState.lastPostMs = Date.now();
          heartbeatState.toolUseCountAtLastPost = toolUseTotal;
          const renderedTotal =
            subTaskId === plan.synthesis.taskId
              ? subTaskTotal + 1
              : subTaskTotal;
          // subTaskIndex tracks COMPLETED sub-tasks; in-flight is +1.
          const renderedIndex = Math.min(subTaskIndex + 1, renderedTotal);
          void this.deliver(
            interaction,
            this.buildDeliveryRequest(
              interaction,
              'followUp',
              'research-plan-progress',
              taskId,
              this.researchPlanReplySeq++,
              renderResearchPlanHeartbeat({
                planId,
                subTaskId,
                index: renderedIndex,
                total: renderedTotal,
                toolCounts: { ...heartbeatState.toolCounts },
                elapsedMs: Date.now() - heartbeatState.startedMs,
              }),
            ),
          );
        },
        onSubTaskCompleted: async ({ kind, outcome }) => {
          subTaskIndex += 1;
          // UX-11: terminate the heartbeat throttle for this sub-task
          // so the next sub-task starts with a fresh budget instead of
          // inheriting the previous sub-task's last-post timer.
          heartbeatState = undefined;
          if (kind === 'subTask' && missionEvidenceContext !== undefined) {
            this.recordResearchPlanSubTaskEvidence({
              missionId: missionEvidenceContext.missionId,
              planId,
              outcome,
              actorId: missionEvidenceContext.actorId,
            });
          }
          const renderedTotal =
            kind === 'synthesis' ? subTaskTotal + 1 : subTaskTotal;
          await this.deliver(
            interaction,
            this.buildDeliveryRequest(
              interaction,
              'followUp',
              'research-plan-progress',
              taskId,
              this.researchPlanReplySeq++,
              renderResearchPlanProgress({
                planId,
                subTaskId: outcome.subTaskId,
                index: subTaskIndex,
                total: renderedTotal,
                causeKind: outcome.causeKind,
                elapsedMs: outcome.elapsedMs,
                toolUseCount: outcome.toolUseCount,
              }),
            ),
          );
        },
        // UX-4: surface retry / fast-fail progress to Discord so
        // operators see "we noticed the failure, we're trying again"
        // instead of silence during a sub-task that took 2-3× the
        // typical run because of a transient SDK 502.
        onRetry: ({
          subTaskId,
          attempt,
          maxAttempts,
          previousCauseKind,
          previousDriverThrew,
          previousCauseClassification,
          previousCauseFastFailed,
        }) => {
          void this.deliver(
            interaction,
            this.buildDeliveryRequest(
              interaction,
              'followUp',
              'research-plan-progress',
              taskId,
              this.researchPlanReplySeq++,
              renderResearchPlanRetry({
                planId,
                subTaskId,
                kind:
                  previousCauseFastFailed === true ? 'fast-fail' : 'retry',
                attempt,
                maxAttempts,
                previousCauseKind,
                ...(previousCauseClassification !== undefined
                  ? { previousCauseClassification }
                  : {}),
                ...(previousDriverThrew !== undefined
                  ? { previousDriverThrew }
                  : {}),
              }),
            ),
          );
        },
        ...(subagentRoster !== undefined ? { subagentRoster } : {}),
        ...(approvalGate !== undefined ? { approvalGate } : {}),
      });
      const synthesisOutcome = result.synthesisOutcome;
      if (result.stoppedEarly || synthesisOutcome === undefined) {
        const lastOutcome = result.subTaskOutcomes.at(-1);
        const lastCauseKind = lastOutcome?.causeKind ?? 'unknown';
        const lastClassification = (
          lastOutcome?.result?.cause as
            | { classification?: string }
            | undefined
        )?.classification;
        // UX-2: derive actionable hint from the last cause + classification.
        const hint = buildResearchPlanEarlyStopHint(
          lastCauseKind,
          lastClassification,
          planId,
        );
        await this.deliver(
          interaction,
          this.buildDeliveryRequest(
            interaction,
            'followUp',
            'research-plan-error',
            taskId,
            this.researchPlanReplySeq++,
            renderResearchPlanError(
              planId,
              `plan stopped early after ${subTaskIndex}/${subTaskTotal} sub-tasks. ` +
                `Last cause: ${lastCauseKind}` +
                (lastClassification !== undefined
                  ? ` (${lastClassification})`
                  : '') +
                '.',
              hint,
            ),
          ),
        );
        return;
      }
      let artifactPath: string | undefined;
      let fullReportSizeBytes: number | undefined;
      if (result.aggregatedReport.length > DISCORD_MESSAGE_BUDGET) {
        const root = resolveResearchPlanReportRoot({
          explicitRoot: this.options.researchPlanArtifactRoot,
          plan,
          cwd: this.options.researchPlanWorkingDirectory ?? process.cwd(),
        });
        const persisted = persistResearchPlanReport({
          root,
          planId,
          aggregatedReport: result.aggregatedReport,
          totalElapsedMs: result.totalElapsedMs,
          subTaskCount: subTaskTotal,
          stoppedEarly: result.stoppedEarly,
          partialSynthesis: result.partialSynthesis,
          skippedSubTaskIds: result.skippedSubTaskIds,
        });
        if (persisted !== undefined) {
          artifactPath = persisted.artifactPath;
          fullReportSizeBytes = persisted.fileSize;
        }
      }
      const attachmentIncluded = artifactPath !== undefined;
      const finalPayload = renderResearchPlanFinal({
        planId,
        aggregatedReport: result.aggregatedReport,
        totalElapsedMs: result.totalElapsedMs,
        subTaskCount: subTaskTotal,
        stoppedEarly: result.stoppedEarly,
        partialSynthesis: result.partialSynthesis,
        ...(artifactPath === undefined ? {} : { artifactPath }),
        ...(fullReportSizeBytes === undefined
          ? {}
          : { fullReportSizeBytes }),
        attachmentIncluded,
      });
      // P3-def-2: when we persisted a file, attach it to the same follow-up
      // so the operator can download from Discord directly without scp. The
      // disk-path string in the rendered text remains as a fallback hint
      // for operators who prefer host-side access (e.g. machines without
      // Discord download capability).
      const finalPayloadWithAttachment: DiscordMessagePayload =
        attachmentIncluded
          ? {
              ...finalPayload,
              attachments: [
                { name: `${planId}.md`, path: artifactPath as string },
              ],
            }
          : finalPayload;
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'followUp',
          'research-plan-final',
          taskId,
          this.researchPlanReplySeq++,
          finalPayloadWithAttachment,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - start;
      console.warn(
        `[discord-research-plan] dispatch threw after ${elapsed}ms: ${message}`,
      );
      await this.deliver(
        interaction,
        this.buildDeliveryRequest(
          interaction,
          'followUp',
          'research-plan-error',
          taskId,
          this.researchPlanReplySeq++,
          renderResearchPlanError(planId, `dispatch threw: ${message}`),
        ),
      );
    } finally {
      if (subagentRoster !== undefined && subagentRosterInstanceId !== undefined) {
        const cleanupCause: TerminalCause = {
          kind: 'driver-failure',
          taskId,
          runtimeInstanceId: subagentRosterInstanceId,
          observedAt: new Date().toISOString(),
          provenance: 'discord-research-plan-roster-cleanup',
          phase: 'research-plan cleanup',
          message:
            'research-plan roster cleanup invoked after dispatch completion',
        };
        try {
          await subagentRoster.terminateAll(cleanupCause);
        } catch (cleanupError) {
          console.warn(
            'discord-research-plan.subagent-roster-cleanup-threw',
            JSON.stringify({
              taskId,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            }),
          );
        }
      }
      if (subagentRosterRegistered) {
        try {
          subagentRosterRegistry?.unregister(taskId);
        } catch (unregisterError) {
          console.warn(
            'discord-research-plan.subagent-roster-unregister-threw',
            JSON.stringify({
              taskId,
              error:
                unregisterError instanceof Error
                  ? unregisterError.message
                  : String(unregisterError),
            }),
          );
        }
      }
      if (subagentRosterEventConsumer !== undefined) {
        try {
          await subagentRosterEventConsumer.iterator.return?.();
        } catch {
          // Iterator teardown is best effort; the consumer swallows loop errors.
        }
        try {
          await subagentRosterEventConsumer.settled;
        } catch {
          // Defensive; the consumer already catches its own failures.
        }
      }
    }
  }

  private attachResearchPlanSubagentEvidenceConsumer(
    roster: SubagentRoster,
  ):
    | {
        readonly iterator: AsyncIterator<RosterEvent, undefined, undefined>;
        readonly settled: Promise<void>;
      }
    | undefined {
    const sink = this.options.researchPlanSubagentEvidenceLedgerSink;
    if (sink === undefined) {
      return undefined;
    }
    const iterator = roster.events[Symbol.asyncIterator]() as AsyncIterator<
      RosterEvent,
      undefined,
      undefined
    >;
    const settled = (async (): Promise<void> => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) {
            return;
          }
          try {
            sink(next.value);
          } catch (sinkError) {
            console.warn(
              'discord-research-plan.subagent-evidence-sink-threw',
              JSON.stringify({
                eventKind: next.value.kind,
                error:
                  sinkError instanceof Error
                    ? sinkError.message
                    : String(sinkError),
              }),
            );
          }
        }
      } catch {
        // Iterator teardown or caller abort; dispatch cleanup owns lifecycle.
      }
    })();
    settled.catch(() => undefined);
    return { iterator, settled };
  }

  private async denyIfUnauthorized(
    interaction: DiscordCommandInteractionAdapter,
  ): Promise<boolean> {
    const decision = this.options.accessPolicy?.check({
      action: interaction.commandName,
      userId: interaction.userId,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      authorIsBot: interaction.authorIsBot,
    });
    if (decision === undefined || decision.status === 'allowed') {
      return false;
    }
    await interaction.deferReply({ ephemeral: true });
    // Route through the standard delivery path so the persona hook
    // (`access-denied` is in CONVERSATIONAL_PERSONA_EVENT_TYPES and the
    // Arona/Plana duet prompt has explicit handling for it) and the
    // delivery queue (idempotency / DLQ / circuit breaker) both apply.
    // The persona transformer is fail-open, so denial latency stays bounded
    // by the transformer's latency budget — no UX regression on the deny path.
    await this.deliver(
      interaction,
      this.buildDeliveryRequest(
        interaction,
        'editReply',
        'access-denied',
        `discord-access-denied-${interaction.userId}`,
        this.accessDeniedReplySeq++,
        renderAccessDenied(interaction.commandName, decision),
      ),
    );
    return true;
  }

  private async denyIfNotTaskOwnerOrAdmin(input: {
    readonly interaction: DiscordCommandInteractionAdapter;
    readonly record: DiscordTaskRecord;
    readonly action: 'cancel' | 'rerun' | 'archive' | 'unarchive';
    readonly eventType: DiscordDeliveryEventType;
    readonly taskId: string;
    readonly sequence: number;
    readonly replyAlreadyDeferred: boolean;
  }): Promise<boolean> {
    if (
      input.record.userId === input.interaction.userId ||
      this.options.accessPolicy?.isAdminUser(input.interaction.userId) === true
    ) {
      return false;
    }
    if (!input.replyAlreadyDeferred) {
      await input.interaction.deferReply();
    }
    await this.deliver(
      input.interaction,
      this.buildDeliveryRequest(
        input.interaction,
        'editReply',
        input.eventType,
        input.taskId,
        input.sequence,
        renderTaskOwnerRequired(input.record, input.action),
      ),
    );
    return true;
  }
}

type DiscordCommandDispatch = (
  handlers: DiscordCommandHandlers,
  interaction: DiscordCommandInteractionAdapter,
) => Promise<void>;

const DISCORD_COMMAND_DISPATCH: Record<
  DiscordFirstSliceCommandName,
  DiscordCommandDispatch
> = {
  ask: (h, i) => h.handleAsk(i),
  research: (h, i) => h.handleResearch(i),
  evidence: (h, i) => h.handleEvidence(i),
  claim: (h, i) => h.handleClaim(i),
  critique: (h, i) => h.handleCritique(i),
  status: (h, i) => h.handleStatus(i),
  cancel: (h, i) => h.handleCancel(i),
  rerun: (h, i) => h.handleRerun(i),
  archive: (h, i) => h.handleArchive(i),
  unarchive: (h, i) => h.handleUnarchive(i),
  tasks: (h, i) => h.handleTasks(i),
  traits: (h, i) => h.handleTraits(i),
  agenda: (h, i) => h.handleAgenda(i),
  history: (h, i) => h.handleHistory(i),
  context: (h, i) => h.handleContext(i),
  escalate: (h, i) => h.handleEscalate(i),
  feed: (h, i) => h.handleFeed(i),
  approve: (h, i) => h.handleApproval(i, 'approved'),
  deny: (h, i) => h.handleApproval(i, 'denied'),
  doctor: (h, i) => h.handleDoctor(i),
  proof: (h, i) => h.handleProof(i),
  subagents: (h, i) => h.handleSubagents(i),
  focus: (h, i) => h.handleFocus(i),
  unfocus: (h, i) => h.handleUnfocus(i),
  auth: (h, i) => h.handleAuth(i),
  config: (h, i) => h.handleConfig(i),
  'research-plan': (h, i) => h.handleResearchPlan(i),
  help: (h, i) => h.handleHelp(i),
  quickstart: (h, i) => h.handleQuickstart(i),
  follow: (h, i) => h.handleFollow(i),
  insights: (h, i) => h.handleInsights(i),
};

type AuthMutationAction = {
  readonly kind: 'add' | 'remove';
  readonly scope: DiscordAuthScope;
};

function parseAuthMutationAction(action: string): AuthMutationAction | undefined {
  switch (action) {
    case 'allow_guild':
      return { kind: 'add', scope: 'allowed-guild' };
    case 'revoke_guild':
      return { kind: 'remove', scope: 'allowed-guild' };
    case 'allow_user':
      return { kind: 'add', scope: 'allowed-user' };
    case 'revoke_user':
      return { kind: 'remove', scope: 'allowed-user' };
    case 'allow_channel':
      return { kind: 'add', scope: 'allowed-channel' };
    case 'revoke_channel':
      return { kind: 'remove', scope: 'allowed-channel' };
    case 'add_admin':
      return { kind: 'add', scope: 'admin-user' };
    case 'remove_admin':
      return { kind: 'remove', scope: 'admin-user' };
    default:
      return undefined;
  }
}

type AgendaAction = 'list' | 'add' | 'done' | 'cadence';

function parseAgendaAction(value: string | null): AgendaAction {
  const normalized = value?.trim();
  switch (normalized) {
    case 'add':
    case 'done':
    case 'cadence':
      return normalized;
    case 'list':
    case undefined:
    case '':
      return 'list';
    default:
      return 'list';
  }
}

function parseAgendaStatus(value: string | null): ResearchAgendaStatus | 'all' {
  const normalized = value?.trim();
  switch (normalized) {
    case 'done':
    case 'all':
      return normalized;
    case 'open':
    case undefined:
    case '':
      return 'open';
    default:
      return 'open';
  }
}

function parseOptionalLimit(value: string | null, fallback: number): number {
  if (value === null || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : fallback;
}

type DiscordHistoryView = 'events' | 'talk';

function parseHistoryView(value: string | null): DiscordHistoryView {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'talk' ||
    normalized === '--talk' ||
    normalized === 'conversation' ||
    normalized === 'chat' ||
    normalized === 'transcript' ||
    normalized === 'messages'
  ) {
    return 'talk';
  }
  return 'events';
}

/**
 * UX-2 — actionable next-step guidance for the `/research-plan`
 * early-stop follow-up. Maps the last sub-task's `causeKind` (and
 * optional `classification` for `provider-failure`) to a one-line
 * hint that tells the operator what to do next.
 *
 * Behavior summary:
 *  - `provider-failure` + transient classification → re-run guidance
 *    (rate-limit / network / provider-internal usually self-recover).
 *  - `provider-failure` + permanent-* classification → fix-root-cause
 *    guidance (re-running won't help; check `/doctor`, env, or auth).
 *  - `runtime-veto` → check `/doctor` advisor health.
 *  - `external-cancel` → operator initiated; no guidance needed
 *    beyond the existing cancel-receipt UX.
 *  - `timeout` → consider raising wallTime budget or scope.
 *  - `driver-threw` (synthetic kind from orchestrator) → check
 *    `/doctor` provider readiness; the SDK threw before producing a
 *    cause.
 *  - any other kind → generic "재시도하거나 `/doctor` 점검" fallback.
 */
export function buildResearchPlanEarlyStopHint(
  causeKind: string,
  classification: string | undefined,
  planId: string,
): string | undefined {
  if (causeKind === 'external-cancel') {
    return undefined;
  }
  const reRunCmd = `\`/research-plan plan-id:${planId}\``;
  if (causeKind === 'provider-failure') {
    if (classification !== undefined && classification.startsWith('permanent-')) {
      return (
        `Permanent provider failure (${classification}) — re-running won't help. ` +
        'Check `/doctor` for provider/auth readiness and fix the root cause before re-run.'
      );
    }
    if (classification === 'rate-limit' || classification === 'transient') {
      return `Transient provider failure — wait briefly, then re-run via ${reRunCmd}.`;
    }
    return (
      `Provider failure — try ${reRunCmd} again, or check \`/doctor\` ` +
      'and `pnpm research:plan:run --retry-attempts 2` for full retry control.'
    );
  }
  if (causeKind === 'runtime-veto') {
    return 'Advisor vetoed the dispatch — check `/doctor` for advisor health and adjust the plan or persona settings before re-run.';
  }
  if (causeKind === 'timeout') {
    return 'Sub-task hit its wallTime budget — raise `runtimeSettings.wallTimeSec` in the plan or split the sub-task before re-run.';
  }
  if (causeKind === 'driver-threw') {
    return 'Driver threw before producing a cause — check `/doctor` for provider/SDK readiness, then re-run.';
  }
  return `Re-run via ${reRunCmd} after a brief pause, or use \`pnpm research:plan:run --retry-attempts 2\` for full retry control.`;
}
