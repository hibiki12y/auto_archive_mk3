import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  rateThrottleConfigFromEnv,
  type RateThrottleSnapshot,
} from './rate-throttle.js';
import { isTaskStallObserverEnabledFromEnv } from './task-stall-observer.js';
import {
  buildTraitSchedulerTickEvidenceReport,
  JsonlTraitSchedulerTickEvidenceLedger,
} from '../cron/trait-scheduler-dispatch-runner.js';
import {
  buildPlanaClaudeAdvisorAuditReport,
  JsonlPlanaClaudeAdvisorAuditLedger,
} from './plana-claude-runtime-advisor.js';
import {
  AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES,
  buildAgentHarnessRegistryReportFromCliOptions,
} from '../runtime/agent-harness-registry-report-cli.js';
import {
  AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
  buildAutonomousResearchEvidenceReportFromCliOptions,
  type AutonomousResearchEvidenceReportStatus,
} from '../runtime/autonomous-research-evidence-report-cli.js';
import {
  RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
  buildRuntimeProviderEvidenceReportFromCliOptions,
  type RuntimeProviderEvidenceProvider,
  type RuntimeProviderEvidenceReportStatus,
} from '../runtime/runtime-provider-evidence-report-cli.js';
import {
  LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES,
  buildLiveProofReportFromCliOptions,
  type LiveProofReportStatus,
} from './live-proof-report-cli.js';
import {
  PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildPeekabooEvidenceReportFromCliOptions,
} from '../remote/peekaboo-evidence-report-cli.js';
import {
  PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildPersonaTelemetryReportFromCliOptions,
  type PersonaTelemetryReportStatus,
} from '../persona/persona-telemetry-report-cli.js';
import type { AgentHarnessRegistryReportStatus } from '../runtime/agent-harness-registry.js';
import type { AgentHarnessSelectionSource } from '../contracts/agent-harness-plugin.js';
import {
  AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST,
  AUTONOMOUS_RESEARCH_TRAIT_PROFILES,
} from '../contracts/autonomous-research-trait.js';
import {
  AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION,
  resolveAutonomousResearchTraitRuntimeDecorationMode,
  type AutonomousResearchTraitRuntimeDecorationMode,
} from '../runtime/autonomous-research-trait-runtime-decorator-resolver.js';
import {
  AUTO_ARCHIVE_OTEL_LOGS_URL,
  AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES,
} from '../control/control-plane-otel-emitter.js';
import {
  TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildTaskHealthEvidenceReportFromCliOptions,
  type TaskHealthEvidenceReportStatus,
} from '../control/task-health-evidence-report-cli.js';
import {
  TASK_ARCHIVE_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildTaskArchiveEvidenceReportFromCliOptions,
  type TaskArchiveEvidenceReportStatus,
} from '../control/task-archive-evidence-report-cli.js';
import {
  SUBAGENT_OPERATOR_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildSubagentOperatorEvidenceReportFromCliOptions,
  type SubagentOperatorEvidenceReportStatus,
} from '../runtime/subagent-operator-evidence-report-cli.js';
import {
  SESSION_BINDING_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildSessionBindingEvidenceReportFromCliOptions,
  type SessionBindingEvidenceReportStatus,
} from '../discord/session-binding-evidence-report-cli.js';
import { CLAUDE_OFFLOAD_LEDGER_DEFAULT_MAX_BYTES } from './claude-token-offload-ledger.js';
import type {
  ClaudeOffloadErrorCategory,
  ClaudeOffloadRouteStatus,
} from './claude-token-offload-result.js';
import type { ClaudeOffloadPurpose } from '../contracts/claude-token-offload.js';
import { buildClaudeOffloadReportFromCliOptions } from './claude-token-offload-report-cli.js';

export type DoctorSectionStatus = 'pass' | 'warn' | 'fail';

export interface DoctorSection {
  readonly name: string;
  readonly status: DoctorSectionStatus;
  readonly details: readonly string[];
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly generatedAt: string;
  readonly sections: readonly DoctorSection[];
}

export const AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH =
  'AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH';
export const AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES';
export const TRAIT_SCHEDULER_TICK_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  100 * 1024 * 1024;
const AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH =
  'AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH';
export const AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES';
export const PLANA_ADVISOR_EVENTS_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  100 * 1024 * 1024;
export const AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH =
  'AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH';
export const AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES =
  'AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES';
export const AGENT_HARNESS_REGISTRY_DOCTOR_DEFAULT_MAX_DESCRIPTOR_BYTES =
  AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES;
export const AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH =
  'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH';
export const AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES =
  'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES';
export const AUTONOMOUS_RESEARCH_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES =
  AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES;
export const AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH =
  'AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH';
export const AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES =
  'AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES';
export const RUNTIME_PROVIDER_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES =
  RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES;
export const AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH =
  'AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH';
export const AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES =
  'AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES';
export const LIVE_PROOF_DOCTOR_DEFAULT_MAX_BYTES =
  LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES;
export const AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH =
  'AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH';
export const AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES';
export const PEEKABOO_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
export const AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH =
  'AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH';
export const AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES';
export const PERSONA_TELEMETRY_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
export const AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH =
  'AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH';
export const AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES';
export const TASK_HEALTH_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
export const AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH =
  'AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH';
export const AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES';
export const TASK_ARCHIVE_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  TASK_ARCHIVE_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
export const AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH =
  'AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH';
export const AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES';
export const SUBAGENT_OPERATOR_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  SUBAGENT_OPERATOR_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
export const AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH =
  'AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH';
export const AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES';
export const SESSION_BINDING_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  SESSION_BINDING_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
export const AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH =
  'AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH';
export const AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES =
  'AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES';
export const CLAUDE_OFFLOAD_DOCTOR_DEFAULT_MAX_LEDGER_BYTES =
  CLAUDE_OFFLOAD_LEDGER_DEFAULT_MAX_BYTES;

export interface DoctorControlPlaneOtelLogsStatus {
  readonly endpointUrl: string;
  readonly protocol?: 'http:' | 'https:';
  readonly resourceAttributeCount?: number;
  readonly customResourceAttributeCount?: number;
  readonly invalidResourceAttributeCount?: number;
  readonly defaultResourceAttributes: readonly ['service.name', 'service.namespace'];
  readonly exportTimeoutMs: number;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorTraitSchedulerTickEvidenceStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly recordCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly sufficientForTrend?: boolean;
  readonly dispatchFailedCount?: number;
  readonly checkpointHoldCount?: number;
  readonly leaseHeldSkipCount?: number;
  readonly malformedLineCount?: number;
  readonly lastRecordedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorPlanaAdvisorEventsStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly recordCount?: number;
  readonly sufficientForTrend?: boolean;
  readonly vetoCount?: number;
  readonly advisorErrorFailOpenCount?: number;
  readonly malformedLineCount?: number;
  readonly lastRecordedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorAgentHarnessRegistryStatus {
  readonly descriptorPath: string;
  readonly maxDescriptorBytes: number;
  readonly provider: string;
  readonly source: AgentHarnessSelectionSource;
  readonly registryStatus?: AgentHarnessRegistryReportStatus;
  readonly pluginCount?: number;
  readonly supportedPluginCount?: number;
  readonly configurationErrorCount?: number;
  readonly selectedPluginId?: string;
  readonly selectedPriority?: number;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorAutonomousResearchTraitRuntimeStatus {
  readonly envVar: typeof AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION;
  readonly mode?: AutonomousResearchTraitRuntimeDecorationMode;
  readonly selectedTraitId?: string;
  readonly selectedProfileId?: string;
  readonly runtimeHook: string;
  readonly runtimeEnforcement: string;
  readonly error?: string;
}

export interface DoctorAutonomousResearchEvidenceStatus {
  readonly evidencePath: string;
  readonly maxEvidenceBytes: number;
  readonly reportStatus?: AutonomousResearchEvidenceReportStatus;
  readonly evidenceRecordCount?: number;
  readonly autonomousTaskCount?: number;
  readonly completeTaskCount?: number;
  readonly delegateErrorTaskCount?: number;
  readonly incompleteTaskCount?: number;
  readonly notRequestedTaskCount?: number;
  readonly startCheckpointCount?: number;
  readonly completeCheckpointCount?: number;
  readonly errorCheckpointCount?: number;
  readonly criteriaComplete?: boolean;
  readonly missingCriteriaCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly lastCheckpointAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorRuntimeProviderEvidenceStatus {
  readonly evidencePath: string;
  readonly maxEvidenceBytes: number;
  readonly provider: RuntimeProviderEvidenceProvider;
  readonly reportStatus?: RuntimeProviderEvidenceReportStatus;
  readonly evidenceRecordCount?: number;
  readonly selectedProviderRecordCount?: number;
  readonly successfulProviderRecordCount?: number;
  readonly failedProviderRecordCount?: number;
  readonly providerProvenanceMatchedCount?: number;
  readonly transcriptEventCount?: number;
  readonly totalTokens?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly lastEndedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorLiveProofReportStatus {
  readonly proofPath: string;
  readonly maxProofBytes: number;
  readonly reportStatus?: LiveProofReportStatus;
  readonly proofRecordCount?: number;
  readonly completeProofCount?: number;
  readonly warnProofCount?: number;
  readonly failProofCount?: number;
  readonly operatorApprovedCount?: number;
  readonly unsafeBoundaryCount?: number;
  readonly missingRequiredArtifactCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorPeekabooEvidenceReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly recordCount?: number;
  readonly liveRecordCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly sufficientForPromotion?: boolean;
  readonly liveOkCount?: number;
  readonly liveOkTotal?: number;
  readonly matchedReplyObservedCount?: number;
  readonly matchedReplyObservedTotal?: number;
  readonly strongCorrelationCount?: number;
  readonly strongCorrelationTotal?: number;
  readonly passOutcomeCount?: number;
  readonly malformedLineCount?: number;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorPersonaTelemetryReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly reportStatus?: PersonaTelemetryReportStatus;
  readonly recordCount?: number;
  readonly successCount?: number;
  readonly fallbackCount?: number;
  readonly latencyBudgetSampleCount?: number;
  readonly withinLatencyBudgetCount?: number;
  readonly humanReviewedNoSourceDialogueCopyCount?: number;
  readonly averageDurationMs?: number;
  readonly totalTokens?: number;
  readonly malformedLineCount?: number;
  readonly unsafeRawContentLineCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorClaudeOffloadReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly recordCount?: number;
  readonly statusCounts?: Readonly<Record<ClaudeOffloadRouteStatus, number>>;
  readonly errorCategoryCounts?: Readonly<
    Record<ClaudeOffloadErrorCategory, number>
  >;
  readonly purposeCounts?: Readonly<Record<ClaudeOffloadPurpose, number>>;
  readonly totalBlockingGaps?: number;
  readonly totalMemoryCandidates?: number;
  readonly skippedMalformedLineCount?: number;
  readonly skippedUnsafeLineCount?: number;
  readonly firstRecordedAt?: string;
  readonly lastRecordedAt?: string;
  readonly error?: string;
}

export interface DoctorTaskArchiveEvidenceReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly reportStatus?: TaskArchiveEvidenceReportStatus;
  readonly recordCount?: number;
  readonly archiveRecordCount?: number;
  readonly unarchiveRecordCount?: number;
  readonly archiveEventCount?: number;
  readonly unarchiveEventCount?: number;
  readonly taskScopedRecordCount?: number;
  readonly actorScopedRecordCount?: number;
  readonly actorAttributedRecordCount?: number;
  readonly channelScopedRecordCount?: number;
  readonly reasonPresentCount?: number;
  readonly currentArchivedTaskCount?: number;
  readonly duplicateArchiveCount?: number;
  readonly unmatchedUnarchiveCount?: number;
  readonly filterApplied?: boolean;
  readonly transitionCountsFiltered?: boolean;
  readonly retainedRecordCount?: number;
  readonly malformedLineCount?: number;
  readonly unsafePayloadLineCount?: number;
  readonly nonTaskArchiveLineCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly lastActionAt?: string;
  readonly lastObservedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorTaskHealthEvidenceReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly reportStatus?: TaskHealthEvidenceReportStatus;
  readonly recordCount?: number;
  readonly taskScopedRecordCount?: number;
  readonly correlationScopedRecordCount?: number;
  readonly averageStallMs?: number;
  readonly maxStallMs?: number;
  readonly maxThresholdMs?: number;
  readonly malformedLineCount?: number;
  readonly unsafePayloadLineCount?: number;
  readonly nonTaskHealthLineCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly lastObservedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorSubagentOperatorEvidenceReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly reportStatus?: SubagentOperatorEvidenceReportStatus;
  readonly recordCount?: number;
  readonly spawnedCount?: number;
  readonly completedCount?: number;
  readonly abortedCount?: number;
  readonly failedCount?: number;
  readonly progressCount?: number;
  readonly terminalCount?: number;
  readonly subagentScopedRecordCount?: number;
  readonly parentTaskScopedRecordCount?: number;
  readonly parentRuntimeScopedRecordCount?: number;
  readonly currentActiveSubagentCount?: number;
  readonly duplicateSpawnCount?: number;
  readonly terminalWithoutSpawnCount?: number;
  readonly filterApplied?: boolean;
  readonly transitionCountsFiltered?: boolean;
  readonly malformedLineCount?: number;
  readonly unsafePayloadLineCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly lastObservedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorSessionBindingEvidenceReportStatus {
  readonly ledgerPath: string;
  readonly maxLedgerBytes: number;
  readonly reportStatus?: SessionBindingEvidenceReportStatus;
  readonly recordCount?: number;
  readonly bindingCreatedCount?: number;
  readonly bindingReleasedCount?: number;
  readonly focusChangedCount?: number;
  readonly bindingExpiredCount?: number;
  readonly bindingEvictedCount?: number;
  readonly steeringSubmittedCount?: number;
  readonly terminalTransitionCount?: number;
  readonly bindingScopedRecordCount?: number;
  readonly taskScopedRecordCount?: number;
  readonly ownerAttributedRecordCount?: number;
  readonly channelScopedRecordCount?: number;
  readonly threadScopedRecordCount?: number;
  readonly subagentScopedRecordCount?: number;
  readonly currentActiveBindingCount?: number;
  readonly duplicateCreateCount?: number;
  readonly terminalWithoutCreateCount?: number;
  readonly steeringWithoutActiveBindingCount?: number;
  readonly filterApplied?: boolean;
  readonly transitionCountsFiltered?: boolean;
  readonly malformedLineCount?: number;
  readonly unsafePayloadLineCount?: number;
  readonly nonSessionBindingLineCount?: number;
  readonly qualityScore?: number;
  readonly qualityScoreMax?: number;
  readonly lastObservedAt?: string;
  readonly recommendation?: string;
  readonly error?: string;
}

export interface DoctorReportInput {
  readonly ledgerEnabled: boolean;
  readonly accessPolicyEnabled: boolean;
  readonly authDatabaseEnabled?: boolean;
  readonly runtimeProviderScope: 'codex-sdk-only' | 'multi-provider' | 'unknown';
  readonly activeRuntimeProvider?: 'codex' | 'claude-agent';
  readonly computeMode?: string;
  readonly apptainerImage?: string;
  readonly agentInstanceEntry?: string;
  readonly modelOverride?: string;
  readonly messageContentIntent?: boolean;
  readonly approvalRegistryEnabled?: boolean;
  readonly executionApprovalPolicy?: 'single-use' | 'unsafe-disabled' | 'unknown';
  readonly toolLoopDetectorEnabled?: boolean;
  readonly taskHealthObserverEnabled?: boolean;
  readonly inFlightProblems?: ReadonlyArray<{
    readonly taskId: string;
    readonly kind: 'stall';
    readonly observedAt: string;
    readonly lastProgressAt: string;
    readonly thresholdMs: number;
  }>;
  readonly subagentMaxSpawnDepth?: number;
  /**
   * Operator shell-hook bridge master gate (`AUTO_ARCHIVE_SHELL_HOOKS`).
   * Only the exact value `on` enables hook registration.
   */
  readonly shellHooksMode?: 'on' | 'off' | 'unknown';
  /**
   * Non-interactive shell-hook consent env (`AUTO_ARCHIVE_ACCEPT_HOOKS`).
   * Only the exact value `1` is accepted; any other set value is ignored.
   */
  readonly shellHookAcceptMode?: 'literal-1' | 'invalid-set' | 'unset' | 'unknown';
  readonly gitLabEnabled?: boolean;
  readonly gitLabTokenConfigured?: boolean;
  readonly gitLabArtifactPublicationEnabled?: boolean;
  readonly codexAuthPath?: string;
  readonly codexAuthConfigured?: boolean;
  readonly anthropicAuthSource?: 'api-key' | 'claude-cli' | 'none';
  readonly anthropicCliPath?: string;
  readonly claudeModelOverride?: string;
  readonly planaAdvisorProvider?: 'claude-agent' | 'codex' | 'none';
  readonly planaAdvisorModel?: string;
  readonly planaAdvisorMaxCalls?: number;
  readonly agentHarnessRegistry?: DoctorAgentHarnessRegistryStatus;
  readonly autonomousResearchTraitRuntime?: DoctorAutonomousResearchTraitRuntimeStatus;
  readonly autonomousResearchEvidence?: DoctorAutonomousResearchEvidenceStatus;
  readonly runtimeProviderEvidence?: DoctorRuntimeProviderEvidenceStatus;
  readonly liveProofReport?: DoctorLiveProofReportStatus;
  readonly peekabooEvidenceReport?: DoctorPeekabooEvidenceReportStatus;
  readonly personaTelemetryReport?: DoctorPersonaTelemetryReportStatus;
  readonly claudeOffloadReport?: DoctorClaudeOffloadReportStatus;
  readonly taskHealthEvidenceReport?: DoctorTaskHealthEvidenceReportStatus;
  readonly taskArchiveEvidenceReport?: DoctorTaskArchiveEvidenceReportStatus;
  readonly subagentOperatorEvidenceReport?: DoctorSubagentOperatorEvidenceReportStatus;
  readonly sessionBindingEvidenceReport?: DoctorSessionBindingEvidenceReportStatus;
  readonly controlPlaneOtelLogs?: DoctorControlPlaneOtelLogsStatus;
  readonly planaAdvisorEvents?: DoctorPlanaAdvisorEventsStatus;
  readonly traitSchedulerTickEvidence?: DoctorTraitSchedulerTickEvidenceStatus;
  /**
   * PR5 — `'rate-throttle'` chokepoint enablement state. `true` iff at
   * least one provider has a finite cap (i.e. at least one
   * `AUTO_ARCHIVE_*_MAX_INFLIGHT` is a non-negative integer). When
   * undefined, the section is omitted entirely (pre-PR5 doctor output
   * preserved bit-for-bit on systems that have not enabled throttling).
   */
  readonly rateThrottleEnabled?: boolean;
  /**
   * PR5 — provider-by-provider live snapshot. Source of truth is the
   * runtime `RateThrottlePort.snapshot()` when wired; the
   * `buildDoctorReportFromEnv` helper derives a static config-only
   * snapshot (inflight=0) for env-only diagnostics.
   */
  readonly rateThrottleSnapshot?: ReadonlyArray<RateThrottleSnapshot>;
  readonly redactionProbe?: string;
  readonly generatedAt?: string;
  /**
   * TLS CA certificate preflight — value of SSL_CERT_FILE env var, if set.
   * Presence check (`sslCertFilePresent`) is resolved by `buildDoctorReportFromEnv`.
   */
  readonly sslCertFile?: string;
  /**
   * TLS CA certificate preflight — value of CODEX_CA_CERTIFICATE env var, if set.
   * Presence check (`codexCaCertificatePresent`) is resolved by `buildDoctorReportFromEnv`.
   */
  readonly codexCaCertificate?: string;
  /**
   * `true` iff `sslCertFile` points to an existing regular file (isFile).
   * `false` if the path was set but stat threw or the entry is not a regular file.
   * Undefined (treat as unset) when `sslCertFile` is not provided.
   */
  readonly sslCertFilePresent?: boolean;
  /**
   * `true` iff `codexCaCertificate` points to an existing regular file (isFile).
   * `false` if the path was set but stat threw or the entry is not a regular file.
   * Undefined (treat as unset) when `codexCaCertificate` is not provided.
   */
  readonly codexCaCertificatePresent?: boolean;
}

export function resolveShellHookDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<DoctorReportInput, 'shellHooksMode' | 'shellHookAcceptMode'> {
  return {
    shellHooksMode: env['AUTO_ARCHIVE_SHELL_HOOKS'] === 'on' ? 'on' : 'off',
    shellHookAcceptMode:
      env['AUTO_ARCHIVE_ACCEPT_HOOKS'] === undefined ||
      env['AUTO_ARCHIVE_ACCEPT_HOOKS'] === ''
        ? 'unset'
        : env['AUTO_ARCHIVE_ACCEPT_HOOKS'] === '1'
          ? 'literal-1'
          : 'invalid-set',
  };
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function redactedPathSummary(path: string | undefined): string {
  if (path === undefined || path.trim().length === 0) {
    return 'unset';
  }
  return `${basename(path)}#${shortHash(path)}`;
}

function redactedEndpointSummary(url: string | undefined): string {
  if (url === undefined || url.trim().length === 0) {
    return 'unset';
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol.replace(/:$/u, '')}#${shortHash(url)}`;
  } catch {
    return `invalid-url#${shortHash(url)}`;
  }
}

function parseOtelResourceAttributeSummary(rawValue: string | undefined): {
  readonly customResourceAttributeCount: number;
  readonly invalidResourceAttributeCount: number;
} {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return {
      customResourceAttributeCount: 0,
      invalidResourceAttributeCount: 0,
    };
  }
  let customResourceAttributeCount = 0;
  let invalidResourceAttributeCount = 0;
  for (const pair of rawValue.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      invalidResourceAttributeCount += 1;
      continue;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      invalidResourceAttributeCount += 1;
      continue;
    }
    customResourceAttributeCount += 1;
  }
  return {
    customResourceAttributeCount,
    invalidResourceAttributeCount,
  };
}

function parseOptionalPositiveSafeIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

export function resolveTraitSchedulerTickEvidenceDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorTraitSchedulerTickEvidenceStatus | undefined {
  const ledgerPath =
    env[AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes =
    TRAIT_SCHEDULER_TICK_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const replay = new JsonlTraitSchedulerTickEvidenceLedger(
      ledgerPath,
    ).loadWithAudit({ maxBytes: maxLedgerBytes });
    const report = buildTraitSchedulerTickEvidenceReport({
      records: replay.records,
      replayAudit: replay.replayAudit,
    });
    const scorecard = report.scorecard;
    return {
      ledgerPath,
      maxLedgerBytes,
      recordCount: scorecard.recordCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      sufficientForTrend: scorecard.confidence.sufficientForTrend,
      dispatchFailedCount: scorecard.dispatchTotals.failed,
      checkpointHoldCount: scorecard.checkpointCounts.hold,
      leaseHeldSkipCount: scorecard.leaseCounts.held,
      malformedLineCount: replay.replayAudit.skippedMalformedLineCount,
      ...(scorecard.recency.lastRecordedAt === undefined
        ? {}
        : { lastRecordedAt: scorecard.recency.lastRecordedAt }),
      recommendation: report.scorecard.recommendations[0],
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolvePlanaAdvisorEventsDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorPlanaAdvisorEventsStatus | undefined {
  const ledgerPath =
    env[AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes = PLANA_ADVISOR_EVENTS_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const replay = new JsonlPlanaClaudeAdvisorAuditLedger(
      ledgerPath,
    ).loadWithAudit({ maxBytes: maxLedgerBytes });
    const report = buildPlanaClaudeAdvisorAuditReport({
      records: replay.records,
      replayAudit: replay.replayAudit,
    });
    const scorecard = report.scorecard;
    return {
      ledgerPath,
      maxLedgerBytes,
      recordCount: scorecard.recordCount,
      sufficientForTrend: scorecard.confidence.sufficientForTrend,
      vetoCount: scorecard.verdictCounts.veto,
      advisorErrorFailOpenCount:
        scorecard.consultationCounts.advisorErrorFailOpen,
      malformedLineCount: replay.replayAudit.skippedMalformedLineCount,
      ...(scorecard.recency.lastRecordedAt === undefined
        ? {}
        : { lastRecordedAt: scorecard.recency.lastRecordedAt }),
      recommendation: report.scorecard.recommendations[0],
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolveAgentHarnessRegistryDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorAgentHarnessRegistryStatus | undefined {
  const descriptorPath =
    env[AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH]?.trim();
  if (descriptorPath === undefined || descriptorPath.length === 0) {
    return undefined;
  }

  let maxDescriptorBytes =
    AGENT_HARNESS_REGISTRY_DOCTOR_DEFAULT_MAX_DESCRIPTOR_BYTES;
  const provider =
    env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim() === 'claude-agent'
      ? 'claude-agent'
      : 'codex';
  const source: AgentHarnessSelectionSource = 'eager';
  try {
    maxDescriptorBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES,
      maxDescriptorBytes,
    );
    const report = buildAgentHarnessRegistryReportFromCliOptions({
      descriptorPath,
      provider,
      source,
      maxDescriptorBytes,
      pretty: false,
      printTemplate: false,
    });
    const recommendation = report.recommendations[0];
    return {
      descriptorPath,
      maxDescriptorBytes,
      provider,
      source,
      registryStatus: report.status,
      pluginCount: report.pluginCount,
      supportedPluginCount: report.entries.filter((entry) => entry.supported)
        .length,
      configurationErrorCount: report.configurationErrors.length,
      ...(report.selected === null
        ? {}
        : {
            selectedPluginId: report.selected.pluginId,
            selectedPriority: report.selected.priority,
          }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      descriptorPath,
      maxDescriptorBytes,
      provider,
      source,
      error: redactedDoctorErrorMessage(error, descriptorPath),
    };
  }
}

export function resolveControlPlaneOtelLogsDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorControlPlaneOtelLogsStatus | undefined {
  const endpointUrl = env[AUTO_ARCHIVE_OTEL_LOGS_URL]?.trim();
  if (endpointUrl === undefined || endpointUrl.length === 0) {
    return undefined;
  }
  // These keys are fixed doctor-known defaults, not operator-provided labels.
  // Custom OTLP resource attribute keys/values stay count-only in /doctor.
  const defaultResourceAttributes = [
    'service.name',
    'service.namespace',
  ] as const;
  const resourceAttributeSummary = parseOtelResourceAttributeSummary(
    env[AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES],
  );
  const baseStatus = {
    endpointUrl,
    defaultResourceAttributes,
    exportTimeoutMs: 2_000,
    ...resourceAttributeSummary,
    resourceAttributeCount:
      defaultResourceAttributes.length +
      resourceAttributeSummary.customResourceAttributeCount,
  } as const;
  try {
    const parsed = new URL(endpointUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `${AUTO_ARCHIVE_OTEL_LOGS_URL} must be an http(s) URL when provided.`,
      );
    }
    return {
      ...baseStatus,
      protocol: parsed.protocol,
      ...(resourceAttributeSummary.invalidResourceAttributeCount > 0
        ? {
            recommendation: `Fix ${String(
              resourceAttributeSummary.invalidResourceAttributeCount,
            )} invalid ${AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES} key=value pair(s); they are ignored by the exporter.`,
          }
        : {}),
    };
  } catch (error) {
    return {
      ...baseStatus,
      error: redactedDoctorErrorMessage(error, endpointUrl),
    };
  }
}

export function resolveAutonomousResearchTraitRuntimeDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorAutonomousResearchTraitRuntimeStatus {
  const profile = AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0];
  try {
    const mode = resolveAutonomousResearchTraitRuntimeDecorationMode(env);
    return {
      envVar: AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION,
      mode,
      ...(mode === 'bounded-evidence'
        ? {
            selectedTraitId: profile.traitId,
            selectedProfileId: profile.id,
          }
        : {}),
      runtimeHook: AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime.hook,
      runtimeEnforcement:
        AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime.enforcement,
    };
  } catch (error) {
    return {
      envVar: AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION,
      runtimeHook: AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime.hook,
      runtimeEnforcement:
        AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime.enforcement,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveAutonomousResearchEvidenceDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorAutonomousResearchEvidenceStatus | undefined {
  const evidencePath =
    env[AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH]?.trim();
  if (evidencePath === undefined || evidencePath.length === 0) {
    return undefined;
  }

  let maxEvidenceBytes =
    AUTONOMOUS_RESEARCH_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES;
  try {
    maxEvidenceBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES,
      maxEvidenceBytes,
    );
    const report = buildAutonomousResearchEvidenceReportFromCliOptions({
      evidencePaths: [evidencePath],
      maxEvidenceBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      evidencePath,
      maxEvidenceBytes,
      reportStatus: report.status,
      evidenceRecordCount: scorecard.evidenceRecordCount,
      autonomousTaskCount: scorecard.autonomousTaskCount,
      completeTaskCount: scorecard.taskStatusCounts.complete,
      delegateErrorTaskCount: scorecard.taskStatusCounts['delegate-error'],
      incompleteTaskCount: scorecard.taskStatusCounts.incomplete,
      notRequestedTaskCount: scorecard.taskStatusCounts['not-requested'],
      startCheckpointCount:
        scorecard.checkpointCounts['runtime-decoration-start'],
      completeCheckpointCount:
        scorecard.checkpointCounts['runtime-decoration-complete'],
      errorCheckpointCount:
        scorecard.checkpointCounts['runtime-decoration-error'],
      criteriaComplete: scorecard.criteriaCoverage.complete,
      missingCriteriaCount: scorecard.criteriaCoverage.missing.length,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(scorecard.recency.lastCheckpointAt === undefined
        ? {}
        : { lastCheckpointAt: scorecard.recency.lastCheckpointAt }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      evidencePath,
      maxEvidenceBytes,
      error: redactedDoctorErrorMessage(error, evidencePath),
    };
  }
}

export function resolveRuntimeProviderEvidenceDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorRuntimeProviderEvidenceStatus | undefined {
  const evidencePath = env[AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH]?.trim();
  if (evidencePath === undefined || evidencePath.length === 0) {
    return undefined;
  }

  const provider: RuntimeProviderEvidenceProvider =
    env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim() === 'claude-agent'
      ? 'claude-agent'
      : 'codex';
  let maxEvidenceBytes = RUNTIME_PROVIDER_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES;
  try {
    maxEvidenceBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES,
      maxEvidenceBytes,
    );
    const report = buildRuntimeProviderEvidenceReportFromCliOptions({
      evidencePaths: [evidencePath],
      providers: [provider],
      maxEvidenceBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      evidencePath,
      maxEvidenceBytes,
      provider,
      reportStatus: report.status,
      evidenceRecordCount: scorecard.evidenceRecordCount,
      selectedProviderRecordCount: scorecard.selectedProviderRecordCount,
      successfulProviderRecordCount: scorecard.successfulProviderRecordCount,
      failedProviderRecordCount: scorecard.failedProviderRecordCount,
      providerProvenanceMatchedCount:
        scorecard.providerProvenanceMatchedCount,
      transcriptEventCount: scorecard.transcriptEventCount,
      totalTokens: scorecard.usage.totalTokens,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(scorecard.recency.lastEndedAt === undefined
        ? {}
        : { lastEndedAt: scorecard.recency.lastEndedAt }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      evidencePath,
      maxEvidenceBytes,
      provider,
      error: redactedDoctorErrorMessage(error, evidencePath),
    };
  }
}

export function resolveLiveProofReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorLiveProofReportStatus | undefined {
  const proofPath = env[AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH]?.trim();
  if (proofPath === undefined || proofPath.length === 0) {
    return undefined;
  }

  let maxProofBytes = LIVE_PROOF_DOCTOR_DEFAULT_MAX_BYTES;
  try {
    maxProofBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES,
      maxProofBytes,
    );
    const report = buildLiveProofReportFromCliOptions({
      proofPaths: [proofPath],
      surfaces: [],
      maxProofBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      proofPath,
      maxProofBytes,
      reportStatus: report.status,
      proofRecordCount: scorecard.recordCount,
      completeProofCount: scorecard.completeProofCount,
      warnProofCount: scorecard.warnProofCount,
      failProofCount: scorecard.failProofCount,
      operatorApprovedCount: scorecard.operatorApprovedCount,
      unsafeBoundaryCount: scorecard.unsafeBoundaryCount,
      missingRequiredArtifactCount: scorecard.missingRequiredArtifactCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      proofPath,
      maxProofBytes,
      error: redactedDoctorErrorMessage(error, proofPath),
    };
  }
}

export function resolvePeekabooEvidenceReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorPeekabooEvidenceReportStatus | undefined {
  const ledgerPath = env[AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes = PEEKABOO_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildPeekabooEvidenceReportFromCliOptions({
      ledgerPath,
      filter: {},
      maxLedgerBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      ledgerPath,
      maxLedgerBytes,
      recordCount: scorecard.recordCount,
      liveRecordCount: scorecard.confidence.liveSampleSize,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      sufficientForPromotion: scorecard.confidence.sufficientForPromotion,
      liveOkCount: scorecard.readiness.liveOk.numerator,
      liveOkTotal: scorecard.readiness.liveOk.denominator,
      matchedReplyObservedCount:
        scorecard.readiness.matchedReplyObserved.numerator,
      matchedReplyObservedTotal:
        scorecard.readiness.matchedReplyObserved.denominator,
      strongCorrelationCount: scorecard.evidence.strongCorrelation.numerator,
      strongCorrelationTotal: scorecard.evidence.strongCorrelation.denominator,
      passOutcomeCount: scorecard.outcomeCounts.pass,
      malformedLineCount: report.replayAudit?.skippedMalformedLineCount ?? 0,
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolvePersonaTelemetryReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorPersonaTelemetryReportStatus | undefined {
  const ledgerPath = env[AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes = PERSONA_TELEMETRY_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildPersonaTelemetryReportFromCliOptions({
      ledgerPath,
      filter: {},
      maxLedgerBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      ledgerPath,
      maxLedgerBytes,
      reportStatus: report.status,
      recordCount: scorecard.recordCount,
      successCount: scorecard.successCount,
      fallbackCount: scorecard.fallbackCount,
      latencyBudgetSampleCount: scorecard.latencyBudgetSampleCount,
      withinLatencyBudgetCount: scorecard.withinLatencyBudgetCount,
      humanReviewedNoSourceDialogueCopyCount:
        scorecard.humanReviewedNoSourceDialogueCopyCount,
      averageDurationMs: scorecard.averageDurationMs,
      totalTokens: scorecard.totalTokens,
      malformedLineCount: report.replayAudit.skippedMalformedLineCount,
      unsafeRawContentLineCount: report.replayAudit.unsafeRawContentLineCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}


export function resolveClaudeOffloadReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorClaudeOffloadReportStatus | undefined {
  const ledgerPath = env[AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes = CLAUDE_OFFLOAD_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildClaudeOffloadReportFromCliOptions({
      ledgerPaths: [ledgerPath],
      maxBytes: maxLedgerBytes,
      pretty: false,
    });
    const file = report.source.files[0];
    const scorecard = report.scorecard;
    return {
      ledgerPath,
      maxLedgerBytes,
      recordCount: scorecard.recordCount,
      statusCounts: scorecard.statusCounts,
      errorCategoryCounts: scorecard.errorCategoryCounts,
      purposeCounts: scorecard.purposeCounts,
      totalBlockingGaps: scorecard.totalBlockingGaps,
      totalMemoryCandidates: scorecard.totalMemoryCandidates,
      skippedMalformedLineCount: file?.skippedMalformedLineCount ?? 0,
      skippedUnsafeLineCount: file?.skippedUnsafeLineCount ?? 0,
      ...(scorecard.recency.firstRecordedAt === undefined
        ? {}
        : { firstRecordedAt: scorecard.recency.firstRecordedAt }),
      ...(scorecard.recency.lastRecordedAt === undefined
        ? {}
        : { lastRecordedAt: scorecard.recency.lastRecordedAt }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolveTaskArchiveEvidenceReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorTaskArchiveEvidenceReportStatus | undefined {
  const ledgerPath = env[AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes = TASK_ARCHIVE_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildTaskArchiveEvidenceReportFromCliOptions({
      ledgerPath,
      filter: {},
      maxLedgerBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      ledgerPath,
      maxLedgerBytes,
      reportStatus: report.status,
      recordCount: scorecard.recordCount,
      archiveRecordCount: scorecard.archiveRecordCount,
      unarchiveRecordCount: scorecard.unarchiveRecordCount,
      archiveEventCount: scorecard.archiveEventCount,
      unarchiveEventCount: scorecard.unarchiveEventCount,
      taskScopedRecordCount: scorecard.taskScopedRecordCount,
      actorScopedRecordCount: scorecard.actorScopedRecordCount,
      actorAttributedRecordCount: scorecard.actorAttributedRecordCount,
      channelScopedRecordCount: scorecard.channelScopedRecordCount,
      reasonPresentCount: scorecard.reasonPresentCount,
      currentArchivedTaskCount: scorecard.currentArchivedTaskCount,
      duplicateArchiveCount: scorecard.duplicateArchiveCount,
      unmatchedUnarchiveCount: scorecard.unmatchedUnarchiveCount,
      filterApplied: scorecard.filterApplied,
      transitionCountsFiltered: scorecard.transitionCountsFiltered,
      retainedRecordCount: scorecard.retainedRecordCount,
      malformedLineCount: report.replayAudit.skippedMalformedLineCount,
      unsafePayloadLineCount: report.replayAudit.unsafePayloadLineCount,
      nonTaskArchiveLineCount: report.replayAudit.skippedNonTaskArchiveLineCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(scorecard.lastActionAt === undefined
        ? {}
        : { lastActionAt: scorecard.lastActionAt }),
      ...(scorecard.lastObservedAt === undefined
        ? {}
        : { lastObservedAt: scorecard.lastObservedAt }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolveSubagentOperatorEvidenceReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorSubagentOperatorEvidenceReportStatus | undefined {
  const ledgerPath =
    env[AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes =
    SUBAGENT_OPERATOR_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildSubagentOperatorEvidenceReportFromCliOptions({
      ledgerPath,
      filter: {},
      maxLedgerBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      ledgerPath,
      maxLedgerBytes,
      reportStatus: report.status,
      recordCount: scorecard.recordCount,
      spawnedCount: scorecard.spawnedCount,
      completedCount: scorecard.completedCount,
      abortedCount: scorecard.abortedCount,
      failedCount: scorecard.failedCount,
      progressCount: scorecard.progressCount,
      terminalCount: scorecard.terminalCount,
      subagentScopedRecordCount: scorecard.subagentScopedRecordCount,
      parentTaskScopedRecordCount: scorecard.parentTaskScopedRecordCount,
      parentRuntimeScopedRecordCount:
        scorecard.parentRuntimeScopedRecordCount,
      currentActiveSubagentCount: scorecard.currentActiveSubagentCount,
      duplicateSpawnCount: scorecard.duplicateSpawnCount,
      terminalWithoutSpawnCount: scorecard.terminalWithoutSpawnCount,
      filterApplied: scorecard.filterApplied,
      transitionCountsFiltered: scorecard.transitionCountsFiltered,
      malformedLineCount: report.replayAudit.skippedMalformedLineCount,
      unsafePayloadLineCount: report.replayAudit.unsafePayloadLineCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(scorecard.lastObservedAt === undefined
        ? {}
        : { lastObservedAt: scorecard.lastObservedAt }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolveSessionBindingEvidenceReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorSessionBindingEvidenceReportStatus | undefined {
  const ledgerPath = env[AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes =
    SESSION_BINDING_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildSessionBindingEvidenceReportFromCliOptions({
      ledgerPath,
      filter: {},
      maxLedgerBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      ledgerPath,
      maxLedgerBytes,
      reportStatus: report.status,
      recordCount: scorecard.recordCount,
      bindingCreatedCount: scorecard.bindingCreatedCount,
      bindingReleasedCount: scorecard.bindingReleasedCount,
      focusChangedCount: scorecard.focusChangedCount,
      bindingExpiredCount: scorecard.bindingExpiredCount,
      bindingEvictedCount: scorecard.bindingEvictedCount,
      steeringSubmittedCount: scorecard.steeringSubmittedCount,
      terminalTransitionCount: scorecard.terminalTransitionCount,
      bindingScopedRecordCount: scorecard.bindingScopedRecordCount,
      taskScopedRecordCount: scorecard.taskScopedRecordCount,
      ownerAttributedRecordCount: scorecard.ownerAttributedRecordCount,
      channelScopedRecordCount: scorecard.channelScopedRecordCount,
      threadScopedRecordCount: scorecard.threadScopedRecordCount,
      subagentScopedRecordCount: scorecard.subagentScopedRecordCount,
      currentActiveBindingCount: scorecard.currentActiveBindingCount,
      duplicateCreateCount: scorecard.duplicateCreateCount,
      terminalWithoutCreateCount: scorecard.terminalWithoutCreateCount,
      steeringWithoutActiveBindingCount:
        scorecard.steeringWithoutActiveBindingCount,
      filterApplied: scorecard.filterApplied,
      transitionCountsFiltered: scorecard.transitionCountsFiltered,
      malformedLineCount: report.replayAudit.skippedMalformedLineCount,
      unsafePayloadLineCount: report.replayAudit.unsafePayloadLineCount,
      nonSessionBindingLineCount:
        report.replayAudit.skippedNonSessionBindingLineCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(scorecard.lastObservedAt === undefined
        ? {}
        : { lastObservedAt: scorecard.lastObservedAt }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

export function resolveTaskHealthEvidenceReportDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoctorTaskHealthEvidenceReportStatus | undefined {
  const ledgerPath = env[AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH]?.trim();
  if (ledgerPath === undefined || ledgerPath.length === 0) {
    return undefined;
  }

  let maxLedgerBytes = TASK_HEALTH_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES;
  try {
    maxLedgerBytes = parseOptionalPositiveSafeIntegerEnv(
      env,
      AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES,
      maxLedgerBytes,
    );
    const report = buildTaskHealthEvidenceReportFromCliOptions({
      ledgerPath,
      filter: {},
      maxLedgerBytes,
      pretty: false,
      printTemplate: false,
    });
    const scorecard = report.scorecard;
    const recommendation = scorecard.recommendations[0];
    return {
      ledgerPath,
      maxLedgerBytes,
      reportStatus: report.status,
      recordCount: scorecard.recordCount,
      taskScopedRecordCount: scorecard.taskScopedRecordCount,
      correlationScopedRecordCount: scorecard.correlationScopedRecordCount,
      averageStallMs: scorecard.averageStallMs,
      maxStallMs: scorecard.maxStallMs,
      maxThresholdMs: scorecard.maxThresholdMs,
      malformedLineCount: report.replayAudit.skippedMalformedLineCount,
      unsafePayloadLineCount: report.replayAudit.unsafePayloadLineCount,
      nonTaskHealthLineCount: report.replayAudit.skippedNonTaskHealthLineCount,
      qualityScore: scorecard.qualityScore.value,
      qualityScoreMax: scorecard.qualityScore.max,
      ...(scorecard.lastObservedAt === undefined
        ? {}
        : { lastObservedAt: scorecard.lastObservedAt }),
      ...(recommendation === undefined ? {} : { recommendation }),
    };
  } catch (error) {
    return {
      ledgerPath,
      maxLedgerBytes,
      error: redactedDoctorErrorMessage(error, ledgerPath),
    };
  }
}

function redactedDoctorErrorMessage(error: unknown, sensitivePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(sensitivePath).join(redactedPathSummary(sensitivePath));
}

function section(name: string, status: DoctorSectionStatus, details: readonly string[], remediation?: string): DoctorSection {
  return { name, status, details, ...(remediation === undefined ? {} : { remediation }) };
}

export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const sections: DoctorSection[] = [];
  sections.push(
    section('Service readiness', input.ledgerEnabled ? 'pass' : 'warn', [
      `Ledger: ${input.ledgerEnabled ? 'enabled' : 'disabled'}`,
      `Message Content Intent: ${input.messageContentIntent === true ? 'enabled' : 'disabled/unknown'}`,
    ], input.ledgerEnabled ? undefined : 'Enable AUTO_ARCHIVE_CONTROL_LEDGER_PATH for replayable operations.'),
  );
  if (input.controlPlaneOtelLogs !== undefined) {
    const otel = input.controlPlaneOtelLogs;
    const hasError = otel.error !== undefined;
    const hasInvalidAttributes =
      (otel.invalidResourceAttributeCount ?? 0) > 0;
    sections.push(
      section(
        'Control-plane OTLP logs',
        hasError || hasInvalidAttributes ? 'warn' : 'pass',
        [
          `Endpoint: ${redactedEndpointSummary(otel.endpointUrl)}`,
          `Protocol: ${otel.protocol ?? 'invalid'}`,
          `Resource attributes: ${otel.resourceAttributeCount ?? 0} (${otel.customResourceAttributeCount ?? 0} custom, ${otel.invalidResourceAttributeCount ?? 0} invalid)`,
          `Default resource attributes: ${otel.defaultResourceAttributes.join(', ')}`,
          `Export timeout: ${otel.exportTimeoutMs}ms`,
          'Configuration check: valid; no export attempted',
          'Observer mode: fail-open after ledger append',
          'Payload boundary: safe control-plane metadata only',
          ...(hasError ? [`Configuration error: ${otel.error}`] : []),
        ],
        hasError
          ? `Set ${AUTO_ARCHIVE_OTEL_LOGS_URL} to an http(s) OTLP /v1/logs endpoint or unset it to keep the observer off; /doctor never contacts the collector.`
          : hasInvalidAttributes
            ? otel.recommendation
            : undefined,
      ),
    );
  }
  sections.push(
    section(
      'Discord auth/access policy',
      input.accessPolicyEnabled && input.authDatabaseEnabled === true ? 'pass' : 'warn',
      [
        `Access policy: ${input.accessPolicyEnabled ? 'enabled' : 'disabled'}`,
        `Auth database: ${input.authDatabaseEnabled === true ? 'enabled' : 'disabled'}`,
      ],
      input.authDatabaseEnabled === true ? undefined : 'Configure AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH or memory auth for explicit access state.',
    ),
  );
  const computeModeLabel = input.computeMode ?? 'default';
  const slurmApptainerActive =
    computeModeLabel === 'default' ||
    computeModeLabel === '' ||
    computeModeLabel === 'slurm-apptainer';
  const sandboxStatus: DoctorSectionStatus = slurmApptainerActive
    ? input.apptainerImage && input.apptainerImage.length > 0 &&
      input.agentInstanceEntry && input.agentInstanceEntry.length > 0
      ? 'pass'
      : 'warn'
    : 'warn';
  const providerLabel =
    input.runtimeProviderScope === 'codex-sdk-only'
      ? 'Codex SDK only'
      : input.runtimeProviderScope === 'multi-provider'
        ? `Multi-provider (Codex + Claude Agent); active: ${input.activeRuntimeProvider ?? 'codex'}`
        : 'unknown';
  sections.push(
    section(
      'Runtime provider scope',
      sandboxStatus,
      [
        `Provider: ${providerLabel}`,
        `Compute mode: ${computeModeLabel}`,
        `Apptainer image: ${input.apptainerImage && input.apptainerImage.length > 0 ? input.apptainerImage : 'unset'}`,
        `Agent-instance entry: ${input.agentInstanceEntry && input.agentInstanceEntry.length > 0 ? input.agentInstanceEntry : 'unset'}`,
      ],
      slurmApptainerActive
        ? sandboxStatus === 'pass'
          ? undefined
          : 'Set AUTO_ARCHIVE_APPTAINER_IMAGE and AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY so dispatch executes inside the apptainer sandbox.'
        : 'Production policy requires slurm-apptainer compute mode (sandboxed dispatch). Unset AUTO_ARCHIVE_COMPUTE_NODE for production runs.',
    ),
  );
  sections.push(
    section(
      'Codex auth mount / model override',
      input.codexAuthConfigured === false ? 'warn' : 'pass',
      [
        `Auth path: ${redactedPathSummary(input.codexAuthPath)}`,
        `Local auth configured: ${input.codexAuthConfigured === false ? 'no/unknown' : 'yes/unknown'}`,
        `Model override: ${input.modelOverride ?? 'unset'}`,
      ],
      input.codexAuthConfigured === false ? 'Mount ~/.codex/auth.json or provide AUTO_ARCHIVE_CODEX_API_KEY.' : undefined,
    ),
  );
  if (input.agentHarnessRegistry !== undefined) {
    const registry = input.agentHarnessRegistry;
    const hasError = registry.error !== undefined;
    const registryStatus = registry.registryStatus ?? 'invalid-plugin-configuration';
    const selectedPluginId = registry.selectedPluginId ?? 'none';
    const registrySectionStatus: DoctorSectionStatus =
      hasError || registryStatus !== 'selected' ? 'warn' : 'pass';
    sections.push(
      section(
        'Agent harness registry',
        registrySectionStatus,
        [
          `Descriptor: ${redactedPathSummary(registry.descriptorPath)}`,
          `Max descriptor bytes: ${registry.maxDescriptorBytes}`,
          `Provider: ${registry.provider}`,
          `Selection source: ${registry.source}`,
          ...(hasError
            ? [`Report status: failed (${registry.error})`]
            : [
                `Registry status: ${registryStatus}`,
                `Plugins: ${registry.pluginCount ?? 0}`,
                `Supported plugins: ${registry.supportedPluginCount ?? 0}`,
                `Configuration errors: ${registry.configurationErrorCount ?? 0}`,
                `Selected harness: ${selectedPluginId}`,
                `Selected priority: ${registry.selectedPriority ?? 'n/a'}`,
              ]),
        ],
        hasError
          ? 'Fix the agent harness registry descriptor path or byte guard; /doctor reads descriptor metadata only and never imports plugin code, wraps drivers, or switches providers.'
          : registrySectionStatus === 'warn'
            ? registry.recommendation
            : undefined,
      ),
    );
  }
  if (input.autonomousResearchTraitRuntime !== undefined) {
    const traitRuntime = input.autonomousResearchTraitRuntime;
    const hasError = traitRuntime.error !== undefined;
    sections.push(
      section(
        'Autonomous research TraitModule runtime',
        hasError ? 'warn' : 'pass',
        [
          `Env: ${traitRuntime.envVar}`,
          `Mode: ${hasError ? 'invalid' : traitRuntime.mode ?? 'off'}`,
          `Selected trait: ${traitRuntime.selectedTraitId ?? 'none'}`,
          `Selected profile: ${traitRuntime.selectedProfileId ?? 'none'}`,
          `Runtime hook: ${traitRuntime.runtimeHook}`,
          `Runtime enforcement: ${traitRuntime.runtimeEnforcement}`,
          'Hidden autonomous runner: no',
          ...(hasError ? [`Configuration error: ${traitRuntime.error}`] : []),
        ],
        hasError
          ? `Set ${traitRuntime.envVar}=bounded-evidence to enable evidence-only checkpoints, or unset it to keep the trait runtime decoration off.`
          : undefined,
      ),
    );
  }
  if (input.autonomousResearchEvidence !== undefined) {
    const evidence = input.autonomousResearchEvidence;
    const hasError = evidence.error !== undefined;
    const reportStatus = evidence.reportStatus ?? 'incomplete';
    const evidenceStatus: DoctorSectionStatus =
      hasError || reportStatus !== 'complete' ? 'warn' : 'pass';
    sections.push(
      section(
        'Autonomous research evidence',
        evidenceStatus,
        [
          `Evidence: ${redactedPathSummary(evidence.evidencePath)}`,
          `Max evidence bytes: ${evidence.maxEvidenceBytes}`,
          ...(hasError
            ? [`Report status: failed (${evidence.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Evidence records: ${evidence.evidenceRecordCount ?? 0}`,
                `Autonomous tasks: ${evidence.autonomousTaskCount ?? 0}`,
                `Task status complete/delegate-error/incomplete/not-requested: ${evidence.completeTaskCount ?? 0}/${evidence.delegateErrorTaskCount ?? 0}/${evidence.incompleteTaskCount ?? 0}/${evidence.notRequestedTaskCount ?? 0}`,
                `Checkpoints start/complete/error: ${evidence.startCheckpointCount ?? 0}/${evidence.completeCheckpointCount ?? 0}/${evidence.errorCheckpointCount ?? 0}`,
                `Criteria coverage: ${
                  evidence.criteriaComplete === true ? 'complete' : 'incomplete'
                } (${evidence.missingCriteriaCount ?? 0} missing)`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Last checkpoint at: ${evidence.lastCheckpointAt ?? 'none'}`,
              ]),
        ],
        hasError
          ? 'Fix the autonomous research terminal evidence path or byte guard; /doctor reads TerminalEvidence JSON only and never runs the trait, dispatches tasks, or calls runtime drivers.'
          : evidenceStatus === 'warn'
            ? evidence.recommendation
            : undefined,
      ),
    );
  }
  if (input.runtimeProviderEvidence !== undefined) {
    const evidence = input.runtimeProviderEvidence;
    const hasError = evidence.error !== undefined;
    const reportStatus = evidence.reportStatus ?? 'no-record';
    const evidenceSectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-record'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Runtime provider evidence (retained)',
        evidenceSectionStatus,
        [
          `Evidence: ${redactedPathSummary(evidence.evidencePath)}`,
          `Max evidence bytes: ${evidence.maxEvidenceBytes}`,
          `Provider: ${evidence.provider}`,
          ...(hasError
            ? [`Report status: failed (${evidence.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Evidence records: ${evidence.evidenceRecordCount ?? 0}`,
                `Selected provider records: ${evidence.selectedProviderRecordCount ?? 0}`,
                `Successful provider records: ${evidence.successfulProviderRecordCount ?? 0}`,
                `Failed provider records: ${evidence.failedProviderRecordCount ?? 0}`,
                `Provider provenance matched: ${evidence.providerProvenanceMatchedCount ?? 0}`,
                `Transcript events: ${evidence.transcriptEventCount ?? 0}`,
                `Total tokens: ${evidence.totalTokens ?? 0}`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Last ended at: ${evidence.lastEndedAt ?? 'none'}`,
                'Raw task ids: not rendered',
                'Raw runtime instance ids: not rendered',
                'Raw terminal reasons: not rendered',
                'Raw transcript: not rendered',
                'Provider contact: none',
              ]),
        ],
        hasError
          ? 'Fix the runtime provider TerminalEvidence path or byte guard; /doctor reads retained evidence only and never calls Codex, Claude Agent, or switches providers.'
          : evidenceSectionStatus === 'pass'
            ? undefined
            : evidence.recommendation,
      ),
    );
  }
  if (input.liveProofReport !== undefined) {
    const liveProof = input.liveProofReport;
    const hasError = liveProof.error !== undefined;
    const reportStatus = liveProof.reportStatus ?? 'no-proof';
    const liveProofSectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-proof'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Live proof artifact report',
        liveProofSectionStatus,
        [
          `Manifest: ${redactedPathSummary(liveProof.proofPath)}`,
          `Max proof bytes: ${liveProof.maxProofBytes}`,
          ...(hasError
            ? [`Report status: failed (${liveProof.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Proof records: ${liveProof.proofRecordCount ?? 0}`,
                `Complete proofs: ${liveProof.completeProofCount ?? 0}`,
                `Warn/fail proofs: ${liveProof.warnProofCount ?? 0}/${liveProof.failProofCount ?? 0}`,
                `Operator-approved proofs: ${liveProof.operatorApprovedCount ?? 0}`,
                `Unsafe boundaries: ${liveProof.unsafeBoundaryCount ?? 0}`,
                `Missing artifact tokens: ${liveProof.missingRequiredArtifactCount ?? 0}`,
                `Quality score: ${liveProof.qualityScore ?? 0}/${liveProof.qualityScoreMax ?? 100}`,
                'Raw summaries: not rendered',
                'Raw correlation ids: not rendered',
                'Live service contact: none',
              ]),
        ],
        hasError
          ? 'Fix the live proof manifest path or byte guard; /doctor reads the redacted proof manifest only and never contacts live services.'
          : liveProofSectionStatus === 'pass'
            ? undefined
            : liveProof.recommendation,
      ),
    );
  }
  if (input.peekabooEvidenceReport !== undefined) {
    const evidence = input.peekabooEvidenceReport;
    const hasError = evidence.error !== undefined;
    const recordCount = evidence.recordCount ?? 0;
    const malformedLineCount = evidence.malformedLineCount ?? 0;
    const sufficientForPromotion = evidence.sufficientForPromotion === true;
    const qualityScore = evidence.qualityScore ?? 0;
    const evidenceStatus: DoctorSectionStatus =
      hasError ||
      recordCount === 0 ||
      !sufficientForPromotion ||
      malformedLineCount > 0 ||
      qualityScore < 80
        ? 'warn'
        : 'pass';
    sections.push(
      section(
        'Peekaboo evidence report',
        evidenceStatus,
        [
          `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
          `Max replay bytes: ${evidence.maxLedgerBytes}`,
          ...(hasError
            ? [`Replay status: failed (${evidence.error})`]
            : [
                `Records: ${recordCount}`,
                `Live records: ${evidence.liveRecordCount ?? 0}`,
                `Quality score: ${qualityScore}/${evidence.qualityScoreMax ?? 100}`,
                `Promotion sample: ${
                  sufficientForPromotion ? 'sufficient' : 'insufficient'
                }`,
                `Live OK: ${evidence.liveOkCount ?? 0}/${evidence.liveOkTotal ?? 0}`,
                `Matched replies: ${evidence.matchedReplyObservedCount ?? 0}/${evidence.matchedReplyObservedTotal ?? 0}`,
                `Strong correlations: ${evidence.strongCorrelationCount ?? 0}/${evidence.strongCorrelationTotal ?? 0}`,
                `PASS outcomes: ${evidence.passOutcomeCount ?? 0}`,
                `Malformed/torn lines: ${malformedLineCount}`,
                'Raw notes: not rendered',
                'Raw correlation ids: not rendered',
                'Live service contact: none',
              ]),
        ],
        hasError
          ? 'Fix the Peekaboo evidence ledger path or bounded replay byte guard; /doctor only reads redacted ledger metadata and never submits GUI actions or polls Discord.'
          : evidenceStatus === 'warn'
            ? evidence.recommendation
            : undefined,
      ),
    );
  }
  if (input.claudeOffloadReport !== undefined) {
    const offload = input.claudeOffloadReport;
    const hasError = offload.error !== undefined;
    const recordCount = offload.recordCount ?? 0;
    const okCount = offload.statusCounts?.['offload-route-ok'] ?? 0;
    const warnCount = offload.statusCounts?.['offload-route-warn'] ?? 0;
    const failCount = offload.statusCounts?.['offload-route-fail'] ?? 0;
    const skippedUnsafe = offload.skippedUnsafeLineCount ?? 0;
    const skippedMalformed = offload.skippedMalformedLineCount ?? 0;
    const offloadStatus: DoctorSectionStatus = hasError
      ? 'warn'
      : failCount > 0 || skippedUnsafe > 0
        ? 'fail'
        : warnCount > 0 || skippedMalformed > 0
          ? 'warn'
          : 'pass';
    sections.push(
      section(
        'Claude token offload report',
        offloadStatus,
        [
          `Ledger: ${redactedPathSummary(offload.ledgerPath)}`,
          `Max replay bytes: ${offload.maxLedgerBytes}`,
          ...(hasError
            ? [`Replay status: failed (${offload.error})`]
            : [
                `Records: ${recordCount}`,
                `Route status: ok=${okCount} warn=${warnCount} fail=${failCount}`,
                `Blocking gaps observed: ${offload.totalBlockingGaps ?? 0}`,
                `Memory candidates observed: ${offload.totalMemoryCandidates ?? 0}`,
                `Malformed/torn lines: ${skippedMalformed}`,
                `Unsafe replay lines: ${skippedUnsafe}`,
                'Decision role: advisory-only',
                'Raw prompts: not rendered',
                'Raw responses: not rendered',
                'Live service contact: none',
              ]),
        ],
        hasError
          ? 'Fix the Claude offload ledger path or bounded replay byte guard; /doctor only reads metadata-only ledger records and never contacts Claude.'
          : offloadStatus === 'fail'
            ? 'Investigate offload-route-fail or unsafe replay lines; offload results are advisory-only and must not satisfy live-proof gates.'
            : offloadStatus === 'warn'
              ? 'Review offload-route-warn entries; degraded categories include quota/auth/network/timeout/tool-use-degraded.'
              : undefined,
      ),
    );
  }
  if (input.personaTelemetryReport !== undefined) {
    const telemetry = input.personaTelemetryReport;
    const hasError = telemetry.error !== undefined;
    const reportStatus = telemetry.reportStatus ?? 'no-record';
    const telemetrySectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-record'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Persona telemetry report',
        telemetrySectionStatus,
        [
          `Ledger: ${redactedPathSummary(telemetry.ledgerPath)}`,
          `Max replay bytes: ${telemetry.maxLedgerBytes}`,
          ...(hasError
            ? [`Report status: failed (${telemetry.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Records: ${telemetry.recordCount ?? 0}`,
                `Success/fallback: ${telemetry.successCount ?? 0}/${telemetry.fallbackCount ?? 0}`,
                `Within latency budget: ${telemetry.withinLatencyBudgetCount ?? 0}/${telemetry.latencyBudgetSampleCount ?? 0}`,
                `Human no-copy reviews: ${telemetry.humanReviewedNoSourceDialogueCopyCount ?? 0}`,
                `Average duration ms: ${telemetry.averageDurationMs ?? 0}`,
                `Total tokens: ${telemetry.totalTokens ?? 0}`,
                `Malformed/torn lines: ${telemetry.malformedLineCount ?? 0}`,
                `Unsafe raw-content lines: ${telemetry.unsafeRawContentLineCount ?? 0}`,
                `Quality score: ${telemetry.qualityScore ?? 0}/${telemetry.qualityScoreMax ?? 100}`,
                'Raw persona text: not rendered',
                'Task ids: not rendered',
                'Live service contact: none',
              ]),
        ],
        hasError
          ? 'Fix the persona telemetry ledger path or bounded replay byte guard; /doctor only reads redacted telemetry metadata and never calls persona models.'
          : telemetrySectionStatus === 'pass'
            ? undefined
            : telemetry.recommendation,
      ),
    );
  }
  if (input.runtimeProviderScope === 'multi-provider') {
    const claudeActive = input.activeRuntimeProvider === 'claude-agent';
    const anthropicAuthSource = input.anthropicAuthSource ?? 'none';
    const claudeStatus: DoctorSectionStatus =
      claudeActive && anthropicAuthSource === 'none' ? 'fail' : 'pass';
    sections.push(
      section(
        'Anthropic auth / Claude model override',
        claudeStatus,
        [
          `Auth source: ${anthropicAuthSource}`,
          `Claude CLI path: ${redactedPathSummary(input.anthropicCliPath)}`,
          `Model override: ${input.claudeModelOverride ?? 'unset'}`,
          `Active provider: ${input.activeRuntimeProvider ?? 'codex'}`,
        ],
        claudeStatus === 'fail'
          ? 'Set AUTO_ARCHIVE_ANTHROPIC_API_KEY (production) or AUTO_ARCHIVE_CLAUDE_CLI_PATH (single-user dev).'
          : undefined,
      ),
    );
    const advisorProvider = input.planaAdvisorProvider ?? 'none';
    const dispatchProvider = input.activeRuntimeProvider ?? 'codex';
    const advisorRequiresAnthropic =
      advisorProvider === 'claude-agent' && anthropicAuthSource === 'none';
    const advisorStatus: DoctorSectionStatus = advisorRequiresAnthropic
      ? 'fail'
      : 'pass';
    const sameVendor =
      advisorProvider !== 'none' && advisorProvider === dispatchProvider;
    sections.push(
      section(
        'Plana runtime advisor',
        advisorStatus,
        [
          `Advisor provider: ${advisorProvider}`,
          `Dispatched task provider: ${dispatchProvider}`,
          `Cross-vendor: ${
            advisorProvider === 'none' ? 'n/a' : sameVendor ? 'no (same vendor)' : 'yes'
          }`,
          `Advisor model override: ${input.planaAdvisorModel ?? 'unset'}`,
          `Max advisor calls per dispatch: ${input.planaAdvisorMaxCalls ?? 'default'}`,
        ],
        advisorRequiresAnthropic
          ? 'Set AUTO_ARCHIVE_ANTHROPIC_API_KEY or AUTO_ARCHIVE_CLAUDE_CLI_PATH so the claude-agent advisor can authenticate.'
          : sameVendor
            ? 'Cross-vendor review benefit lost: advisor and dispatched task use the same provider. Consider unsetting the advisor or switching one of them.'
            : undefined,
      ),
    );
    if (input.planaAdvisorEvents !== undefined) {
      const evidence = input.planaAdvisorEvents;
      const hasError = evidence.error !== undefined;
      const recordCount = evidence.recordCount ?? 0;
      const malformedLineCount = evidence.malformedLineCount ?? 0;
      const vetoCount = evidence.vetoCount ?? 0;
      const advisorErrorFailOpenCount =
        evidence.advisorErrorFailOpenCount ?? 0;
      const insufficientTrend =
        evidence.sufficientForTrend === undefined
          ? true
          : !evidence.sufficientForTrend;
      const evidenceStatus: DoctorSectionStatus =
        hasError ||
        recordCount === 0 ||
        insufficientTrend ||
        malformedLineCount > 0 ||
        advisorErrorFailOpenCount > 0 ||
        vetoCount > 0
          ? 'warn'
          : 'pass';
      sections.push(
        section(
          'Plana advisor events ledger',
          evidenceStatus,
          [
            `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
            `Max replay bytes: ${evidence.maxLedgerBytes}`,
            ...(hasError
              ? [`Replay status: failed (${evidence.error})`]
              : [
                  `Records: ${recordCount}`,
                  `Trend sample: ${
                    evidence.sufficientForTrend === true
                      ? 'sufficient'
                      : 'insufficient'
                  }`,
                  `Advisor vetoes: ${vetoCount}`,
                  `Advisor fail-open errors: ${advisorErrorFailOpenCount}`,
                  `Malformed/torn lines: ${malformedLineCount}`,
                  `Last recorded at: ${evidence.lastRecordedAt ?? 'none'}`,
                ]),
          ],
          hasError
            ? 'Fix the Plana advisor events ledger path or bounded replay byte guard; /doctor only reads and never repairs the ledger.'
            : evidenceStatus === 'warn'
              ? evidence.recommendation
              : undefined,
        ),
      );
    }
  }
  sections.push(
    section(
      'Approval registry status',
      input.approvalRegistryEnabled === true ? 'pass' : 'warn',
      [`Runtime approval registry: ${input.approvalRegistryEnabled === true ? 'enabled' : 'disabled'}`],
      input.approvalRegistryEnabled === true ? undefined : 'Wire RuntimeApprovalRegistry to Discord approve/deny for live approval resolution.',
    ),
  );
  sections.push(
    section(
      'Execution approval policy',
      input.executionApprovalPolicy === 'single-use' ? 'pass' : 'warn',
      [`Policy: ${input.executionApprovalPolicy ?? 'unknown'}`],
      input.executionApprovalPolicy === 'single-use' ? undefined : 'Use single-use execution approval records; allow-always is unsupported.',
    ),
  );
  sections.push(
    section(
      'Tool-loop detector status',
      input.toolLoopDetectorEnabled === false ? 'warn' : 'pass',
      [`Detector: ${input.toolLoopDetectorEnabled === false ? 'disabled' : 'enabled'}`],
    ),
  );
  if (input.taskHealthObserverEnabled !== undefined) {
    const enabled = input.taskHealthObserverEnabled === true;
    const problems = enabled ? input.inFlightProblems ?? [] : [];
    sections.push(
      section(
        'Task health observer status',
        !enabled || problems.length > 0 ? 'warn' : 'pass',
        [
          `Observer: ${enabled ? 'enabled' : 'disabled'}`,
          ...(problems.length === 0
            ? ['In-flight problems: none']
            : problems.map(
                (problem) =>
                  `${problem.kind}: task=${problem.taskId} lastProgressAt=${problem.lastProgressAt} observedAt=${problem.observedAt} thresholdMs=${problem.thresholdMs}`,
              )),
        ],
        enabled
          ? problems.length > 0
            ? 'Inspect stalled task evidence with /status, /history, /feed, or /escalate.'
            : undefined
          : 'Set AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS after collecting site-specific runtime interval evidence.',
      ),
    );
  }

  if (input.taskArchiveEvidenceReport !== undefined) {
    const evidence = input.taskArchiveEvidenceReport;
    const hasError = evidence.error !== undefined;
    const reportStatus = evidence.reportStatus ?? 'no-record';
    const evidenceSectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-record'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Task archive evidence report (retained)',
        evidenceSectionStatus,
        [
          `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
          `Max replay bytes: ${evidence.maxLedgerBytes}`,
          ...(hasError
            ? [`Report status: failed (${evidence.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Records: ${evidence.recordCount ?? 0}`,
                `Archive records: ${evidence.archiveEventCount ?? evidence.archiveRecordCount ?? 0}`,
                `Unarchive records: ${evidence.unarchiveEventCount ?? evidence.unarchiveRecordCount ?? 0}`,
                `Task-scoped records: ${evidence.taskScopedRecordCount ?? 0}`,
                `Actor-scoped records: ${evidence.actorAttributedRecordCount ?? evidence.actorScopedRecordCount ?? 0}`,
                `Channel-scoped records: ${evidence.channelScopedRecordCount ?? 0}`,
                `Reasons present: ${evidence.reasonPresentCount ?? 0}`,
                `Retained records: ${evidence.retainedRecordCount ?? 0}`,
                `Current archived tasks: ${evidence.currentArchivedTaskCount ?? 0}`,
                `Duplicate archive transitions: ${evidence.duplicateArchiveCount ?? 0}`,
                `Unmatched unarchive transitions: ${evidence.unmatchedUnarchiveCount ?? 0}`,
                `Archive evidence filter applied: ${evidence.filterApplied === true ? 'yes' : 'no'}`,
                `Transition counts filtered: ${evidence.transitionCountsFiltered === true ? 'yes' : 'no'}`,
                `Malformed/torn lines: ${evidence.malformedLineCount ?? 0}`,
                `Unsafe payload lines: ${evidence.unsafePayloadLineCount ?? 0}`,
                `Non-task-archive lines: ${evidence.nonTaskArchiveLineCount ?? 0}`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Last action at: ${evidence.lastActionAt ?? evidence.lastObservedAt ?? 'none'}`,
                'Raw task ids: not rendered',
                'Raw actor ids: not rendered',
                'Raw channel ids: not rendered',
                'Raw reasons: not rendered',
                'Raw payload: not rendered',
                'Live service contact: none',
              ]),
        ],
        hasError
          ? 'Fix the task-archive evidence ledger path or bounded replay byte guard; /doctor only reads retained control-plane metadata and never runs archive mutations.'
          : evidenceSectionStatus === 'pass'
            ? undefined
            : evidence.recommendation,
      ),
    );
  }
  if (input.subagentOperatorEvidenceReport !== undefined) {
    const evidence = input.subagentOperatorEvidenceReport;
    const hasError = evidence.error !== undefined;
    const reportStatus = evidence.reportStatus ?? 'no-record';
    const evidenceSectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-record'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Subagent operator evidence report (retained)',
        evidenceSectionStatus,
        [
          `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
          `Max replay bytes: ${evidence.maxLedgerBytes}`,
          ...(hasError
            ? [`Report status: failed (${evidence.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Records: ${evidence.recordCount ?? 0}`,
                `Spawned events: ${evidence.spawnedCount ?? 0}`,
                `Completed/aborted/failed events: ${evidence.completedCount ?? 0}/${evidence.abortedCount ?? 0}/${evidence.failedCount ?? 0}`,
                `Progress events: ${evidence.progressCount ?? 0}`,
                `Terminal events: ${evidence.terminalCount ?? 0}`,
                `Subagent-scoped records: ${evidence.subagentScopedRecordCount ?? 0}`,
                `Parent task-scoped records: ${evidence.parentTaskScopedRecordCount ?? 0}`,
                `Parent runtime-scoped records: ${evidence.parentRuntimeScopedRecordCount ?? 0}`,
                `Current active subagents: ${evidence.currentActiveSubagentCount ?? 0}`,
                `Duplicate spawn transitions: ${evidence.duplicateSpawnCount ?? 0}`,
                `Terminal-without-spawn transitions: ${evidence.terminalWithoutSpawnCount ?? 0}`,
                `Subagent evidence filter applied: ${evidence.filterApplied === true ? 'yes' : 'no'}`,
                `Transition counts filtered: ${evidence.transitionCountsFiltered === true ? 'yes' : 'no'}`,
                `Malformed/torn lines: ${evidence.malformedLineCount ?? 0}`,
                `Unsafe payload lines: ${evidence.unsafePayloadLineCount ?? 0}`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Last observed at: ${evidence.lastObservedAt ?? 'none'}`,
                'Raw subagent ids: not rendered',
                'Raw task ids: not rendered',
                'Raw runtime instance ids: not rendered',
                'Raw messages: not rendered',
                'Raw artifacts: not rendered',
                'Raw payload: not rendered',
                'Live service contact: none',
                'Roster mutation: none',
                'Ledger mutation: none',
                'Operator actions: none',
                'Env reload: none',
              ]),
        ],
        hasError
          ? 'Fix the subagent-operator evidence ledger path or bounded replay byte guard; /doctor only reads retained roster metadata and never spawns, steers, kills, inspects live subagents, or mutates ledgers.'
          : evidenceSectionStatus === 'pass'
            ? undefined
            : evidence.recommendation,
      ),
    );
  }
  if (input.sessionBindingEvidenceReport !== undefined) {
    const evidence = input.sessionBindingEvidenceReport;
    const hasError = evidence.error !== undefined;
    const reportStatus = evidence.reportStatus ?? 'no-record';
    const evidenceSectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-record'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Session binding evidence report (retained)',
        evidenceSectionStatus,
        [
          `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
          `Max replay bytes: ${evidence.maxLedgerBytes}`,
          ...(hasError
            ? [`Report status: failed (${evidence.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Records: ${evidence.recordCount ?? 0}`,
                `Created/released/focus-changed: ${evidence.bindingCreatedCount ?? 0}/${evidence.bindingReleasedCount ?? 0}/${evidence.focusChangedCount ?? 0}`,
                `Expired/evicted: ${evidence.bindingExpiredCount ?? 0}/${evidence.bindingEvictedCount ?? 0}`,
                `Steering submitted: ${evidence.steeringSubmittedCount ?? 0}`,
                `Terminal transitions: ${evidence.terminalTransitionCount ?? 0}`,
                `Binding-scoped records: ${evidence.bindingScopedRecordCount ?? 0}`,
                `Task-scoped records: ${evidence.taskScopedRecordCount ?? 0}`,
                `Owner-attributed records: ${evidence.ownerAttributedRecordCount ?? 0}`,
                `Channel-scoped records: ${evidence.channelScopedRecordCount ?? 0}`,
                `Thread-scoped records: ${evidence.threadScopedRecordCount ?? 0}`,
                `Subagent-scoped records: ${evidence.subagentScopedRecordCount ?? 0}`,
                `Current active bindings: ${evidence.currentActiveBindingCount ?? 0}`,
                `Duplicate create transitions: ${evidence.duplicateCreateCount ?? 0}`,
                `Terminal-without-create transitions: ${evidence.terminalWithoutCreateCount ?? 0}`,
                `Steering-without-active-binding transitions: ${evidence.steeringWithoutActiveBindingCount ?? 0}`,
                `Session binding evidence filter applied: ${evidence.filterApplied === true ? 'yes' : 'no'}`,
                `Transition counts filtered: ${evidence.transitionCountsFiltered === true ? 'yes' : 'no'}`,
                `Malformed/torn lines: ${evidence.malformedLineCount ?? 0}`,
                `Unsafe payload lines: ${evidence.unsafePayloadLineCount ?? 0}`,
                `Non-session-binding lines: ${evidence.nonSessionBindingLineCount ?? 0}`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Last observed at: ${evidence.lastObservedAt ?? 'none'}`,
                'Raw binding ids: not rendered',
                'Raw task ids: not rendered',
                'Raw owner/user ids: not rendered',
                'Raw guild/channel/thread ids: not rendered',
                'Raw subagent ids: not rendered',
                'Raw instructions: not rendered',
                'Raw payload: not rendered',
                'Live service contact: none',
                'Focus mutation: none',
                'Ledger mutation: none',
                'Operator actions: none',
                'Env reload: none',
              ]),
        ],
        hasError
          ? 'Fix the session-binding evidence ledger path or bounded replay byte guard; /doctor only reads retained binding metadata and never focuses, unfocuses, steers, contacts live services, or mutates ledgers.'
          : evidenceSectionStatus === 'pass'
            ? undefined
            : evidence.recommendation,
      ),
    );
  }
  if (input.taskHealthEvidenceReport !== undefined) {
    const evidence = input.taskHealthEvidenceReport;
    const hasError = evidence.error !== undefined;
    const reportStatus = evidence.reportStatus ?? 'no-record';
    const evidenceSectionStatus: DoctorSectionStatus =
      hasError || reportStatus === 'warn' || reportStatus === 'no-record'
        ? 'warn'
        : reportStatus === 'fail'
          ? 'fail'
          : 'pass';
    sections.push(
      section(
        'Task health evidence report',
        evidenceSectionStatus,
        [
          `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
          `Max replay bytes: ${evidence.maxLedgerBytes}`,
          ...(hasError
            ? [`Report status: failed (${evidence.error})`]
            : [
                `Report status: ${reportStatus}`,
                `Records: ${evidence.recordCount ?? 0}`,
                `Task-scoped records: ${evidence.taskScopedRecordCount ?? 0}`,
                `Correlation-scoped records: ${evidence.correlationScopedRecordCount ?? 0}`,
                `Average stall ms: ${evidence.averageStallMs ?? 0}`,
                `Max stall ms: ${evidence.maxStallMs ?? 0}`,
                `Max threshold ms: ${evidence.maxThresholdMs ?? 0}`,
                `Malformed/torn lines: ${evidence.malformedLineCount ?? 0}`,
                `Unsafe payload lines: ${evidence.unsafePayloadLineCount ?? 0}`,
                `Non-task-health lines: ${evidence.nonTaskHealthLineCount ?? 0}`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Last observed at: ${evidence.lastObservedAt ?? 'none'}`,
                'Raw task ids: not rendered',
                'Raw correlation ids: not rendered',
                'Raw payload: not rendered',
                'Live service contact: none',
              ]),
        ],
        hasError
          ? 'Fix the task-health evidence ledger path or bounded replay byte guard; /doctor only reads retained control-plane metadata and never runs observers.'
          : evidenceSectionStatus === 'pass'
            ? undefined
            : evidence.recommendation,
      ),
    );
  }
  if (input.traitSchedulerTickEvidence !== undefined) {
    const evidence = input.traitSchedulerTickEvidence;
    const hasError = evidence.error !== undefined;
    const recordCount = evidence.recordCount ?? 0;
    const malformedLineCount = evidence.malformedLineCount ?? 0;
    const dispatchFailedCount = evidence.dispatchFailedCount ?? 0;
    const checkpointHoldCount = evidence.checkpointHoldCount ?? 0;
    const leaseHeldSkipCount = evidence.leaseHeldSkipCount ?? 0;
    const insufficientTrend =
      evidence.sufficientForTrend === undefined
        ? true
        : !evidence.sufficientForTrend;
    const evidenceStatus: DoctorSectionStatus =
      hasError ||
      recordCount === 0 ||
      insufficientTrend ||
      malformedLineCount > 0 ||
      dispatchFailedCount > 0 ||
      checkpointHoldCount > 0
        ? 'warn'
        : 'pass';
    sections.push(
      section(
        'Trait scheduler tick evidence',
        evidenceStatus,
        [
          `Ledger: ${redactedPathSummary(evidence.ledgerPath)}`,
          `Max replay bytes: ${evidence.maxLedgerBytes}`,
          ...(hasError
            ? [`Replay status: failed (${evidence.error})`]
            : [
                `Records: ${recordCount}`,
                `Quality score: ${evidence.qualityScore ?? 0}/${evidence.qualityScoreMax ?? 100}`,
                `Trend sample: ${
                  evidence.sufficientForTrend === true
                    ? 'sufficient'
                    : 'insufficient'
                }`,
                `Dispatch failures: ${dispatchFailedCount}`,
                `Checkpoint holds: ${checkpointHoldCount}`,
                `Lease-held skips: ${leaseHeldSkipCount}`,
                `Malformed/torn lines: ${malformedLineCount}`,
                `Last recorded at: ${evidence.lastRecordedAt ?? 'none'}`,
              ]),
        ],
        hasError
          ? 'Fix the scheduler tick evidence ledger path or bounded replay byte guard; /doctor only reads and never repairs the ledger.'
          : evidenceStatus === 'warn'
            ? evidence.recommendation
            : undefined,
      ),
    );
  }
  sections.push(
    section('Subagent roster policy', 'pass', [
      `maxSpawnDepth: ${input.subagentMaxSpawnDepth ?? 1}`,
      'Nested depth-2 spawn: disabled',
    ]),
  );
  {
    const hookMode = input.shellHooksMode ?? 'unknown';
    const acceptMode = input.shellHookAcceptMode ?? 'unknown';
    const hooksEnabled = hookMode === 'on';
    const acceptSet = acceptMode === 'literal-1' || acceptMode === 'invalid-set';
    const status: DoctorSectionStatus =
      hookMode === 'unknown' ||
      acceptMode === 'unknown' ||
      acceptMode === 'invalid-set' ||
      (!hooksEnabled && acceptSet)
        ? 'warn'
        : 'pass';
    const details = [
      `Master gate: ${hooksEnabled ? 'enabled' : hookMode === 'off' ? 'disabled' : 'unknown'}`,
      `Non-interactive consent: ${
        acceptMode === 'literal-1'
          ? 'AUTO_ARCHIVE_ACCEPT_HOOKS=1'
          : acceptMode === 'invalid-set'
            ? 'invalid/ignored'
            : acceptMode === 'unset'
              ? 'unset'
              : 'unknown'
      }`,
      hookMode === 'unknown'
        ? 'Shell-hook bridge env state was not supplied to this doctor payload.'
        : hooksEnabled
          ? 'Execution still requires an exact (event, command) allowlist match.'
          : 'No shell hooks are executable while the master gate is off.',
      ...(hooksEnabled && acceptMode === 'literal-1'
        ? [
            'Consent persistence: in-memory only; persist the resolved allowlist explicitly with saveAllowlist if durable consent is desired.',
          ]
        : []),
    ];
    const remediation =
      hookMode === 'unknown' || acceptMode === 'unknown'
        ? 'Run /doctor through the service bootstrap or provide env-derived shell-hook doctor status.'
        : acceptMode === 'invalid-set'
        ? 'AUTO_ARCHIVE_ACCEPT_HOOKS is ignored unless it is exactly "1"; unset it or set the exact literal only when non-interactive consent is intended.'
        : !hooksEnabled && acceptSet
          ? 'AUTO_ARCHIVE_ACCEPT_HOOKS is ignored while AUTO_ARCHIVE_SHELL_HOOKS is not "on"; unset the accept env or enable the master hook gate intentionally.'
          : undefined;
    sections.push(
      section(
        'Shell-hook bridge',
        status,
        details,
        remediation,
      ),
    );
  }
  sections.push(
    section(
      'GitLab recording/artifact publication status',
      input.gitLabEnabled === true && input.gitLabTokenConfigured === false ? 'warn' : 'pass',
      [
        `GitLab: ${input.gitLabEnabled === true ? 'enabled' : 'disabled'}`,
        `Token configured: ${input.gitLabTokenConfigured === true ? 'yes' : input.gitLabEnabled === true ? 'no/unknown' : 'not required'}`,
        `Artifact publication: ${input.gitLabArtifactPublicationEnabled === true ? 'enabled' : 'disabled'}`,
      ],
      input.gitLabEnabled === true && input.gitLabTokenConfigured === false
        ? 'Set AUTO_ARCHIVE_GITLAB_TOKEN_ENV or AUTO_ARCHIVE_GITLAB_TOKEN without exposing the token in logs.'
        : undefined,
    ),
  );
  // TLS CA certificate preflight (F6 production-blocking case)
  {
    const sslSet = input.sslCertFile !== undefined && input.sslCertFile.length > 0;
    const codexSet = input.codexCaCertificate !== undefined && input.codexCaCertificate.length > 0;
    const sslMissing = sslSet && input.sslCertFilePresent === false;
    const codexMissing = codexSet && input.codexCaCertificatePresent === false;
    const tlsStatus: DoctorSectionStatus =
      sslMissing || codexMissing ? 'fail' : 'pass';
    const tlsDetails: string[] = [];
    if (!sslSet && !codexSet) {
      tlsDetails.push('SSL_CERT_FILE: unset (using system roots)');
      tlsDetails.push('CODEX_CA_CERTIFICATE: unset (using system roots)');
    } else {
      tlsDetails.push(
        `SSL_CERT_FILE: ${sslSet ? redactedPathSummary(input.sslCertFile) : 'unset'} — ${
          sslSet ? (input.sslCertFilePresent === true ? 'present' : 'MISSING') : 'n/a'
        }`,
      );
      tlsDetails.push(
        `CODEX_CA_CERTIFICATE: ${codexSet ? redactedPathSummary(input.codexCaCertificate) : 'unset'} — ${
          codexSet ? (input.codexCaCertificatePresent === true ? 'present' : 'MISSING') : 'n/a'
        }`,
      );
    }
    sections.push(
      section(
        'TLS CA certificate',
        tlsStatus,
        tlsDetails,
        tlsStatus === 'fail'
          ? 'SSL_CERT_FILE/CODEX_CA_CERTIFICATE points at a missing file. Either unset to use system roots, or fix the path. Codex SDK websocket TLS will fail closed otherwise.'
          : undefined,
      ),
    );
  }
  if (input.rateThrottleEnabled === true) {
    const snapshot = input.rateThrottleSnapshot ?? [];
    const overUtilized = snapshot.some(
      (entry) => entry.limit >= 0 && entry.utilizationPercent >= 80,
    );
    const saturated = snapshot.some(
      (entry) =>
        entry.limit >= 0 && entry.inflight >= entry.limit && entry.limit > 0,
    );
    const status: DoctorSectionStatus = saturated
      ? 'warn'
      : overUtilized
        ? 'warn'
        : 'pass';
    const details: string[] = snapshot.length === 0
      ? ['No provider snapshots available.']
      : snapshot.map((entry) => {
          const limitLabel = entry.limit < 0 ? 'unlimited' : String(entry.limit);
          const utilizationLabel =
            entry.limit < 0 ? 'n/a' : `${entry.utilizationPercent}%`;
          return `${entry.provider}: inflight=${entry.inflight} limit=${limitLabel} utilization=${utilizationLabel}`;
        });
    sections.push(
      section(
        'Rate-throttle (rate-throttle chokepoint)',
        status,
        details,
        saturated
          ? 'A provider is at its cap. Subsequent submissions will be admission-denied with reason="rate-throttle quota exhausted" until inflight drops.'
          : overUtilized
            ? 'A provider is at >=80% utilization. Consider raising AUTO_ARCHIVE_CODEX_MAX_INFLIGHT / AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT or sustained throughput will degrade.'
            : undefined,
      ),
    );
  }
  const probe = input.redactionProbe ?? 'sk-example-token glpat-example';
  const redactedProbe = probe.replace(/(?:sk-[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+)/g, '[REDACTED_SECRET]');
  sections.push(
    section('Secret redaction check', redactedProbe.includes('sk-') || redactedProbe.includes('glpat-') ? 'fail' : 'pass', [
      `Probe hash: ${shortHash(probe)}`,
      'Probe value: [redacted]',
    ]),
  );
  return { generatedAt: input.generatedAt ?? new Date().toISOString(), sections };
}

export function renderDoctorReport(report: DoctorReport): string {
  return [
    'Auto Archive doctor',
    `Generated: ${report.generatedAt}`,
    ...report.sections.flatMap((entry) => [
      '',
      `[${entry.status.toUpperCase()}] ${entry.name}`,
      ...entry.details.map((detail) => `- ${detail}`),
      ...(entry.remediation === undefined ? [] : [`Remediation: ${entry.remediation}`]),
    ]),
  ].join('\n');
}

export function buildDoctorReportFromEnv(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const gitLabEnabled = env['AUTO_ARCHIVE_GITLAB_ENABLED'] === 'true' || env['AUTO_ARCHIVE_GITLAB_ENABLED'] === '1';
  const tokenEnv = env['AUTO_ARCHIVE_GITLAB_TOKEN_ENV'] || 'GITLAB_TOKEN';

  // multi-provider-scope.md: provider is selected at bootstrap from
  // AUTO_ARCHIVE_RUNTIME_PROVIDER. Doctor reflects the active selection
  // plus the readiness of the alternate provider's auth surface.
  const runtimeProviderRaw = env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim();
  const activeRuntimeProvider: 'codex' | 'claude-agent' =
    runtimeProviderRaw === 'claude-agent' ? 'claude-agent' : 'codex';
  const anthropicApiKey = env['AUTO_ARCHIVE_ANTHROPIC_API_KEY']?.trim();
  const anthropicCliPath = env['AUTO_ARCHIVE_CLAUDE_CLI_PATH']?.trim();
  const anthropicAuthSource: 'api-key' | 'claude-cli' | 'none' =
    anthropicApiKey && anthropicApiKey.length > 0
      ? 'api-key'
      : anthropicCliPath && anthropicCliPath.length > 0
        ? 'claude-cli'
        : 'none';

  // PR5 — env-only static snapshot. The runtime port supplies the live
  // inflight count; without a wired port we fall back to inflight=0 so
  // doctor still reflects which provider has a configured cap.
  const throttleCfg = rateThrottleConfigFromEnv(env);
  const throttleEnabled =
    throttleCfg.codexMaxInflight >= 0 ||
    throttleCfg.claudeAgentMaxInflight >= 0;
  const throttleSnapshot: ReadonlyArray<RateThrottleSnapshot> = throttleEnabled
    ? [
        {
          provider: 'codex',
          inflight: 0,
          limit: throttleCfg.codexMaxInflight,
          utilizationPercent: 0,
        },
        {
          provider: 'claude-agent',
          inflight: 0,
          limit: throttleCfg.claudeAgentMaxInflight,
          utilizationPercent: 0,
        },
      ]
    : [];

  return buildDoctorReport({
    ledgerEnabled: Boolean(env['AUTO_ARCHIVE_CONTROL_LEDGER_PATH']),
    accessPolicyEnabled: true,
    authDatabaseEnabled: Boolean(env['AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH']),
    runtimeProviderScope: 'multi-provider',
    activeRuntimeProvider,
    computeMode: env['AUTO_ARCHIVE_COMPUTE_NODE'] ?? 'default',
    apptainerImage: env['AUTO_ARCHIVE_APPTAINER_IMAGE'],
    agentInstanceEntry: env['AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY'],
    modelOverride: env['AUTO_ARCHIVE_CODEX_MODEL'],
    messageContentIntent: env['AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT'] === '1',
    approvalRegistryEnabled: true,
    executionApprovalPolicy: 'single-use',
    toolLoopDetectorEnabled: true,
    taskHealthObserverEnabled: isTaskStallObserverEnabledFromEnv(env),
    subagentMaxSpawnDepth: 1,
    ...resolveShellHookDoctorStatusFromEnv(env),
    gitLabEnabled,
    gitLabTokenConfigured: gitLabEnabled ? Boolean(env['AUTO_ARCHIVE_GITLAB_TOKEN'] || env[tokenEnv]) : undefined,
    gitLabArtifactPublicationEnabled: env['AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED'] === 'true' || env['AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED'] === '1',
    codexAuthPath: env['CODEX_HOME'] === undefined ? undefined : `${env['CODEX_HOME']}/auth.json`,
    codexAuthConfigured: undefined,
    anthropicAuthSource,
    ...(anthropicCliPath === undefined ? {} : { anthropicCliPath }),
    ...(env['AUTO_ARCHIVE_CLAUDE_MODEL'] === undefined
      ? {}
      : { claudeModelOverride: env['AUTO_ARCHIVE_CLAUDE_MODEL'] }),
    planaAdvisorProvider:
      env['AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER']?.trim() === 'claude-agent'
        ? 'claude-agent'
        : env['AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER']?.trim() === 'codex'
          ? 'codex'
          : 'none',
    ...(() => {
      const agentHarnessRegistry =
        resolveAgentHarnessRegistryDoctorStatusFromEnv(env);
      return agentHarnessRegistry === undefined
        ? {}
        : { agentHarnessRegistry };
    })(),
    ...(() => {
      const controlPlaneOtelLogs =
        resolveControlPlaneOtelLogsDoctorStatusFromEnv(env);
      return controlPlaneOtelLogs === undefined
        ? {}
        : { controlPlaneOtelLogs };
    })(),
    autonomousResearchTraitRuntime:
      resolveAutonomousResearchTraitRuntimeDoctorStatusFromEnv(env),
    ...(() => {
      const autonomousResearchEvidence =
        resolveAutonomousResearchEvidenceDoctorStatusFromEnv(env);
      return autonomousResearchEvidence === undefined
        ? {}
        : { autonomousResearchEvidence };
    })(),
    ...(() => {
      const runtimeProviderEvidence =
        resolveRuntimeProviderEvidenceDoctorStatusFromEnv(env);
      return runtimeProviderEvidence === undefined
        ? {}
        : { runtimeProviderEvidence };
    })(),
    ...(() => {
      const liveProofReport = resolveLiveProofReportDoctorStatusFromEnv(env);
      return liveProofReport === undefined ? {} : { liveProofReport };
    })(),
    ...(() => {
      const peekabooEvidenceReport =
        resolvePeekabooEvidenceReportDoctorStatusFromEnv(env);
      return peekabooEvidenceReport === undefined
        ? {}
        : { peekabooEvidenceReport };
    })(),
    ...(() => {
      const personaTelemetryReport =
        resolvePersonaTelemetryReportDoctorStatusFromEnv(env);
      return personaTelemetryReport === undefined
        ? {}
        : { personaTelemetryReport };
    })(),
    ...(() => {
      const claudeOffloadReport =
        resolveClaudeOffloadReportDoctorStatusFromEnv(env);
      return claudeOffloadReport === undefined ? {} : { claudeOffloadReport };
    })(),
    ...(() => {
      const taskHealthEvidenceReport =
        resolveTaskHealthEvidenceReportDoctorStatusFromEnv(env);
      return taskHealthEvidenceReport === undefined
        ? {}
        : { taskHealthEvidenceReport };
    })(),
    ...(() => {
      const taskArchiveEvidenceReport =
        resolveTaskArchiveEvidenceReportDoctorStatusFromEnv(env);
      return taskArchiveEvidenceReport === undefined
        ? {}
        : { taskArchiveEvidenceReport };
    })(),
    ...(() => {
      const subagentOperatorEvidenceReport =
        resolveSubagentOperatorEvidenceReportDoctorStatusFromEnv(env);
      return subagentOperatorEvidenceReport === undefined
        ? {}
        : { subagentOperatorEvidenceReport };
    })(),
    ...(() => {
      const sessionBindingEvidenceReport =
        resolveSessionBindingEvidenceReportDoctorStatusFromEnv(env);
      return sessionBindingEvidenceReport === undefined
        ? {}
        : { sessionBindingEvidenceReport };
    })(),
    ...(() => {
      const planaAdvisorEvents = resolvePlanaAdvisorEventsDoctorStatusFromEnv(env);
      return planaAdvisorEvents === undefined
        ? {}
        : { planaAdvisorEvents };
    })(),
    ...(() => {
      const traitSchedulerTickEvidence =
        resolveTraitSchedulerTickEvidenceDoctorStatusFromEnv(env);
      return traitSchedulerTickEvidence === undefined
        ? {}
        : { traitSchedulerTickEvidence };
    })(),
    ...(env['AUTO_ARCHIVE_PLANA_ADVISOR_MODEL'] === undefined
      ? {}
      : { planaAdvisorModel: env['AUTO_ARCHIVE_PLANA_ADVISOR_MODEL'] }),
    ...(env['AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS'] === undefined ||
    env['AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS']?.trim() === ''
      ? {}
      : {
          planaAdvisorMaxCalls: Number(
            env['AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS'],
          ),
        }),
    ...(throttleEnabled
      ? {
          rateThrottleEnabled: true,
          rateThrottleSnapshot: throttleSnapshot,
        }
      : {}),
    ...(() => {
      const sslCertFile = env['SSL_CERT_FILE']?.trim();
      const codexCaCertificate = env['CODEX_CA_CERTIFICATE']?.trim();
      const result: {
        sslCertFile?: string;
        sslCertFilePresent?: boolean;
        codexCaCertificate?: string;
        codexCaCertificatePresent?: boolean;
      } = {};
      if (sslCertFile !== undefined && sslCertFile.length > 0) {
        result.sslCertFile = sslCertFile;
        try {
          result.sslCertFilePresent = statSync(sslCertFile).isFile();
        } catch {
          result.sslCertFilePresent = false;
        }
      }
      if (codexCaCertificate !== undefined && codexCaCertificate.length > 0) {
        result.codexCaCertificate = codexCaCertificate;
        try {
          result.codexCaCertificatePresent = statSync(codexCaCertificate).isFile();
        } catch {
          result.codexCaCertificatePresent = false;
        }
      }
      return result;
    })(),
  });
}
