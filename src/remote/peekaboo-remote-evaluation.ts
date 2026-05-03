import { resolve } from 'node:path';

export const PEEKABOO_EVALUATION_PROTOCOL_VERSION = '2026-04-25';

export const PEEKABOO_DEFAULTS = Object.freeze({
  helperScript: 'scripts/agent-node-discord-direct-control.mjs',
  evidenceDirectory: 'results/peekaboo-remote-evals',
  channelId: '1483826614335836170',
  guildId: '1476114038743367713',
  sshHost: 'chevalgrand@100.85.156.3',
  sshKey: 'resource/ssh/key',
  expectedAronaAuthorId: '1476113538320957451',
  expectedPlanaAuthorId: '1494347028971655238',
  polls: 12,
  pollMs: 5000,
  maxTurns: 15,
});

export const PEEKABOO_CONTROL_MODES = Object.freeze([
  'slash-ask',
  'slash-status',
  'slash-cancel',
  'slash-focus',
  'slash-unfocus',
  'message',
  'natural-ask',
] as const);

export type PeekabooControlMode = (typeof PEEKABOO_CONTROL_MODES)[number];

export const PEEKABOO_POLL_MODES = Object.freeze([
  'auto',
  'marker',
  'after-start',
  'task-lifecycle',
  'command-response',
] as const);

export type PeekabooPollMode = (typeof PEEKABOO_POLL_MODES)[number];

export const PEEKABOO_COMMAND_SELECT_MODES = Object.freeze([
  'return',
  'click',
] as const);

export type PeekabooCommandSelectMode =
  (typeof PEEKABOO_COMMAND_SELECT_MODES)[number];

export const PEEKABOO_EXECUTION_MODES = Object.freeze([
  'dry-run',
  'probe',
  'live',
] as const);

export type PeekabooExecutionMode = (typeof PEEKABOO_EXECUTION_MODES)[number];

export const PEEKABOO_BATCH_EXECUTION_MODES = Object.freeze([
  'precheck',
  'live',
] as const);

export type PeekabooBatchExecutionMode =
  (typeof PEEKABOO_BATCH_EXECUTION_MODES)[number];

export const PEEKABOO_BATCH_MIN_TURNS = 5;
export const PEEKABOO_BATCH_MAX_TURNS = 10;

export const PEEKABOO_READINESS_LABELS = Object.freeze([
  'CONFIG_OK',
  'SSH_OK',
  'BRIDGE_PRESENT',
  'PROXY_READY',
  'SUBMIT_READY',
  'LIVE_OK',
] as const);

export type PeekabooReadinessLabel = (typeof PEEKABOO_READINESS_LABELS)[number];

export const PEEKABOO_READINESS_STATUSES = Object.freeze([
  'ready',
  'failed',
  'unknown',
  'skipped',
] as const);

export type PeekabooReadinessStatus =
  (typeof PEEKABOO_READINESS_STATUSES)[number];

export const PEEKABOO_EVIDENCE_STATUSES = Object.freeze([
  'captured',
  'attempted',
  'missing',
  'weak',
  'skipped',
] as const);

export type PeekabooEvidenceStatus = (typeof PEEKABOO_EVIDENCE_STATUSES)[number];

export const PEEKABOO_EVIDENCE_MATCH_SIGNALS = Object.freeze([
  'marker',
  'task-id',
  'author',
  'timing',
  'lifecycle-shape',
] as const);

export type PeekabooEvidenceMatchSignal =
  (typeof PEEKABOO_EVIDENCE_MATCH_SIGNALS)[number];

export const PEEKABOO_EVIDENCE_CORRELATION_SCORES = Object.freeze([
  'strong',
  'moderate',
  'weak',
  'none',
] as const);

export type PeekabooEvidenceCorrelationScore =
  (typeof PEEKABOO_EVIDENCE_CORRELATION_SCORES)[number];

export interface PeekabooEvidenceScoringFactor {
  readonly signal: PeekabooEvidenceMatchSignal;
  readonly explanation: string;
}

export interface PeekabooEvidenceObservation {
  readonly observedAt?: string;
  readonly source?: string;
  readonly messageId?: string;
  readonly authorId?: string;
  readonly taskId?: string;
  readonly marker?: string;
  readonly matchedOn?: readonly PeekabooEvidenceMatchSignal[];
}

export interface PeekabooEvidenceStage {
  readonly status: PeekabooEvidenceStatus;
  readonly summary: string;
  readonly observedAt?: string;
  readonly source?: string;
  readonly messageId?: string;
  readonly authorId?: string;
  readonly taskId?: string;
  readonly marker?: string;
  readonly matchedOn?: readonly PeekabooEvidenceMatchSignal[];
  readonly correlationScore?: PeekabooEvidenceCorrelationScore;
  readonly scoringFactors?: readonly PeekabooEvidenceScoringFactor[];
}

export interface PeekabooEvidenceAudit {
  readonly marker?: string;
  readonly expectedTaskId?: string;
  readonly submit: PeekabooEvidenceStage;
  readonly taskCorrelation: PeekabooEvidenceStage;
  readonly ack: PeekabooEvidenceStage;
  readonly matchedReply: PeekabooEvidenceStage;
}

export interface PeekabooReadinessError {
  readonly code?: string;
  readonly message: string;
  readonly domain?: string;
  readonly retryable?: boolean;
  readonly remediations: readonly string[];
}

export interface PeekabooReadinessCheck {
  readonly label: PeekabooReadinessLabel;
  readonly status: PeekabooReadinessStatus;
  readonly summary: string;
  readonly error?: PeekabooReadinessError;
}

export interface PeekabooReadinessReport {
  readonly phase: PeekabooExecutionMode;
  readonly overallStatus: PeekabooReadinessStatus;
  readonly highestReady: PeekabooReadinessLabel | null;
  readonly proxyReady: boolean;
  readonly probeProxyReady: boolean;
  readonly liveProxyReady: boolean;
  readonly submitReady: boolean;
  readonly liveOk: boolean;
  readonly liveSubmitPerformed: boolean;
  readonly matchedReplyObserved: boolean;
  readonly evidence: PeekabooEvidenceAudit;
  readonly checks: readonly PeekabooReadinessCheck[];
  readonly summary: string;
}

export interface PeekabooReadinessReportInput {
  readonly phase: PeekabooExecutionMode;
  readonly configOk?: boolean;
  readonly sshOk?: boolean;
  readonly bridgePresent?: boolean;
  readonly proxyReady?: boolean;
  readonly probeProxyReady?: boolean;
  readonly liveProxyReady?: boolean;
  readonly submitAttempted?: boolean;
  readonly controlOk?: boolean;
  readonly restObservationAttempted?: boolean;
  readonly matchedReplyObserved?: boolean;
  readonly marker?: string;
  readonly expectedTaskId?: string;
  readonly ack?: PeekabooEvidenceObservation;
  readonly matchedReply?: PeekabooEvidenceObservation;
  readonly relatedReplyCount?: number;
  readonly error?: unknown;
}

export interface PeekabooEvaluationStandard {
  readonly protocolVersion: string;
  readonly authority: string;
  readonly purpose: readonly string[];
  readonly nonGoals: readonly string[];
  readonly readinessGates: readonly string[];
  readonly stages: readonly string[];
  readonly evidencePacketFields: readonly string[];
  readonly passRubric: readonly string[];
  readonly warnRubric: readonly string[];
  readonly failRubric: readonly string[];
  readonly helperScript: string;
  readonly mcpTools: readonly string[];
}

export const PEEKABOO_REMOTE_EVALUATION_STANDARD: PeekabooEvaluationStandard =
  Object.freeze({
    protocolVersion: PEEKABOO_EVALUATION_PROTOCOL_VERSION,
    authority: 'specs/GUIDES/peekaboo-remote-evaluation-mcp.md',
    purpose: Object.freeze([
      'Use the real macOS agent-node GUI path through Peekaboo to create user-authored Discord actions.',
      'Treat Discord REST as observation/evidence only, never as a substitute for user-authored GUI input.',
      'Run a single-turn readiness smoke before bounded multi-turn/adaptive evaluation.',
      'Save marker-correlated evidence packets that can be replayed or audited.',
    ]),
    nonGoals: Object.freeze([
      'Do not send user messages with a bot token.',
      'Do not treat local simulator output as actual Discord GUI evidence.',
      'Do not run live remote GUI mutation unless the caller explicitly opts in.',
    ]),
    readinessGates: Object.freeze([
      'PROJECT.md project_metadata.status is ACTIVE.',
      'macOS agent node is reachable by SSH.',
      'Discord desktop app is logged in and can access the target channel.',
      'desktop-control-bridge.json is fresh and points at a ready Peekaboo proxy.',
      'accessibilityTrusted and screenRecordingAuthorized are true on the macOS host.',
      'Target Arona/Plana bot runtime is available for the selected evaluation path.',
    ]),
    stages: Object.freeze([
      'Plan: choose runId, bounded turn count, target role, marker policy, and evidence path.',
      'Readiness: verify host/UI/bot preconditions before mutation.',
      'Single-turn smoke: submit one GUI-authored action and require correlated bot evidence.',
      'Escalation: continue to bounded multi-turn evaluation only after smoke passes.',
      'Evidence closeout: persist user messages, bot replies, timestamps, authors, tool steps, and PASS/WARN/FAIL outcome.',
    ]),
    evidencePacketFields: Object.freeze([
      'protocolVersion',
      'runId',
      'turnMarker',
      'correlationId',
      'channelId',
      'mode',
      'userMessage',
      'expectedAuthorId',
      'expectedTaskId',
      'startedAt',
      'controlSteps',
      'evidence',
      'artifactPath',
      'matchedReply',
      'relatedMessages',
      'outcome',
    ]),
    passRubric: Object.freeze([
      'Remote GUI control succeeded through SSH + Peekaboo + Discord desktop.',
      'Exactly the intended user-authored action was submitted.',
      'Expected bot reply or task lifecycle evidence is correlated by marker/task id/author.',
      'Evidence packet is saved without secrets.',
    ]),
    warnRubric: Object.freeze([
      'GUI submission succeeded but evidence is indirect or weak.',
      'Text input degraded to type fallback or needed retry.',
      'Bot replied but did not fully satisfy the turn rubric.',
    ]),
    failRubric: Object.freeze([
      'macOS host, bridge, or Discord UI is not reachable.',
      'No user-authored Discord action appears after GUI submission.',
      'Expected bot reply is missing after timeout.',
      'Bot-authored or REST-authored content was used as a substitute for user input.',
      'The run claims success without marker/task evidence.',
    ]),
    helperScript: PEEKABOO_DEFAULTS.helperScript,
    mcpTools: Object.freeze([
      'peekaboo_remote_eval_standard',
      'peekaboo_remote_eval_plan',
      'peekaboo_remote_eval_batch_plan',
      'peekaboo_remote_eval_run_turn',
      'peekaboo_remote_eval_evidence_append',
      'peekaboo_remote_eval_evidence_query',
    ]),
  });

export interface PeekabooEvaluationPlanInput {
  readonly runId: string;
  readonly goal?: string;
  readonly maxTurns?: number;
  readonly channelId?: string;
  readonly target?: 'arona' | 'plana' | 'mixed';
  readonly firstMode?: PeekabooControlMode;
  readonly evidenceDirectory?: string;
}

export interface PeekabooEvaluationPlan {
  readonly protocolVersion: string;
  readonly runId: string;
  readonly goal: string;
  readonly maxTurns: number;
  readonly channelId: string;
  readonly target: 'arona' | 'plana' | 'mixed';
  readonly firstMode: PeekabooControlMode;
  readonly evidencePath: string;
  readonly markers: readonly string[];
  readonly requiredGates: readonly string[];
  readonly firstTurn: PeekabooTurnPlan;
  readonly closeout: readonly string[];
}

export interface PeekabooTurnPlan {
  readonly turnNumber: number;
  readonly marker: string;
  readonly mode: PeekabooControlMode;
  readonly pollMode: PeekabooPollMode;
  readonly expectedAuthorId?: string;
  readonly instructionTemplate: string;
}

export interface PeekabooBatchPrecheckProof {
  readonly probeRunId: string;
  readonly probeTurnMarker: string;
  readonly probeProxyReady: boolean;
  readonly submitReady: boolean;
  readonly recordedAt?: string;
}

export interface PeekabooBatchPlanInput {
  readonly runId: string;
  readonly executionMode: PeekabooBatchExecutionMode;
  readonly goal?: string;
  readonly maxTurns?: number;
  readonly channelId?: string;
  readonly target?: 'arona' | 'plana' | 'mixed';
  readonly firstMode?: PeekabooControlMode;
  readonly evidenceDirectory?: string;
  readonly allowLive?: boolean;
  readonly probe?: boolean;
  readonly precheckOnly?: boolean;
  readonly precheck?: PeekabooBatchPrecheckProof;
}

export interface PeekabooBatchPrecheckPlan {
  readonly marker: string;
  readonly correlationId: string;
  readonly mode: PeekabooControlMode;
  readonly pollMode: PeekabooPollMode;
  readonly expectedAuthorId?: string;
  readonly instructionTemplate: string;
  readonly command: PeekabooTurnCommand;
}

export interface PeekabooBatchTurnPlan {
  readonly turnNumber: number;
  readonly marker: string;
  readonly correlationId: string;
  readonly mode: PeekabooControlMode;
  readonly pollMode: PeekabooPollMode;
  readonly expectedAuthorId?: string;
  readonly instructionTemplate: string;
  readonly command: PeekabooTurnCommand;
}

export interface PeekabooBatchPlan {
  readonly protocolVersion: string;
  readonly runId: string;
  readonly goal: string;
  readonly maxTurns: number;
  readonly channelId: string;
  readonly target: 'arona' | 'plana' | 'mixed';
  readonly mode: PeekabooControlMode;
  readonly executionMode: PeekabooBatchExecutionMode;
  readonly evidencePath: string;
  readonly plannedTurnMarkers: readonly string[];
  readonly requiredGates: readonly string[];
  readonly autonomousExecution: false;
  readonly precheckCommand?: PeekabooBatchPrecheckPlan;
  readonly precheckProof?: PeekabooBatchPrecheckProof;
  readonly turns: readonly PeekabooBatchTurnPlan[];
  readonly closeout: readonly string[];
  readonly safetyNotes: readonly string[];
}

export interface PeekabooTurnCommandInput {
  readonly repoRoot?: string;
  readonly helperScript?: string;
  readonly runId: string;
  readonly turnNumber?: number;
  readonly marker?: string;
  readonly mode?: PeekabooControlMode;
  readonly message: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly expectAuthor?: string;
  readonly expectTaskId?: string;
  readonly pollMode?: PeekabooPollMode;
  readonly polls?: number;
  readonly pollMs?: number;
  readonly commandSelect?: PeekabooCommandSelectMode;
  readonly mentionUserId?: string;
  readonly naturalAddress?: string;
  readonly sshHost?: string;
  readonly sshKey?: string;
  readonly remoteRoot?: string;
  readonly remoteNode?: string;
  readonly bridgePath?: string;
  readonly envFile?: string;
  readonly botTokenEnv?: string;
  readonly noRest?: boolean;
  readonly debugSteps?: boolean;
  readonly dryRun?: boolean;
  readonly probe?: boolean;
  readonly allowLive?: boolean;
}

export interface PeekabooTurnCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly marker: string;
  readonly mode: PeekabooControlMode;
  readonly pollMode: PeekabooPollMode;
  readonly executionMode: PeekabooExecutionMode;
  readonly dryRun: boolean;
  readonly probe: boolean;
  readonly mutatesRemoteGui: boolean;
  readonly evidenceExpectation: string;
}

const PEEKABOO_TIMEOUT_PATTERN = /\b(?:timed out|timeout|ETIMEDOUT)\b/iu;

function isReadinessStatus(value: string): value is PeekabooReadinessStatus {
  return (PEEKABOO_READINESS_STATUSES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function mapPeekabooRemediations(error: {
  readonly code?: string;
  readonly message?: string;
  readonly domain?: string;
  readonly retryable?: boolean;
}): readonly string[] {
  const code = error.code?.trim();
  const message = error.message?.trim() ?? '';
  const domain = error.domain?.trim();
  const hints: string[] = [];

  if (code === 'PEEKABOO_LIST_TOOLS_FAILED') {
    hints.push(
      'Run the helper with --probe before live submit to verify proxy tool-list readiness without mutating Discord.',
      'Refresh or recreate desktop-control-bridge.json on the macOS host, then confirm it points at the current Peekaboo proxy socket.',
      'Restart the Peekaboo proxy or bridge service if tool listing continues to time out.',
    );
  }

  if (
    domain === 'TRANSPORT' ||
    PEEKABOO_TIMEOUT_PATTERN.test(message) ||
    /ECONNREFUSED|ENOENT|socket/i.test(message)
  ) {
    hints.push(
      'Verify SSH reachability, remote host load, and that the Peekaboo proxy socket from the bridge file is reachable.',
      'Retry after the transport path recovers; transport timeout-like failures are usually transient.',
    );
  }

  if (/ENOENT|not found/i.test(message)) {
    hints.push(
      'Confirm the bridge file and referenced proxy socket path both exist on the remote host.',
    );
  }

  if (/ECONNREFUSED|connection refused/i.test(message)) {
    hints.push(
      'Start or restart the Peekaboo proxy server on the remote host before retrying.',
    );
  }

  if (error.retryable === false && code === 'PEEKABOO_INIT_FAILED') {
    hints.push(
      'Inspect the remote desktop-control bridge and Peekaboo proxy logs before retrying live control.',
    );
  }

  if (hints.length === 0) {
    hints.push(
      'Re-run the helper with --probe to isolate readiness failures before attempting live Discord submission.',
    );
  }

  return uniqueStrings(hints);
}

export function normalizePeekabooReadinessError(
  error: unknown,
): PeekabooReadinessError | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error === 'string') {
    return {
      message: error,
      remediations: mapPeekabooRemediations({ message: error }),
    };
  }

  const record = asRecord(error);
  const message =
    typeof record.message === 'string'
      ? record.message
      : error instanceof Error
        ? error.message
        : String(error);
  if (message.trim().length === 0) {
    return undefined;
  }

  const code =
    typeof record.code === 'string' && record.code.trim().length > 0
      ? record.code
      : undefined;
  const domain =
    typeof record.domain === 'string' && record.domain.trim().length > 0
      ? record.domain
      : undefined;
  const retryable =
    typeof record.retryable === 'boolean' ? record.retryable : undefined;

  return {
    ...(code === undefined ? {} : { code }),
    message,
    ...(domain === undefined ? {} : { domain }),
    ...(retryable === undefined ? {} : { retryable }),
    remediations: mapPeekabooRemediations({
      ...(code === undefined ? {} : { code }),
      message,
      ...(domain === undefined ? {} : { domain }),
      ...(retryable === undefined ? {} : { retryable }),
    }),
  };
}

function readinessStatusFromBoolean(
  value: boolean | undefined,
  fallback: PeekabooReadinessStatus = 'unknown',
): PeekabooReadinessStatus {
  if (value === true) {
    return 'ready';
  }
  if (value === false) {
    return 'failed';
  }
  return fallback;
}

function resolveProxyReadinessFields(input: {
  readonly phase: PeekabooExecutionMode;
  readonly proxyReady?: boolean;
  readonly probeProxyReady?: boolean;
  readonly liveProxyReady?: boolean;
}): {
  readonly proxyStatus: PeekabooReadinessStatus;
  readonly proxyReady: boolean;
  readonly probeProxyReady: boolean;
  readonly liveProxyReady: boolean;
} {
  const probeProxyReady =
    input.probeProxyReady ?? (input.phase === 'probe' ? input.proxyReady : undefined);
  const liveProxyReady =
    input.liveProxyReady ?? (input.phase === 'live' ? input.proxyReady : undefined);
  const phaseSpecificProxyReady =
    input.phase === 'probe'
      ? probeProxyReady
      : input.phase === 'live'
        ? liveProxyReady
        : undefined;

  return {
    proxyStatus:
      input.phase === 'dry-run'
        ? 'unknown'
        : readinessStatusFromBoolean(phaseSpecificProxyReady),
    proxyReady: phaseSpecificProxyReady === true,
    probeProxyReady: probeProxyReady === true,
    liveProxyReady: liveProxyReady === true,
  };
}

function isEvidenceStatus(value: string): value is PeekabooEvidenceStatus {
  return (PEEKABOO_EVIDENCE_STATUSES as readonly string[]).includes(value);
}

function isEvidenceMatchSignal(
  value: string,
): value is PeekabooEvidenceMatchSignal {
  return (PEEKABOO_EVIDENCE_MATCH_SIGNALS as readonly string[]).includes(value);
}

function cloneEvidenceObservation(
  observation: PeekabooEvidenceObservation,
): PeekabooEvidenceObservation {
  return {
    ...observation,
    matchedOn:
      observation.matchedOn === undefined ? undefined : [...observation.matchedOn],
  };
}

function cloneEvidenceStage(stage: PeekabooEvidenceStage): PeekabooEvidenceStage {
  return {
    ...stage,
    matchedOn: stage.matchedOn === undefined ? undefined : [...stage.matchedOn],
    scoringFactors:
      stage.scoringFactors === undefined
        ? undefined
        : stage.scoringFactors.map((factor) => ({ ...factor })),
  };
}

function isEvidenceCorrelationScore(
  value: string,
): value is PeekabooEvidenceCorrelationScore {
  return (
    PEEKABOO_EVIDENCE_CORRELATION_SCORES as readonly string[]
  ).includes(value);
}

function hasStrongEvidenceSignal(
  observation: PeekabooEvidenceObservation | undefined,
  expectedTaskId: string | undefined,
): boolean {
  if (observation === undefined) {
    return false;
  }
  if (
    expectedTaskId !== undefined &&
    observation.taskId !== undefined &&
    observation.taskId === expectedTaskId
  ) {
    return true;
  }
  if (expectedTaskId === undefined && observation.taskId !== undefined) {
    return true;
  }
  return (
    observation.matchedOn?.some(
      (signal) => signal === 'task-id' || signal === 'marker',
    ) ?? false
  );
}

function collectObservedEvidenceSignals(input: {
  readonly observation: PeekabooEvidenceObservation | undefined;
  readonly expectedTaskId?: string;
  readonly marker?: string;
}): readonly PeekabooEvidenceMatchSignal[] {
  const { observation } = input;
  if (observation === undefined) {
    return [];
  }

  const observedSignals = new Set<PeekabooEvidenceMatchSignal>(
    observation.matchedOn ?? [],
  );

  if (
    input.marker !== undefined &&
    observation.marker !== undefined &&
    observation.marker === input.marker
  ) {
    observedSignals.add('marker');
  }

  if (
    observation.taskId !== undefined &&
    (input.expectedTaskId === undefined || observation.taskId === input.expectedTaskId)
  ) {
    observedSignals.add('task-id');
  }

  return PEEKABOO_EVIDENCE_MATCH_SIGNALS.filter((signal) =>
    observedSignals.has(signal),
  );
}

function explainScoringFactor(
  signal: PeekabooEvidenceMatchSignal,
  expectedTaskId: string | undefined,
): string {
  switch (signal) {
    case 'marker':
      return 'Observed the expected turn marker in the correlated evidence.';
    case 'task-id':
      return expectedTaskId === undefined
        ? 'Observed a Discord task id in the correlated evidence.'
        : 'Observed the expected Discord task id in the correlated evidence.';
    case 'author':
      return 'Observed the expected author as a supporting correlation signal.';
    case 'timing':
      return 'Observed timing alignment with the live submit window as supporting evidence.';
    case 'lifecycle-shape':
      return 'Observed the expected task lifecycle shape as supporting evidence.';
  }
}

function assessTaskCorrelation(input: {
  readonly observation: PeekabooEvidenceObservation | undefined;
  readonly expectedTaskId?: string;
  readonly marker?: string;
}): {
  readonly correlationScore: PeekabooEvidenceCorrelationScore;
  readonly scoringFactors: readonly PeekabooEvidenceScoringFactor[];
} {
  const observedSignals = collectObservedEvidenceSignals(input);
  const correlationScore: PeekabooEvidenceCorrelationScore =
    observedSignals.includes('marker') || observedSignals.includes('task-id')
      ? 'strong'
      : observedSignals.length >= 2
        ? 'moderate'
        : observedSignals.length === 1
          ? 'weak'
          : 'none';

  return {
    correlationScore,
    scoringFactors: observedSignals.map((signal) => ({
      signal,
      explanation: explainScoringFactor(signal, input.expectedTaskId),
    })),
  };
}

function buildEvidenceStage(
  observation: PeekabooEvidenceObservation | undefined,
  status: PeekabooEvidenceStatus,
  summary: string,
  metadata?: {
    readonly correlationScore?: PeekabooEvidenceCorrelationScore;
    readonly scoringFactors?: readonly PeekabooEvidenceScoringFactor[];
  },
): PeekabooEvidenceStage {
  return {
    status,
    summary,
    observedAt: observation?.observedAt,
    source: observation?.source,
    messageId: observation?.messageId,
    authorId: observation?.authorId,
    taskId: observation?.taskId,
    marker: observation?.marker,
    matchedOn: observation?.matchedOn,
    correlationScore: metadata?.correlationScore,
    scoringFactors:
      metadata?.scoringFactors === undefined
        ? undefined
        : [...metadata.scoringFactors],
  };
}

export function buildPeekabooEvidenceAudit(input: {
  readonly phase: PeekabooExecutionMode;
  readonly marker?: string;
  readonly expectedTaskId?: string;
  readonly submitAttempted?: boolean;
  readonly restObservationAttempted?: boolean;
  readonly ack?: PeekabooEvidenceObservation;
  readonly matchedReply?: PeekabooEvidenceObservation;
  readonly relatedReplyCount?: number;
}): PeekabooEvidenceAudit {
  const ack = input.ack ?? input.matchedReply;
  const matchedReply = input.matchedReply;
  const livePhase = input.phase === 'live';
  const submitAttempted = input.submitAttempted === true;
  const relatedReplyCount = input.relatedReplyCount ?? 0;
  const restObservationAttempted = input.restObservationAttempted !== false;

  const submit = buildEvidenceStage(
    undefined,
    !livePhase ? 'skipped' : submitAttempted ? 'attempted' : 'missing',
    !livePhase
      ? 'No live Discord submission was attempted in this phase.'
      : submitAttempted
        ? 'Live Discord submit was attempted through the remote GUI path.'
        : 'Live Discord submit was not observed.',
  );

  const ackStatus = !livePhase
    ? 'skipped'
    : !submitAttempted
      ? 'missing'
      : !restObservationAttempted
        ? 'missing'
        : ack === undefined
          ? relatedReplyCount > 0
            ? 'weak'
            : 'missing'
          : hasStrongEvidenceSignal(ack, input.expectedTaskId)
            ? 'captured'
            : 'weak';
  const ackSummary =
    ackStatus === 'skipped'
      ? 'Acknowledgement capture was skipped outside live execution.'
      : ackStatus === 'captured'
        ? 'Acknowledgement evidence was captured with task-id or marker correlation.'
        : ackStatus === 'weak'
          ? ack === undefined
            ? 'Bot replies were observed after submit, but no acknowledgement could be strongly correlated.'
            : 'Acknowledgement evidence was observed, but only indirect correlation signals were available.'
          : !restObservationAttempted
            ? 'REST observation was skipped, so acknowledgement evidence could not be captured.'
            : 'No acknowledgement evidence was captured after live submit.';

  const matchedReplyStatus = !livePhase
    ? 'skipped'
    : !submitAttempted
      ? 'missing'
      : !restObservationAttempted
        ? 'missing'
        : matchedReply === undefined
          ? relatedReplyCount > 0
            ? 'weak'
            : 'missing'
          : hasStrongEvidenceSignal(matchedReply, input.expectedTaskId)
            ? 'captured'
            : 'weak';
  const matchedReplySummary =
    matchedReplyStatus === 'skipped'
      ? 'Matched-reply capture was skipped outside live execution.'
      : matchedReplyStatus === 'captured'
        ? 'Matched reply evidence was captured with task-id or marker correlation.'
        : matchedReplyStatus === 'weak'
          ? matchedReply === undefined
            ? 'Related replies were observed after submit, but none satisfied the matched-reply gate.'
            : 'Matched reply evidence was observed, but only indirect correlation signals were available.'
          : !restObservationAttempted
            ? 'REST observation was skipped, so matched-reply evidence could not be captured.'
            : 'No matched reply evidence was captured after live submit.';

  const taskCorrelationObservation =
    matchedReply !== undefined && matchedReply.taskId !== undefined
      ? matchedReply
      : ack;
  const taskCorrelationStatus = !livePhase
    ? 'skipped'
    : !submitAttempted
      ? 'missing'
      : taskCorrelationObservation === undefined
        ? relatedReplyCount > 0 && input.marker !== undefined
          ? 'weak'
          : 'missing'
        : hasStrongEvidenceSignal(taskCorrelationObservation, input.expectedTaskId)
          ? 'captured'
          : 'weak';
  const taskCorrelationSummary =
    taskCorrelationStatus === 'skipped'
      ? 'Task correlation was skipped outside live execution.'
      : taskCorrelationStatus === 'captured'
        ? 'Task correlation was captured from acknowledgement or reply evidence.'
      : taskCorrelationStatus === 'weak'
          ? 'Task correlation relied on indirect evidence such as marker-only or timing-only matches.'
          : 'No task-correlated acknowledgement or reply evidence was captured.';
  const taskCorrelationAssessment = assessTaskCorrelation({
    observation: taskCorrelationObservation,
    expectedTaskId: input.expectedTaskId,
    marker: input.marker,
  });

  return {
    marker: input.marker,
    expectedTaskId: input.expectedTaskId,
    submit,
    taskCorrelation: buildEvidenceStage(
      taskCorrelationObservation,
      taskCorrelationStatus,
      taskCorrelationSummary,
      taskCorrelationAssessment,
    ),
    ack: buildEvidenceStage(ack, ackStatus, ackSummary),
    matchedReply: buildEvidenceStage(
      matchedReply,
      matchedReplyStatus,
      matchedReplySummary,
    ),
  };
}

function parseEvidenceObservation(value: unknown): PeekabooEvidenceObservation | undefined {
  const record = asRecord(value);
  const matchedOn = Array.isArray(record.matchedOn)
    ? record.matchedOn
        .filter((entry): entry is string => typeof entry === 'string')
        .filter((entry): entry is PeekabooEvidenceMatchSignal =>
          isEvidenceMatchSignal(entry),
        )
    : undefined;
  if (
    typeof record.observedAt !== 'string' &&
    typeof record.source !== 'string' &&
    typeof record.messageId !== 'string' &&
    typeof record.authorId !== 'string' &&
    typeof record.taskId !== 'string' &&
    typeof record.marker !== 'string' &&
    matchedOn === undefined
  ) {
    return undefined;
  }
  return {
    ...(typeof record.observedAt === 'string' ? { observedAt: record.observedAt } : {}),
    ...(typeof record.source === 'string' ? { source: record.source } : {}),
    ...(typeof record.messageId === 'string' ? { messageId: record.messageId } : {}),
    ...(typeof record.authorId === 'string' ? { authorId: record.authorId } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.marker === 'string' ? { marker: record.marker } : {}),
    ...(matchedOn === undefined ? {} : { matchedOn }),
  };
}

function parseEvidenceStage(value: unknown): PeekabooEvidenceStage | undefined {
  const record = asRecord(value);
  if (
    typeof record.status !== 'string' ||
    !isEvidenceStatus(record.status) ||
    typeof record.summary !== 'string'
  ) {
    return undefined;
  }
  const observation = parseEvidenceObservation(record);
  const correlationScore =
    typeof record.correlationScore === 'string' &&
    isEvidenceCorrelationScore(record.correlationScore)
      ? record.correlationScore
      : undefined;
  const scoringFactors = Array.isArray(record.scoringFactors)
    ? record.scoringFactors
        .map((entry) => {
          const factor = asRecord(entry);
          return typeof factor.signal === 'string' &&
            isEvidenceMatchSignal(factor.signal) &&
            typeof factor.explanation === 'string'
            ? {
                signal: factor.signal,
                explanation: factor.explanation,
              }
            : undefined;
        })
        .filter(
          (
            factor,
          ): factor is PeekabooEvidenceScoringFactor => factor !== undefined,
        )
    : undefined;
  return {
    status: record.status,
    summary: record.summary,
    ...(observation === undefined ? {} : observation),
    ...(correlationScore === undefined ? {} : { correlationScore }),
    ...(scoringFactors === undefined ? {} : { scoringFactors }),
  };
}

export function parsePeekabooEvidenceAudit(
  value: unknown,
): PeekabooEvidenceAudit | undefined {
  const record = asRecord(value);
  const submit = parseEvidenceStage(record.submit);
  const taskCorrelation = parseEvidenceStage(record.taskCorrelation);
  const ack = parseEvidenceStage(record.ack);
  const matchedReply = parseEvidenceStage(record.matchedReply);
  if (
    submit === undefined ||
    taskCorrelation === undefined ||
    ack === undefined ||
    matchedReply === undefined
  ) {
    return undefined;
  }
  return {
    ...(typeof record.marker === 'string' ? { marker: record.marker } : {}),
    ...(typeof record.expectedTaskId === 'string'
      ? { expectedTaskId: record.expectedTaskId }
      : {}),
    submit: cloneEvidenceStage(submit),
    taskCorrelation: cloneEvidenceStage(taskCorrelation),
    ack: cloneEvidenceStage(ack),
    matchedReply: cloneEvidenceStage(matchedReply),
  };
}

function summarizeReadiness(
  phase: PeekabooExecutionMode,
  overallStatus: PeekabooReadinessStatus,
  submitReady: boolean,
  liveOk: boolean,
): string {
  if (phase === 'dry-run') {
    return 'Dry-run preview only; live readiness was not probed and no Discord submission occurred.';
  }
  if (phase === 'probe') {
    return submitReady
      ? 'Probe confirmed submit readiness without performing a live Discord submission.'
      : overallStatus === 'failed'
        ? 'Probe found a readiness failure before live Discord submission.'
        : 'Probe completed without enough evidence to declare live submit readiness.';
  }
  if (liveOk) {
    return 'Live control reached the expected evidence gate.';
  }
  if (submitReady) {
    return 'Live submit path ran, but end-to-end evidence did not satisfy the matched-reply gate.';
  }
  return 'Live run stopped before a fully ready Discord submission path was confirmed.';
}

function errorTargetLabel(
  phase: PeekabooExecutionMode,
  error: PeekabooReadinessError | undefined,
  submitAttempted: boolean,
): PeekabooReadinessLabel | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (
    error.code === 'PEEKABOO_LIST_TOOLS_FAILED' ||
    error.code === 'PEEKABOO_INIT_FAILED' ||
    error.code === 'PEEKABOO_NOT_READY' ||
    error.code === 'PEEKABOO_INVALID_RESPONSE'
  ) {
    return 'PROXY_READY';
  }
  if (/ssh|connecttimeout|host key|permission denied/i.test(error.message)) {
    return 'SSH_OK';
  }
  if (phase === 'live' && submitAttempted) {
    return 'LIVE_OK';
  }
  return phase === 'live' ? 'SUBMIT_READY' : 'PROXY_READY';
}

export function buildPeekabooReadinessReport(
  input: PeekabooReadinessReportInput,
): PeekabooReadinessReport {
  const phase = input.phase;
  const normalizedError = normalizePeekabooReadinessError(input.error);
  const proxyReadiness = resolveProxyReadinessFields(input);
  const configStatus = input.configOk === false ? 'failed' : 'ready';
  const sshStatus =
    phase === 'dry-run'
      ? 'unknown'
      : readinessStatusFromBoolean(input.sshOk);
  const bridgeStatus =
    phase === 'dry-run'
      ? 'unknown'
      : readinessStatusFromBoolean(input.bridgePresent);
  const proxyStatus = proxyReadiness.proxyStatus;
  const prereqStatuses = [configStatus, sshStatus, bridgeStatus, proxyStatus];
  const prereqsReady = prereqStatuses.every((status) => status === 'ready');
  const prereqsFailed = prereqStatuses.some((status) => status === 'failed');
  const submitAttempted = input.submitAttempted === true;
  const matchedReplyObserved =
    input.matchedReply !== undefined || input.matchedReplyObserved === true;
  const liveSubmitPerformed = phase === 'live' && submitAttempted;
  const evidence = buildPeekabooEvidenceAudit({
    phase,
    marker: input.marker,
    expectedTaskId: input.expectedTaskId,
    submitAttempted,
    restObservationAttempted: input.restObservationAttempted,
    ack: input.ack,
    matchedReply: input.matchedReply,
    relatedReplyCount: input.relatedReplyCount,
  });

  let submitStatus: PeekabooReadinessStatus;
  if (phase === 'dry-run') {
    submitStatus = 'unknown';
  } else if (phase === 'probe') {
    submitStatus = prereqsReady ? 'ready' : prereqsFailed ? 'failed' : 'unknown';
  } else if (submitAttempted || input.controlOk === true) {
    submitStatus = 'ready';
  } else {
    submitStatus = prereqsFailed ? 'failed' : 'unknown';
  }

  let liveStatus: PeekabooReadinessStatus;
  if (phase !== 'live') {
    liveStatus = 'skipped';
  } else if (input.controlOk !== true) {
    liveStatus = 'failed';
  } else if (input.restObservationAttempted === false) {
    liveStatus = 'unknown';
  } else {
    liveStatus = matchedReplyObserved ? 'ready' : 'failed';
  }

  const checks: PeekabooReadinessCheck[] = [
    {
      label: 'CONFIG_OK',
      status: configStatus,
      summary:
        configStatus === 'ready'
          ? 'Local helper configuration parsed and sanitized.'
          : 'Local helper configuration was invalid.',
    },
    {
      label: 'SSH_OK',
      status: sshStatus,
      summary:
        sshStatus === 'ready'
          ? 'SSH reachability was confirmed for the remote macOS host.'
          : sshStatus === 'failed'
            ? 'SSH reachability failed before remote GUI control could continue.'
            : 'SSH reachability was not checked in this execution mode.',
    },
    {
      label: 'BRIDGE_PRESENT',
      status: bridgeStatus,
      summary:
        bridgeStatus === 'ready'
          ? 'desktop-control-bridge.json was present and readable.'
          : bridgeStatus === 'failed'
            ? 'desktop-control-bridge.json was missing or unreadable.'
            : 'Bridge presence was not confirmed in this execution mode.',
    },
    {
      label: 'PROXY_READY',
      status: proxyStatus,
      summary:
        phase === 'dry-run'
          ? 'Dry-run preview does not confirm proxy readiness.'
          : phase === 'probe'
            ? proxyStatus === 'ready'
              ? 'Peekaboo proxy initialize/list-tools readiness succeeded.'
              : proxyStatus === 'failed'
                ? 'Peekaboo proxy initialize/list-tools readiness failed.'
                : 'Peekaboo proxy initialize/list-tools readiness was not confirmed.'
            : proxyStatus === 'ready'
              ? 'Live-control proxy readiness was reported ready.'
              : proxyStatus === 'failed'
                ? 'Live-control proxy readiness was reported failed.'
                : 'Live-control proxy readiness was not confirmed.',
    },
    {
      label: 'SUBMIT_READY',
      status: submitStatus,
      summary:
        phase === 'dry-run'
          ? 'Dry-run preview does not verify whether a live submit would succeed.'
          : phase === 'probe'
            ? submitStatus === 'ready'
              ? 'Probe verified the pre-submit gates needed for live Discord control.'
              : submitStatus === 'failed'
                ? 'Probe failed before the live submit gate was considered ready.'
                : 'Probe could not prove submit readiness.'
            : submitStatus === 'ready'
              ? 'The run reached or passed the live submit gate.'
              : submitStatus === 'failed'
                ? 'The run failed before reaching the live submit gate.'
                : 'Submit readiness remained unknown.',
    },
    {
      label: 'LIVE_OK',
      status: liveStatus,
      summary:
        phase !== 'live'
          ? 'No live Discord submission was attempted.'
          : liveStatus === 'ready'
            ? 'Live submission and matched-reply evidence both succeeded.'
            : liveStatus === 'failed'
              ? 'Live evidence did not satisfy the matched-reply gate.'
              : 'Live submission ran, but matched-reply evidence was not collected.',
    },
  ];

  const targetLabel = errorTargetLabel(phase, normalizedError, submitAttempted);
  const checksWithError = checks.map((check) =>
    check.label === targetLabel && normalizedError !== undefined
      ? { ...check, error: normalizedError }
      : check,
  );

  const overallStatus =
    phase === 'dry-run'
      ? 'unknown'
      : phase === 'probe'
        ? submitStatus === 'ready'
          ? 'ready'
          : submitStatus
        : liveStatus === 'ready'
          ? 'ready'
          : liveStatus === 'failed' || submitStatus === 'failed'
            ? 'failed'
            : 'unknown';

  const highestReady =
    [...checksWithError]
      .reverse()
      .find((check) => check.status === 'ready')?.label ?? null;

  return {
    phase,
    overallStatus,
    highestReady,
    proxyReady: proxyReadiness.proxyReady,
    probeProxyReady: proxyReadiness.probeProxyReady,
    liveProxyReady: proxyReadiness.liveProxyReady,
    submitReady: submitStatus === 'ready',
    liveOk: liveStatus === 'ready',
    liveSubmitPerformed,
    matchedReplyObserved,
    evidence,
    checks: checksWithError,
    summary: summarizeReadiness(
      phase,
      overallStatus,
      submitStatus === 'ready',
      liveStatus === 'ready',
    ),
  };
}

export function parsePeekabooReadinessReport(
  value: unknown,
): PeekabooReadinessReport | undefined {
  const record = asRecord(value);
  const phase =
    typeof record.phase === 'string' &&
      (PEEKABOO_EXECUTION_MODES as readonly string[]).includes(record.phase)
      ? (record.phase as PeekabooExecutionMode)
      : undefined;
  if (phase === undefined) {
    return undefined;
  }
  const overallStatus =
    typeof record.overallStatus === 'string' && isReadinessStatus(record.overallStatus)
      ? record.overallStatus
      : undefined;
  if (overallStatus === undefined) {
    return undefined;
  }
  const checks = Array.isArray(record.checks)
    ? record.checks
        .map((entry) => {
          const item = asRecord(entry);
          if (
            typeof item.label !== 'string' ||
            !(PEEKABOO_READINESS_LABELS as readonly string[]).includes(item.label) ||
            typeof item.status !== 'string' ||
            !isReadinessStatus(item.status) ||
            typeof item.summary !== 'string'
          ) {
            return undefined;
          }
          const error = normalizePeekabooReadinessError(item.error);
          return {
            label: item.label as PeekabooReadinessLabel,
            status: item.status as PeekabooReadinessStatus,
            summary: item.summary,
            ...(error === undefined ? {} : { error }),
          };
        })
        .filter((entry): entry is PeekabooReadinessCheck => entry !== undefined)
    : [];
  const legacyProxyReady =
    typeof record.proxyReady === 'boolean' ? record.proxyReady : undefined;
  const proxyCheckStatus = checks.find((check) => check.label === 'PROXY_READY')?.status;
  const phaseSpecificLegacyProxyReady =
    proxyCheckStatus === 'ready'
      ? true
      : proxyCheckStatus === 'failed'
        ? false
        : legacyProxyReady;
  const proxyReadiness = resolveProxyReadinessFields({
    phase,
    proxyReady: legacyProxyReady,
    probeProxyReady:
      typeof record.probeProxyReady === 'boolean'
        ? record.probeProxyReady
        : phase === 'probe'
          ? phaseSpecificLegacyProxyReady
          : undefined,
    liveProxyReady:
      typeof record.liveProxyReady === 'boolean'
        ? record.liveProxyReady
        : phase === 'live'
          ? phaseSpecificLegacyProxyReady
          : undefined,
  });
  const legacyMatchedReply: PeekabooEvidenceObservation | undefined =
    record.matchedReplyObserved === true ? { source: 'legacy-readiness' } : undefined;
  const evidence =
    parsePeekabooEvidenceAudit(record.evidence) ??
    buildPeekabooEvidenceAudit({
      phase,
      marker: typeof record.marker === 'string' ? record.marker : undefined,
      expectedTaskId:
        typeof record.expectedTaskId === 'string' ? record.expectedTaskId : undefined,
      submitAttempted: record.liveSubmitPerformed === true,
      restObservationAttempted:
        phase === 'live'
          ? typeof record.restObservationAttempted === 'boolean'
            ? record.restObservationAttempted
            : true
          : false,
      matchedReply: legacyMatchedReply,
      relatedReplyCount: 0,
    });
  return {
    phase,
    overallStatus,
    highestReady:
      typeof record.highestReady === 'string' &&
        (PEEKABOO_READINESS_LABELS as readonly string[]).includes(record.highestReady)
        ? (record.highestReady as PeekabooReadinessLabel)
        : null,
    proxyReady:
      typeof record.proxyReady === 'boolean'
        ? record.proxyReady
        : proxyReadiness.proxyReady,
    probeProxyReady: proxyReadiness.probeProxyReady,
    liveProxyReady: proxyReadiness.liveProxyReady,
    submitReady: record.submitReady === true,
    liveOk: record.liveOk === true,
    liveSubmitPerformed: record.liveSubmitPerformed === true,
    matchedReplyObserved: record.matchedReplyObserved === true,
    evidence,
    checks,
    summary:
      typeof record.summary === 'string' ? record.summary : summarizeReadiness(phase, overallStatus, record.submitReady === true, record.liveOk === true),
  };
}

function isOneOf<T extends readonly string[]>(
  value: string,
  candidates: T,
): value is T[number] {
  return (candidates as readonly string[]).includes(value);
}

export function assertPeekabooControlMode(
  value: string,
): asserts value is PeekabooControlMode {
  if (!isOneOf(value, PEEKABOO_CONTROL_MODES)) {
    throw new Error(
      `mode must be one of: ${PEEKABOO_CONTROL_MODES.join(', ')}; received ${JSON.stringify(value)}.`,
    );
  }
}

export function assertPeekabooPollMode(
  value: string,
): asserts value is PeekabooPollMode {
  if (!isOneOf(value, PEEKABOO_POLL_MODES)) {
    throw new Error(
      `pollMode must be one of: ${PEEKABOO_POLL_MODES.join(', ')}; received ${JSON.stringify(value)}.`,
    );
  }
}

export function assertPeekabooCommandSelectMode(
  value: string,
): asserts value is PeekabooCommandSelectMode {
  if (!isOneOf(value, PEEKABOO_COMMAND_SELECT_MODES)) {
    throw new Error(
      `commandSelect must be one of: ${PEEKABOO_COMMAND_SELECT_MODES.join(', ')}; received ${JSON.stringify(value)}.`,
    );
  }
}

export function sanitizeRunId(runId: string): string {
  const sanitized = runId.trim().replace(/[^A-Za-z0-9_-]+/gu, '_');
  if (sanitized.length === 0) {
    throw new Error('runId must contain at least one alphanumeric, underscore, or dash character.');
  }
  return sanitized.slice(0, 80);
}

export function buildTurnMarker(runId: string, turnNumber: number): string {
  if (!Number.isInteger(turnNumber) || turnNumber <= 0 || turnNumber > 99) {
    throw new Error(`turnNumber must be an integer from 1 to 99; received ${turnNumber}.`);
  }
  return `${sanitizeRunId(runId)}_T${String(turnNumber).padStart(2, '0')}`;
}

export function resolveExpectedAuthorId(
  target: 'arona' | 'plana' | 'mixed' | undefined,
): string | undefined {
  if (target === 'arona') {
    return PEEKABOO_DEFAULTS.expectedAronaAuthorId;
  }
  if (target === 'plana') {
    return PEEKABOO_DEFAULTS.expectedPlanaAuthorId;
  }
  return undefined;
}

export function resolvePollModeForMode(mode: PeekabooControlMode): PeekabooPollMode {
  if (
    mode === 'slash-status' ||
    mode === 'slash-cancel' ||
    mode === 'slash-focus' ||
    mode === 'slash-unfocus'
  ) {
    return 'command-response';
  }
  if (mode === 'slash-ask' || mode === 'natural-ask') {
    return 'task-lifecycle';
  }
  return 'marker';
}

export function buildPeekabooEvaluationPlan(
  input: PeekabooEvaluationPlanInput,
): PeekabooEvaluationPlan {
  const runId = sanitizeRunId(input.runId);
  const maxTurns = input.maxTurns ?? PEEKABOO_DEFAULTS.maxTurns;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0 || maxTurns > 30) {
    throw new Error(`maxTurns must be an integer from 1 to 30; received ${maxTurns}.`);
  }
  const target = input.target ?? 'arona';
  const firstMode = input.firstMode ?? 'natural-ask';
  const markers = Array.from({ length: maxTurns }, (_, index) =>
    buildTurnMarker(runId, index + 1),
  );
  const evidenceDirectory = input.evidenceDirectory ??
    PEEKABOO_DEFAULTS.evidenceDirectory;
  const pollMode = resolvePollModeForMode(firstMode);

  return {
    protocolVersion: PEEKABOO_EVALUATION_PROTOCOL_VERSION,
    runId,
    goal:
      input.goal ??
      'Validate remote Peekaboo GUI control through a real user-authored Discord action.',
    maxTurns,
    channelId: input.channelId ?? PEEKABOO_DEFAULTS.channelId,
    target,
    firstMode,
    evidencePath: `${evidenceDirectory}/${runId}.json`,
    markers,
    requiredGates: PEEKABOO_REMOTE_EVALUATION_STANDARD.readinessGates,
    firstTurn: {
      turnNumber: 1,
      marker: markers[0] ?? buildTurnMarker(runId, 1),
      mode: firstMode,
      pollMode,
      ...(resolveExpectedAuthorId(target) === undefined
        ? {}
        : { expectedAuthorId: resolveExpectedAuthorId(target) }),
      instructionTemplate:
        `[${markers[0] ?? buildTurnMarker(runId, 1)}] ` +
        'Perform one small observable action, report evidence, and echo the marker at the beginning of the reply.',
    },
    closeout: Object.freeze([
      'Save the raw helper JSON result.',
      'Attach Discord REST observation as evidence only.',
      'Classify outcome with PASS/WARN/FAIL rubric.',
      'Do not claim live success if the GUI mutation path did not run.',
    ]),
  };
}

function pushFlag(args: string[], name: string, value: string | number | undefined): void {
  if (value === undefined) {
    return;
  }
  args.push(name, String(value));
}

function buildPeekabooBatchInstructionTemplate(
  marker: string,
  turnNumber: number,
  maxTurns: number,
): string {
  return `[${marker}] Batch turn ${turnNumber}/${maxTurns}: perform one small observable action, report evidence, and echo the marker at the beginning of the reply.`;
}

function buildPeekabooBatchPrecheckMarker(runId: string): string {
  return `${sanitizeRunId(runId)}_PRECHECK`;
}

function buildPeekabooBatchCorrelationId(runId: string, suffix: string): string {
  return `${sanitizeRunId(runId)}:${suffix}`;
}

function assertPeekabooBatchTurnCount(maxTurns: number): void {
  if (
    !Number.isInteger(maxTurns) ||
    maxTurns < PEEKABOO_BATCH_MIN_TURNS ||
    maxTurns > PEEKABOO_BATCH_MAX_TURNS
  ) {
    throw new Error(
      `maxTurns must be an integer from ${PEEKABOO_BATCH_MIN_TURNS} to ${PEEKABOO_BATCH_MAX_TURNS}; received ${maxTurns}.`,
    );
  }
}

function normalizePeekabooBatchPrecheckProof(
  proof: PeekabooBatchPrecheckProof | undefined,
): PeekabooBatchPrecheckProof | undefined {
  if (proof === undefined) {
    return undefined;
  }
  return {
    probeRunId: sanitizeRunId(proof.probeRunId),
    probeTurnMarker: proof.probeTurnMarker.trim(),
    probeProxyReady: proof.probeProxyReady === true,
    submitReady: proof.submitReady === true,
    ...(proof.recordedAt === undefined ? {} : { recordedAt: proof.recordedAt }),
  };
}

function validatePeekabooBatchPlanInput(
  input: PeekabooBatchPlanInput,
  maxTurns: number,
): void {
  assertPeekabooBatchTurnCount(maxTurns);
  if (input.executionMode === 'live' && input.precheckOnly === true) {
    throw new Error(
      'Ambiguous batch invocation: precheckOnly=true cannot be combined with executionMode="live".',
    );
  }
  if (input.executionMode === 'live' && input.probe === true) {
    throw new Error(
      'Ambiguous batch invocation: probe=true cannot be combined with executionMode="live".',
    );
  }
  if (input.executionMode === 'precheck' && input.allowLive === true) {
    throw new Error(
      'Precheck batch plans are read-only templates and must not set allowLive=true.',
    );
  }
  if (input.executionMode === 'live' && input.allowLive !== true) {
    throw new Error(
      'Live Peekaboo batch plans require allowLive=true because returned commands are live-submit templates.',
    );
  }
  if (input.executionMode !== 'live') {
    return;
  }
  const proof = normalizePeekabooBatchPrecheckProof(input.precheck);
  if (proof === undefined) {
    throw new Error(
      'Live Peekaboo batch plans require precheck proof from a completed probe/precheck run.',
    );
  }
  if (proof.probeTurnMarker.length === 0) {
    throw new Error('precheck.probeTurnMarker is required for live batch plans.');
  }
  if (proof.probeProxyReady !== true || proof.submitReady !== true) {
    throw new Error(
      'Live Peekaboo batch plans require precheck proof with probeProxyReady=true and submitReady=true.',
    );
  }
}

export function buildPeekabooBatchPlan(
  input: PeekabooBatchPlanInput,
): PeekabooBatchPlan {
  const maxTurns = input.maxTurns ?? PEEKABOO_BATCH_MIN_TURNS;
  validatePeekabooBatchPlanInput(input, maxTurns);
  const evaluationPlan = buildPeekabooEvaluationPlan({
    runId: input.runId,
    goal: input.goal,
    maxTurns,
    channelId: input.channelId,
    target: input.target,
    firstMode: input.firstMode,
    evidenceDirectory: input.evidenceDirectory,
  });
  const mode = evaluationPlan.firstMode;
  const pollMode = resolvePollModeForMode(mode);
  const expectedAuthorId = resolveExpectedAuthorId(evaluationPlan.target);
  const plannedTurnMarkers = evaluationPlan.markers.slice(0, maxTurns);
  const precheckProof = normalizePeekabooBatchPrecheckProof(input.precheck);

  if (input.executionMode === 'precheck') {
    const marker = buildPeekabooBatchPrecheckMarker(evaluationPlan.runId);
    const instructionTemplate =
      `[${marker}] Probe only. Validate bounded batch readiness and do not submit a live Discord action.`;
    const command = buildPeekabooTurnCommand({
      runId: evaluationPlan.runId,
      marker,
      mode,
      message: instructionTemplate,
      channelId: evaluationPlan.channelId,
      ...(expectedAuthorId === undefined ? {} : { expectAuthor: expectedAuthorId }),
      pollMode,
      probe: true,
    });

    return {
      protocolVersion: PEEKABOO_EVALUATION_PROTOCOL_VERSION,
      runId: evaluationPlan.runId,
      goal:
        evaluationPlan.goal ??
        'Validate bounded batch readiness before reviewing live turn templates.',
      maxTurns,
      channelId: evaluationPlan.channelId,
      target: evaluationPlan.target,
      mode,
      executionMode: 'precheck',
      evidencePath: evaluationPlan.evidencePath,
      plannedTurnMarkers,
      requiredGates: evaluationPlan.requiredGates,
      autonomousExecution: false,
      precheckCommand: {
        marker,
        correlationId: buildPeekabooBatchCorrelationId(
          evaluationPlan.runId,
          'batch:precheck',
        ),
        mode,
        pollMode,
        ...(expectedAuthorId === undefined ? {} : { expectedAuthorId }),
        instructionTemplate,
        command,
      },
      turns: [],
      closeout: Object.freeze([
        'Review the precheck command before running it through the existing single-turn surface.',
        'Do not generate or execute live batch turns until probe evidence proves proxy and submit readiness.',
        ...evaluationPlan.closeout,
      ]),
      safetyNotes: Object.freeze([
        `Batch plans are bounded to ${PEEKABOO_BATCH_MIN_TURNS}-${PEEKABOO_BATCH_MAX_TURNS} turns.`,
        'This surface only returns a single non-mutating probe template for precheck mode.',
        'No helper is spawned and no ledger append occurs from batch planning.',
      ]),
    };
  }

  const turns = plannedTurnMarkers.map((marker, index) => {
    const turnNumber = index + 1;
    const instructionTemplate = buildPeekabooBatchInstructionTemplate(
      marker,
      turnNumber,
      maxTurns,
    );
    const command = buildPeekabooTurnCommand({
      runId: evaluationPlan.runId,
      turnNumber,
      marker,
      mode,
      message: instructionTemplate,
      channelId: evaluationPlan.channelId,
      ...(expectedAuthorId === undefined ? {} : { expectAuthor: expectedAuthorId }),
      pollMode,
      dryRun: false,
      allowLive: true,
    });

    return {
      turnNumber,
      marker,
      correlationId: buildPeekabooBatchCorrelationId(
        evaluationPlan.runId,
        `batch:turn:${String(turnNumber).padStart(2, '0')}`,
      ),
      mode,
      pollMode,
      ...(expectedAuthorId === undefined ? {} : { expectedAuthorId }),
      instructionTemplate,
      command,
    };
  });

  return {
    protocolVersion: PEEKABOO_EVALUATION_PROTOCOL_VERSION,
    runId: evaluationPlan.runId,
    goal:
      evaluationPlan.goal ??
      'Review bounded live turn templates after a successful precheck.',
    maxTurns,
    channelId: evaluationPlan.channelId,
    target: evaluationPlan.target,
    mode,
    executionMode: 'live',
    evidencePath: evaluationPlan.evidencePath,
    plannedTurnMarkers,
    requiredGates: evaluationPlan.requiredGates,
    autonomousExecution: false,
    ...(precheckProof === undefined ? {} : { precheckProof }),
    turns,
    closeout: Object.freeze([
      'Review every returned live command template before any operator execution.',
      'Execute live turns through the existing single-turn surface only after the recorded precheck proof stays valid.',
      ...evaluationPlan.closeout,
    ]),
    safetyNotes: Object.freeze([
      `Batch plans are bounded to ${PEEKABOO_BATCH_MIN_TURNS}-${PEEKABOO_BATCH_MAX_TURNS} turns.`,
      'This surface returns live-submit command templates only; it does not execute them.',
      'No helper is spawned and no ledger append occurs from batch planning.',
    ]),
  };
}

export function buildPeekabooTurnCommand(
  input: PeekabooTurnCommandInput,
): PeekabooTurnCommand {
  const mode = input.mode ?? 'natural-ask';
  assertPeekabooControlMode(mode);
  const pollMode = input.pollMode ?? resolvePollModeForMode(mode);
  assertPeekabooPollMode(pollMode);
  const commandSelect = input.commandSelect ?? 'return';
  assertPeekabooCommandSelectMode(commandSelect);
  const probe = input.probe ?? false;
  const dryRun = probe ? false : (input.dryRun ?? true);
  if (!probe && !dryRun && input.allowLive !== true) {
    throw new Error(
      'Live Peekaboo remote GUI control requires dryRun=false and allowLive=true.',
    );
  }
  const executionMode: PeekabooExecutionMode = probe
    ? 'probe'
    : dryRun
      ? 'dry-run'
      : 'live';

  const turnNumber = input.turnNumber ?? 1;
  const marker = input.marker ?? buildTurnMarker(input.runId, turnNumber);
  const repoRoot = input.repoRoot ?? process.cwd();
  const helperScript = input.helperScript ?? PEEKABOO_DEFAULTS.helperScript;
  const executable = process.execPath;
  const args = [resolve(repoRoot, helperScript)];

  args.push('--mode', mode);
  args.push('--marker', marker);
  args.push('--message', input.message);
  args.push('--poll-mode', pollMode);
  args.push('--polls', String(input.noRest === true ? 0 : (input.polls ?? PEEKABOO_DEFAULTS.polls)));
  args.push('--poll-ms', String(input.pollMs ?? PEEKABOO_DEFAULTS.pollMs));
  args.push('--command-select', commandSelect);

  pushFlag(args, '--channel-id', input.channelId);
  pushFlag(args, '--guild-id', input.guildId);
  pushFlag(args, '--expect-author', input.expectAuthor);
  pushFlag(args, '--expect-task-id', input.expectTaskId);
  pushFlag(args, '--mention-user-id', input.mentionUserId);
  pushFlag(args, '--natural-address', input.naturalAddress);
  pushFlag(args, '--ssh-host', input.sshHost);
  pushFlag(args, '--ssh-key', input.sshKey);
  pushFlag(args, '--remote-root', input.remoteRoot);
  pushFlag(args, '--remote-node', input.remoteNode);
  pushFlag(args, '--bridge-path', input.bridgePath);
  pushFlag(args, '--env-file', input.envFile);
  pushFlag(args, '--bot-token-env', input.botTokenEnv);

  if (input.noRest === true) {
    args.push('--no-rest');
  }
  if (input.debugSteps === true) {
    args.push('--debug-steps');
  }
  if (probe) {
    args.push('--probe');
  } else if (dryRun) {
    args.push('--dry-run');
  }

  return {
    executable,
    args,
    marker,
    mode,
    pollMode,
    executionMode,
    dryRun,
    probe,
    mutatesRemoteGui: executionMode === 'live',
    evidenceExpectation:
      executionMode === 'probe'
        ? 'Probe verifies staged readiness only and must not submit a live Discord action.'
        :
      pollMode === 'command-response'
        ? 'Expected bot command response must include the expected task id or marker.'
        : pollMode === 'task-lifecycle'
          ? 'Expected bot lifecycle response must be after GUI submission and task-correlated when possible.'
          : 'Expected bot reply must be marker-correlated or explicitly classified as weak evidence.',
  };
}
