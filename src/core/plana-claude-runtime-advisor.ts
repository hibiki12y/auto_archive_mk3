/**
 * Claude-backed Plana runtime advisor.
 *
 * Calls the Claude Agent SDK with a single-shot prompt that summarizes one
 * `RuntimeEvent` and asks Claude to return a JSON verdict. Used to provide
 * a *different perspective* on dispatched task progress when the dispatched
 * task itself runs on Codex (or vice-versa) per
 * `specs/CLARIFICATIONS/multi-provider-scope.md` §Advisor 패턴.
 *
 * Hard constraints (advisor port invariants):
 *   - Single prompt per advised event. No tools, no files, no MCP.
 *   - Sampling: only `item.completed` (`error` / `agent_message` / `reasoning`
 *     types) and `approval.requested`. Other events return `'skip'`
 *     immediately without calling Claude.
 *   - Per-instance call cap. Once the cap is hit, all subsequent reviews
 *     return `'skip'` (advisor self-throttles).
 *   - Fail-open by default. Network errors, parse errors, unexpected response
 *     shapes return `'approve'` so an advisor outage cannot stall dispatch.
 *     Operators may opt in to risk-tier-specific fail-closed semantics by
 *     supplying `failClosedOnCatch`; when the predicate returns `true`, the
 *     catch path emits `'veto'` with the `'advisor-error-fail-closed'`
 *     consultation outcome instead.
 */

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

import type { AgentInstance } from '../contracts/runtime-driver.js';
import type {
  RuntimeEvent,
} from '../contracts/runtime-event.js';
import type {
  ClaudeAgentQueryFactory,
  ClaudeAgentQueryOptions,
  ClaudeAgentSDKMessage,
} from '../runtime/claude-agent-runtime-adapter.js';
import type {
  PlanaAdvisorInput,
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from './plana-runtime-advisor.js';

export const PLANA_CLAUDE_ADVISOR_PROVENANCE =
  'plana-claude-runtime-advisor' as const;

export const PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION = 1 as const;
export const PLANA_CLAUDE_ADVISOR_AUDIT_REPORT_SCHEMA_VERSION = 1 as const;
export const PLANA_CLAUDE_ADVISOR_AUDIT_MIN_RECORDS_FOR_TREND = 5 as const;

// Cross-reference: `PlanaCodexAdvisorConsultationOutcome` in
// `plana-codex-runtime-advisor.ts` mirrors this union; keep them in sync.
export type PlanaClaudeAdvisorConsultationOutcome =
  | 'consulted'
  | 'advisor-error-fail-open'
  | 'advisor-error-fail-closed';

export const PLANA_ADVISOR_FAIL_CLOSED_REASON =
  'Advisor failed; risk tier required fail-closed' as const;

export interface PlanaClaudeAdvisorAuditRecord {
  readonly schemaVersion: typeof PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION;
  readonly recordId: string;
  readonly recordedAt: string;
  readonly provider: 'claude-agent';
  readonly provenance: typeof PLANA_CLAUDE_ADVISOR_PROVENANCE;
  readonly taskId: string;
  readonly instanceId: string;
  readonly eventKind: RuntimeEvent['kind'];
  readonly eventTimestamp: string;
  readonly eventItemType?: string;
  readonly verdictStatus: PlanaAdvisorVerdict['status'];
  readonly consultationOutcome: PlanaClaudeAdvisorConsultationOutcome;
  readonly model?: string;
  readonly fallbackModel?: string;
}

export interface PlanaClaudeAdvisorAuditLedger {
  append(record: PlanaClaudeAdvisorAuditRecord): void;
}

export interface PlanaClaudeAdvisorAuditReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
}

export interface PlanaClaudeAdvisorAuditReplayResult {
  readonly records: readonly PlanaClaudeAdvisorAuditRecord[];
  readonly replayAudit: PlanaClaudeAdvisorAuditReplayAudit;
}

export interface PlanaClaudeAdvisorAuditReplayOptions {
  /**
   * Optional read guard for operator-facing report surfaces. When set, replay
   * fails during bounded chunked replay before accepting bytes beyond this
   * bound.
   */
  readonly maxBytes?: number;
}

export interface PlanaClaudeAdvisorAuditScorecard {
  readonly schemaVersion: typeof PLANA_CLAUDE_ADVISOR_AUDIT_REPORT_SCHEMA_VERSION;
  readonly recordCount: number;
  readonly verdictCounts: {
    readonly approve: number;
    readonly veto: number;
    readonly skip: number;
  };
  readonly consultationCounts: {
    readonly consulted: number;
    readonly advisorErrorFailOpen: number;
    readonly advisorErrorFailClosed: number;
  };
  readonly eventKindCounts: Readonly<Record<string, number>>;
  readonly recency: {
    readonly firstRecordedAt?: string;
    readonly lastRecordedAt?: string;
  };
  readonly confidence: {
    readonly sampleSize: number;
    readonly templateRecordCount: number;
    readonly minimumRecommendedRecords: typeof PLANA_CLAUDE_ADVISOR_AUDIT_MIN_RECORDS_FOR_TREND;
    readonly sufficientForTrend: boolean;
    readonly summary: string;
  };
  readonly recommendations: readonly string[];
}

export interface PlanaClaudeAdvisorAuditReport {
  readonly schemaVersion: typeof PLANA_CLAUDE_ADVISOR_AUDIT_REPORT_SCHEMA_VERSION;
  readonly generatedAt?: string;
  readonly filter: PlanaClaudeAdvisorAuditFilter;
  readonly replayAudit?: PlanaClaudeAdvisorAuditReplayAudit;
  readonly method: {
    readonly primaryMetric: string;
    readonly guardrailMetrics: readonly string[];
    readonly minimumSampleGuidance: string;
    readonly promotionRule: string;
  };
  readonly scorecard: PlanaClaudeAdvisorAuditScorecard;
}

export interface PlanaClaudeAdvisorAuditFilter {
  readonly taskId?: string;
  readonly eventKind?: string;
  readonly verdictStatus?: PlanaAdvisorVerdict['status'];
  readonly consultationOutcome?: PlanaClaudeAdvisorConsultationOutcome;
  readonly limit?: number;
}

export interface PlanaClaudeAdvisorAuditReportInput {
  readonly records: readonly PlanaClaudeAdvisorAuditRecord[];
  readonly filter?: PlanaClaudeAdvisorAuditFilter;
  readonly generatedAt?: string;
  readonly replayAudit?: PlanaClaudeAdvisorAuditReplayAudit;
}

export interface PlanaClaudeRuntimeAdvisorOptions {
  readonly queryFactory: ClaudeAgentQueryFactory;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly anthropicApiKey?: string;
  readonly maxAdvisorCallsPerInstance?: number;
  /**
   * Optional logger called with the advisor's prompt and parsed verdict for
   * each consulted event. Useful for `runtime-state/plana-advisor-events.jsonl`
   * audit ledgers; out-of-scope for the in-process advisor itself.
   */
  readonly onAdvise?: (record: {
    readonly instanceId: string;
    readonly eventKind: string;
    readonly prompt: string;
    readonly responseText: string;
    readonly verdict: PlanaAdvisorVerdict;
  }) => void;
  /**
   * Optional redacted audit sink for live-proof breadcrumbs. Unlike `onAdvise`,
   * this receives no prompt text, model response text, instruction content, or
   * free-form veto reason. Sink failures are contained so the advisor remains
   * fail-open.
   */
  readonly auditLedger?: PlanaClaudeAdvisorAuditLedger;
  readonly auditClock?: () => string;
  /**
   * Optional predicate that promotes the catch path from fail-open to
   * fail-closed for risk-tier-specific events (e.g. shell-write tool uses,
   * destructive approval requests). When `failClosedOnCatch(input, error)`
   * returns `true`, the catch block emits `'veto'` with consultation outcome
   * `'advisor-error-fail-closed'` instead of `'approve'` /
   * `'advisor-error-fail-open'`. Predicate failures are swallowed and treated
   * as `false` so the advisor remains fail-open by default.
   */
  readonly failClosedOnCatch?: (
    input: PlanaAdvisorInput,
    error: unknown,
  ) => boolean;
}

const DEFAULT_MAX_ADVISOR_CALLS = 5;

const ADVISED_KINDS = new Set<RuntimeEvent['kind']>([
  'item.completed',
  'item.failed',
  'approval.requested',
]);

const ADVISED_ITEM_TYPES = new Set([
  'error',
  'agent_message',
  'reasoning',
]);

interface ClaudeVerdictPayload {
  readonly verdict?: unknown;
  readonly reason?: unknown;
}

export function shouldConsultPlanaAdvisor(event: RuntimeEvent): boolean {
  return shouldConsult(event);
}

function shouldConsult(event: RuntimeEvent): boolean {
  if (!ADVISED_KINDS.has(event.kind)) return false;
  if (event.kind === 'item.completed') {
    return ADVISED_ITEM_TYPES.has((event).item.type);
  }
  if (event.kind === 'item.failed') {
    return ADVISED_ITEM_TYPES.has((event).item.type);
  }
  return true;
}

function summarizeEvent(event: RuntimeEvent): string {
  switch (event.kind) {
    case 'item.completed': {
      const e = event;
      return `event=item.completed type=${e.item.type} summary=${JSON.stringify(
        e.item.summary.slice(0, 400),
      )}`;
    }
    case 'item.failed': {
      const e = event;
      return `event=item.failed type=${e.item.type} summary=${JSON.stringify(
        e.item.summary.slice(0, 200),
      )} failure=${JSON.stringify(e.failure.message.slice(0, 200))}`;
    }
    case 'approval.requested': {
      const e = event;
      return `event=approval.requested kind=${e.request.kind} reason=${JSON.stringify(
        e.request.reason.slice(0, 200),
      )} command=${JSON.stringify(e.request.command ?? '')}`;
    }
    default:
      return `event=${event.kind}`;
  }
}

const ADVISOR_INSTRUCTION =
  'You are a strict review advisor for an autonomous research agent. ' +
  'You will receive ONE event from the agent and must decide whether to allow it to continue. ' +
  'Reply ONLY with a single-line JSON object matching one of these two shapes:\n' +
  '  {"verdict":"approve"}\n' +
  '  {"verdict":"veto","reason":"<short string>"}\n' +
  'Veto only if the event shows: hallucinated facts, unsafe shell commands, attempts to exfiltrate secrets, ' +
  'destructive operations on production data, or clear violation of the user task. ' +
  'Otherwise, approve. Do NOT call tools. Do NOT explain. JSON only.';

export function buildPlanaAdvisorPrompt(input: PlanaAdvisorInput): string {
  return buildPrompt(input);
}

function buildPrompt(input: PlanaAdvisorInput): string {
  const { plan, event } = input;
  return [
    ADVISOR_INSTRUCTION,
    '',
    `task_id=${plan.taskId}`,
    `instruction=${JSON.stringify(plan.instruction.slice(0, 500))}`,
    summarizeEvent(event),
  ].join('\n');
}

export function parsePlanaAdvisorVerdictText(
  text: string,
  provenance: string,
): PlanaAdvisorVerdict {
  if (typeof text !== 'string' || text.length === 0) {
    return { status: 'approve' };
  }
  // F17: iterate every JSON-object substring; veto-wins fail-safe, so any
  // parseable block carrying `verdict:'veto'` triggers veto regardless of
  // ordering or sibling `verdict:'approve'` blocks.
  for (const match of text.matchAll(/\{[^}]*\}/g)) {
    let parsed: ClaudeVerdictPayload;
    try {
      parsed = JSON.parse(match[0]) as ClaudeVerdictPayload;
    } catch {
      continue;
    }
    if (parsed?.verdict === 'veto') {
      const reason =
        typeof parsed.reason === 'string' && parsed.reason.length > 0
          ? parsed.reason.slice(0, 1000)
          : 'plana advisor flagged the event without a reason';
      return {
        status: 'veto',
        reason,
        provenance,
      };
    }
  }
  return { status: 'approve' };
}

function parseVerdictText(text: string): PlanaAdvisorVerdict {
  return parsePlanaAdvisorVerdictText(text, PLANA_CLAUDE_ADVISOR_PROVENANCE);
}

async function collectResponseText(
  handle: AsyncIterable<ClaudeAgentSDKMessage>,
): Promise<string> {
  const parts: string[] = [];
  for await (const message of handle) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      continue;
    }
    if (message.type === 'result') {
      if (typeof message.result === 'string' && message.result.length > 0) {
        return parts.length === 0 ? message.result : parts.join('\n');
      }
      break;
    }
  }
  return parts.join('\n');
}

function eventItemType(event: RuntimeEvent): string | undefined {
  if (event.kind === 'item.completed' || event.kind === 'item.failed') {
    return event.item.type;
  }
  return undefined;
}

function parsePlanaClaudeAdvisorAuditRecord(
  value: unknown,
): PlanaClaudeAdvisorAuditRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<PlanaClaudeAdvisorAuditRecord>;
  const verdictStatus = candidate.verdictStatus;
  const consultationOutcome = candidate.consultationOutcome;
  if (
    candidate.schemaVersion !== PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION ||
    typeof candidate.recordId !== 'string' ||
    typeof candidate.recordedAt !== 'string' ||
    candidate.provider !== 'claude-agent' ||
    candidate.provenance !== PLANA_CLAUDE_ADVISOR_PROVENANCE ||
    typeof candidate.taskId !== 'string' ||
    typeof candidate.instanceId !== 'string' ||
    typeof candidate.eventKind !== 'string' ||
    typeof candidate.eventTimestamp !== 'string' ||
    !isPlanaAdvisorVerdictStatus(verdictStatus) ||
    !isPlanaClaudeAdvisorConsultationOutcome(consultationOutcome)
  ) {
    return undefined;
  }
  return {
    schemaVersion: PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION,
    recordId: candidate.recordId,
    recordedAt: candidate.recordedAt,
    provider: 'claude-agent',
    provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
    taskId: candidate.taskId,
    instanceId: candidate.instanceId,
    eventKind: candidate.eventKind,
    eventTimestamp: candidate.eventTimestamp,
    ...(typeof candidate.eventItemType === 'string'
      ? { eventItemType: candidate.eventItemType }
      : {}),
    verdictStatus,
    consultationOutcome,
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    ...(typeof candidate.fallbackModel === 'string'
      ? { fallbackModel: candidate.fallbackModel }
      : {}),
  };
}

function isPlanaAdvisorVerdictStatus(
  value: unknown,
): value is PlanaAdvisorVerdict['status'] {
  return value === 'approve' || value === 'veto' || value === 'skip';
}

function isPlanaClaudeAdvisorConsultationOutcome(
  value: unknown,
): value is PlanaClaudeAdvisorConsultationOutcome {
  return (
    value === 'consulted' ||
    value === 'advisor-error-fail-open' ||
    value === 'advisor-error-fail-closed'
  );
}

const PLANA_CLAUDE_ADVISOR_AUDIT_REPLAY_CHUNK_BYTES = 64 * 1024;

export class JsonlPlanaClaudeAdvisorAuditLedger
  implements PlanaClaudeAdvisorAuditLedger {
  constructor(private readonly filePath: string) {}

  append(record: PlanaClaudeAdvisorAuditRecord): void {
    const parsed = parsePlanaClaudeAdvisorAuditRecord(record);
    if (parsed === undefined) {
      throw new TypeError('Invalid Plana Claude advisor audit record.');
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(parsed)}\n`, 'utf8');
  }

  loadAll(): PlanaClaudeAdvisorAuditRecord[] {
    return [...this.loadWithAudit().records];
  }

  loadWithAudit(
    options: PlanaClaudeAdvisorAuditReplayOptions = {},
  ): PlanaClaudeAdvisorAuditReplayResult {
    if (!existsSync(this.filePath)) {
      return emptyPlanaClaudeAdvisorAuditReplayResult();
    }
    const maxBytes = options.maxBytes;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    ) {
      throw new Error(
        'Plana Claude advisor audit ledger replay maxBytes must be a positive safe integer.',
      );
    }
    return replayPlanaClaudeAdvisorAuditJsonlFile(this.filePath, maxBytes);
  }
}

export function buildPlanaClaudeAdvisorAuditReport(
  input: PlanaClaudeAdvisorAuditReportInput,
): PlanaClaudeAdvisorAuditReport {
  const filter = input.filter ?? {};
  const filteredRecords = filterPlanaClaudeAdvisorAuditRecords(
    input.records,
    filter,
  );
  const scorecard = buildPlanaClaudeAdvisorAuditScorecard(filteredRecords);
  return {
    schemaVersion: PLANA_CLAUDE_ADVISOR_AUDIT_REPORT_SCHEMA_VERSION,
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    filter,
    ...(input.replayAudit === undefined
      ? {}
      : { replayAudit: input.replayAudit }),
    method: {
      primaryMetric:
        'sampled redacted advisor verdict breadcrumbs grouped by verdict and consultation outcome',
      guardrailMetrics: [
        'advisor-error-fail-open count',
        'advisor-error-fail-closed count',
        'veto count',
        'malformed/torn JSONL line count',
        'last recorded advisor event time',
      ],
      minimumSampleGuidance: `At least ${String(PLANA_CLAUDE_ADVISOR_AUDIT_MIN_RECORDS_FOR_TREND)} valid advisor event records are recommended before treating the trend as live-proof evidence.`,
      promotionRule:
        'Use this report as operator-facing diagnostic evidence only; it does not prove live Claude auth, Discord delivery, or that a veto was operationally handled.',
    },
    scorecard:
      input.replayAudit === undefined ||
      input.replayAudit.skippedMalformedLineCount === 0
        ? scorecard
        : {
            ...scorecard,
            recommendations: [
              `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn advisor JSONL line(s); they were excluded from scoring.`,
              ...scorecard.recommendations,
            ],
          },
  };
}

export function filterPlanaClaudeAdvisorAuditRecords(
  records: readonly PlanaClaudeAdvisorAuditRecord[],
  filter: PlanaClaudeAdvisorAuditFilter = {},
): PlanaClaudeAdvisorAuditRecord[] {
  const filtered = records.filter((record) => {
    if (filter.taskId !== undefined && record.taskId !== filter.taskId) {
      return false;
    }
    if (filter.eventKind !== undefined && record.eventKind !== filter.eventKind) {
      return false;
    }
    if (
      filter.verdictStatus !== undefined &&
      record.verdictStatus !== filter.verdictStatus
    ) {
      return false;
    }
    if (
      filter.consultationOutcome !== undefined &&
      record.consultationOutcome !== filter.consultationOutcome
    ) {
      return false;
    }
    return true;
  });
  if (filter.limit === undefined) {
    return filtered;
  }
  if (filter.limit === 0) {
    return [];
  }
  return filtered.slice(-filter.limit);
}

function buildPlanaClaudeAdvisorAuditScorecard(
  records: readonly PlanaClaudeAdvisorAuditRecord[],
): PlanaClaudeAdvisorAuditScorecard {
  const verdictCounts = {
    approve: 0,
    veto: 0,
    skip: 0,
  };
  const consultationCounts = {
    consulted: 0,
    advisorErrorFailOpen: 0,
    advisorErrorFailClosed: 0,
  };
  const eventKindCounts: Record<string, number> = {};
  let firstRecordedAt: string | undefined;
  let lastRecordedAt: string | undefined;

  for (const record of records) {
    verdictCounts[record.verdictStatus] += 1;
    if (record.consultationOutcome === 'consulted') {
      consultationCounts.consulted += 1;
    } else if (record.consultationOutcome === 'advisor-error-fail-closed') {
      consultationCounts.advisorErrorFailClosed += 1;
    } else {
      consultationCounts.advisorErrorFailOpen += 1;
    }
    eventKindCounts[record.eventKind] =
      (eventKindCounts[record.eventKind] ?? 0) + 1;
    if (firstRecordedAt === undefined || record.recordedAt < firstRecordedAt) {
      firstRecordedAt = record.recordedAt;
    }
    if (lastRecordedAt === undefined || record.recordedAt > lastRecordedAt) {
      lastRecordedAt = record.recordedAt;
    }
  }

  const recordCount = records.length;
  const templateRecordCount = records.filter(
    isPlanaClaudeAdvisorAuditTemplateRecord,
  ).length;
  const trendSampleSize = recordCount - templateRecordCount;
  const sufficientForTrend =
    trendSampleSize >= PLANA_CLAUDE_ADVISOR_AUDIT_MIN_RECORDS_FOR_TREND;
  const recommendations: string[] = [];
  if (templateRecordCount > 0) {
    recommendations.push(
      `Replace ${String(templateRecordCount)} template advisor event record(s) with real redacted advisor breadcrumbs before treating this as trend evidence.`,
    );
  }
  if (!sufficientForTrend) {
    recommendations.push(
      `Collect at least ${String(PLANA_CLAUDE_ADVISOR_AUDIT_MIN_RECORDS_FOR_TREND)} valid advisor event records before treating this as a trend sample.`,
    );
  }
  if (consultationCounts.advisorErrorFailOpen > 0) {
    recommendations.push(
      `Investigate ${String(consultationCounts.advisorErrorFailOpen)} advisor-error-fail-open event(s); advisor outages must stay visible even though dispatch remains fail-open.`,
    );
  }
  if (consultationCounts.advisorErrorFailClosed > 0) {
    recommendations.push(
      `Review ${String(consultationCounts.advisorErrorFailClosed)} advisor-error-fail-closed veto(es); the operator-supplied risk-tier predicate promoted these advisor outages to dispatch-blocking veto.`,
    );
  }
  if (verdictCounts.veto > 0) {
    recommendations.push(
      `Review ${String(verdictCounts.veto)} advisor veto breadcrumb(s) and correlate them with task/feed history before relying on the dispatch outcome.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Advisor event ledger sample is currently clean; continue collecting redacted breadcrumbs for live-proof trend evidence.',
    );
  }

  return {
    schemaVersion: PLANA_CLAUDE_ADVISOR_AUDIT_REPORT_SCHEMA_VERSION,
    recordCount,
    verdictCounts,
    consultationCounts,
    eventKindCounts,
    recency: {
      ...(firstRecordedAt === undefined ? {} : { firstRecordedAt }),
      ...(lastRecordedAt === undefined ? {} : { lastRecordedAt }),
    },
    confidence: {
      sampleSize: trendSampleSize,
      templateRecordCount,
      minimumRecommendedRecords: PLANA_CLAUDE_ADVISOR_AUDIT_MIN_RECORDS_FOR_TREND,
      sufficientForTrend,
      summary: sufficientForTrend
        ? 'sufficient advisor event sample for trend diagnostics'
        : 'insufficient advisor event sample for trend diagnostics',
    },
    recommendations,
  };
}

function isPlanaClaudeAdvisorAuditTemplateRecord(
  record: PlanaClaudeAdvisorAuditRecord,
): boolean {
  return (
    record.recordId.startsWith('template-') ||
    record.taskId.startsWith('template-') ||
    record.instanceId.startsWith('template-') ||
    record.eventItemType === 'template' ||
    record.model?.startsWith('template-') === true
  );
}

interface PlanaClaudeAdvisorAuditReplayAccumulator {
  readonly records: PlanaClaudeAdvisorAuditRecord[];
  totalLineCount: number;
  emptyLineCount: number;
  skippedMalformedLineCount: number;
}

function emptyPlanaClaudeAdvisorAuditReplayResult(): PlanaClaudeAdvisorAuditReplayResult {
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

function replayPlanaClaudeAdvisorAuditJsonlFile(
  filePath: string,
  maxBytes: number | undefined,
): PlanaClaudeAdvisorAuditReplayResult {
  const fileDescriptor = openSync(filePath, 'r');
  const buffer = Buffer.alloc(PLANA_CLAUDE_ADVISOR_AUDIT_REPLAY_CHUNK_BYTES);
  const decoder = new TextDecoder('utf-8');
  const accumulator: PlanaClaudeAdvisorAuditReplayAccumulator = {
    records: [],
    totalLineCount: 0,
    emptyLineCount: 0,
    skippedMalformedLineCount: 0,
  };
  let bytesReadTotal = 0;
  let pendingLine = '';

  try {
    for (;;) {
      const bytesToRead = replayAdvisorAuditBytesToRead(
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
          `Plana Claude advisor audit ledger exceeds maxBytes: ${String(bytesReadTotal)} > ${String(maxBytes)}.`,
        );
      }
      pendingLine = replayPlanaClaudeAdvisorAuditTextChunk(
        accumulator,
        `${pendingLine}${decoder.decode(buffer.subarray(0, bytesRead), {
          stream: true,
        })}`,
      );
    }

    const finalDecodedText = decoder.decode();
    if (finalDecodedText.length > 0) {
      pendingLine = replayPlanaClaudeAdvisorAuditTextChunk(
        accumulator,
        `${pendingLine}${finalDecodedText}`,
      );
    }
    if (pendingLine.length > 0) {
      replayPlanaClaudeAdvisorAuditLine(accumulator, pendingLine);
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

function replayAdvisorAuditBytesToRead(
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

function replayPlanaClaudeAdvisorAuditTextChunk(
  accumulator: PlanaClaudeAdvisorAuditReplayAccumulator,
  text: string,
): string {
  const physicalLines = text.split('\n');
  const pendingLine = physicalLines[physicalLines.length - 1] ?? '';
  for (const physicalLine of physicalLines.slice(0, -1)) {
    replayPlanaClaudeAdvisorAuditLine(
      accumulator,
      stripAdvisorAuditJsonlLineFeedCarriageReturn(physicalLine),
    );
  }
  return pendingLine;
}

function stripAdvisorAuditJsonlLineFeedCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function replayPlanaClaudeAdvisorAuditLine(
  accumulator: PlanaClaudeAdvisorAuditReplayAccumulator,
  line: string,
): void {
  accumulator.totalLineCount += 1;
  if (line.trim().length === 0) {
    accumulator.emptyLineCount += 1;
    return;
  }
  try {
    const parsed = parsePlanaClaudeAdvisorAuditRecord(JSON.parse(line));
    if (parsed !== undefined) {
      accumulator.records.push(parsed);
    } else {
      accumulator.skippedMalformedLineCount += 1;
    }
  } catch {
    accumulator.skippedMalformedLineCount += 1;
    // Skip torn or malformed JSONL records during replay.
  }
}

export class PlanaClaudeRuntimeAdvisor implements PlanaRuntimeAdvisor {
  private readonly queryFactory: ClaudeAgentQueryFactory;
  private readonly model: string | undefined;
  private readonly fallbackModel: string | undefined;
  private readonly pathToClaudeCodeExecutable: string | undefined;
  private readonly anthropicApiKey: string | undefined;
  private readonly maxAdvisorCalls: number;
  private readonly onAdvise:
    | PlanaClaudeRuntimeAdvisorOptions['onAdvise']
    | undefined;
  private readonly auditLedger:
    | PlanaClaudeRuntimeAdvisorOptions['auditLedger']
    | undefined;
  private readonly auditClock: () => string;
  private readonly failClosedOnCatch:
    | PlanaClaudeRuntimeAdvisorOptions['failClosedOnCatch']
    | undefined;
  private readonly callCounts = new Map<string, number>();

  constructor(options: PlanaClaudeRuntimeAdvisorOptions) {
    if (typeof options.queryFactory !== 'function') {
      throw new TypeError(
        'PlanaClaudeRuntimeAdvisor requires a queryFactory.',
      );
    }
    this.queryFactory = options.queryFactory;
    this.model = options.model;
    this.fallbackModel = options.fallbackModel;
    this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
    this.anthropicApiKey = options.anthropicApiKey;
    this.maxAdvisorCalls = Math.max(
      0,
      Math.floor(options.maxAdvisorCallsPerInstance ?? DEFAULT_MAX_ADVISOR_CALLS),
    );
    this.onAdvise = options.onAdvise;
    this.auditLedger = options.auditLedger;
    this.auditClock = options.auditClock ?? (() => new Date().toISOString());
    this.failClosedOnCatch = options.failClosedOnCatch;
  }

  async review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict> {
    if (!shouldConsult(input.event)) {
      return { status: 'skip' };
    }
    if (!this.tryClaim(input.instance)) {
      return { status: 'skip' };
    }

    const prompt = buildPrompt(input);
    const queryOptions: ClaudeAgentQueryOptions = {
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.fallbackModel === undefined
        ? {}
        : { fallbackModel: this.fallbackModel }),
      ...(this.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }),
      ...(this.anthropicApiKey === undefined
        ? {}
        : { env: { ANTHROPIC_API_KEY: this.anthropicApiKey } }),
      permissionMode: 'bypassPermissions',
      maxTurns: 1,
      includePartialMessages: false,
    };

    let responseText: string;
    try {
      const handle = this.queryFactory({ prompt, options: queryOptions });
      responseText = await collectResponseText(handle);
    } catch (error) {
      if (this.shouldFailClosed(input, error)) {
        const failClosed: PlanaAdvisorVerdict = {
          status: 'veto',
          reason: PLANA_ADVISOR_FAIL_CLOSED_REASON,
          provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
        };
        this.emitAudit(
          input,
          prompt,
          '<advisor error>',
          failClosed,
          'advisor-error-fail-closed',
        );
        return failClosed;
      }
      const fallback: PlanaAdvisorVerdict = { status: 'approve' };
      this.emitAudit(input, prompt, '<advisor error>', fallback, 'advisor-error-fail-open');
      return fallback;
    }

    const verdict = parseVerdictText(responseText);
    this.emitAudit(input, prompt, responseText, verdict, 'consulted');
    return verdict;
  }

  private tryClaim(instance: AgentInstance): boolean {
    if (this.maxAdvisorCalls <= 0) return false;
    const used = this.callCounts.get(instance.instanceId) ?? 0;
    if (used >= this.maxAdvisorCalls) return false;
    this.callCounts.set(instance.instanceId, used + 1);
    return true;
  }

  private shouldFailClosed(input: PlanaAdvisorInput, error: unknown): boolean {
    const predicate = this.failClosedOnCatch;
    if (predicate === undefined) {
      return false;
    }
    try {
      return predicate(input, error) === true;
    } catch {
      // Predicate failures must not convert advisor outages into hard task
      // failures; treat as fail-open.
      return false;
    }
  }

  private emitAudit(
    input: PlanaAdvisorInput,
    prompt: string,
    responseText: string,
    verdict: PlanaAdvisorVerdict,
    consultationOutcome: PlanaClaudeAdvisorConsultationOutcome,
  ): void {
    try {
      this.onAdvise?.({
        instanceId: input.instance.instanceId,
        eventKind: input.event.kind,
        prompt,
        responseText,
        verdict,
      });
    } catch {
      // Advisor observation must remain fail-open.
    }

    try {
      this.auditLedger?.append({
        schemaVersion: PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION,
        recordId: randomUUID(),
        recordedAt: this.auditClock(),
        provider: 'claude-agent',
        provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
        taskId: input.plan.taskId,
        instanceId: input.instance.instanceId,
        eventKind: input.event.kind,
        eventTimestamp: input.event.timestamp,
        ...(eventItemType(input.event) === undefined
          ? {}
          : { eventItemType: eventItemType(input.event) }),
        verdictStatus: verdict.status,
        consultationOutcome,
        ...(this.model === undefined ? {} : { model: this.model }),
        ...(this.fallbackModel === undefined
          ? {}
          : { fallbackModel: this.fallbackModel }),
      });
    } catch {
      // Audit ledger write failures must not convert advisor evidence into a
      // task-blocking failure.
    }
  }
}
