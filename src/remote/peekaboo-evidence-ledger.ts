import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  PEEKABOO_CONTROL_MODES,
  PEEKABOO_EVALUATION_PROTOCOL_VERSION,
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
export const PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS = 5 as const;
export const PEEKABOO_QUANTITATIVE_RUBRIC_VERSION =
  '2026-05-04.initial-live-evidence-v1' as const;

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

export interface PeekabooEvidenceLedgerReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
}

export interface PeekabooEvidenceLedgerReplayResult {
  readonly records: readonly PeekabooEvidenceRecord[];
  readonly replayAudit: PeekabooEvidenceLedgerReplayAudit;
}

export interface PeekabooEvidenceLedgerReplayOptions {
  readonly maxBytes?: number;
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

export interface PeekabooQuantitativeRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface PeekabooQuantitativeScorecard {
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly recordCount: number;
  readonly runIds: readonly string[];
  readonly phaseCounts: Readonly<Record<PeekabooExecutionMode, number>>;
  readonly outcomeCounts: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly other: number;
    readonly missing: number;
  };
  readonly readiness: {
    readonly liveOk: PeekabooQuantitativeRate;
    readonly submitReady: PeekabooQuantitativeRate;
    readonly matchedReplyObserved: PeekabooQuantitativeRate;
  };
  readonly evidence: {
    readonly taskCorrelationCaptured: PeekabooQuantitativeRate;
    readonly ackCaptured: PeekabooQuantitativeRate;
    readonly matchedReplyCaptured: PeekabooQuantitativeRate;
    readonly strongCorrelation: PeekabooQuantitativeRate;
    readonly averageCorrelationPoints: number;
    readonly correlationScoreCounts: {
      readonly strong: number;
      readonly moderate: number;
      readonly weak: number;
      readonly none: number;
      readonly missing: number;
    };
    readonly observationSourceCounts: {
      readonly submit: Readonly<Record<string, number>>;
      readonly taskCorrelation: Readonly<Record<string, number>>;
      readonly ack: Readonly<Record<string, number>>;
      readonly matchedReply: Readonly<Record<string, number>>;
    };
  };
  readonly confidence: {
    readonly liveSampleSize: number;
    readonly minimumRecommendedLiveRecords: typeof PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS;
    readonly sufficientForPromotion: boolean;
    readonly summary: string;
  };
  readonly qualityScore: {
    readonly rubricVersion: typeof PEEKABOO_QUANTITATIVE_RUBRIC_VERSION;
    readonly value: number;
    readonly max: 100;
    readonly summary: string;
    readonly components: readonly {
      readonly id: string;
      readonly weight: number;
      readonly rate: number;
      readonly contribution: number;
    }[];
  };
  readonly recommendations: readonly string[];
}

export interface PeekabooQuantitativeComparison {
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly baseline: PeekabooQuantitativeScorecard;
  readonly candidate: PeekabooQuantitativeScorecard;
  readonly deltas: {
    readonly recordCount: number;
    readonly qualityScore: number;
    readonly liveOkRate: number;
    readonly matchedReplyObservedRate: number;
    readonly strongCorrelationRate: number;
    readonly passRate: number;
    readonly observationSourceShifts: {
      readonly submit: Readonly<Record<string, number>>;
      readonly taskCorrelation: Readonly<Record<string, number>>;
      readonly ack: Readonly<Record<string, number>>;
      readonly matchedReply: Readonly<Record<string, number>>;
    };
  };
  readonly promotionGate: {
    readonly baselineSufficientForPromotion: boolean;
    readonly candidateSufficientForPromotion: boolean;
    readonly qualityDeltaMeetsThreshold: boolean;
    readonly readinessGuardrailsPassed: boolean;
    readonly eligibleForPromotion: boolean;
  };
  readonly interpretation: string;
}

export interface PeekabooQuantitativeReport {
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly generatedAt?: string;
  readonly filter: PeekabooEvidenceRecordFilter;
  readonly replayAudit?: PeekabooEvidenceLedgerReplayAudit;
  readonly method: {
    readonly primaryMetric: string;
    readonly guardrailMetrics: readonly string[];
    readonly minimumSampleGuidance: string;
    readonly scoringRubricVersion: typeof PEEKABOO_QUANTITATIVE_RUBRIC_VERSION;
    readonly iterationLoop: readonly string[];
    readonly promotionRule: string;
  };
  readonly scorecard: PeekabooQuantitativeScorecard;
  readonly comparison?: PeekabooQuantitativeComparison;
}

export interface PeekabooQuantitativeReportInput {
  readonly records: readonly PeekabooEvidenceRecord[];
  readonly filter?: PeekabooEvidenceRecordFilter;
  readonly replayAudit?: PeekabooEvidenceLedgerReplayAudit;
  readonly baselineRunId?: string;
  readonly candidateRunId?: string;
  readonly generatedAt?: string;
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

function rate(numerator: number, denominator: number): PeekabooQuantitativeRate {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : round4(numerator / denominator),
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function normalizeOutcome(
  outcome: string | undefined,
): 'pass' | 'warn' | 'fail' | 'other' | 'missing' {
  if (outcome === undefined || outcome.trim().length === 0) {
    return 'missing';
  }
  const normalized = outcome.trim().toUpperCase();
  if (normalized.startsWith('PASS')) return 'pass';
  if (normalized.startsWith('WARN')) return 'warn';
  if (normalized.startsWith('FAIL')) return 'fail';
  return 'other';
}

function diffObservationSourceCounts(
  baseline: Readonly<Record<string, number>>,
  candidate: Readonly<Record<string, number>>,
): Record<string, number> {
  const shift: Record<string, number> = {};
  const keys = new Set<string>([
    ...Object.keys(baseline),
    ...Object.keys(candidate),
  ]);
  for (const key of keys) {
    const delta = (candidate[key] ?? 0) - (baseline[key] ?? 0);
    if (delta !== 0) {
      shift[key] = delta;
    }
  }
  return shift;
}

function incrementObservationSource(
  bucket: Record<string, number>,
  field: { readonly status: string; readonly source?: string },
): void {
  if (field.status !== 'captured') {
    return;
  }
  const sourceKey =
    typeof field.source === 'string' && field.source.trim().length > 0
      ? field.source.trim()
      : 'unspecified';
  bucket[sourceKey] = (bucket[sourceKey] ?? 0) + 1;
}

function correlationPoints(
  score: PeekabooEvidenceRecord['evidence']['taskCorrelation']['correlationScore'],
): number {
  switch (score) {
    case 'strong':
      return 3;
    case 'moderate':
      return 2;
    case 'weak':
      return 1;
    case 'none':
    case undefined:
      return 0;
  }
}

function buildRecommendations(input: {
  readonly recordCount: number;
  readonly liveSampleSize: number;
  readonly liveOk: PeekabooQuantitativeRate;
  readonly matchedReplyObserved: PeekabooQuantitativeRate;
  readonly strongCorrelation: PeekabooQuantitativeRate;
  readonly livePassRate: PeekabooQuantitativeRate;
  readonly observationSourceCounts: PeekabooQuantitativeScorecard['evidence']['observationSourceCounts'];
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.liveSampleSize < PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS) {
    recommendations.push(
      `Collect at least ${PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS} bounded live Peekaboo turns before treating score deltas as stable.`,
    );
  }
  if (input.liveOk.rate < 1) {
    recommendations.push(
      'Improve readiness/proxy/submit reliability before optimizing agent behavior.',
    );
  }
  if (input.matchedReplyObserved.rate < 0.8) {
    recommendations.push(
      'Strengthen marker/task-id correlation or REST observation before promoting the run.',
    );
  }
  if (input.strongCorrelation.rate < 0.8) {
    recommendations.push(
      'Require stronger evidence anchors: marker plus task-id is preferred over timing-only matches.',
    );
  }
  if (input.livePassRate.rate < 0.8) {
    recommendations.push(
      'Treat the next iteration as an improvement candidate, not a promoted baseline.',
    );
  }
  if (
    input.liveSampleSize >= PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS &&
    isOnlyImageSourced(input.observationSourceCounts.ack) &&
    Object.keys(input.observationSourceCounts.matchedReply).length === 0
  ) {
    recommendations.push(
      'All ack evidence is image-sourced and no REST matchedReply records exist; collect at least one REST-corroborated record per scope to cross-validate the image-observe path before promoting.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Evidence quality is sufficient for comparison; promote only if the candidate improves the weighted score without guardrail regression.',
    );
  }
  return recommendations;
}

function isOnlyImageSourced(
  counts: Readonly<Record<string, number>>,
): boolean {
  const keys = Object.keys(counts);
  if (keys.length === 0) {
    return false;
  }
  return keys.every((key) => key === 'image') && (counts['image'] ?? 0) > 0;
}

export function buildPeekabooQuantitativeScorecard(
  records: readonly PeekabooEvidenceRecord[],
): PeekabooQuantitativeScorecard {
  const parsedRecords = records
    .map((record) => parsePeekabooEvidenceRecord(record) ?? record)
    .filter((record): record is PeekabooEvidenceRecord => record !== undefined);
  const recordCount = parsedRecords.length;
  const liveRecords = parsedRecords.filter(
    (record) => (record.phase ?? record.readiness.phase) === 'live',
  );
  const liveDenominator = liveRecords.length;
  const runIds = [...new Set(parsedRecords.map((record) => record.runId))].sort();
  const phaseCounts = {
    'dry-run': 0,
    probe: 0,
    live: 0,
  } satisfies Record<PeekabooExecutionMode, number>;
  const outcomeCounts = {
    pass: 0,
    warn: 0,
    fail: 0,
    other: 0,
    missing: 0,
  };
  const correlationScoreCounts = {
    strong: 0,
    moderate: 0,
    weak: 0,
    none: 0,
    missing: 0,
  };
  let correlationPointTotal = 0;
  const observationSourceCounts = {
    submit: {} as Record<string, number>,
    taskCorrelation: {} as Record<string, number>,
    ack: {} as Record<string, number>,
    matchedReply: {} as Record<string, number>,
  };

  for (const record of parsedRecords) {
    phaseCounts[record.phase ?? record.readiness.phase] += 1;
    outcomeCounts[normalizeOutcome(record.outcome)] += 1;
    const score = record.evidence.taskCorrelation.correlationScore;
    if (score === undefined) {
      correlationScoreCounts.missing += 1;
    } else {
      correlationScoreCounts[score] += 1;
    }
    correlationPointTotal += correlationPoints(score);
    incrementObservationSource(
      observationSourceCounts.submit,
      record.evidence.submit,
    );
    incrementObservationSource(
      observationSourceCounts.taskCorrelation,
      record.evidence.taskCorrelation,
    );
    incrementObservationSource(
      observationSourceCounts.ack,
      record.evidence.ack,
    );
    incrementObservationSource(
      observationSourceCounts.matchedReply,
      record.evidence.matchedReply,
    );
  }

  const liveOk = rate(
    liveRecords.filter((record) => record.readiness.liveOk).length,
    liveDenominator,
  );
  const submitReady = rate(
    liveRecords.filter((record) => record.readiness.submitReady).length,
    liveDenominator,
  );
  const matchedReplyObserved = rate(
    liveRecords.filter((record) => record.readiness.matchedReplyObserved).length,
    liveDenominator,
  );
  const taskCorrelationCaptured = rate(
    liveRecords.filter(
      (record) => record.evidence.taskCorrelation.status === 'captured',
    ).length,
    liveDenominator,
  );
  const ackCaptured = rate(
    liveRecords.filter((record) => record.evidence.ack.status === 'captured')
      .length,
    liveDenominator,
  );
  const matchedReplyCaptured = rate(
    liveRecords.filter(
      (record) => record.evidence.matchedReply.status === 'captured',
    ).length,
    liveDenominator,
  );
  const strongCorrelation = rate(
    liveRecords.filter(
      (record) => record.evidence.taskCorrelation.correlationScore === 'strong',
    ).length,
    liveDenominator,
  );
  const livePassRate = rate(
    liveRecords.filter((record) => normalizeOutcome(record.outcome) === 'pass')
      .length,
    liveDenominator,
  );
  const confidence = {
    liveSampleSize: liveDenominator,
    minimumRecommendedLiveRecords: PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS,
    sufficientForPromotion:
      liveDenominator >= PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS,
    summary:
      liveDenominator >= PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS
        ? `Sample has ${liveDenominator} live record(s), meeting the minimum recommendation for promotion comparison.`
        : `Sample has ${liveDenominator} live record(s); collect at least ${PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS} before treating score deltas as stable.`,
  } as const;

  const components = [
    {
      id: 'live-ok-rate',
      weight: 25,
      rate: liveOk.rate,
      contribution: round4(25 * liveOk.rate),
    },
    {
      id: 'matched-reply-observed-rate',
      weight: 25,
      rate: matchedReplyObserved.rate,
      contribution: round4(25 * matchedReplyObserved.rate),
    },
    {
      id: 'strong-correlation-rate',
      weight: 20,
      rate: strongCorrelation.rate,
      contribution: round4(20 * strongCorrelation.rate),
    },
    {
      id: 'task-correlation-captured-rate',
      weight: 15,
      rate: taskCorrelationCaptured.rate,
      contribution: round4(15 * taskCorrelationCaptured.rate),
    },
    {
      id: 'live-pass-outcome-rate',
      weight: 15,
      rate: livePassRate.rate,
      contribution: round4(15 * livePassRate.rate),
    },
  ] as const;
  const qualityScoreValue = round4(
    components.reduce((total, component) => total + component.contribution, 0),
  );

  return {
    schemaVersion: 1,
    protocolVersion: PEEKABOO_EVALUATION_PROTOCOL_VERSION,
    recordCount,
    runIds,
    phaseCounts,
    outcomeCounts,
    readiness: {
      liveOk,
      submitReady,
      matchedReplyObserved,
    },
    evidence: {
      taskCorrelationCaptured,
      ackCaptured,
      matchedReplyCaptured,
      strongCorrelation,
      averageCorrelationPoints:
        recordCount === 0 ? 0 : round4(correlationPointTotal / recordCount),
      correlationScoreCounts,
      observationSourceCounts,
    },
    confidence,
    qualityScore: {
      rubricVersion: PEEKABOO_QUANTITATIVE_RUBRIC_VERSION,
      value: qualityScoreValue,
      max: 100,
      summary:
        recordCount === 0
          ? 'No Peekaboo evidence records were available for quantitative scoring.'
          : `Weighted Peekaboo evidence score ${qualityScoreValue}/100 over ${recordCount} record(s).`,
      components,
    },
    recommendations: buildRecommendations({
      recordCount,
      liveSampleSize: liveDenominator,
      liveOk,
      matchedReplyObserved,
      strongCorrelation,
      livePassRate,
      observationSourceCounts,
    }),
  };
}

function scorecardComponentRate(
  scorecard: PeekabooQuantitativeScorecard,
  componentId: string,
): number {
  return (
    scorecard.qualityScore.components.find(
      (component) => component.id === componentId,
    )?.rate ?? 0
  );
}

function buildPeekabooQuantitativeComparison(input: {
  readonly records: readonly PeekabooEvidenceRecord[];
  readonly filter: PeekabooEvidenceRecordFilter;
  readonly baselineRunId: string;
  readonly candidateRunId: string;
}): PeekabooQuantitativeComparison {
  const baseline = buildPeekabooQuantitativeScorecard(
    filterPeekabooEvidenceRecords(input.records, {
      ...input.filter,
      runId: input.baselineRunId,
    }),
  );
  const candidate = buildPeekabooQuantitativeScorecard(
    filterPeekabooEvidenceRecords(input.records, {
      ...input.filter,
      runId: input.candidateRunId,
    }),
  );
  const deltas = {
    recordCount: candidate.recordCount - baseline.recordCount,
    qualityScore: round4(candidate.qualityScore.value - baseline.qualityScore.value),
    liveOkRate: round4(candidate.readiness.liveOk.rate - baseline.readiness.liveOk.rate),
    matchedReplyObservedRate: round4(
      candidate.readiness.matchedReplyObserved.rate -
        baseline.readiness.matchedReplyObserved.rate,
    ),
    strongCorrelationRate: round4(
      candidate.evidence.strongCorrelation.rate -
        baseline.evidence.strongCorrelation.rate,
    ),
    passRate: round4(
      scorecardComponentRate(candidate, 'live-pass-outcome-rate') -
        scorecardComponentRate(baseline, 'live-pass-outcome-rate'),
    ),
    observationSourceShifts: {
      submit: diffObservationSourceCounts(
        baseline.evidence.observationSourceCounts.submit,
        candidate.evidence.observationSourceCounts.submit,
      ),
      taskCorrelation: diffObservationSourceCounts(
        baseline.evidence.observationSourceCounts.taskCorrelation,
        candidate.evidence.observationSourceCounts.taskCorrelation,
      ),
      ack: diffObservationSourceCounts(
        baseline.evidence.observationSourceCounts.ack,
        candidate.evidence.observationSourceCounts.ack,
      ),
      matchedReply: diffObservationSourceCounts(
        baseline.evidence.observationSourceCounts.matchedReply,
        candidate.evidence.observationSourceCounts.matchedReply,
      ),
    },
  };
  const qualityDeltaMeetsThreshold = deltas.qualityScore >= 5;
  const readinessGuardrailsPassed =
    deltas.liveOkRate >= 0 && deltas.matchedReplyObservedRate >= 0;
  const eligibleForPromotion =
    baseline.confidence.sufficientForPromotion &&
    candidate.confidence.sufficientForPromotion &&
    qualityDeltaMeetsThreshold &&
    readinessGuardrailsPassed;
  const promotionGate = {
    baselineSufficientForPromotion:
      baseline.confidence.sufficientForPromotion,
    candidateSufficientForPromotion:
      candidate.confidence.sufficientForPromotion,
    qualityDeltaMeetsThreshold,
    readinessGuardrailsPassed,
    eligibleForPromotion,
  } as const;
  const interpretation =
    !promotionGate.baselineSufficientForPromotion ||
    !promotionGate.candidateSufficientForPromotion
      ? 'insufficient-live-sample-for-promotion'
      : eligibleForPromotion
      ? 'candidate-improved-without-readiness-regression'
      : deltas.qualityScore > 0
        ? 'candidate-improved-but-guardrails-need-review'
        : deltas.qualityScore === 0
          ? 'candidate-tied-baseline'
          : 'candidate-regressed';
  return {
    baselineRunId: input.baselineRunId,
    candidateRunId: input.candidateRunId,
    baseline,
    candidate,
    deltas,
    promotionGate,
    interpretation,
  };
}

export function buildPeekabooQuantitativeReport(
  input: PeekabooQuantitativeReportInput,
): PeekabooQuantitativeReport {
  const filter = input.filter ?? {};
  const scopedRecords = filterPeekabooEvidenceRecords(input.records, filter);
  const comparison =
    input.baselineRunId === undefined || input.candidateRunId === undefined
      ? undefined
      : buildPeekabooQuantitativeComparison({
          records: input.records,
          filter,
          baselineRunId: input.baselineRunId,
          candidateRunId: input.candidateRunId,
        });
  return {
    schemaVersion: 1,
    protocolVersion: PEEKABOO_EVALUATION_PROTOCOL_VERSION,
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    filter,
    ...(input.replayAudit === undefined
      ? {}
      : { replayAudit: input.replayAudit }),
    method: {
      primaryMetric:
        'weighted qualityScore: liveOk 25 + matchedReplyObserved 25 + strongCorrelation 20 + taskCorrelationCaptured 15 + live PASS outcome 15',
      guardrailMetrics: [
        'liveOkRate must not regress',
        'matchedReplyObservedRate must not regress',
        'strongCorrelationRate should improve or stay stable',
        'sample size should be at least 5 bounded live turns before promotion',
      ],
      minimumSampleGuidance:
        `Use a ${PEEKABOO_QUANTITATIVE_MIN_LIVE_RECORDS}-10 live-turn Peekaboo batch per candidate; compare against a baseline run with the same target/channel/mode whenever possible. Smaller batches are reported but marked insufficient for promotion.`,
      scoringRubricVersion: PEEKABOO_QUANTITATIVE_RUBRIC_VERSION,
      iterationLoop: [
        'Run a non-mutating precheck/probe.',
        'Execute a bounded 5-10 turn live batch only after explicit precheck proof.',
        'Append each turn to the JSONL evidence ledger.',
        'Generate this quantitative report for the baseline and candidate run.',
        'Promote the candidate only when baseline/candidate sample sizes are sufficient, qualityScore improves by at least 5 points, and guardrails do not regress.',
      ],
      promotionRule:
        'baseline and candidate must each have >= 5 live records, candidate qualityScore delta >= +5, and liveOk/matchedReplyObserved deltas >= 0; otherwise iterate or keep the baseline.',
    },
    scorecard: buildPeekabooQuantitativeScorecard(scopedRecords),
    ...(comparison === undefined ? {} : { comparison }),
  };
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
    return [...this.loadWithAudit().records];
  }

  loadWithAudit(
    options: PeekabooEvidenceLedgerReplayOptions = {},
  ): PeekabooEvidenceLedgerReplayResult {
    if (!existsSync(this.filePath)) {
      return emptyPeekabooEvidenceLedgerReplayResult();
    }
    const maxBytes = options.maxBytes;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    ) {
      throw new Error(
        'Peekaboo evidence ledger replay maxBytes must be a positive safe integer.',
      );
    }
    return replayPeekabooEvidenceLedgerJsonlFile(this.filePath, maxBytes);
  }
}

const PEEKABOO_EVIDENCE_REPLAY_CHUNK_BYTES = 64 * 1024;

interface PeekabooEvidenceReplayAccumulator {
  readonly records: PeekabooEvidenceRecord[];
  totalLineCount: number;
  emptyLineCount: number;
  skippedMalformedLineCount: number;
}

function emptyPeekabooEvidenceLedgerReplayResult(): PeekabooEvidenceLedgerReplayResult {
  return {
    records: [],
    replayAudit: {
      source: 'jsonl',
      totalLineCount: 0,
      emptyLineCount: 0,
      parsedRecordCount: 0,
      skippedMalformedLineCount: 0,
    },
  };
}

function replayPeekabooEvidenceLedgerJsonlFile(
  filePath: string,
  maxBytes: number | undefined,
): PeekabooEvidenceLedgerReplayResult {
  const fileDescriptor = openSync(filePath, 'r');
  const buffer = Buffer.alloc(PEEKABOO_EVIDENCE_REPLAY_CHUNK_BYTES);
  const decoder = new TextDecoder('utf-8');
  const accumulator: PeekabooEvidenceReplayAccumulator = {
    records: [],
    totalLineCount: 0,
    emptyLineCount: 0,
    skippedMalformedLineCount: 0,
  };
  let bytesReadTotal = 0;
  let pendingLine = '';

  try {
    for (;;) {
      const bytesToRead = replayPeekabooBytesToRead(
        buffer.byteLength,
        bytesReadTotal,
        maxBytes,
      );
      const bytesRead = readSync(fileDescriptor, buffer, 0, bytesToRead, null);
      if (bytesRead === 0) {
        break;
      }
      bytesReadTotal += bytesRead;
      if (maxBytes !== undefined && bytesReadTotal > maxBytes) {
        throw new Error(
          `Peekaboo evidence ledger exceeds maxBytes: ${String(bytesReadTotal)} > ${String(maxBytes)}.`,
        );
      }
      pendingLine = replayPeekabooEvidenceTextChunk(
        accumulator,
        `${pendingLine}${decoder.decode(buffer.subarray(0, bytesRead), {
          stream: true,
        })}`,
      );
    }

    const finalDecodedText = decoder.decode();
    if (finalDecodedText.length > 0) {
      pendingLine = replayPeekabooEvidenceTextChunk(
        accumulator,
        `${pendingLine}${finalDecodedText}`,
      );
    }
    if (pendingLine.length > 0) {
      replayPeekabooEvidenceLine(accumulator, pendingLine);
    }

    return {
      records: accumulator.records,
      replayAudit: {
        source: 'jsonl',
        totalLineCount: accumulator.totalLineCount,
        emptyLineCount: accumulator.emptyLineCount,
        parsedRecordCount: accumulator.records.length,
        skippedMalformedLineCount: accumulator.skippedMalformedLineCount,
      },
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

function replayPeekabooBytesToRead(
  bufferBytes: number,
  bytesReadTotal: number,
  maxBytes: number | undefined,
): number {
  if (maxBytes === undefined) {
    return bufferBytes;
  }
  const remainingAllowedBytes = maxBytes - bytesReadTotal;
  return Math.min(bufferBytes, remainingAllowedBytes + 1);
}

function replayPeekabooEvidenceTextChunk(
  accumulator: PeekabooEvidenceReplayAccumulator,
  text: string,
): string {
  const physicalLines = text.split('\n');
  const pendingLine = physicalLines[physicalLines.length - 1] ?? '';
  for (const physicalLine of physicalLines.slice(0, -1)) {
    replayPeekabooEvidenceLine(
      accumulator,
      stripPeekabooJsonlLineFeedCarriageReturn(physicalLine),
    );
  }
  return pendingLine;
}

function stripPeekabooJsonlLineFeedCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function replayPeekabooEvidenceLine(
  accumulator: PeekabooEvidenceReplayAccumulator,
  line: string,
): void {
  accumulator.totalLineCount += 1;
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    accumulator.emptyLineCount += 1;
    return;
  }
  try {
    const record = parsePeekabooEvidenceRecord(JSON.parse(trimmed));
    if (record === undefined) {
      accumulator.skippedMalformedLineCount += 1;
      return;
    }
    accumulator.records.push(record);
  } catch {
    accumulator.skippedMalformedLineCount += 1;
  }
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (dir.length > 0 && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
