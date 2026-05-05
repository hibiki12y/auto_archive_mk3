import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildDoctorReport,
  buildDoctorReportFromEnv,
  renderDoctor,
  renderDoctorReport,
  renderGitLabTaskProjectReadme,
  renderGitLabWorkResultMarkdown,
  createRuntimeSettingsBundle,
  AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES,
  AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH,
  AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES,
  AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH,
  AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES,
  AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION,
  AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH,
  AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES,
  AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH,
  AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES,
  AUTO_ARCHIVE_OTEL_LOGS_URL,
  AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES,
  AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH,
  AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES,
  AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES,
  AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH,
  AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES,
  AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES,
  AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES,
  AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES,
  TRAIT_SCHEDULER_TICK_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  PLANA_ADVISOR_EVENTS_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  AGENT_HARNESS_REGISTRY_DOCTOR_DEFAULT_MAX_DESCRIPTOR_BYTES,
  AUTONOMOUS_RESEARCH_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES,
  RUNTIME_PROVIDER_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES,
  LIVE_PROOF_DOCTOR_DEFAULT_MAX_BYTES,
  PEEKABOO_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  PERSONA_TELEMETRY_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  TASK_HEALTH_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  TASK_ARCHIVE_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  SUBAGENT_OPERATOR_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  JsonlPeekabooEvidenceLedger,
  buildPeekabooReadinessReport,
  createAutonomousResearchEvidenceCheckpoint,
  formatAutonomousResearchEvidenceCheckpointDetail,
  resolveAutonomousResearchTraitRuntimeDoctorStatusFromEnv,
  resolveAutonomousResearchEvidenceDoctorStatusFromEnv,
  resolveRuntimeProviderEvidenceDoctorStatusFromEnv,
  resolveAgentHarnessRegistryDoctorStatusFromEnv,
  resolveControlPlaneOtelLogsDoctorStatusFromEnv,
  resolveLiveProofReportDoctorStatusFromEnv,
  resolvePeekabooEvidenceReportDoctorStatusFromEnv,
  resolvePersonaTelemetryReportDoctorStatusFromEnv,
  resolveTaskHealthEvidenceReportDoctorStatusFromEnv,
  resolveTaskArchiveEvidenceReportDoctorStatusFromEnv,
  resolveSubagentOperatorEvidenceReportDoctorStatusFromEnv,
  resolvePlanaAdvisorEventsDoctorStatusFromEnv,
  resolveTraitSchedulerTickEvidenceDoctorStatusFromEnv,
  type DispatchPlan,
  type TerminalEvidence,
} from '../src/index.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';
import { Arona, Dispatcher, Plana } from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { AgentRuntime, type RuntimeDriver } from '../src/index.js';

function plan(taskId: string): DispatchPlan {
  const driver: RuntimeDriver = {
    async run(context) {
      return {
        reason: 'ok',
        provenance: 'test',
        cause: {
          kind: 'success',
          taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: '2026-04-27T00:00:00.000Z',
          provenance: 'test',
        },
      };
    },
  };
  return new Arona(
    new Plana({ toolLoopDetector: false }),
    new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
  ).preparePlan(createTaskRequest(taskId, { instruction: 'test task' }));
}

function evidence(taskId: string): TerminalEvidence {
  return {
    taskId,
    runtimeInstanceId: 'runtime-1',
    reason: 'done',
    provenance: 'test',
      executionContext: {
        planCreatedAt: '2026-04-27T00:00:00.000Z',
        runtimeSettings: createRuntimeSettingsBundle({
          networkProfile: 'offline',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        }),
      },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    runtimeWarnings: [
      {
        kind: 'tool-loop',
        status: 'warn',
        reason: 'tool loop suspected',
        provenance: 'plana-tool-loop-detector',
        fingerprint: 'abcdef0123456789',
        count: 4,
        observedAt: '2026-04-27T00:00:01.000Z',
      },
    ],
    startedAt: '2026-04-27T00:00:00.000Z',
    endedAt: '2026-04-27T00:00:02.000Z',
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId: 'runtime-1',
      observedAt: '2026-04-27T00:00:02.000Z',
      provenance: 'test',
    },
  };
}

function runtimeProviderEvidenceJson(
  input: {
    readonly provider?: 'codex' | 'claude-agent';
    readonly terminalCause?: 'success' | 'provider-failure';
  } = {},
): string {
  const provider = input.provider ?? 'codex';
  const driverProvenance =
    provider === 'codex'
      ? 'codex-runtime-driver'
      : 'claude-agent-runtime-driver';
  const taskId = 'SECRET-doctor-provider-task';
  const runtimeInstanceId = 'SECRET-doctor-provider-runtime';
  return JSON.stringify({
    taskId,
    runtimeInstanceId,
    reason: 'SECRET provider reason must not render',
    provenance: driverProvenance,
    executionContext: {
      planCreatedAt: '2026-05-05T17:00:00.000Z',
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    transcript: {
      events: [
        {
          kind: 'turn.completed',
          timestamp: '2026-05-05T17:00:02.000Z',
          instanceId: runtimeInstanceId,
          turnSequence: 1,
          usage: {
            inputTokens: 21,
            cachedInputTokens: 3,
            outputTokens: 8,
          },
          provenance: {
            producer: driverProvenance,
            sdkEventType: 'turn.completed',
            threadId: null,
          },
        },
      ],
      droppedCount: 0,
    },
    startedAt: '2026-05-05T17:00:00.000Z',
    endedAt: '2026-05-05T17:00:03.000Z',
    cause:
      input.terminalCause === 'provider-failure'
        ? {
            kind: 'provider-failure',
            taskId,
            runtimeInstanceId,
            observedAt: '2026-05-05T17:00:03.000Z',
            provenance: driverProvenance,
            provider: provider === 'codex' ? 'codex' : 'anthropic',
            classification: 'permanent-auth',
            retryable: false,
            message: 'SECRET provider diagnostic must not render',
          }
        : {
            kind: 'success',
            taskId,
            runtimeInstanceId,
            observedAt: '2026-05-05T17:00:03.000Z',
            provenance: driverProvenance,
          },
  });
}

function traitSchedulerTickEvidenceJson(recordId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    recordId,
    recordedAt: '2026-05-05T09:00:32.000Z',
    source: 'doctor-test',
    status: 'ran',
    lease: {
      status: 'acquired',
      leasePath: '/tmp/auto-archive/tick.lock',
      ownerId: 'doctor-test-runner',
      acquiredAt: '2026-05-05T09:00:00.000Z',
      expiresAt: '2026-05-05T09:01:00.000Z',
    },
    batch: {
      planTickedAt: '2026-05-05T09:00:30.000Z',
      windowStartExclusive: '2026-05-05T08:59:00.000Z',
      windowEndInclusive: '2026-05-05T09:00:00.000Z',
      attemptedCount: 1,
      dispatchedCount: 1,
      failedCount: 0,
      skippedPlannedCount: 0,
      truncated: false,
      checkpointStatus: 'advance',
      checkpointLastTickAt: '2026-05-05T09:00:00.000Z',
    },
  });
}

function planaAdvisorEventJson(
  recordId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    recordId,
    recordedAt: '2026-05-05T10:00:00.000Z',
    provider: 'claude-agent',
    provenance: 'plana-claude-runtime-advisor',
    taskId: 'task-doctor-advisor',
    instanceId: 'agent-task-doctor-advisor',
    eventKind: 'item.completed',
    eventTimestamp: '2026-05-05T09:59:59.000Z',
    eventItemType: 'agent_message',
    verdictStatus: 'approve',
    consultationOutcome: 'consulted',
    ...overrides,
  });
}

function agentHarnessRegistryDescriptorJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    plugins: [
      {
        id: 'harness.claude-only.doctor',
        defaultUnsupportedReason: 'claude-agent only',
        supports: [{ provider: 'claude-agent', priority: 10 }],
      },
      {
        id: 'harness.codex.doctor',
        label: 'Codex doctor harness',
        supports: [
          {
            provider: 'codex',
            priority: 5,
            reason: 'codex doctor diagnostics',
          },
        ],
      },
    ],
    ...overrides,
  });
}

function liveProofManifestJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    proofs: [
      {
        proofId: 'discord-doctor-proof',
        surface: 'discord-service',
        recordedAt: '2026-05-05T12:00:00.000Z',
        status: 'pass',
        operatorApproved: true,
        artifactKind: 'redacted-transcript',
        summary:
          'secret token and raw task instruction must not appear in doctor output',
        artifacts: [
          'gateway-ready',
          'command-registration',
          'admin-doctor-or-auth-smoke',
          'correlated-command-reply',
        ],
        correlationIds: ['task-secret-correlation-id'],
        boundary: {
          secretsRedacted: true,
          rawTokensIncluded: false,
          rawCredentialsIncluded: false,
          rawPromptsIncluded: false,
          rawResponsesIncluded: false,
          rawInstructionsIncluded: false,
          rawPrivateArtifactContentIncluded: false,
        },
      },
    ],
    ...overrides,
  });
}

function appendPeekabooEvidenceRecord(
  ledger: JsonlPeekabooEvidenceLedger,
  turn: number,
  overrides: { readonly matched?: boolean; readonly outcome?: string } = {},
): void {
  const marker = `RUN_DOCTOR_T${String(turn).padStart(2, '0')}`;
  const taskId = `discord-task-doctor-${String(turn)}`;
  const matched = overrides.matched ?? true;
  const readiness = buildPeekabooReadinessReport({
    phase: 'live',
    configOk: true,
    sshOk: true,
    bridgePresent: true,
    proxyReady: true,
    marker,
    expectedTaskId: taskId,
    submitAttempted: true,
    controlOk: true,
    restObservationAttempted: true,
    ack: {
      observedAt: `2026-05-05T02:0${String(turn)}:02.000Z`,
      taskId,
      matchedOn: ['task-id', 'author'],
    },
    ...(matched
      ? {
          matchedReply: {
            observedAt: `2026-05-05T02:0${String(turn)}:05.000Z`,
            taskId,
            marker,
            matchedOn: ['marker', 'task-id'] as const,
          },
        }
      : { relatedReplyCount: 1 }),
  });
  ledger.append({
    runId: 'RUN_DOCTOR',
    turnMarker: marker,
    correlationId: `peekaboo-secret-correlation-${String(turn)}`,
    channelId: 'doctor-channel',
    readiness,
    evidence: readiness.evidence,
    outcome: overrides.outcome ?? 'PASS',
    notes: 'SECRET_PEEKABOO_NOTE_MUST_NOT_RENDER',
  });
}

function personaTelemetryLine(
  index: number,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    event: 'persona-transform-observed',
    details: {
      eventType: index % 2 === 0 ? 'running-update' : 'ask-accepted',
      model: 'gpt-4o-mini',
      outcome: 'success',
      observedAt: `2026-05-05T05:0${String(index)}:00.000Z`,
      durationMs: 100 + index,
      latencyBudgetMs: 500,
      withinLatencyBudget: true,
      inputChars: 120 + index,
      outputChars: 140 + index,
      totalTokens: 70,
      humanReviewedNoSourceDialogueCopy: index === 1,
      ...overrides,
    },
  });
}

function taskHealthEvidenceLine(
  index: number,
  overrides: {
    readonly payload?: Record<string, unknown>;
    readonly event?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    eventId: `task-health-doctor-event-${String(index)}`,
    timestamp: `2026-05-05T06:0${String(index)}:01.000Z`,
    type: 'task.health_stalled',
    actor: { kind: 'system' },
    channel: { kind: 'system' },
    taskId: `SECRET-task-health-doctor-${String(index)}`,
    correlationId: `SECRET-instance-health-doctor-${String(index)}`,
    trust: {
      source: 'system',
      inputTrust: 'trusted',
    },
    payload: {
      phase: 'stalled',
      scope: 'task-health',
      provenance: 'task-health-control-plane-recorder',
      lastProgressAt: `2026-05-05T06:0${String(index)}:00.000Z`,
      thresholdMs: 1000,
      lastEventKind: index % 2 === 0 ? 'turn.completed' : 'turn.started',
      ...overrides.payload,
    },
    ...overrides.event,
  });
}

function taskArchiveEvidenceHash(seed: number): `sha256:${string}` {
  return `sha256:${seed.toString(16).padStart(16, '0')}`;
}

function taskArchiveEvidenceLine(
  action: 'archive' | 'unarchive',
  index: number,
  overrides: {
    readonly payload?: Record<string, unknown>;
    readonly event?: Record<string, unknown>;
    readonly taskHash?: string;
  } = {},
): string {
  const archived = action === 'archive';
  const timestamp = `2026-05-05T07:0${String(index)}:01.000Z`;
  return JSON.stringify({
    schemaVersion: 1,
    eventId: `task-archive-doctor-event-${String(index)}`,
    timestamp,
    type: archived ? 'task.archived' : 'task.unarchived',
    actor: {
      kind: 'discord-user',
      userId: `SECRET-task-archive-actor-${String(index)}`,
    },
    channel: {
      kind: 'discord',
      channelId: `SECRET-task-archive-channel-${String(index)}`,
    },
    conversationId: `SECRET-task-archive-channel-${String(index)}`,
    taskId: `SECRET-task-archive-doctor-${String(index)}`,
    trust: {
      source: 'discord',
      inputTrust: 'trusted',
    },
    payload: {
      archiveAudit: {
        schemaVersion: 1,
        action,
        legacyEventType: archived ? 'task.archived' : 'task.unarchived',
        status: archived ? 'archived' : 'unarchived',
        occurredAt: timestamp,
        retained: true,
        taskIdPresent: true,
        taskHash: overrides.taskHash ?? taskArchiveEvidenceHash(7000),
        actorPresent: true,
        actorHash: taskArchiveEvidenceHash(7100 + index),
        reasonPresent: true,
        reasonHash: taskArchiveEvidenceHash(7200 + index),
        requestIdPresent: false,
      },
      ...overrides.payload,
    },
    ...overrides.event,
  });
}

function subagentOperatorEvidenceLine(
  kind: 'subagent.spawned' | 'subagent.completed' | 'roster.progress',
  index: number,
  overrides: Record<string, unknown> = {},
): string {
  const timestamp = `2026-05-05T08:0${String(index)}:01.000Z`;
  const correlationKey = {
    taskId: `SECRET-subagent-doctor-task-${String(index)}`,
    instanceId: `SECRET-subagent-doctor-runtime-${String(index)}`,
    subagentId: `SECRET-subagent-doctor-id-${String(index)}`,
  };
  const base = {
    kind,
    correlationKey,
    timestamp,
  } as const;
  if (kind === 'subagent.spawned') {
    return JSON.stringify({
      ...base,
      descriptor: {
        subagentId: correlationKey.subagentId,
        role: 'explorer',
        parent: {
          taskId: correlationKey.taskId,
          instanceId: correlationKey.instanceId,
        },
        createdAt: timestamp,
        state: 'active',
        envelope: {
          requested: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
            gpuCards: 0,
          },
          effective: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
            gpuCards: 0,
          },
        },
      },
      ...overrides,
    });
  }
  if (kind === 'subagent.completed') {
    return JSON.stringify({
      ...base,
      artifact: {
        digest: `sha256:${String(index).padStart(16, '0')}`,
        ref: `artifact://doctor-subagent/${String(index)}`,
      },
      cause: {
        kind: 'success',
        taskId: correlationKey.taskId,
        runtimeInstanceId: correlationKey.instanceId,
        observedAt: timestamp,
        provenance: 'doctor-test',
      },
      ...overrides,
    });
  }
  return JSON.stringify({
    ...base,
    completed: 1,
    aborted: 0,
    failed: 0,
    total: 1,
    inFlight: 0,
    ...overrides,
  });
}

function autonomousResearchCheckpointDetail(
  checkpoint: Parameters<typeof createAutonomousResearchEvidenceCheckpoint>[0]['checkpoint'],
): string {
  return formatAutonomousResearchEvidenceCheckpointDetail(
    createAutonomousResearchEvidenceCheckpoint({
      taskId: 'task-doctor-autonomous-research',
      requested: true,
      selectedTraitId: 'autonomous-research-goal-loop',
      selectedProfileId: 'dgm-bounded-archive-runtime',
      runtimeDecorationIntent: 'bounded-archive-evidence',
      runtimeDecorationEnforcement: 'required',
      checkpoint,
      ...(checkpoint === 'runtime-decoration-complete'
        ? {
            completionStatus: 'delegate-returned',
            causeKind: 'success',
          }
        : {}),
    }),
  );
}

function autonomousResearchTerminalEvidenceJson(): string {
  const taskId = 'task-doctor-autonomous-research';
  const runtimeInstanceId = 'runtime-doctor-autonomous-research';
  return JSON.stringify({
    taskId,
    runtimeInstanceId,
    reason: 'autonomous research complete',
    provenance: 'doctor-test',
    executionContext: {
      planCreatedAt: '2026-05-05T14:00:00.000Z',
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    transcript: {
      events: [
        {
          kind: 'agent-step',
          timestamp: '2026-05-05T14:00:01.000Z',
          instanceId: runtimeInstanceId,
          step: 'autonomous-research.checkpoint',
          detail: autonomousResearchCheckpointDetail(
            'runtime-decoration-start',
          ),
        },
        {
          kind: 'agent-step',
          timestamp: '2026-05-05T14:00:02.000Z',
          instanceId: runtimeInstanceId,
          step: 'autonomous-research.checkpoint',
          detail: autonomousResearchCheckpointDetail(
            'runtime-decoration-complete',
          ),
        },
      ],
      droppedCount: 0,
    },
    startedAt: '2026-05-05T14:00:00.000Z',
    endedAt: '2026-05-05T14:00:03.000Z',
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId,
      observedAt: '2026-05-05T14:00:03.000Z',
      provenance: 'doctor-test',
    },
  });
}

describe('OC-3 doctor and GitLab lifecycle rendering', () => {
  it('exposes a package-level doctor entrypoint without adding mutating auto-fix behavior', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    const cli = readFileSync('scripts/auto-archive-doctor.mjs', 'utf8');
    const readme = readFileSync('README.md', 'utf8');

    expect(pkg.scripts['doctor']).toBe(
      'npm run build && node scripts/auto-archive-doctor.mjs',
    );
    expect(cli).toMatch(/^#!\/usr\/bin\/env node/u);
    expect(cli).toContain("from '../dist/src/core/doctor.js'");
    expect(cli).toContain(
      'renderDoctorReport(buildDoctorReportFromEnv(process.env))',
    );
    expect(readme).toContain('`pnpm run doctor`');
    expect(readme).toContain(
      "bare\n    `pnpm doctor`; that is pnpm's own diagnostic command",
    );
    expect(cli).not.toMatch(
      /\b(?:--fix|writeFile|mkdir|unlink|rmSync|chmod|symlink)\b/u,
    );
  });

  it('renders non-mutating doctor sections without leaking token-like probes', () => {
    const text = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: false,
        accessPolicyEnabled: true,
        authDatabaseEnabled: false,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        taskHealthObserverEnabled: false,
        gitLabEnabled: true,
        gitLabTokenConfigured: false,
        redactionProbe: 'sk-secret glpat-secret',
        generatedAt: '2026-04-27T00:00:00.000Z',
      }),
    );
    expect(text).toContain('[WARN] Service readiness');
    expect(text).toContain('Approval registry status');
    expect(text).toContain('Tool-loop detector status');
    expect(text).toContain('Task health observer status');
    expect(text).toContain('AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS');
    expect(text).toContain('GitLab recording/artifact publication status');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('glpat-secret');
  });

  it('ignores stale task-health problem input when the observer is disabled', () => {
    const text = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        runtimeProviderScope: 'multi-provider',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        taskHealthObserverEnabled: false,
        inFlightProblems: [
          {
            taskId: 'task-stale-stall',
            kind: 'stall',
            observedAt: '2026-05-05T00:01:00.000Z',
            lastProgressAt: '2026-05-05T00:00:00.000Z',
            thresholdMs: 60000,
          },
        ],
        generatedAt: '2026-05-05T00:01:00.000Z',
      }),
    );

    expect(text).toContain('[WARN] Task health observer status');
    expect(text).toContain('Observer: disabled');
    expect(text).toContain('In-flight problems: none');
    expect(text).not.toContain('task-stale-stall');
  });

  it('renders task-health observer stall signals when enabled', () => {
    const text = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        runtimeProviderScope: 'multi-provider',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        taskHealthObserverEnabled: true,
        inFlightProblems: [
          {
            taskId: 'task-stalled',
            kind: 'stall',
            observedAt: '2026-05-05T00:01:00.000Z',
            lastProgressAt: '2026-05-05T00:00:00.000Z',
            thresholdMs: 60000,
          },
        ],
        generatedAt: '2026-05-05T00:01:00.000Z',
      }),
    );

    expect(text).toContain('[WARN] Task health observer status');
    expect(text).toContain('stall: task=task-stalled');
    expect(text).toContain('/feed');
    expect(text).toContain('/escalate');
  });

  it('keeps Trait scheduler tick evidence hidden from doctor when the ledger path is unset', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
    });

    expect(
      report.sections.find(
        (entry) => entry.name === 'Trait scheduler tick evidence',
      ),
    ).toBeUndefined();
    expect(renderDoctorReport(report)).not.toContain(
      'Trait scheduler tick evidence',
    );
  });

  it('keeps Task health evidence report hidden from doctor when the ledger path is unset', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
    });

    expect(
      report.sections.find(
        (entry) => entry.name === 'Task health evidence report',
      ),
    ).toBeUndefined();
    expect(renderDoctorReport(report)).not.toContain(
      'Task health evidence report',
    );
  });

  it('keeps Subagent operator evidence report hidden from doctor when the ledger path is unset', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
    });

    expect(
      report.sections.find(
        (entry) =>
          entry.name === 'Subagent operator evidence report (retained)',
      ),
    ).toBeUndefined();
    expect(renderDoctorReport(report)).not.toContain(
      'Subagent operator evidence report',
    );
  });

  it('keeps Plana advisor events ledger hidden from doctor when the ledger path is unset', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
      AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
      AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER: 'claude-agent',
      AUTO_ARCHIVE_ANTHROPIC_API_KEY: 'test-key',
    });

    expect(
      report.sections.find(
        (entry) => entry.name === 'Plana advisor events ledger',
      ),
    ).toBeUndefined();
    expect(renderDoctorReport(report)).not.toContain(
      'Plana advisor events ledger',
    );
  });

  it('keeps Agent harness registry hidden from doctor when descriptor path is unset', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
      AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
    });

    expect(
      report.sections.find((entry) => entry.name === 'Agent harness registry'),
    ).toBeUndefined();
    expect(renderDoctorReport(report)).not.toContain('Agent harness registry');
  });

  it('keeps Agent harness registry hidden from doctor when descriptor path is blank', () => {
    for (const blankDescriptorPath of ['', '   ']) {
      const report = buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH]:
          blankDescriptorPath,
      });
      expect(
        report.sections.find(
          (entry) => entry.name === 'Agent harness registry',
        ),
      ).toBeUndefined();
    }
  });

  it('keeps Control-plane OTLP logs hidden from doctor when endpoint is unset or blank', () => {
    for (const endpoint of [undefined, '', '   ']) {
      const report = buildDoctorReportFromEnv({
        ...(endpoint === undefined
          ? {}
          : { [AUTO_ARCHIVE_OTEL_LOGS_URL]: endpoint }),
      });
      expect(
        report.sections.find(
          (entry) => entry.name === 'Control-plane OTLP logs',
        ),
      ).toBeUndefined();
    }
  });

  it('renders redacted read-only Control-plane OTLP logs diagnostics when configured', () => {
    const text = renderDoctorReport(
      buildDoctorReportFromEnv({
        AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
        [AUTO_ARCHIVE_OTEL_LOGS_URL]:
          'https://collector.secret.example/v1/logs?token=do-not-leak',
        [AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES]:
          'deployment.environment=test,service.instance.id=local',
      }),
    );

    expect(text).toContain('[PASS] Control-plane OTLP logs');
    expect(text).toContain('Endpoint: https#');
    expect(text).not.toContain('collector.secret.example');
    expect(text).not.toContain('do-not-leak');
    expect(text).not.toContain('/v1/logs');
    expect(text).toContain('Protocol: https:');
    expect(text).toContain('Resource attributes: 4 (2 custom, 0 invalid)');
    expect(text).toContain(
      'Default resource attributes: service.name, service.namespace',
    );
    expect(text).toContain('Export timeout: 2000ms');
    expect(text).toContain('Configuration check: valid; no export attempted');
    expect(text).toContain('Observer mode: fail-open after ledger append');
    expect(text).toContain('Payload boundary: safe control-plane metadata only');
    expect(text).not.toContain('deployment.environment');
    expect(text).not.toContain('service.instance.id');
    expect(text).not.toContain('deployment.environment=test');
  });

  it('passes Control-plane OTLP logs status through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      controlPlaneOtelLogs: {
        endpointUrl:
          'https://collector.discord-doctor.example/v1/logs?token=secret',
        protocol: 'https:',
        resourceAttributeCount: 3,
        customResourceAttributeCount: 1,
        invalidResourceAttributeCount: 0,
        defaultResourceAttributes: ['service.name', 'service.namespace'],
        exportTimeoutMs: 2000,
      },
    });

    expect(payload.content).toContain('[PASS] Control-plane OTLP logs');
    expect(payload.content).toContain('Endpoint: https#');
    expect(payload.content).not.toContain('collector.discord-doctor.example');
    expect(payload.content).not.toContain('token=secret');
    expect(payload.content).not.toContain('/v1/logs');
  });

  it('warns on invalid Control-plane OTLP logs resource attributes and URLs', () => {
    const invalidAttributes = resolveControlPlaneOtelLogsDoctorStatusFromEnv({
      [AUTO_ARCHIVE_OTEL_LOGS_URL]: 'http://otel.example/v1/logs',
      [AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES]:
        'deployment.environment=test,missing-separator,empty=',
    });
    const invalidAttributeText = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        authDatabaseEnabled: true,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        ...(invalidAttributes === undefined
          ? {}
          : { controlPlaneOtelLogs: invalidAttributes }),
      }),
    );

    expect(invalidAttributeText).toContain('[WARN] Control-plane OTLP logs');
    expect(invalidAttributeText).toContain(
      'Resource attributes: 3 (1 custom, 2 invalid)',
    );
    expect(invalidAttributeText).toContain(
      'Fix 2 invalid AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES key=value pair(s)',
    );

    const invalidUrlText = renderDoctorReport(
      buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_OTEL_LOGS_URL]: 'file:///tmp/otel-secret/v1/logs',
      }),
    );

    expect(invalidUrlText).toContain('[WARN] Control-plane OTLP logs');
    expect(invalidUrlText).toContain('Endpoint: file#');
    expect(invalidUrlText).not.toContain('/tmp/otel-secret');
    expect(invalidUrlText).toContain('Protocol: invalid');
    expect(invalidUrlText).toContain(
      'AUTO_ARCHIVE_OTEL_LOGS_URL must be an http(s) URL when provided.',
    );
    expect(invalidUrlText).toContain('/doctor never contacts the collector');

    const malformedUrlText = renderDoctorReport(
      buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_OTEL_LOGS_URL]: 'https://%not-a-valid-url',
      }),
    );

    expect(malformedUrlText).toContain('[WARN] Control-plane OTLP logs');
    expect(malformedUrlText).toContain('Endpoint: invalid-url#');
    expect(malformedUrlText).toContain('Protocol: invalid');
    expect(malformedUrlText).not.toContain('%not-a-valid-url');
    expect(malformedUrlText).toContain('/doctor never contacts the collector');
  });

  it('does not contact the OTLP collector while rendering doctor diagnostics', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_OTEL_LOGS_URL]:
            'https://collector.no-network.example/v1/logs',
        }),
      );

      expect(text).toContain('[PASS] Control-plane OTLP logs');
      expect(text).toContain('Configuration check: valid; no export attempted');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps OTLP endpoint hash stable and userinfo redacted', () => {
    const env = {
      [AUTO_ARCHIVE_OTEL_LOGS_URL]:
        'https://user:pass@collector.userinfo.example/v1/logs?token=secret',
    };
    const firstText = renderDoctorReport(buildDoctorReportFromEnv(env));
    const secondText = renderDoctorReport(buildDoctorReportFromEnv(env));
    const firstEndpoint = firstText.match(/Endpoint: (https#[0-9a-f]+)/u)?.[1];
    const secondEndpoint = secondText.match(/Endpoint: (https#[0-9a-f]+)/u)?.[1];

    expect(firstEndpoint).toBeDefined();
    expect(secondEndpoint).toBe(firstEndpoint);
    expect(firstText).not.toContain('user:pass');
    expect(firstText).not.toContain('collector.userinfo.example');
    expect(firstText).not.toContain('/v1/logs');
    expect(firstText).not.toContain('token=secret');
  });

  it('keeps OTLP resource attribute values redacted and counts edge cases deterministically', () => {
    const text = renderDoctorReport(
      buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_OTEL_LOGS_URL]:
          'https://collector.attributes.example/v1/logs?api_key=secret',
        [AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES]:
          'auth=Bearer secret-token, key=, =value, key==value, duplicate=one, duplicate=two, unicode=연구, ',
      }),
    );

    expect(text).toContain('[WARN] Control-plane OTLP logs');
    expect(text).toContain('Resource attributes: 7 (5 custom, 3 invalid)');
    expect(text).not.toContain('Bearer secret-token');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('api_key=secret');
    expect(text).not.toContain('collector.attributes.example');
    expect(text).not.toContain('duplicate=one');
    expect(text).not.toContain('duplicate=two');
    expect(text).not.toContain('unicode=연구');

    const first = resolveControlPlaneOtelLogsDoctorStatusFromEnv({
      [AUTO_ARCHIVE_OTEL_LOGS_URL]:
        'https://collector-one.example/v1/logs',
    });
    const second = resolveControlPlaneOtelLogsDoctorStatusFromEnv({
      [AUTO_ARCHIVE_OTEL_LOGS_URL]:
        'https://collector-two.example/v1/logs',
    });
    const firstText = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        authDatabaseEnabled: true,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        ...(first === undefined ? {} : { controlPlaneOtelLogs: first }),
      }),
    );
    const secondText = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        authDatabaseEnabled: true,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        ...(second === undefined ? {} : { controlPlaneOtelLogs: second }),
      }),
    );
    const firstEndpoint = firstText.match(/Endpoint: (https#[0-9a-f]+)/u)?.[1];
    const secondEndpoint = secondText.match(/Endpoint: (https#[0-9a-f]+)/u)?.[1];
    expect(firstEndpoint).toBeDefined();
    expect(secondEndpoint).toBeDefined();
    expect(firstEndpoint).not.toBe(secondEndpoint);
  });

  it('renders autonomous research TraitModule runtime mode as read-only doctor evidence', () => {
    const text = renderDoctorReport(
      buildDoctorReportFromEnv({
        AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
        [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]:
          'bounded-evidence',
      }),
    );

    expect(text).toContain('[PASS] Autonomous research TraitModule runtime');
    expect(text).toContain(
      `Env: ${AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION}`,
    );
    expect(text).toContain('Mode: bounded-evidence');
    expect(text).toContain('Selected trait: autonomous-research-goal-loop');
    expect(text).toContain(
      'Selected profile: dgm-bounded-archive-runtime',
    );
    expect(text).toContain('Runtime hook: evidence-decorator');
    expect(text).toContain('Hidden autonomous runner: no');
  });

  it('contains invalid autonomous research TraitModule runtime env values', () => {
    const status = resolveAutonomousResearchTraitRuntimeDoctorStatusFromEnv({
      [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]: 'surprise',
    });
    const text = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        authDatabaseEnabled: true,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        autonomousResearchTraitRuntime: status,
      }),
    );

    expect(text).toContain('[WARN] Autonomous research TraitModule runtime');
    expect(text).toContain('Mode: invalid');
    expect(text).toContain('Configuration error:');
    expect(text).toContain(
      'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION must be one of: off, bounded-evidence.',
    );
    expect(text).toContain(
      'Set AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION=bounded-evidence',
    );
  });

  it('keeps autonomous research evidence hidden from doctor when evidence path is unset or blank', () => {
    for (const evidencePath of [undefined, '', '   ']) {
      const report = buildDoctorReportFromEnv({
        ...(evidencePath === undefined
          ? {}
          : { [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH]: evidencePath }),
      });
      expect(
        report.sections.find(
          (entry) => entry.name === 'Autonomous research evidence',
        ),
      ).toBeUndefined();
    }
  });

  it('renders read-only autonomous research evidence diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-autonomous-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, autonomousResearchTerminalEvidenceJson(), 'utf8');

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH]: evidencePath,
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Autonomous research evidence');
      expect(text).toContain('Evidence: terminal-evidence.json#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max evidence bytes: 10000');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Evidence records: 1');
      expect(text).toContain('Autonomous tasks: 1');
      expect(text).toContain(
        'Task status complete/delegate-error/incomplete/not-requested: 1/0/0/0',
      );
      expect(text).toContain('Checkpoints start/complete/error: 1/1/0');
      expect(text).toContain('Criteria coverage: complete (0 missing)');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Last checkpoint at: 2026-05-05T14:00:02.000Z');
      expect(text).not.toContain('RuntimeDriver');
      expect(text).not.toContain('dispatches tasks');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes autonomous research evidence status through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      autonomousResearchEvidence: {
        evidencePath:
          '/tmp/auto-archive-discord-doctor-autonomous/terminal-evidence.json',
        maxEvidenceBytes: 10000,
        reportStatus: 'complete',
        evidenceRecordCount: 1,
        autonomousTaskCount: 1,
        completeTaskCount: 1,
        delegateErrorTaskCount: 0,
        incompleteTaskCount: 0,
        notRequestedTaskCount: 0,
        startCheckpointCount: 1,
        completeCheckpointCount: 1,
        errorCheckpointCount: 0,
        criteriaComplete: true,
        missingCriteriaCount: 0,
        qualityScore: 100,
        qualityScoreMax: 100,
        lastCheckpointAt: '2026-05-05T14:00:02.000Z',
      },
    });

    expect(payload.content).toContain('[PASS] Autonomous research evidence');
    expect(payload.content).toContain('Evidence: terminal-evidence.json#');
    expect(payload.content).toContain('Report status: complete');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain(
      '/tmp/auto-archive-discord-doctor-autonomous',
    );
  });

  it('uses the default bounded evidence guard for autonomous research evidence', () => {
    const status = resolveAutonomousResearchEvidenceDoctorStatusFromEnv({
      [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH]:
        '/tmp/auto-archive-doctor-autonomous/terminal-evidence.json',
    });

    expect(status?.maxEvidenceBytes).toBe(
      AUTONOMOUS_RESEARCH_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES,
    );
    expect(status?.error).toBeDefined();
  });

  it('contains autonomous research evidence configuration failures', () => {
    for (const invalidMaxEvidenceBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH]:
            '/tmp/auto-archive-doctor-autonomous/terminal-evidence.json',
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES]:
            invalidMaxEvidenceBytes,
        }),
      );

      expect(text).toContain('[WARN] Autonomous research evidence');
      expect(text).toContain('Evidence: terminal-evidence.json#');
      expect(text).not.toContain('/tmp/auto-archive-doctor-autonomous');
      expect(text).not.toContain('/tmp/');
      expect(text).toContain('Report status: failed');
      expect(text).toContain(
        'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES must be a positive safe integer.',
      );
    }
  });

  it('redacts autonomous research evidence IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-autonomous-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Autonomous research evidence');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Evidence: auto-archive-doctor-autonomous-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor reads TerminalEvidence JSON only and never runs the trait',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only runtime provider evidence diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-provider-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, runtimeProviderEvidenceJson(), 'utf8');

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
          [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH]: evidencePath,
          [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Runtime provider evidence (retained)');
      expect(text).toContain('Evidence: terminal-evidence.json#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max evidence bytes: 10000');
      expect(text).toContain('Provider: codex');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Evidence records: 1');
      expect(text).toContain('Selected provider records: 1');
      expect(text).toContain('Successful provider records: 1');
      expect(text).toContain('Failed provider records: 0');
      expect(text).toContain('Provider provenance matched: 1');
      expect(text).toContain('Transcript events: 1');
      expect(text).toContain('Total tokens: 32');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Last ended at: 2026-05-05T17:00:03.000Z');
      expect(text).toContain('Raw task ids: not rendered');
      expect(text).toContain('Raw runtime instance ids: not rendered');
      expect(text).toContain('Raw terminal reasons: not rendered');
      expect(text).toContain('Raw transcript: not rendered');
      expect(text).toContain('Provider contact: none');
      expect(text).not.toContain('SECRET-doctor-provider-task');
      expect(text).not.toContain('SECRET provider reason');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes runtime provider evidence diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      runtimeProviderEvidence: {
        evidencePath:
          '/tmp/auto-archive-discord-doctor-provider/terminal-evidence.json',
        maxEvidenceBytes: 10000,
        provider: 'codex',
        reportStatus: 'complete',
        evidenceRecordCount: 1,
        selectedProviderRecordCount: 1,
        successfulProviderRecordCount: 1,
        failedProviderRecordCount: 0,
        providerProvenanceMatchedCount: 1,
        transcriptEventCount: 1,
        totalTokens: 32,
        qualityScore: 100,
        qualityScoreMax: 100,
        lastEndedAt: '2026-05-05T17:00:03.000Z',
      },
    });

    expect(payload.content).toContain('[PASS] Runtime provider evidence (retained)');
    expect(payload.content).toContain('Evidence: terminal-evidence.json#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain(
      '/tmp/auto-archive-discord-doctor-provider',
    );
    expect(payload.content).toContain('Raw task ids: not rendered');
    expect(payload.content).toContain('Provider contact: none');
  });

  it('contains runtime provider evidence warnings and redacted configuration failures', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-provider-warn-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(
        evidencePath,
        runtimeProviderEvidenceJson({
          provider: 'claude-agent',
          terminalCause: 'provider-failure',
        }),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'claude-agent',
          [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH]: evidencePath,
        }),
      );

      expect(text).toContain('[WARN] Runtime provider evidence (retained)');
      expect(text).toContain('Provider: claude-agent');
      expect(text).toContain('Report status: warn');
      expect(text).toContain('Evidence records: 1');
      expect(text).toContain('Failed provider records: 1');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET provider diagnostic');

      const defaultStatus = resolveRuntimeProviderEvidenceDoctorStatusFromEnv({
        AUTO_ARCHIVE_RUNTIME_PROVIDER: 'claude-agent',
        [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH]: evidencePath,
      });
      expect(defaultStatus?.maxEvidenceBytes).toBe(
        RUNTIME_PROVIDER_EVIDENCE_DOCTOR_DEFAULT_MAX_BYTES,
      );
      expect(defaultStatus?.provider).toBe('claude-agent');

      for (const invalidMaxEvidenceBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH]:
              '/tmp/auto-archive-doctor-provider/terminal-evidence.json',
            [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES]:
              invalidMaxEvidenceBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Runtime provider evidence (retained)');
        expect(invalidText).toContain('Evidence: terminal-evidence.json#');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts runtime provider evidence IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-provider-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Runtime provider evidence (retained)');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Evidence: auto-archive-doctor-provider-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor reads retained evidence only and never calls Codex, Claude Agent, or switches providers',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only Agent harness registry diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-harness-'));
    try {
      const descriptorPath = join(workspace, 'agent-harnesses.json');
      writeFileSync(descriptorPath, agentHarnessRegistryDescriptorJson(), 'utf8');

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
          [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH]: descriptorPath,
          [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Agent harness registry');
      expect(text).toContain('Descriptor: agent-harnesses.json#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max descriptor bytes: 10000');
      expect(text).toContain('Provider: codex');
      expect(text).toContain('Selection source: eager');
      expect(text).toContain('Registry status: selected');
      expect(text).toContain('Plugins: 2');
      expect(text).toContain('Supported plugins: 1');
      expect(text).toContain('Configuration errors: 0');
      expect(text).toContain('Selected harness: harness.codex.doctor');
      expect(text).toContain('Selected priority: 5');
      expect(text).not.toContain('wrapDriver');
      expect(text).not.toContain('plugin code');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes Agent harness registry status through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      agentHarnessRegistry: {
        descriptorPath:
          '/tmp/auto-archive-discord-doctor-harness/agent-harnesses.json',
        maxDescriptorBytes: 10000,
        provider: 'codex',
        source: 'eager',
        registryStatus: 'selected',
        pluginCount: 1,
        supportedPluginCount: 1,
        configurationErrorCount: 0,
        selectedPluginId: 'harness.discord.doctor',
        selectedPriority: 7,
      },
    });

    expect(payload.content).toContain('[PASS] Agent harness registry');
    expect(payload.content).toContain('Descriptor: agent-harnesses.json#');
    expect(payload.content).toContain(
      'Selected harness: harness.discord.doctor',
    );
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain(
      '/tmp/auto-archive-discord-doctor-harness',
    );
  });

  it('uses the default bounded descriptor guard for Agent harness registry', () => {
    const status = resolveAgentHarnessRegistryDoctorStatusFromEnv({
      [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH]:
        '/tmp/auto-archive-doctor-harness/agent-harnesses.json',
    });

    expect(status?.maxDescriptorBytes).toBe(
      AGENT_HARNESS_REGISTRY_DOCTOR_DEFAULT_MAX_DESCRIPTOR_BYTES,
    );
    expect(status?.provider).toBe('codex');
    expect(status?.source).toBe('eager');
    expect(status?.error).toBeDefined();
  });

  it('contains Agent harness registry descriptor configuration failures', () => {
    for (const invalidMaxDescriptorBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
          [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH]:
            '/tmp/auto-archive-doctor-harness/agent-harnesses.json',
          [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES]:
            invalidMaxDescriptorBytes,
        }),
      );

      expect(text).toContain('[WARN] Agent harness registry');
      expect(text).toContain('Descriptor: agent-harnesses.json#');
      expect(text).not.toContain('/tmp/auto-archive-doctor-harness');
      expect(text).not.toContain('/tmp/');
      expect(text).toContain('Report status: failed');
      expect(text).toContain(
        'AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES must be a positive safe integer.',
      );
    }
  });

  it('redacts Agent harness registry descriptor IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-harness-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
          [AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Agent harness registry');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Descriptor: auto-archive-doctor-harness-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor reads descriptor metadata only and never imports plugin code',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only live proof artifact diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-live-proof-'));
    try {
      const proofPath = join(workspace, 'live-proof.json');
      writeFileSync(proofPath, liveProofManifestJson(), 'utf8');

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
          [AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH]: proofPath,
          [AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Live proof artifact report');
      expect(text).toContain('Manifest: live-proof.json#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max proof bytes: 10000');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Proof records: 1');
      expect(text).toContain('Complete proofs: 1');
      expect(text).toContain('Warn/fail proofs: 0/0');
      expect(text).toContain('Operator-approved proofs: 1');
      expect(text).toContain('Unsafe boundaries: 0');
      expect(text).toContain('Missing artifact tokens: 0');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Raw summaries: not rendered');
      expect(text).toContain('Raw correlation ids: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).not.toContain('secret token');
      expect(text).not.toContain('raw task instruction');
      expect(text).not.toContain('task-secret-correlation-id');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes live proof artifact diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      liveProofReport: {
        proofPath: '/tmp/auto-archive-discord-live-proof/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'complete',
        proofRecordCount: 1,
        completeProofCount: 1,
        warnProofCount: 0,
        failProofCount: 0,
        operatorApprovedCount: 1,
        unsafeBoundaryCount: 0,
        missingRequiredArtifactCount: 0,
        qualityScore: 100,
        qualityScoreMax: 100,
      },
    });

    expect(payload.content).toContain('[PASS] Live proof artifact report');
    expect(payload.content).toContain('Manifest: live-proof.json#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain('auto-archive-discord-live-proof');
    expect(payload.content).toContain('Raw correlation ids: not rendered');
  });

  it('uses the default bounded live proof manifest guard', () => {
    const status = resolveLiveProofReportDoctorStatusFromEnv({
      [AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH]:
        '/tmp/auto-archive-doctor-live-proof/live-proof.json',
    });

    expect(status?.maxProofBytes).toBe(LIVE_PROOF_DOCTOR_DEFAULT_MAX_BYTES);
    expect(status?.error).toBeDefined();
  });

  it('contains live proof artifact warnings and configuration failures', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-live-proof-warn-'));
    try {
      const proofPath = join(workspace, 'live-proof.json');
      writeFileSync(
        proofPath,
        liveProofManifestJson({
          proofs: [
            {
              proofId: 'otel-unsafe-proof',
              surface: 'control-plane-otel-logs',
              recordedAt: '2026-05-05T14:00:00.000Z',
              status: 'pass',
              operatorApproved: false,
              artifactKind: 'collector-receipt',
              summary: 'token=SECRET must not be rendered',
              artifacts: ['collector-receipt'],
              correlationIds: ['event-secret-correlation-id'],
              boundary: {
                secretsRedacted: false,
                rawTokensIncluded: true,
                rawCredentialsIncluded: false,
                rawPromptsIncluded: false,
                rawResponsesIncluded: false,
                rawInstructionsIncluded: false,
                rawPrivateArtifactContentIncluded: false,
              },
            },
          ],
        }),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH]: proofPath,
        }),
      );

      expect(text).toContain('[FAIL] Live proof artifact report');
      expect(text).toContain('Report status: fail');
      expect(text).toContain('Unsafe boundaries: 1');
      expect(text).toContain('Missing artifact tokens: 2');
      expect(text).not.toContain('token=SECRET');
      expect(text).not.toContain('event-secret-correlation-id');

      for (const invalidMaxProofBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH]:
              '/tmp/auto-archive-doctor-live-proof/live-proof.json',
            [AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES]: invalidMaxProofBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Live proof artifact report');
        expect(invalidText).toContain('Manifest: live-proof.json#');
        expect(invalidText).not.toContain('/tmp/auto-archive-doctor-live-proof');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain('Report status: failed');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts live proof artifact IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-live-proof-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Live proof artifact report');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Manifest: auto-archive-doctor-live-proof-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor reads the redacted proof manifest only and never contacts live services',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only Peekaboo evidence diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-peekaboo-'));
    try {
      const ledgerPath = join(workspace, 'peekaboo-evidence.jsonl');
      const ledger = new JsonlPeekabooEvidenceLedger(ledgerPath);
      for (let turn = 1; turn <= 5; turn += 1) {
        appendPeekabooEvidenceRecord(ledger, turn);
      }

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES]: '100000',
        }),
      );

      expect(text).toContain('[PASS] Peekaboo evidence report');
      expect(text).toContain('Ledger: peekaboo-evidence.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max replay bytes: 100000');
      expect(text).toContain('Records: 5');
      expect(text).toContain('Live records: 5');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Promotion sample: sufficient');
      expect(text).toContain('Live OK: 5/5');
      expect(text).toContain('Matched replies: 5/5');
      expect(text).toContain('Strong correlations: 5/5');
      expect(text).toContain('PASS outcomes: 5');
      expect(text).toContain('Malformed/torn lines: 0');
      expect(text).toContain('Raw notes: not rendered');
      expect(text).toContain('Raw correlation ids: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).not.toContain('SECRET_PEEKABOO_NOTE_MUST_NOT_RENDER');
      expect(text).not.toContain('peekaboo-secret-correlation-1');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes Peekaboo evidence diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      peekabooEvidenceReport: {
        ledgerPath: '/tmp/auto-archive-peekaboo/peekaboo-evidence.jsonl',
        maxLedgerBytes: 100000,
        recordCount: 5,
        liveRecordCount: 5,
        qualityScore: 100,
        qualityScoreMax: 100,
        sufficientForPromotion: true,
        liveOkCount: 5,
        liveOkTotal: 5,
        matchedReplyObservedCount: 5,
        matchedReplyObservedTotal: 5,
        strongCorrelationCount: 5,
        strongCorrelationTotal: 5,
        passOutcomeCount: 5,
        malformedLineCount: 0,
      },
    });

    expect(payload.content).toContain('[PASS] Peekaboo evidence report');
    expect(payload.content).toContain('Ledger: peekaboo-evidence.jsonl#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain('auto-archive-peekaboo');
    expect(payload.content).toContain('Raw notes: not rendered');
  });

  it('contains Peekaboo evidence warnings and redacted configuration failures', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-peekaboo-warn-'));
    try {
      const ledgerPath = join(workspace, 'peekaboo-evidence.jsonl');
      const ledger = new JsonlPeekabooEvidenceLedger(ledgerPath);
      appendPeekabooEvidenceRecord(ledger, 1, {
        matched: false,
        outcome: 'FAIL',
      });
      writeFileSync(
        ledgerPath,
        `${readFileSync(ledgerPath, 'utf8')}{"schemaVersion":1,"recordId":"torn"`,
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH]: ledgerPath,
        }),
      );

      expect(text).toContain('[WARN] Peekaboo evidence report');
      expect(text).toContain('Records: 1');
      expect(text).toContain('Promotion sample: insufficient');
      expect(text).toContain('Matched replies: 0/1');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET_PEEKABOO_NOTE_MUST_NOT_RENDER');
      expect(text).not.toContain('peekaboo-secret-correlation-1');

      const defaultStatus = resolvePeekabooEvidenceReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH]: ledgerPath,
      });
      expect(defaultStatus?.maxLedgerBytes).toBe(
        PEEKABOO_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
      );

      for (const invalidMaxLedgerBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH]:
              '/tmp/auto-archive-doctor-peekaboo/peekaboo-evidence.jsonl',
            [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES]:
              invalidMaxLedgerBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Peekaboo evidence report');
        expect(invalidText).toContain('Ledger: peekaboo-evidence.jsonl#');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts Peekaboo evidence IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-peekaboo-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Peekaboo evidence report');
      expect(text).toContain('Replay status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-peekaboo-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor only reads redacted ledger metadata and never submits GUI actions or polls Discord',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only persona telemetry diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-persona-'));
    try {
      const ledgerPath = join(workspace, 'persona-telemetry.jsonl');
      writeFileSync(
        ledgerPath,
        [1, 2, 3, 4, 5].map((index) => personaTelemetryLine(index)).join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Persona telemetry report');
      expect(text).toContain('Ledger: persona-telemetry.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max replay bytes: 10000');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Records: 5');
      expect(text).toContain('Success/fallback: 5/0');
      expect(text).toContain('Within latency budget: 5/5');
      expect(text).toContain('Human no-copy reviews: 1');
      expect(text).toContain('Total tokens: 350');
      expect(text).toContain('Malformed/torn lines: 0');
      expect(text).toContain('Unsafe raw-content lines: 0');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Raw persona text: not rendered');
      expect(text).toContain('Task ids: not rendered');
      expect(text).toContain('Live service contact: none');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes persona telemetry diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      personaTelemetryReport: {
        ledgerPath: '/tmp/auto-archive-persona/persona-telemetry.jsonl',
        maxLedgerBytes: 10000,
        reportStatus: 'complete',
        recordCount: 5,
        successCount: 5,
        fallbackCount: 0,
        latencyBudgetSampleCount: 5,
        withinLatencyBudgetCount: 5,
        humanReviewedNoSourceDialogueCopyCount: 1,
        averageDurationMs: 103,
        totalTokens: 350,
        malformedLineCount: 0,
        unsafeRawContentLineCount: 0,
        qualityScore: 100,
        qualityScoreMax: 100,
      },
    });

    expect(payload.content).toContain('[PASS] Persona telemetry report');
    expect(payload.content).toContain('Ledger: persona-telemetry.jsonl#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain('auto-archive-persona');
    expect(payload.content).toContain('Raw persona text: not rendered');
  });

  it('contains persona telemetry warnings, failures, and redacted configuration errors', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-persona-warn-'));
    try {
      const ledgerPath = join(workspace, 'persona-telemetry.jsonl');
      writeFileSync(
        ledgerPath,
        [
          personaTelemetryLine(1, {
            outcome: 'fallback',
            fallbackReason: 'timeout',
            withinLatencyBudget: false,
            humanReviewedNoSourceDialogueCopy: false,
          }),
          personaTelemetryLine(2, {
            inputText: 'SECRET source dialogue must not render',
          }),
          '{"event":"persona-transform-observed","details":{"broken":true}',
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH]: ledgerPath,
        }),
      );

      expect(text).toContain('[FAIL] Persona telemetry report');
      expect(text).toContain('Report status: fail');
      expect(text).toContain('Records: 1');
      expect(text).toContain('Success/fallback: 0/1');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Unsafe raw-content lines: 1');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET source dialogue');

      const defaultStatus = resolvePersonaTelemetryReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH]: ledgerPath,
      });
      expect(defaultStatus?.maxLedgerBytes).toBe(
        PERSONA_TELEMETRY_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
      );

      for (const invalidMaxLedgerBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH]:
              '/tmp/auto-archive-doctor-persona/persona-telemetry.jsonl',
            [AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES]:
              invalidMaxLedgerBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Persona telemetry report');
        expect(invalidText).toContain('Ledger: persona-telemetry.jsonl#');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts persona telemetry IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-persona-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Persona telemetry report');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-persona-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor only reads redacted telemetry metadata and never calls persona models',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only task health evidence diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-health-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          taskHealthEvidenceLine(1),
          taskHealthEvidenceLine(2),
          JSON.stringify({
            schemaVersion: 1,
            eventId: 'other-control-plane-event',
            timestamp: '2026-05-05T06:00:00.000Z',
            type: 'task.accepted',
            actor: { kind: 'system' },
            trust: { source: 'system', inputTrust: 'trusted' },
            payload: { instruction: 'SECRET non-task instruction ignored' },
          }),
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Task health evidence report');
      expect(text).toContain('Ledger: control-plane.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max replay bytes: 10000');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Records: 2');
      expect(text).toContain('Task-scoped records: 2');
      expect(text).toContain('Correlation-scoped records: 2');
      expect(text).toContain('Average stall ms: 1000');
      expect(text).toContain('Max stall ms: 1000');
      expect(text).toContain('Max threshold ms: 1000');
      expect(text).toContain('Malformed/torn lines: 0');
      expect(text).toContain('Unsafe payload lines: 0');
      expect(text).toContain('Non-task-health lines: 1');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Last observed at: 2026-05-05T06:02:01.000Z');
      expect(text).toContain('Raw task ids: not rendered');
      expect(text).toContain('Raw correlation ids: not rendered');
      expect(text).toContain('Raw payload: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).not.toContain('SECRET-task-health-doctor');
      expect(text).not.toContain('SECRET-instance-health-doctor');
      expect(text).not.toContain('SECRET non-task instruction');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes task health evidence diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      taskHealthEvidenceReport: {
        ledgerPath: '/tmp/auto-archive-task-health/control-plane.jsonl',
        maxLedgerBytes: 10000,
        reportStatus: 'complete',
        recordCount: 1,
        taskScopedRecordCount: 1,
        correlationScopedRecordCount: 1,
        averageStallMs: 1000,
        maxStallMs: 1000,
        maxThresholdMs: 1000,
        malformedLineCount: 0,
        unsafePayloadLineCount: 0,
        nonTaskHealthLineCount: 0,
        qualityScore: 100,
        qualityScoreMax: 100,
        lastObservedAt: '2026-05-05T06:01:01.000Z',
      },
    });

    expect(payload.content).toContain('[PASS] Task health evidence report');
    expect(payload.content).toContain('Ledger: control-plane.jsonl#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain('auto-archive-task-health');
    expect(payload.content).toContain('Raw task ids: not rendered');
    expect(payload.content).toContain('Raw correlation ids: not rendered');
  });

  it('contains task health evidence warnings, failures, and redacted configuration errors', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-health-warn-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          taskHealthEvidenceLine(1, {
            payload: { instruction: 'SECRET task instruction must not render' },
          }),
          taskHealthEvidenceLine(2),
          '{"schemaVersion":1,"eventId":"broken"',
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH]: ledgerPath,
        }),
      );

      expect(text).toContain('[FAIL] Task health evidence report');
      expect(text).toContain('Report status: fail');
      expect(text).toContain('Records: 1');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Unsafe payload lines: 1');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET task instruction');
      expect(text).not.toContain('SECRET-task-health-doctor');

      const defaultStatus = resolveTaskHealthEvidenceReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH]: ledgerPath,
      });
      expect(defaultStatus?.maxLedgerBytes).toBe(
        TASK_HEALTH_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
      );

      for (const invalidMaxLedgerBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH]:
              '/tmp/auto-archive-doctor-task-health/control-plane.jsonl',
            [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES]:
              invalidMaxLedgerBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Task health evidence report');
        expect(invalidText).toContain('Ledger: control-plane.jsonl#');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts task health evidence IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-health-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Task health evidence report');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-task-health-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor only reads retained control-plane metadata and never runs observers',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only task archive evidence diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-archive-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          taskArchiveEvidenceLine('archive', 1),
          taskArchiveEvidenceLine('unarchive', 2),
          JSON.stringify({
            schemaVersion: 1,
            eventId: 'other-control-plane-event',
            timestamp: '2026-05-05T07:00:00.000Z',
            type: 'task.accepted',
            actor: { kind: 'system' },
            trust: { source: 'system', inputTrust: 'trusted' },
            payload: { instruction: 'SECRET non-archive instruction ignored' },
          }),
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Task archive evidence report');
      expect(text).toContain('Ledger: control-plane.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max replay bytes: 10000');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Records: 2');
      expect(text).toContain('Archive records: 1');
      expect(text).toContain('Unarchive records: 1');
      expect(text).toContain('Task-scoped records: 2');
      expect(text).toContain('Actor-scoped records: 2');
      expect(text).toContain('Channel-scoped records: 2');
      expect(text).toContain('Reasons present: 2');
      expect(text).toContain('Current archived tasks: 0');
      expect(text).toContain('Duplicate archive transitions: 0');
      expect(text).toContain('Unmatched unarchive transitions: 0');
      expect(text).toContain('Malformed/torn lines: 0');
      expect(text).toContain('Unsafe payload lines: 0');
      expect(text).toContain('Non-task-archive lines: 1');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Last action at: 2026-05-05T07:02:01.000Z');
      expect(text).toContain('Raw task ids: not rendered');
      expect(text).toContain('Raw actor ids: not rendered');
      expect(text).toContain('Raw channel ids: not rendered');
      expect(text).toContain('Raw reasons: not rendered');
      expect(text).toContain('Raw payload: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).not.toContain('SECRET-task-archive-doctor');
      expect(text).not.toContain('SECRET-task-archive-actor');
      expect(text).not.toContain('SECRET-task-archive-channel');
      expect(text).not.toContain('SECRET non-archive instruction');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes task archive evidence diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      taskArchiveEvidenceReport: {
        ledgerPath: '/tmp/auto-archive-task-archive/control-plane.jsonl',
        maxLedgerBytes: 10000,
        reportStatus: 'complete',
        recordCount: 2,
        archiveEventCount: 1,
        unarchiveEventCount: 1,
        taskScopedRecordCount: 2,
        actorAttributedRecordCount: 2,
        channelScopedRecordCount: 2,
        reasonPresentCount: 2,
        currentArchivedTaskCount: 0,
        duplicateArchiveCount: 0,
        unmatchedUnarchiveCount: 0,
        malformedLineCount: 0,
        unsafePayloadLineCount: 0,
        nonTaskArchiveLineCount: 0,
        qualityScore: 100,
        qualityScoreMax: 100,
        lastActionAt: '2026-05-05T07:02:01.000Z',
      },
    });

    expect(payload.content).toContain('[PASS] Task archive evidence report');
    expect(payload.content).toContain('Ledger: control-plane.jsonl#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain('auto-archive-task-archive');
    expect(payload.content).toContain('Raw task ids: not rendered');
    expect(payload.content).toContain('Raw actor ids: not rendered');
    expect(payload.content).toContain('Raw channel ids: not rendered');
  });

  it('contains task archive evidence failures, default guard, and redacted configuration errors', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-archive-warn-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          taskArchiveEvidenceLine('archive', 1, {
            payload: {
              archive: {
                archivedBy: 'SECRET raw archive actor must not render',
                reason: 'SECRET raw archive reason must not render',
              },
            },
          }),
          taskArchiveEvidenceLine('unarchive', 2),
          '{"schemaVersion":1,"eventId":"broken"',
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]: ledgerPath,
        }),
      );

      expect(text).toContain('[FAIL] Task archive evidence report');
      expect(text).toContain('Report status: fail');
      expect(text).toContain('Records: 1');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Unsafe payload lines: 1');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET raw archive actor');
      expect(text).not.toContain('SECRET raw archive reason');
      expect(text).not.toContain('SECRET-task-archive-doctor');

      const defaultStatus = resolveTaskArchiveEvidenceReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]: ledgerPath,
      });
      expect(defaultStatus?.maxLedgerBytes).toBe(
        TASK_ARCHIVE_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
      );

      for (const invalidMaxLedgerBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]:
              '/tmp/auto-archive-doctor-task-archive/control-plane.jsonl',
            [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES]:
              invalidMaxLedgerBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Task archive evidence report');
        expect(invalidText).toContain('Ledger: control-plane.jsonl#');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts task archive evidence IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-archive-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Task archive evidence report');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-task-archive-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor only reads retained control-plane metadata and never runs archive mutations',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only subagent operator evidence diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-subagent-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          subagentOperatorEvidenceLine('subagent.spawned', 1),
          subagentOperatorEvidenceLine('subagent.completed', 1),
          subagentOperatorEvidenceLine('roster.progress', 1),
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Subagent operator evidence report');
      expect(text).toContain('Ledger: subagent-roster-events.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Max replay bytes: 10000');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Records: 3');
      expect(text).toContain('Spawned events: 1');
      expect(text).toContain('Completed/aborted/failed events: 1/0/0');
      expect(text).toContain('Progress events: 1');
      expect(text).toContain('Terminal events: 1');
      expect(text).toContain('Subagent-scoped records: 3');
      expect(text).toContain('Parent task-scoped records: 3');
      expect(text).toContain('Parent runtime-scoped records: 3');
      expect(text).toContain('Current active subagents: 0');
      expect(text).toContain('Duplicate spawn transitions: 0');
      expect(text).toContain('Terminal-without-spawn transitions: 0');
      expect(text).toContain('Malformed/torn lines: 0');
      expect(text).toContain('Unsafe payload lines: 0');
      expect(text).toContain('Quality score: 100/100');
      expect(text).toContain('Last observed at: 2026-05-05T08:01:01.000Z');
      expect(text).toContain('Raw subagent ids: not rendered');
      expect(text).toContain('Raw task ids: not rendered');
      expect(text).toContain('Raw runtime instance ids: not rendered');
      expect(text).toContain('Raw messages: not rendered');
      expect(text).toContain('Raw artifacts: not rendered');
      expect(text).toContain('Raw payload: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).toContain('Roster mutation: none');
      expect(text).toContain('Ledger mutation: none');
      expect(text).toContain('Operator actions: none');
      expect(text).toContain('Env reload: none');
      expect(text).not.toContain('SECRET-subagent-doctor-task');
      expect(text).not.toContain('SECRET-subagent-doctor-runtime');
      expect(text).not.toContain('SECRET-subagent-doctor-id');
      expect(text).not.toContain('artifact://doctor-subagent');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes subagent operator evidence diagnostics through the Discord doctor renderer', () => {
    const payload = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: true,
      authDatabaseEnabled: true,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'codex',
      approvalRegistryEnabled: true,
      subagentOperatorEvidenceReport: {
        ledgerPath:
          '/tmp/auto-archive-subagent-doctor/subagent-roster-events.jsonl',
        maxLedgerBytes: 10000,
        reportStatus: 'complete',
        recordCount: 3,
        spawnedCount: 1,
        completedCount: 1,
        abortedCount: 0,
        failedCount: 0,
        progressCount: 1,
        terminalCount: 1,
        subagentScopedRecordCount: 3,
        parentTaskScopedRecordCount: 3,
        parentRuntimeScopedRecordCount: 3,
        currentActiveSubagentCount: 0,
        duplicateSpawnCount: 0,
        terminalWithoutSpawnCount: 0,
        malformedLineCount: 0,
        unsafePayloadLineCount: 0,
        qualityScore: 100,
        qualityScoreMax: 100,
        lastObservedAt: '2026-05-05T08:01:01.000Z',
      },
    });

    expect(payload.content).toContain('[PASS] Subagent operator evidence report');
    expect(payload.content).toContain('Ledger: subagent-roster-events.jsonl#');
    expect(payload.content).not.toContain('/tmp/');
    expect(payload.content).not.toContain('auto-archive-subagent-doctor');
    expect(payload.content).toContain('Raw subagent ids: not rendered');
    expect(payload.content).toContain('Raw runtime instance ids: not rendered');
    expect(payload.content).toContain('Live service contact: none');
    expect(payload.content).toContain('Operator actions: none');
  });

  it('contains subagent operator evidence failures, default guard, and redacted configuration errors', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-subagent-warn-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          subagentOperatorEvidenceLine('subagent.spawned', 1),
          subagentOperatorEvidenceLine('subagent.completed', 1, {
            artifact: 'SECRET raw subagent artifact must not render',
          }),
          '{"kind":"subagent.spawned","timestamp":"broken"',
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: ledgerPath,
        }),
      );

      expect(text).toContain('[FAIL] Subagent operator evidence report');
      expect(text).toContain('Report status: fail');
      expect(text).toContain('Records: 1');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Unsafe payload lines: 1');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET raw subagent artifact');
      expect(text).not.toContain('SECRET-subagent-doctor-task');

      const defaultStatus = resolveSubagentOperatorEvidenceReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: ledgerPath,
      });
      expect(defaultStatus?.maxLedgerBytes).toBe(
        SUBAGENT_OPERATOR_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
      );

      for (const invalidMaxLedgerBytes of [
        '0',
        '-1',
        '1.5',
        'abc',
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const invalidText = renderDoctorReport(
          buildDoctorReportFromEnv({
            [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]:
              '/tmp/auto-archive-doctor-subagent/subagent-roster-events.jsonl',
            [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES]:
              invalidMaxLedgerBytes,
          }),
        );

        expect(invalidText).toContain('[WARN] Subagent operator evidence report');
        expect(invalidText).toContain('Ledger: subagent-roster-events.jsonl#');
        expect(invalidText).not.toContain('/tmp/');
        expect(invalidText).toContain(
          'AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES must be a positive safe integer.',
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('redacts subagent operator evidence IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-subagent-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Subagent operator evidence report');
      expect(text).toContain('Report status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-subagent-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
      expect(text).toContain(
        '/doctor only reads retained roster metadata and never spawns, steers, kills',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only Plana advisor events ledger diagnostics when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-plana-advisor-'));
    try {
      const ledgerPath = join(workspace, 'plana-advisor-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          planaAdvisorEventJson('advisor-doctor-record-1', {
            verdictStatus: 'veto',
          }),
          '{"schemaVersion":1,"recordId":"malformed-shape"}',
          '',
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
          AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER: 'claude-agent',
          AUTO_ARCHIVE_ANTHROPIC_API_KEY: 'test-key',
          [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[WARN] Plana advisor events ledger');
      expect(text).toContain('Ledger: plana-advisor-events.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Records: 1');
      expect(text).toContain('Trend sample: insufficient');
      expect(text).toContain('Advisor vetoes: 1');
      expect(text).toContain('Advisor fail-open errors: 0');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Last recorded at: 2026-05-05T10:00:00.000Z');
      expect(text).toContain(
        'Review 1 malformed/torn advisor JSONL line(s); they were excluded from scoring.',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uses the default bounded replay guard for Plana advisor events', () => {
    const status = resolvePlanaAdvisorEventsDoctorStatusFromEnv({
      [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]:
        '/tmp/auto-archive-doctor-plana-advisor/events.jsonl',
    });

    expect(status?.maxLedgerBytes).toBe(
      PLANA_ADVISOR_EVENTS_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
    );
    expect(status?.recordCount).toBe(0);
    expect(status?.error).toBeUndefined();
  });

  it('contains Plana advisor events replay configuration failures', () => {
    const text = renderDoctorReport(
      buildDoctorReportFromEnv({
        AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
        [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]:
          '/tmp/auto-archive-doctor-plana-advisor/events.jsonl',
        [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES]: '0',
      }),
    );

    expect(text).toContain('[WARN] Plana advisor events ledger');
    expect(text).toContain('Ledger: events.jsonl#');
    expect(text).not.toContain('/tmp/auto-archive-doctor-plana-advisor');
    expect(text).not.toContain('/tmp/');
    expect(text).toContain('Replay status: failed');
    expect(text).toContain(
      'AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES must be a positive safe integer.',
    );
  });

  it('redacts Plana advisor events replay IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-plana-advisor-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
          [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Plana advisor events ledger');
      expect(text).toContain('Replay status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-plana-advisor-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only Trait scheduler tick evidence when configured', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-trait-tick-'));
    try {
      const ledgerPath = join(workspace, 'trait-scheduler-tick-evidence.jsonl');
      writeFileSync(
        ledgerPath,
        `${traitSchedulerTickEvidenceJson('doctor-record-1')}\n{"schemaVersion":1,"recordId":"malformed-shape"}\n`,
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          AUTO_ARCHIVE_CONTROL_LEDGER_PATH: 'runtime-state/control.jsonl',
          [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES]:
            '10000',
        }),
      );

      expect(text).toContain('[WARN] Trait scheduler tick evidence');
      expect(text).toContain('Ledger: trait-scheduler-tick-evidence.jsonl#');
      expect(text).not.toContain(workspace);
      expect(text).toContain('Records: 1');
      expect(text).toContain('Quality score:');
      expect(text).toContain('Trend sample: insufficient');
      expect(text).toContain('Dispatch failures: 0');
      expect(text).toContain('Checkpoint holds: 0');
      expect(text).toContain('Lease-held skips: 0');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Last recorded at: 2026-05-05T09:00:32.000Z');
      expect(text).toContain(
        'Review 1 malformed/torn JSONL line(s); they were excluded from scoring.',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('passes Trait scheduler tick evidence doctor status for a healthy sufficient sample', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-trait-tick-pass-'));
    try {
      const ledgerPath = join(workspace, 'trait-scheduler-tick-evidence.jsonl');
      writeFileSync(
        ledgerPath,
        Array.from({ length: 5 }, (_, index) =>
          traitSchedulerTickEvidenceJson(`doctor-pass-record-${String(index + 1)}`),
        ).join('\n') + '\n',
        'utf8',
      );

      const report = buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH]: ledgerPath,
      });
      const traitSchedulerSection = report.sections.find(
        (entry) => entry.name === 'Trait scheduler tick evidence',
      );

      expect(traitSchedulerSection).toBeDefined();
      expect(traitSchedulerSection?.status).toBe('pass');
      expect(traitSchedulerSection?.remediation).toBeUndefined();
      expect(traitSchedulerSection?.details).toContain('Records: 5');
      expect(traitSchedulerSection?.details).toContain('Quality score: 100/100');
      expect(traitSchedulerSection?.details).toContain('Trend sample: sufficient');
      expect(traitSchedulerSection?.details).toContain('Dispatch failures: 0');
      expect(traitSchedulerSection?.details).toContain('Checkpoint holds: 0');
      expect(traitSchedulerSection?.details).toContain('Lease-held skips: 0');
      expect(traitSchedulerSection?.details).toContain('Malformed/torn lines: 0');
      expect(traitSchedulerSection?.details).toContain(
        'Last recorded at: 2026-05-05T09:00:32.000Z',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uses the default bounded replay guard for Trait scheduler tick evidence', () => {
    const status = resolveTraitSchedulerTickEvidenceDoctorStatusFromEnv({
      [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH]:
        '/tmp/auto-archive-doctor-default-guard/evidence.jsonl',
    });

    expect(status?.maxLedgerBytes).toBe(
      TRAIT_SCHEDULER_TICK_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
    );
    expect(status?.recordCount).toBe(0);
    expect(status?.error).toBeUndefined();
  });

  it('contains Trait scheduler tick evidence replay configuration failures', () => {
    const text = renderDoctorReport(
      buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH]:
          '/tmp/auto-archive-doctor-trait-tick/evidence.jsonl',
        [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES]: '0',
      }),
    );

    expect(text).toContain('[WARN] Trait scheduler tick evidence');
    expect(text).toContain('Ledger: evidence.jsonl#');
    expect(text).not.toContain('/tmp/auto-archive-doctor-trait-tick');
    expect(text).not.toContain('/tmp/');
    expect(text).toContain('Replay status: failed');
    expect(text).toContain(
      'AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES must be a positive safe integer.',
    );
  });

  it('redacts Trait scheduler tick evidence replay IO failure paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-trait-tick-dir-'));
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH]: workspace,
        }),
      );

      expect(text).toContain('[WARN] Trait scheduler tick evidence');
      expect(text).toContain('Replay status: failed');
      expect(text).toContain('Ledger: auto-archive-doctor-trait-tick-dir-');
      expect(text).not.toContain(`${workspace}/`);
      expect(text).not.toContain('/tmp/');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders GitLab task project README metadata and terminal warning provenance', () => {
    const p = plan('task-gitlab-readme');
    const e = evidence('task-gitlab-readme');
    const readme = renderGitLabTaskProjectReadme({
      plan: p,
      evidence: e,
      artifactPublication: {
        kind: 'commit-created',
        projectId: 42,
        branch: 'main',
        commitId: 'commit',
        destinationPrefix: 'artifacts/task-gitlab-readme',
        publishedFiles: ['artifacts/task-gitlab-readme/package.json'],
      },
    });
    expect(readme).toContain('Task ID: `task-gitlab-readme`');
    expect(readme).toContain('Optional test command: npm test');

    const issue = renderGitLabWorkResultMarkdown(p, e);
    expect(issue).toContain('## Terminal evidence');
    expect(issue).toContain('plana-tool-loop-detector');
    expect(issue).toContain('## Operator follow-up');
  });
});
