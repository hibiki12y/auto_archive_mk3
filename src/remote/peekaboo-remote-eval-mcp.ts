#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  PEEKABOO_BATCH_EXECUTION_MODES,
  PEEKABOO_BATCH_MAX_TURNS,
  PEEKABOO_BATCH_MIN_TURNS,
  PEEKABOO_CONTROL_MODES,
  PEEKABOO_EVIDENCE_CORRELATION_SCORES,
  PEEKABOO_EVIDENCE_MATCH_SIGNALS,
  PEEKABOO_EVIDENCE_STATUSES,
  PEEKABOO_EXECUTION_MODES,
  PEEKABOO_OBSERVE_MODES,
  PEEKABOO_POLL_MODES,
  PEEKABOO_READINESS_LABELS,
  PEEKABOO_READINESS_STATUSES,
  PEEKABOO_REMOTE_EVALUATION_STANDARD,
  buildPeekabooBatchPlan,
  buildPeekabooReadinessReport,
  buildPeekabooEvaluationPlan,
  buildPeekabooTurnCommand,
  parsePeekabooEvidenceAudit,
  parsePeekabooReadinessReport,
  type PeekabooBatchPlanInput,
  type PeekabooEvaluationPlanInput,
  type PeekabooTurnCommandInput,
} from './peekaboo-remote-evaluation.js';
import {
  JsonlPeekabooEvidenceLedger,
  buildPeekabooQuantitativeReport,
  filterPeekabooEvidenceRecords,
  parsePeekabooEvidenceLedgerReadiness,
  type PeekabooEvidenceRecordInput,
  type PeekabooEvidenceRecordFilter,
} from './peekaboo-evidence-ledger.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'auto-archive-peekaboo-remote-eval';
const SERVER_VERSION = '0.1.0';

const PEEKABOO_EVIDENCE_OBSERVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observedAt: { type: 'string' },
    source: { type: 'string' },
    messageId: { type: 'string' },
    authorId: { type: 'string' },
    taskId: { type: 'string' },
    marker: { type: 'string' },
    matchedOn: {
      type: 'array',
      items: { type: 'string', enum: PEEKABOO_EVIDENCE_MATCH_SIGNALS },
    },
  },
} as const;

const PEEKABOO_EVIDENCE_SCORING_FACTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['signal', 'explanation'],
  properties: {
    signal: { type: 'string', enum: PEEKABOO_EVIDENCE_MATCH_SIGNALS },
    explanation: { type: 'string' },
  },
} as const;

const PEEKABOO_EVIDENCE_STAGE_SCHEMA = {
  ...PEEKABOO_EVIDENCE_OBSERVATION_SCHEMA,
  required: ['status', 'summary'],
  properties: {
    ...PEEKABOO_EVIDENCE_OBSERVATION_SCHEMA.properties,
    status: { type: 'string', enum: PEEKABOO_EVIDENCE_STATUSES },
    summary: { type: 'string' },
    correlationScore: {
      type: 'string',
      enum: PEEKABOO_EVIDENCE_CORRELATION_SCORES,
    },
    scoringFactors: {
      type: 'array',
      items: PEEKABOO_EVIDENCE_SCORING_FACTOR_SCHEMA,
    },
  },
} as const;

const PEEKABOO_EVIDENCE_AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['submit', 'taskCorrelation', 'ack', 'matchedReply'],
  properties: {
    marker: { type: 'string' },
    expectedTaskId: { type: 'string' },
    submit: PEEKABOO_EVIDENCE_STAGE_SCHEMA,
    taskCorrelation: PEEKABOO_EVIDENCE_STAGE_SCHEMA,
    ack: PEEKABOO_EVIDENCE_STAGE_SCHEMA,
    matchedReply: PEEKABOO_EVIDENCE_STAGE_SCHEMA,
  },
} as const;

const PEEKABOO_READINESS_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    domain: { type: 'string' },
    retryable: { type: 'boolean' },
    remediations: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

const PEEKABOO_READINESS_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'status', 'summary'],
  properties: {
    label: { type: 'string', enum: PEEKABOO_READINESS_LABELS },
    status: { type: 'string', enum: PEEKABOO_READINESS_STATUSES },
    summary: { type: 'string' },
    error: PEEKABOO_READINESS_ERROR_SCHEMA,
  },
} as const;

const PEEKABOO_READINESS_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'overallStatus'],
  properties: {
    phase: { type: 'string', enum: PEEKABOO_EXECUTION_MODES },
    overallStatus: { type: 'string', enum: PEEKABOO_READINESS_STATUSES },
    highestReady: {
      anyOf: [
        { type: 'string', enum: PEEKABOO_READINESS_LABELS },
        { type: 'null' },
      ],
    },
    proxyReady: { type: 'boolean' },
    probeProxyReady: { type: 'boolean' },
    liveProxyReady: { type: 'boolean' },
    submitReady: { type: 'boolean' },
    liveOk: { type: 'boolean' },
    liveSubmitPerformed: { type: 'boolean' },
    matchedReplyObserved: { type: 'boolean' },
    evidence: PEEKABOO_EVIDENCE_AUDIT_SCHEMA,
    checks: {
      type: 'array',
      items: PEEKABOO_READINESS_CHECK_SCHEMA,
    },
    summary: { type: 'string' },
  },
} as const;

const PEEKABOO_EVIDENCE_APPEND_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'turnMarker', 'correlationId', 'readiness', 'evidence'],
  properties: {
    recordId: { type: 'string' },
    recordedAt: { type: 'string' },
    runId: { type: 'string' },
    turnMarker: { type: 'string' },
    correlationId: { type: 'string' },
    artifactPath: { type: 'string' },
    taskId: { type: 'string' },
    channelId: { type: 'string' },
    guildId: { type: 'string' },
    mode: { type: 'string', enum: PEEKABOO_CONTROL_MODES },
    phase: { type: 'string', enum: PEEKABOO_EXECUTION_MODES },
    readiness: PEEKABOO_READINESS_REPORT_SCHEMA,
    evidence: PEEKABOO_EVIDENCE_AUDIT_SCHEMA,
    outcome: { type: 'string' },
    notes: { type: 'string' },
  },
} as const;

const PEEKABOO_BATCH_PRECHECK_PROOF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'probeRunId',
    'probeTurnMarker',
    'probeProxyReady',
    'submitReady',
  ],
  properties: {
    probeRunId: { type: 'string' },
    probeTurnMarker: { type: 'string' },
    probeProxyReady: { type: 'boolean' },
    submitReady: { type: 'boolean' },
    recordedAt: { type: 'string' },
  },
} as const;

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

/**
 * Boundary validator for incoming JSON-RPC frames (audit 2026-05-03 / G2).
 *
 * The previous shape `JSON.parse(line) as JsonRpcRequest` was insufficient:
 * JSON.parse can yield `null`, primitives, or arrays, all of which would
 * later throw TypeErrors deep inside `handleMcpJsonRpcMessage` when
 * accessing `.id` or `.method`. Those throws were caught by the inner
 * `try/catch` and surfaced as generic JSON-RPC -32000 errors with
 * uninformative messages.
 *
 * This validator enforces the minimal shape contract:
 *   - parsed value is a non-null, non-array object
 *   - if `id` is present, it is `string | number | null`
 *   - if `method` is present, it is a string
 *
 * Returns the validated reference (typed) or `undefined` for malformed
 * input. Callers should respond with a JSON-RPC parse-error frame
 * (-32700) on `undefined`.
 */
export function validateJsonRpcRequest(
  candidate: unknown,
): JsonRpcRequest | undefined {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    return undefined;
  }
  const obj = candidate as Record<string, unknown>;
  if (
    obj['id'] !== undefined &&
    obj['id'] !== null &&
    typeof obj['id'] !== 'string' &&
    typeof obj['id'] !== 'number'
  ) {
    return undefined;
  }
  if (obj['method'] !== undefined && typeof obj['method'] !== 'string') {
    return undefined;
  }
  if (
    obj['jsonrpc'] !== undefined &&
    typeof obj['jsonrpc'] !== 'string'
  ) {
    return undefined;
  }
  return obj;
}

interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

type ToolResult = {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
};

export interface ToolExecutionOptions {
  readonly executor?: (command: string, args: readonly string[]) => {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: Error;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  minimum?: number,
): number | undefined {
  const value = readNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }
  if (minimum !== undefined && value < minimum) {
    throw new Error(`${key} must be >= ${minimum}.`);
  }
  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`);
  }
  return value;
}

function readEnum<T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = readString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${values.join(', ')}.`);
  }
  return value;
}

function requireEnum<T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = readEnum(record, key, values);
  if (value === undefined) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${context} contains unsupported properties: ${unknownKeys.join(', ')}.`,
    );
  }
}

function parsePlanInput(value: unknown): PeekabooEvaluationPlanInput {
  const record = asRecord(value);
  const runId = requireString(record, 'runId');
  return {
    runId,
    ...(readString(record, 'goal') === undefined
      ? {}
      : { goal: readString(record, 'goal') }),
    ...(readNumber(record, 'maxTurns') === undefined
      ? {}
      : { maxTurns: readNumber(record, 'maxTurns') }),
    ...(readString(record, 'channelId') === undefined
      ? {}
      : { channelId: readString(record, 'channelId') }),
    ...(readEnum(record, 'target', ['arona', 'plana', 'mixed'] as const) === undefined
      ? {}
      : { target: readEnum(record, 'target', ['arona', 'plana', 'mixed'] as const) }),
    ...(readEnum(record, 'firstMode', PEEKABOO_CONTROL_MODES) === undefined
      ? {}
      : { firstMode: readEnum(record, 'firstMode', PEEKABOO_CONTROL_MODES) }),
    ...(readString(record, 'evidenceDirectory') === undefined
      ? {}
      : { evidenceDirectory: readString(record, 'evidenceDirectory') }),
  };
}

function parseBatchPrecheckProof(value: unknown): PeekabooBatchPlanInput['precheck'] {
  const record = asRecord(value);
  assertAllowedKeys(
    record,
    [
      'probeRunId',
      'probeTurnMarker',
      'probeProxyReady',
      'submitReady',
      'recordedAt',
    ],
    'peekaboo_remote_eval_batch_plan precheck',
  );
  return {
    probeRunId: requireString(record, 'probeRunId'),
    probeTurnMarker: requireString(record, 'probeTurnMarker'),
    probeProxyReady: readBoolean(record, 'probeProxyReady') ?? false,
    submitReady: readBoolean(record, 'submitReady') ?? false,
    ...(readString(record, 'recordedAt') === undefined
      ? {}
      : { recordedAt: readString(record, 'recordedAt') }),
  };
}

function parseBatchPlanInput(value: unknown): PeekabooBatchPlanInput {
  const record = asRecord(value);
  assertAllowedKeys(
    record,
    [
      'runId',
      'executionMode',
      'goal',
      'maxTurns',
      'channelId',
      'target',
      'firstMode',
      'evidenceDirectory',
      'allowLive',
      'probe',
      'precheckOnly',
      'precheck',
    ],
    'peekaboo_remote_eval_batch_plan arguments',
  );
  return {
    runId: requireString(record, 'runId'),
    executionMode: requireEnum(
      record,
      'executionMode',
      PEEKABOO_BATCH_EXECUTION_MODES,
    ),
    ...(readNumber(record, 'maxTurns') === undefined
      ? {}
      : { maxTurns: readNumber(record, 'maxTurns') }),
    ...(readString(record, 'goal') === undefined
      ? {}
      : { goal: readString(record, 'goal') }),
    ...(readString(record, 'channelId') === undefined
      ? {}
      : { channelId: readString(record, 'channelId') }),
    ...(readEnum(record, 'target', ['arona', 'plana', 'mixed'] as const) === undefined
      ? {}
      : { target: readEnum(record, 'target', ['arona', 'plana', 'mixed'] as const) }),
    ...(readEnum(record, 'firstMode', PEEKABOO_CONTROL_MODES) === undefined
      ? {}
      : { firstMode: readEnum(record, 'firstMode', PEEKABOO_CONTROL_MODES) }),
    ...(readString(record, 'evidenceDirectory') === undefined
      ? {}
      : { evidenceDirectory: readString(record, 'evidenceDirectory') }),
    ...(readBoolean(record, 'allowLive') === undefined
      ? {}
      : { allowLive: readBoolean(record, 'allowLive') }),
    ...(readBoolean(record, 'probe') === undefined
      ? {}
      : { probe: readBoolean(record, 'probe') }),
    ...(readBoolean(record, 'precheckOnly') === undefined
      ? {}
      : { precheckOnly: readBoolean(record, 'precheckOnly') }),
    ...(record['precheck'] === undefined
      ? {}
      : { precheck: parseBatchPrecheckProof(record['precheck']) }),
  };
}

function parseTurnInput(value: unknown): PeekabooTurnCommandInput {
  const record = asRecord(value);
  const runId = requireString(record, 'runId');
  const mode = readEnum(record, 'mode', PEEKABOO_CONTROL_MODES);
  const message =
    mode === 'slash-unfocus'
      ? (readString(record, 'message') ?? '')
      : requireString(record, 'message');
  return {
    runId,
    message,
    ...(readString(record, 'repoRoot') === undefined
      ? {}
      : { repoRoot: readString(record, 'repoRoot') }),
    ...(readString(record, 'helperScript') === undefined
      ? {}
      : { helperScript: readString(record, 'helperScript') }),
    ...(readNumber(record, 'turnNumber') === undefined
      ? {}
      : { turnNumber: readNumber(record, 'turnNumber') }),
    ...(readString(record, 'marker') === undefined
      ? {}
      : { marker: readString(record, 'marker') }),
    ...(readEnum(record, 'mode', PEEKABOO_CONTROL_MODES) === undefined
      ? {}
      : { mode: readEnum(record, 'mode', PEEKABOO_CONTROL_MODES) }),
    ...(readString(record, 'channelId') === undefined
      ? {}
      : { channelId: readString(record, 'channelId') }),
    ...(readString(record, 'guildId') === undefined
      ? {}
      : { guildId: readString(record, 'guildId') }),
    ...(readString(record, 'expectAuthor') === undefined
      ? {}
      : { expectAuthor: readString(record, 'expectAuthor') }),
    ...(readString(record, 'expectTaskId') === undefined
      ? {}
      : { expectTaskId: readString(record, 'expectTaskId') }),
    ...(readEnum(record, 'pollMode', PEEKABOO_POLL_MODES) === undefined
      ? {}
      : { pollMode: readEnum(record, 'pollMode', PEEKABOO_POLL_MODES) }),
    ...(readNumber(record, 'polls') === undefined
      ? {}
      : { polls: readNumber(record, 'polls') }),
    ...(readNumber(record, 'pollMs') === undefined
      ? {}
      : { pollMs: readNumber(record, 'pollMs') }),
    ...(readEnum(record, 'commandSelect', ['return', 'click'] as const) === undefined
      ? {}
      : { commandSelect: readEnum(record, 'commandSelect', ['return', 'click'] as const) }),
    ...(readString(record, 'mentionUserId') === undefined
      ? {}
      : { mentionUserId: readString(record, 'mentionUserId') }),
    ...(readString(record, 'naturalAddress') === undefined
      ? {}
      : { naturalAddress: readString(record, 'naturalAddress') }),
    ...(readString(record, 'sshHost') === undefined
      ? {}
      : { sshHost: readString(record, 'sshHost') }),
    ...(readString(record, 'sshKey') === undefined
      ? {}
      : { sshKey: readString(record, 'sshKey') }),
    ...(readString(record, 'remoteRoot') === undefined
      ? {}
      : { remoteRoot: readString(record, 'remoteRoot') }),
    ...(readString(record, 'remoteNode') === undefined
      ? {}
      : { remoteNode: readString(record, 'remoteNode') }),
    ...(readString(record, 'bridgePath') === undefined
      ? {}
      : { bridgePath: readString(record, 'bridgePath') }),
    ...(readString(record, 'envFile') === undefined
      ? {}
      : { envFile: readString(record, 'envFile') }),
    ...(readString(record, 'botTokenEnv') === undefined
      ? {}
      : { botTokenEnv: readString(record, 'botTokenEnv') }),
    ...(readBoolean(record, 'noRest') === undefined
      ? {}
      : { noRest: readBoolean(record, 'noRest') }),
    ...(readBoolean(record, 'debugSteps') === undefined
      ? {}
      : { debugSteps: readBoolean(record, 'debugSteps') }),
    ...(readEnum(record, 'observeMode', PEEKABOO_OBSERVE_MODES) === undefined
      ? {}
      : { observeMode: readEnum(record, 'observeMode', PEEKABOO_OBSERVE_MODES) }),
    ...(readString(record, 'imageCapturePath') === undefined
      ? {}
      : { imageCapturePath: readString(record, 'imageCapturePath') }),
    ...(readString(record, 'imageOutput') === undefined
      ? {}
      : { imageOutput: readString(record, 'imageOutput') }),
    ...(readBoolean(record, 'dryRun') === undefined
      ? {}
      : { dryRun: readBoolean(record, 'dryRun') }),
    ...(readBoolean(record, 'probe') === undefined
      ? {}
      : { probe: readBoolean(record, 'probe') }),
    ...(readBoolean(record, 'allowLive') === undefined
      ? {}
      : { allowLive: readBoolean(record, 'allowLive') }),
  };
}

function parseEvidenceReadinessArgument(
  value: unknown,
): PeekabooEvidenceRecordInput['readiness'] {
  const report = parsePeekabooReadinessReport(value);
  if (report !== undefined) {
    return report;
  }
  const readiness = parsePeekabooEvidenceLedgerReadiness(value);
  if (readiness !== undefined) {
    return readiness;
  }
  throw new Error(
    'readiness must be a valid Peekaboo readiness report or normalized readiness digest.',
  );
}

function parseEvidenceAuditArgument(
  value: unknown,
): PeekabooEvidenceRecordInput['evidence'] {
  const evidence = parsePeekabooEvidenceAudit(value);
  if (evidence === undefined) {
    throw new Error('evidence must be a valid Peekaboo evidence audit.');
  }
  return evidence;
}

function parseEvidenceRecordInput(
  value: unknown,
  context: string,
): PeekabooEvidenceRecordInput {
  const record = asRecord(value);
  assertAllowedKeys(
    record,
    [
      'recordId',
      'recordedAt',
      'runId',
      'turnMarker',
      'correlationId',
      'artifactPath',
      'taskId',
      'channelId',
      'guildId',
      'mode',
      'phase',
      'readiness',
      'evidence',
      'outcome',
      'notes',
    ],
    context,
  );

  return {
    ...(readString(record, 'recordId') === undefined
      ? {}
      : { recordId: readString(record, 'recordId') }),
    ...(readString(record, 'recordedAt') === undefined
      ? {}
      : { recordedAt: readString(record, 'recordedAt') }),
    runId: requireString(record, 'runId'),
    turnMarker: requireString(record, 'turnMarker'),
    correlationId: requireString(record, 'correlationId'),
    ...(readString(record, 'artifactPath') === undefined
      ? {}
      : { artifactPath: readString(record, 'artifactPath') }),
    ...(readString(record, 'taskId') === undefined
      ? {}
      : { taskId: readString(record, 'taskId') }),
    ...(readString(record, 'channelId') === undefined
      ? {}
      : { channelId: readString(record, 'channelId') }),
    ...(readString(record, 'guildId') === undefined
      ? {}
      : { guildId: readString(record, 'guildId') }),
    ...(readEnum(record, 'mode', PEEKABOO_CONTROL_MODES) === undefined
      ? {}
      : { mode: readEnum(record, 'mode', PEEKABOO_CONTROL_MODES) }),
    ...(readEnum(record, 'phase', ['dry-run', 'probe', 'live'] as const) === undefined
      ? {}
      : { phase: readEnum(record, 'phase', ['dry-run', 'probe', 'live'] as const) }),
    readiness: parseEvidenceReadinessArgument(record['readiness']),
    evidence: parseEvidenceAuditArgument(record['evidence']),
    ...(readString(record, 'outcome') === undefined
      ? {}
      : { outcome: readString(record, 'outcome') }),
    ...(readString(record, 'notes') === undefined
      ? {}
      : { notes: readString(record, 'notes') }),
  };
}

function parseEvidenceAppendInput(value: unknown): {
  readonly ledgerPath: string;
  readonly record: PeekabooEvidenceRecordInput;
} {
  const record = asRecord(value);
  assertAllowedKeys(
    record,
    [
      'ledgerPath',
      'record',
      'recordId',
      'recordedAt',
      'runId',
      'turnMarker',
      'correlationId',
      'artifactPath',
      'taskId',
      'channelId',
      'guildId',
      'mode',
      'phase',
      'readiness',
      'evidence',
      'outcome',
      'notes',
    ],
    'peekaboo_remote_eval_evidence_append arguments',
  );
  const ledgerPath = requireString(record, 'ledgerPath');
  if (record['record'] !== undefined) {
    const inlineKeys = [
      'recordId',
      'recordedAt',
      'runId',
      'turnMarker',
      'correlationId',
      'artifactPath',
      'taskId',
      'channelId',
      'guildId',
      'mode',
      'phase',
      'readiness',
      'evidence',
      'outcome',
      'notes',
    ].filter((key) => key in record);
    if (inlineKeys.length > 0) {
      throw new Error(
        'Use either record or top-level evidence fields for append, not both.',
      );
    }
    return {
      ledgerPath,
      record: parseEvidenceRecordInput(
        record['record'],
        'peekaboo_remote_eval_evidence_append record',
      ),
    };
  }
  const inlineRecord = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'ledgerPath'),
  );
  return {
    ledgerPath,
    record: parseEvidenceRecordInput(
      inlineRecord,
      'peekaboo_remote_eval_evidence_append arguments',
    ),
  };
}

function parseEvidenceQueryInput(value: unknown): {
  readonly ledgerPath: string;
  readonly filter: Parameters<typeof filterPeekabooEvidenceRecords>[1];
} {
  const record = asRecord(value);
  assertAllowedKeys(
    record,
    [
      'ledgerPath',
      'runId',
      'turnMarker',
      'taskId',
      'correlationId',
      'channelId',
      'phase',
      'limit',
    ],
    'peekaboo_remote_eval_evidence_query arguments',
  );
  return {
    ledgerPath: requireString(record, 'ledgerPath'),
    filter: {
      ...(readString(record, 'runId') === undefined
        ? {}
        : { runId: readString(record, 'runId') }),
      ...(readString(record, 'turnMarker') === undefined
        ? {}
        : { turnMarker: readString(record, 'turnMarker') }),
      ...(readString(record, 'taskId') === undefined
        ? {}
        : { taskId: readString(record, 'taskId') }),
      ...(readString(record, 'correlationId') === undefined
        ? {}
        : { correlationId: readString(record, 'correlationId') }),
      ...(readString(record, 'channelId') === undefined
        ? {}
        : { channelId: readString(record, 'channelId') }),
      ...(readEnum(record, 'phase', ['dry-run', 'probe', 'live'] as const) ===
      undefined
        ? {}
        : { phase: readEnum(record, 'phase', ['dry-run', 'probe', 'live'] as const) }),
      ...(readInteger(record, 'limit', 0) === undefined
        ? {}
        : { limit: readInteger(record, 'limit', 0) }),
    },
  };
}

function parseQuantitativeReportInput(value: unknown): {
  readonly ledgerPath: string;
  readonly filter: PeekabooEvidenceRecordFilter;
  readonly baselineRunId?: string;
  readonly candidateRunId?: string;
  readonly generatedAt?: string;
} {
  const record = asRecord(value);
  assertAllowedKeys(
    record,
    [
      'ledgerPath',
      'runId',
      'turnMarker',
      'taskId',
      'correlationId',
      'channelId',
      'phase',
      'limit',
      'baselineRunId',
      'candidateRunId',
      'generatedAt',
    ],
    'peekaboo_remote_eval_quantitative_report arguments',
  );
  return {
    ledgerPath: requireString(record, 'ledgerPath'),
    filter: {
      ...(readString(record, 'runId') === undefined
        ? {}
        : { runId: readString(record, 'runId') }),
      ...(readString(record, 'turnMarker') === undefined
        ? {}
        : { turnMarker: readString(record, 'turnMarker') }),
      ...(readString(record, 'taskId') === undefined
        ? {}
        : { taskId: readString(record, 'taskId') }),
      ...(readString(record, 'correlationId') === undefined
        ? {}
        : { correlationId: readString(record, 'correlationId') }),
      ...(readString(record, 'channelId') === undefined
        ? {}
        : { channelId: readString(record, 'channelId') }),
      ...(readEnum(record, 'phase', ['dry-run', 'probe', 'live'] as const) ===
      undefined
        ? {}
        : { phase: readEnum(record, 'phase', ['dry-run', 'probe', 'live'] as const) }),
      ...(readInteger(record, 'limit', 0) === undefined
        ? {}
        : { limit: readInteger(record, 'limit', 0) }),
    },
    ...(readString(record, 'baselineRunId') === undefined
      ? {}
      : { baselineRunId: readString(record, 'baselineRunId') }),
    ...(readString(record, 'candidateRunId') === undefined
      ? {}
      : { candidateRunId: readString(record, 'candidateRunId') }),
    ...(readString(record, 'generatedAt') === undefined
      ? {}
      : { generatedAt: readString(record, 'generatedAt') }),
  };
}

function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function readNestedBoolean(
  value: unknown,
  path: readonly string[],
): boolean | undefined {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return typeof current === 'boolean' ? current : undefined;
}

function readNestedValue(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function readFlagArg(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  return typeof value === 'string' ? value : undefined;
}

function extractTaskIdFromText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : '';
  return text.match(/\bdiscord-task-[A-Za-z0-9_-]+\b/u)?.[0];
}

function deriveMatchedOn(
  record: Record<string, unknown>,
  marker: string | undefined,
  expectedTaskId: string | undefined,
): readonly ('marker' | 'task-id' | 'author' | 'timing' | 'lifecycle-shape')[] {
  const content = typeof record.content === 'string' ? record.content : '';
  const signals = new Set<
    'marker' | 'task-id' | 'author' | 'timing' | 'lifecycle-shape'
  >();
  if (marker !== undefined && content.includes(marker)) {
    signals.add('marker');
  }
  const taskId = extractTaskIdFromText(content);
  if (
    (expectedTaskId !== undefined && taskId === expectedTaskId) ||
    (expectedTaskId === undefined && taskId !== undefined)
  ) {
    signals.add('task-id');
  }
  if (typeof record.authorId === 'string') {
    signals.add('author');
  }
  if (typeof record.timestamp === 'string') {
    signals.add('timing');
  }
  if (
    /task|accepted|running|finished|completed|failed|cancelled|queued|작업|실행|완료|실패/i.test(
      content,
    )
  ) {
    signals.add('lifecycle-shape');
  }
  return [...signals];
}

function parseEvidenceObservation(
  value: unknown,
  marker: string | undefined,
  expectedTaskId: string | undefined,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const content = typeof record.content === 'string' ? record.content : undefined;
  const signals = Array.isArray(record.matchedOn)
    ? record.matchedOn.filter(
        (
          entry,
        ): entry is 'marker' | 'task-id' | 'author' | 'timing' | 'lifecycle-shape' =>
          typeof entry === 'string' &&
          ['marker', 'task-id', 'author', 'timing', 'lifecycle-shape'].includes(entry),
      )
    : deriveMatchedOn(record, marker, expectedTaskId);
  const taskId =
    typeof record.taskId === 'string'
      ? record.taskId
      : extractTaskIdFromText(content);
  return {
    ...(typeof record.timestamp === 'string' ? { observedAt: record.timestamp } : {}),
    ...(typeof record.id === 'string' ? { messageId: record.id } : {}),
    ...(typeof record.authorId === 'string' ? { authorId: record.authorId } : {}),
    ...(taskId === undefined ? {} : { taskId }),
    ...(marker === undefined ? {} : { marker }),
    ...(signals.length === 0 ? {} : { matchedOn: signals }),
    source: 'discord-rest-observation',
  };
}

function deriveMcpReadiness(
  command: ReturnType<typeof buildPeekabooTurnCommand>,
  helperResult: unknown,
): unknown {
  const parsed = parsePeekabooReadinessReport(
    readNestedValue(helperResult, ['readiness']),
  );
  if (parsed !== undefined) {
    return parsed;
  }
  if (command.executionMode === 'dry-run') {
    return buildPeekabooReadinessReport({
      phase: 'dry-run',
      configOk: true,
    });
  }

  const matchedReply = readNestedValue(helperResult, ['observation', 'matchedReply']);
  const related = readNestedValue(helperResult, ['observation', 'related']);
  const marker = command.marker;
  const expectedTaskId = readFlagArg(command.args, '--expect-task-id');
  const ack =
    readNestedValue(helperResult, ['observation', 'acknowledgement']) ??
    readNestedValue(helperResult, ['observation', 'ack']) ??
    matchedReply;

  return buildPeekabooReadinessReport({
    phase: command.executionMode,
    configOk: true,
    marker,
    expectedTaskId,
    sshOk:
      readNestedBoolean(helperResult, ['probeResult', 'ssh', 'ok']) ??
      readNestedBoolean(helperResult, ['control', 'ssh', 'ok']),
    bridgePresent:
      readNestedBoolean(helperResult, ['probeResult', 'remote', 'bridge', 'exists']) ??
      readNestedBoolean(helperResult, ['control', 'bridge', 'exists']),
    proxyReady:
      command.executionMode === 'probe'
        ? readNestedBoolean(helperResult, ['probeResult', 'remote', 'proxy', 'ready'])
        : command.executionMode === 'live'
          ? readNestedBoolean(helperResult, ['control', 'proxy', 'ready'])
          : undefined,
    probeProxyReady: readNestedBoolean(
      helperResult,
      ['probeResult', 'remote', 'proxy', 'ready'],
    ),
    liveProxyReady: readNestedBoolean(helperResult, ['control', 'proxy', 'ready']),
    submitAttempted:
      readNestedBoolean(helperResult, ['control', 'submitAttempted']) ??
      readNestedBoolean(helperResult, ['submitAttempted']),
    controlOk:
      readNestedBoolean(helperResult, ['control', 'ok']) ??
      readNestedBoolean(helperResult, ['ok']),
    restObservationAttempted:
      command.executionMode === 'live' ? !command.args.includes('--no-rest') : false,
    ack: parseEvidenceObservation(ack, marker, expectedTaskId),
    matchedReply: parseEvidenceObservation(matchedReply, marker, expectedTaskId),
    relatedReplyCount: Array.isArray(related) ? related.length : 0,
    matchedReplyObserved: matchedReply !== undefined && matchedReply !== null,
    error:
      readNestedValue(helperResult, ['error']) ??
      readNestedValue(helperResult, ['control', 'error']) ??
      readNestedValue(helperResult, ['probeResult', 'remote', 'error']),
  });
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    for (const line of [...lines].reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Keep searching from the bottom; helper output should be JSON, but
        // transport diagnostics may occasionally precede it in local tests.
      }
    }
    return { raw: trimmed.slice(0, 4000) };
  }
}

export function listPeekabooMcpTools(): readonly Record<string, unknown>[] {
  return [
    {
      name: 'peekaboo_remote_eval_standard',
      description:
        'Return the standardized Peekaboo remote-access evaluation protocol, gates, evidence schema, and PASS/WARN/FAIL rubric.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'peekaboo_remote_eval_plan',
      description:
        'Create a marker/evidence plan for a bounded Peekaboo Discord GUI evaluation run. This is read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['runId'],
        properties: {
          runId: { type: 'string', description: 'Stable run id; markers become RUN_ID_T01...' },
          goal: { type: 'string' },
          maxTurns: { type: 'integer', minimum: 1, maximum: 30, default: 15 },
          channelId: { type: 'string' },
          target: { type: 'string', enum: ['arona', 'plana', 'mixed'], default: 'arona' },
          firstMode: { type: 'string', enum: PEEKABOO_CONTROL_MODES, default: 'natural-ask' },
          evidenceDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'peekaboo_remote_eval_batch_plan',
      description:
        'Create a bounded 5-10 turn Peekaboo batch planning surface. This is validation-only, returns precheck or live command templates, and never executes them.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['runId', 'executionMode'],
        properties: {
          runId: { type: 'string' },
          executionMode: {
            type: 'string',
            enum: PEEKABOO_BATCH_EXECUTION_MODES,
          },
          goal: { type: 'string' },
          maxTurns: {
            type: 'integer',
            minimum: PEEKABOO_BATCH_MIN_TURNS,
            maximum: PEEKABOO_BATCH_MAX_TURNS,
            default: PEEKABOO_BATCH_MIN_TURNS,
          },
          channelId: { type: 'string' },
          target: { type: 'string', enum: ['arona', 'plana', 'mixed'], default: 'arona' },
          firstMode: { type: 'string', enum: PEEKABOO_CONTROL_MODES, default: 'natural-ask' },
          evidenceDirectory: { type: 'string' },
          allowLive: { type: 'boolean', default: false },
          probe: {
            type: 'boolean',
            default: false,
            description:
              'Compatibility guard only. probe=true is rejected when executionMode="live".',
          },
          precheckOnly: {
            type: 'boolean',
            default: false,
            description:
              'Compatibility guard only. precheckOnly=true is rejected when executionMode="live".',
          },
          precheck: PEEKABOO_BATCH_PRECHECK_PROOF_SCHEMA,
        },
      },
    },
    {
      name: 'peekaboo_remote_eval_run_turn',
      description:
        'Run one standardized Peekaboo direct-control turn through the existing GUI helper. Defaults to dry-run; set probe=true for staged readiness checks without Discord submission; live remote GUI control requires dryRun=false and allowLive=true.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['runId'],
        properties: {
          runId: { type: 'string' },
          turnNumber: { type: 'integer', minimum: 1, maximum: 99, default: 1 },
          marker: { type: 'string' },
          mode: { type: 'string', enum: PEEKABOO_CONTROL_MODES, default: 'natural-ask' },
          message: {
            type: 'string',
            description:
              'Required for every mode except slash-unfocus, which takes no instruction option.',
          },
          channelId: { type: 'string' },
          guildId: { type: 'string' },
          expectAuthor: { type: 'string' },
          expectTaskId: { type: 'string' },
          pollMode: { type: 'string', enum: PEEKABOO_POLL_MODES },
          polls: { type: 'integer', minimum: 0, default: 12 },
          pollMs: { type: 'integer', minimum: 1, default: 5000 },
          commandSelect: { type: 'string', enum: ['return', 'click'], default: 'return' },
          mentionUserId: { type: 'string' },
          naturalAddress: { type: 'string' },
          sshHost: { type: 'string' },
          sshKey: { type: 'string' },
          remoteRoot: { type: 'string' },
          remoteNode: { type: 'string' },
          bridgePath: { type: 'string' },
          envFile: {
            type: 'string',
            description:
              'Optional explicit env file passed to the helper for REST observation. Use only with operator authorization for that path.',
          },
          botTokenEnv: {
            type: 'string',
            description:
              'Optional environment variable name that contains the Discord bot token for REST observation.',
          },
          noRest: { type: 'boolean', default: false },
          debugSteps: { type: 'boolean', default: false },
          observeMode: {
            type: 'string',
            enum: PEEKABOO_OBSERVE_MODES,
            default: 'see',
            description:
              'Post-submit GUI observation mode passed to the helper. "image"/"both" capture a Peekaboo PNG when GUI OCR text cannot reliably show the latest Discord message.',
          },
          imageCapturePath: {
            type: 'string',
            description:
              'Remote PNG path used by --observe-mode image|both. Must not contain spaces. Defaults to /tmp/auto-archive-discord-observe-<timestamp>.png on the remote node when omitted.',
          },
          imageOutput: {
            type: 'string',
            description:
              'Optional local artifact path to copy the remote PNG capture to via scp (no raw secrets are exposed; only the binary file).',
          },
          dryRun: { type: 'boolean', default: true },
          probe: { type: 'boolean', default: false },
          allowLive: { type: 'boolean', default: false },
        },
      },
    },
    {
      name: 'peekaboo_remote_eval_evidence_append',
      description:
        'Append one normalized Peekaboo evidence digest record to a JSONL ledger for durable adjudication replay.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ledgerPath'],
        properties: {
          ledgerPath: { type: 'string' },
          record: {
            ...PEEKABOO_EVIDENCE_APPEND_RECORD_SCHEMA,
            description:
              'Optional full append payload. If supplied, do not also send top-level run/turn/readiness/evidence fields. Caller MUST provide either `record`, or the inline tuple {runId, turnMarker, correlationId, readiness, evidence}; runtime parser fails closed when neither shape is satisfied.',
          },
          recordId: { type: 'string' },
          recordedAt: { type: 'string' },
          runId: { type: 'string' },
          turnMarker: { type: 'string' },
          correlationId: { type: 'string' },
          artifactPath: { type: 'string' },
          taskId: { type: 'string' },
          channelId: { type: 'string' },
          guildId: { type: 'string' },
          mode: { type: 'string', enum: PEEKABOO_CONTROL_MODES },
          phase: { type: 'string', enum: PEEKABOO_EXECUTION_MODES },
          readiness: PEEKABOO_READINESS_REPORT_SCHEMA,
          evidence: PEEKABOO_EVIDENCE_AUDIT_SCHEMA,
          outcome: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    {
      name: 'peekaboo_remote_eval_evidence_query',
      description:
        'Query a Peekaboo evidence JSONL ledger by run, turn marker, task id, correlation id, channel, phase, and optional tail limit.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ledgerPath'],
        properties: {
          ledgerPath: { type: 'string' },
          runId: { type: 'string' },
          turnMarker: { type: 'string' },
          taskId: { type: 'string' },
          correlationId: { type: 'string' },
          channelId: { type: 'string' },
          phase: { type: 'string', enum: PEEKABOO_EXECUTION_MODES },
          limit: { type: 'integer', minimum: 0 },
        },
      },
    },
    {
      name: 'peekaboo_remote_eval_quantitative_report',
      description:
        'Build a read-only quantitative scorecard and optional baseline-vs-candidate comparison from a Peekaboo evidence JSONL ledger.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ledgerPath'],
        properties: {
          ledgerPath: { type: 'string' },
          runId: { type: 'string' },
          turnMarker: { type: 'string' },
          taskId: { type: 'string' },
          correlationId: { type: 'string' },
          channelId: { type: 'string' },
          phase: { type: 'string', enum: PEEKABOO_EXECUTION_MODES },
          limit: { type: 'integer', minimum: 0 },
          baselineRunId: {
            type: 'string',
            description:
              'Optional baseline run id for improvement comparison.',
          },
          candidateRunId: {
            type: 'string',
            description:
              'Optional candidate run id for improvement comparison.',
          },
          generatedAt: { type: 'string' },
        },
      },
    },
  ];
}

export function callPeekabooMcpTool(
  name: string,
  toolArguments: unknown,
  options: ToolExecutionOptions = {},
): ToolResult {
  if (name === 'peekaboo_remote_eval_standard') {
    return textResult(PEEKABOO_REMOTE_EVALUATION_STANDARD);
  }
  if (name === 'peekaboo_remote_eval_plan') {
    return textResult(buildPeekabooEvaluationPlan(parsePlanInput(toolArguments)));
  }
  if (name === 'peekaboo_remote_eval_batch_plan') {
    return textResult(buildPeekabooBatchPlan(parseBatchPlanInput(toolArguments)));
  }
  if (name === 'peekaboo_remote_eval_run_turn') {
    const input = parseTurnInput(toolArguments);
    const command = buildPeekabooTurnCommand(input);
    if (command.executionMode === 'dry-run') {
      const readiness = deriveMcpReadiness(command, null);
      return textResult({
        ok: true,
        command: {
          executable: command.executable,
          args: command.args,
          marker: command.marker,
          mode: command.mode,
          pollMode: command.pollMode,
          executionMode: command.executionMode,
          dryRun: command.dryRun,
          probe: command.probe,
          mutatesRemoteGui: command.mutatesRemoteGui,
          evidenceExpectation: command.evidenceExpectation,
        },
        execution: {
          status: 0,
          signal: null,
          skipped: true,
          reason:
            'MCP dry-run returns the standardized helper command without spawning the helper or mutating remote GUI state.',
        },
        helperResult: {
          ok: true,
          dryRun: true,
        },
        readiness,
        evidence:
          asRecord(readiness).evidence === undefined
            ? undefined
            : asRecord(readiness).evidence,
      });
    }
    const executor = options.executor ?? ((executable, args) => {
      const result = spawnSync(executable, [...args], {
        cwd: input.repoRoot ?? process.cwd(),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    });
    const execution = executor(command.executable, command.args);
    const ok = execution.error === undefined && execution.status === 0;
    const helperResult = parseJsonOutput(execution.stdout);
    const readiness = deriveMcpReadiness(command, helperResult);
    const payload = {
      ok,
      command: {
        executable: command.executable,
        args: command.args,
        marker: command.marker,
        mode: command.mode,
        pollMode: command.pollMode,
        executionMode: command.executionMode,
        dryRun: command.dryRun,
        probe: command.probe,
        mutatesRemoteGui: command.mutatesRemoteGui,
        evidenceExpectation: command.evidenceExpectation,
      },
      execution: {
        status: execution.status,
        signal: execution.signal,
        stderr: execution.stderr.trim().slice(0, 4000),
        ...(execution.error === undefined
          ? {}
          : { error: execution.error.message }),
      },
      helperResult,
      readiness,
      evidence:
        asRecord(readiness).evidence === undefined
          ? undefined
          : asRecord(readiness).evidence,
    };
    return textResult(payload, !ok);
  }
  if (name === 'peekaboo_remote_eval_evidence_append') {
    const input = parseEvidenceAppendInput(toolArguments);
    const ledger = new JsonlPeekabooEvidenceLedger(input.ledgerPath);
    const record = ledger.append(input.record);
    return textResult({
      ok: true,
      ledgerPath: input.ledgerPath,
      record,
    });
  }
  if (name === 'peekaboo_remote_eval_evidence_query') {
    const input = parseEvidenceQueryInput(toolArguments);
    const ledger = new JsonlPeekabooEvidenceLedger(input.ledgerPath);
    const records = filterPeekabooEvidenceRecords(ledger.loadAll(), input.filter);
    return textResult({
      ok: true,
      ledgerPath: input.ledgerPath,
      count: records.length,
      records,
    });
  }
  if (name === 'peekaboo_remote_eval_quantitative_report') {
    const input = parseQuantitativeReportInput(toolArguments);
    const ledger = new JsonlPeekabooEvidenceLedger(input.ledgerPath);
    return textResult({
      ok: true,
      ledgerPath: input.ledgerPath,
      report: buildPeekabooQuantitativeReport({
        records: ledger.loadAll(),
        filter: input.filter,
        ...(input.baselineRunId === undefined
          ? {}
          : { baselineRunId: input.baselineRunId }),
        ...(input.candidateRunId === undefined
          ? {}
          : { candidateRunId: input.candidateRunId }),
        ...(input.generatedAt === undefined
          ? {}
          : { generatedAt: input.generatedAt }),
      }),
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

export function handleMcpJsonRpcMessage(
  message: JsonRpcRequest,
  options: ToolExecutionOptions = {},
): JsonRpcResponse | undefined {
  const id = message.id ?? null;
  const method = message.method;
  const params = asRecord(message.params);

  try {
    if (method === 'initialize') {
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Use peekaboo_remote_eval_plan or peekaboo_remote_eval_batch_plan before live turns. The batch tool is planning-only and never executes remote GUI actions. peekaboo_remote_eval_run_turn defaults to dry-run; use probe=true to verify staged readiness without submission; set dryRun=false and allowLive=true only for approved remote GUI mutation.',
      });
    }

    if (method === 'notifications/initialized') {
      return undefined;
    }

    if (method === 'ping') {
      return success(id, {});
    }

    if (method === 'tools/list') {
      return success(id, { tools: listPeekabooMcpTools() });
    }

    if (method === 'tools/call') {
      const name = readString(params, 'name');
      if (name === undefined) {
        throw new Error('tools/call requires params.name.');
      }
      const toolArguments = params.arguments ?? {};
      return success(id, callPeekabooMcpTool(name, toolArguments, options));
    }

    return failure(id, -32601, `Method not found: ${method ?? '<missing>'}`);
  } catch (error) {
    return failure(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function startPeekabooRemoteEvalMcpServer(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      process.stdout.write(
        JSON.stringify(
          failure(
            null,
            -32700,
            error instanceof Error ? error.message : String(error),
          ),
        ) + '\n',
      );
      return;
    }
    const message = validateJsonRpcRequest(parsed);
    if (message === undefined) {
      // Audit 2026-05-03 / G2: malformed envelope (null, primitive,
      // array, or wrong-typed id/method/jsonrpc) is rejected at the
      // boundary instead of falling through to a generic -32000.
      process.stdout.write(
        JSON.stringify(
          failure(
            null,
            -32700,
            'Invalid JSON-RPC frame: expected an object with optional string method/jsonrpc and optional string|number|null id.',
          ),
        ) + '\n',
      );
      return;
    }
    const response = handleMcpJsonRpcMessage(message);
    if (response !== undefined) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
  rl.on('close', () => process.exit(0));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  startPeekabooRemoteEvalMcpServer();
}
