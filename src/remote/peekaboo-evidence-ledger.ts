import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  PEEKABOO_CONTROL_MODES,
  PEEKABOO_EXECUTION_MODES,
  PEEKABOO_READINESS_LABELS,
  PEEKABOO_READINESS_STATUSES,
  parsePeekabooEvidenceAudit,
  parsePeekabooReadinessReport,
  type PeekabooControlMode,
  type PeekabooEvidenceAudit,
  type PeekabooEvidenceScoringFactor,
  type PeekabooEvidenceStage,
  type PeekabooExecutionMode,
  type PeekabooReadinessLabel,
  type PeekabooReadinessReport,
  type PeekabooReadinessStatus,
} from './peekaboo-remote-evaluation.js';

export const PEEKABOO_EVIDENCE_RECORD_SCHEMA_VERSION = 1 as const;

export interface PeekabooEvidenceLedgerReadiness {
  readonly phase: PeekabooExecutionMode;
  readonly overallStatus: PeekabooReadinessStatus;
  readonly proxyReady: boolean;
  readonly probeProxyReady: boolean;
  readonly liveProxyReady: boolean;
  readonly submitReady: boolean;
  readonly liveOk: boolean;
  readonly liveSubmitPerformed: boolean;
  readonly matchedReplyObserved: boolean;
  readonly highestReady: PeekabooReadinessLabel | null;
  readonly summary: string;
}

export interface PeekabooEvidenceRecord {
  readonly schemaVersion: typeof PEEKABOO_EVIDENCE_RECORD_SCHEMA_VERSION;
  readonly recordId: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly turnMarker: string;
  readonly correlationId: string;
  /** Path to the durable evidence artifact/ledger that contains this record. */
  readonly artifactPath?: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly mode?: PeekabooControlMode;
  readonly phase?: PeekabooExecutionMode;
  readonly readiness: PeekabooEvidenceLedgerReadiness;
  readonly evidence: PeekabooEvidenceAudit;
  readonly outcome?: string;
  readonly notes?: string;
}

export interface PeekabooEvidenceRecordInput {
  readonly recordId?: string;
  readonly recordedAt?: string;
  readonly runId: string;
  readonly turnMarker: string;
  readonly correlationId: string;
  readonly artifactPath?: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly mode?: PeekabooControlMode;
  readonly phase?: PeekabooExecutionMode;
  readonly readiness:
    | PeekabooEvidenceLedgerReadiness
    | PeekabooReadinessReport;
  readonly evidence: PeekabooEvidenceAudit;
  readonly outcome?: string;
  readonly notes?: string;
}

export interface BuildPeekabooEvidenceDigestInput {
  readonly recordId?: string;
  readonly recordedAt?: string;
  readonly runId: string;
  readonly turnMarker: string;
  readonly correlationId: string;
  readonly artifactPath?: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly mode?: PeekabooControlMode;
  readonly phase?: PeekabooExecutionMode;
  readonly readinessReport: PeekabooReadinessReport;
  readonly evidence?: PeekabooEvidenceAudit;
  readonly outcome?: string;
  readonly notes?: string;
}

export interface PeekabooEvidenceLedgerPort {
  append(input: PeekabooEvidenceRecordInput): PeekabooEvidenceRecord;
  loadAll(): PeekabooEvidenceRecord[];
}

export interface PeekabooEvidenceRecordFilter {
  readonly runId?: string;
  readonly turnMarker?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly channelId?: string;
  readonly phase?: PeekabooExecutionMode;
  readonly limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return value;
}

function isOneOf<T extends readonly string[]>(
  value: string,
  candidates: T,
): value is T[number] {
  return (candidates as readonly string[]).includes(value);
}

function cloneScoringFactors(
  factors: readonly PeekabooEvidenceScoringFactor[] | undefined,
): readonly PeekabooEvidenceScoringFactor[] | undefined {
  return factors === undefined ? undefined : factors.map((factor) => ({ ...factor }));
}

function cloneEvidenceStage(stage: PeekabooEvidenceStage): PeekabooEvidenceStage {
  const scoringFactors = cloneScoringFactors(stage.scoringFactors);
  return {
    ...stage,
    ...(stage.matchedOn === undefined ? {} : { matchedOn: [...stage.matchedOn] }),
    ...(scoringFactors === undefined ? {} : { scoringFactors }),
  };
}

function cloneEvidenceAudit(evidence: PeekabooEvidenceAudit): PeekabooEvidenceAudit {
  return {
    ...(evidence.marker === undefined ? {} : { marker: evidence.marker }),
    ...(evidence.expectedTaskId === undefined
      ? {}
      : { expectedTaskId: evidence.expectedTaskId }),
    submit: cloneEvidenceStage(evidence.submit),
    taskCorrelation: cloneEvidenceStage(evidence.taskCorrelation),
    ack: cloneEvidenceStage(evidence.ack),
    matchedReply: cloneEvidenceStage(evidence.matchedReply),
  };
}

function cloneReadiness(
  readiness: PeekabooEvidenceLedgerReadiness,
): PeekabooEvidenceLedgerReadiness {
  return { ...readiness };
}

function deriveTaskId(
  explicitTaskId: string | undefined,
  evidence: PeekabooEvidenceAudit,
): string | undefined {
  return (
    explicitTaskId ??
    evidence.expectedTaskId ??
    evidence.taskCorrelation.taskId ??
    evidence.ack.taskId ??
    evidence.matchedReply.taskId
  );
}

export function createPeekabooEvidenceLedgerReadiness(
  report: PeekabooReadinessReport,
): PeekabooEvidenceLedgerReadiness {
  return {
    phase: report.phase,
    overallStatus: report.overallStatus,
    proxyReady: report.proxyReady,
    probeProxyReady: report.probeProxyReady,
    liveProxyReady: report.liveProxyReady,
    submitReady: report.submitReady,
    liveOk: report.liveOk,
    liveSubmitPerformed: report.liveSubmitPerformed,
    matchedReplyObserved: report.matchedReplyObserved,
    highestReady: report.highestReady,
    summary: report.summary,
  };
}

export function parsePeekabooEvidenceLedgerReadiness(
  raw: unknown,
): PeekabooEvidenceLedgerReadiness | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const phase =
    typeof raw['phase'] === 'string' &&
    isOneOf(raw['phase'], PEEKABOO_EXECUTION_MODES)
      ? raw['phase']
      : undefined;
  const overallStatus =
    typeof raw['overallStatus'] === 'string' &&
    isOneOf(raw['overallStatus'], PEEKABOO_READINESS_STATUSES)
      ? raw['overallStatus']
      : undefined;
  const highestReadyValue = raw['highestReady'];
  const highestReady =
    highestReadyValue === null
      ? null
      : typeof highestReadyValue === 'string' &&
          isOneOf(highestReadyValue, PEEKABOO_READINESS_LABELS)
        ? highestReadyValue
        : undefined;
  if (
    phase === undefined ||
    overallStatus === undefined ||
    highestReady === undefined ||
    typeof raw['proxyReady'] !== 'boolean' ||
    typeof raw['probeProxyReady'] !== 'boolean' ||
    typeof raw['liveProxyReady'] !== 'boolean' ||
    typeof raw['submitReady'] !== 'boolean' ||
    typeof raw['liveOk'] !== 'boolean' ||
    typeof raw['liveSubmitPerformed'] !== 'boolean' ||
    typeof raw['matchedReplyObserved'] !== 'boolean' ||
    typeof raw['summary'] !== 'string'
  ) {
    return undefined;
  }
  return {
    phase,
    overallStatus,
    proxyReady: raw['proxyReady'],
    probeProxyReady: raw['probeProxyReady'],
    liveProxyReady: raw['liveProxyReady'],
    submitReady: raw['submitReady'],
    liveOk: raw['liveOk'],
    liveSubmitPerformed: raw['liveSubmitPerformed'],
    matchedReplyObserved: raw['matchedReplyObserved'],
    highestReady,
    summary: raw['summary'],
  };
}

function normalizeReadiness(
  value: PeekabooEvidenceLedgerReadiness | PeekabooReadinessReport,
): PeekabooEvidenceLedgerReadiness {
  const report = parsePeekabooReadinessReport(value);
  if (report !== undefined) {
    return createPeekabooEvidenceLedgerReadiness(report);
  }
  const readiness = parsePeekabooEvidenceLedgerReadiness(value);
  if (readiness !== undefined) {
    return readiness;
  }
  throw new Error(
    'readiness must be a valid Peekaboo readiness report or normalized readiness digest.',
  );
}

function normalizeEvidence(value: PeekabooEvidenceAudit): PeekabooEvidenceAudit {
  const evidence = parsePeekabooEvidenceAudit(value);
  if (evidence === undefined) {
    throw new Error('evidence must be a valid Peekaboo evidence audit.');
  }
  return evidence;
}

export function createPeekabooEvidenceRecord(
  input: PeekabooEvidenceRecordInput,
): PeekabooEvidenceRecord {
  const readiness = normalizeReadiness(input.readiness);
  const evidence = normalizeEvidence(input.evidence);
  const phase = input.phase ?? readiness.phase;
  if (phase !== readiness.phase) {
    throw new Error('phase must match readiness.phase when both are provided.');
  }
  const taskId = deriveTaskId(optionalString(input.taskId), evidence);
  const artifactPath = optionalString(input.artifactPath);
  const mode = optionalString(input.mode);
  const channelId = optionalString(input.channelId);
  const guildId = optionalString(input.guildId);
  const outcome = optionalString(input.outcome);
  const notes = optionalString(input.notes);

  requireNonEmptyString(input.runId, 'runId');
  requireNonEmptyString(input.turnMarker, 'turnMarker');
  requireNonEmptyString(input.correlationId, 'correlationId');
  if (input.recordId !== undefined) {
    requireNonEmptyString(input.recordId, 'recordId');
  }
  if (
    mode !== undefined &&
    !isOneOf(mode, PEEKABOO_CONTROL_MODES)
  ) {
    throw new Error(
      `mode must be one of: ${PEEKABOO_CONTROL_MODES.join(', ')}.`,
    );
  }

  return {
    schemaVersion: PEEKABOO_EVIDENCE_RECORD_SCHEMA_VERSION,
    recordId: input.recordId ?? randomUUID(),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    runId: input.runId,
    turnMarker: input.turnMarker,
    correlationId: input.correlationId,
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(guildId === undefined ? {} : { guildId }),
    ...(mode === undefined ? {} : { mode }),
    phase,
    readiness: cloneReadiness(readiness),
    evidence: cloneEvidenceAudit(evidence),
    ...(outcome === undefined ? {} : { outcome }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function buildPeekabooEvidenceDigest(
  input: BuildPeekabooEvidenceDigestInput,
): PeekabooEvidenceRecord {
  return createPeekabooEvidenceRecord({
    recordId: input.recordId,
    recordedAt: input.recordedAt,
    runId: input.runId,
    turnMarker: input.turnMarker,
    correlationId: input.correlationId,
    ...(input.artifactPath === undefined ? {} : { artifactPath: input.artifactPath }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
    ...(input.guildId === undefined ? {} : { guildId: input.guildId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    readiness: input.readinessReport,
    evidence: input.evidence ?? input.readinessReport.evidence,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });
}

export function parsePeekabooEvidenceRecord(
  raw: unknown,
): PeekabooEvidenceRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw['schemaVersion'] !== PEEKABOO_EVIDENCE_RECORD_SCHEMA_VERSION) {
    return undefined;
  }
  const recordId = optionalString(raw['recordId']);
  const recordedAt = optionalString(raw['recordedAt']);
  const runId = optionalString(raw['runId']);
  const turnMarker = optionalString(raw['turnMarker']);
  const correlationId = optionalString(raw['correlationId']);
  const artifactPath = optionalString(raw['artifactPath']);
  const channelId = optionalString(raw['channelId']);
  const guildId = optionalString(raw['guildId']);
  const taskId = optionalString(raw['taskId']);
  const outcome = optionalString(raw['outcome']);
  const notes = optionalString(raw['notes']);
  const mode =
    typeof raw['mode'] === 'string' && isOneOf(raw['mode'], PEEKABOO_CONTROL_MODES)
      ? raw['mode']
      : undefined;
  const phase =
    typeof raw['phase'] === 'string' && isOneOf(raw['phase'], PEEKABOO_EXECUTION_MODES)
      ? raw['phase']
      : undefined;
  const readiness = parsePeekabooEvidenceLedgerReadiness(raw['readiness']);
  const evidence = parsePeekabooEvidenceAudit(raw['evidence']);
  if (
    recordId === undefined ||
    recordedAt === undefined ||
    runId === undefined ||
    turnMarker === undefined ||
    correlationId === undefined ||
    readiness === undefined ||
    evidence === undefined
  ) {
    return undefined;
  }
  if (phase !== undefined && phase !== readiness.phase) {
    return undefined;
  }
  return {
    schemaVersion: PEEKABOO_EVIDENCE_RECORD_SCHEMA_VERSION,
    recordId,
    recordedAt,
    runId,
    turnMarker,
    correlationId,
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(guildId === undefined ? {} : { guildId }),
    ...(mode === undefined ? {} : { mode }),
    ...(phase === undefined ? {} : { phase }),
    readiness: cloneReadiness(readiness),
    evidence: cloneEvidenceAudit(evidence),
    ...(outcome === undefined ? {} : { outcome }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function recordTaskId(record: PeekabooEvidenceRecord): string | undefined {
  return deriveTaskId(record.taskId, record.evidence);
}

export function filterPeekabooEvidenceRecords(
  records: readonly PeekabooEvidenceRecord[],
  filter: PeekabooEvidenceRecordFilter = {},
): PeekabooEvidenceRecord[] {
  const filtered = records.filter((record) => {
    if (filter.runId !== undefined && record.runId !== filter.runId) {
      return false;
    }
    if (
      filter.turnMarker !== undefined &&
      record.turnMarker !== filter.turnMarker
    ) {
      return false;
    }
    if (filter.taskId !== undefined && recordTaskId(record) !== filter.taskId) {
      return false;
    }
    if (
      filter.correlationId !== undefined &&
      record.correlationId !== filter.correlationId
    ) {
      return false;
    }
    if (
      filter.channelId !== undefined &&
      record.channelId !== filter.channelId
    ) {
      return false;
    }
    if (
      filter.phase !== undefined &&
      (record.phase ?? record.readiness.phase) !== filter.phase
    ) {
      return false;
    }
    return true;
  });
  const bounded =
    filter.limit === undefined
      ? filtered
      : filtered.slice(-Math.max(0, filter.limit));
  return bounded.map((record) => parsePeekabooEvidenceRecord(record) ?? record);
}

export class InMemoryPeekabooEvidenceLedger
  implements PeekabooEvidenceLedgerPort
{
  private readonly records: PeekabooEvidenceRecord[] = [];

  constructor(seed: readonly PeekabooEvidenceRecord[] = []) {
    this.records.push(
      ...seed.map((record) => parsePeekabooEvidenceRecord(record) ?? record),
    );
  }

  append(input: PeekabooEvidenceRecordInput): PeekabooEvidenceRecord {
    const record = createPeekabooEvidenceRecord(input);
    this.records.push(record);
    return parsePeekabooEvidenceRecord(record) ?? record;
  }

  loadAll(): PeekabooEvidenceRecord[] {
    return this.records.map(
      (record) => parsePeekabooEvidenceRecord(record) ?? record,
    );
  }
}

export class JsonlPeekabooEvidenceLedger implements PeekabooEvidenceLedgerPort {
  constructor(private readonly filePath: string) {}

  append(input: PeekabooEvidenceRecordInput): PeekabooEvidenceRecord {
    const record = createPeekabooEvidenceRecord(input);
    ensureDirFor(this.filePath);
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  loadAll(): PeekabooEvidenceRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const records: PeekabooEvidenceRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const record = parsePeekabooEvidenceRecord(JSON.parse(trimmed));
        if (record !== undefined) {
          records.push(record);
        }
      } catch {
        // Torn final lines or manual edits must not block evidence replay.
      }
    }
    return records;
  }
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (dir.length > 0 && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
