/**
 * Codex-backed Plana runtime advisor.
 *
 * Sibling of `PlanaClaudeRuntimeAdvisor`. Single-shot read-only review of one
 * RuntimeEvent via the Codex SDK. Used when the operator hot-swaps Plana onto
 * the Codex provider via `/config set persona:plana key:provider value:codex`
 * (multi-provider-scope.md §1.5.0).
 *
 * Hard constraints (advisor port invariants — same as the Claude advisor):
 *   - Single prompt per advised event. No tools, no MCP, no recursion.
 *   - Sampling: only `item.completed` (`error` / `agent_message` / `reasoning`
 *     types) and `approval.requested`. Other events return `'skip'` immediately.
 *   - Per-instance call cap. Once the cap is hit, all subsequent reviews
 *     return `'skip'` (advisor self-throttles).
 *   - Fail-open by default. Network errors, parse errors, unexpected response
 *     shapes return `'approve'` so an advisor outage cannot stall dispatch.
 *     Operators may opt in to risk-tier-specific fail-closed semantics by
 *     supplying `failClosedOnCatch`; when the predicate returns `true`, the
 *     catch path emits `'veto'` with consultation outcome
 *     `'advisor-error-fail-closed'` instead.
 *
 * Auth: bootstrap-time CodexOptions (typically auth.json or API key) — same
 * pattern as the dispatched-task Codex driver. Mid-flight swap of the Codex
 * auth source is OOS.
 */

import { Codex } from '@openai/codex-sdk';
import type {
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
} from '@openai/codex-sdk';
import { randomUUID } from 'node:crypto';

import type { AgentInstance } from '../contracts/runtime-driver.js';
import {
  authFingerprintsEqual,
  type AuthFingerprint,
  type CodexReasoningEffort,
} from '../runtime/codex-bootstrap-settings.js';
import {
  buildPlanaAdvisorPrompt,
  normalizeAdvisorErrorBurstThresholds,
  parsePlanaAdvisorVerdictText,
  PLANA_ADVISOR_FAIL_CLOSED_REASON,
  shouldConsultPlanaAdvisor,
  type AdvisorAuthFreshnessSnapshot,
} from './plana-claude-runtime-advisor.js';
import type {
  PlanaAdvisorInput,
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from './plana-runtime-advisor.js';

export const PLANA_CODEX_ADVISOR_PROVENANCE =
  'plana-codex-runtime-advisor' as const;

export const PLANA_CODEX_ADVISOR_AUDIT_SCHEMA_VERSION = 1 as const;

// Cross-reference: `PlanaClaudeAdvisorConsultationOutcome` in
// `plana-claude-runtime-advisor.ts` mirrors this union; keep them in sync.
export type PlanaCodexAdvisorConsultationOutcome =
  | 'consulted'
  | 'advisor-error-fail-open'
  | 'advisor-error-fail-closed';

export interface PlanaCodexAdvisorAuditRecord {
  readonly schemaVersion: typeof PLANA_CODEX_ADVISOR_AUDIT_SCHEMA_VERSION;
  readonly recordId: string;
  readonly recordedAt: string;
  readonly provider: 'codex';
  readonly provenance: typeof PLANA_CODEX_ADVISOR_PROVENANCE;
  readonly taskId: string;
  readonly instanceId: string;
  readonly eventKind: string;
  readonly eventTimestamp: string;
  readonly eventItemType?: string;
  readonly verdictStatus: PlanaAdvisorVerdict['status'];
  readonly consultationOutcome: PlanaCodexAdvisorConsultationOutcome;
  readonly model?: string;
  readonly modelReasoningEffort?: CodexReasoningEffort;
}

export interface PlanaCodexAdvisorAuditLedger {
  append(record: PlanaCodexAdvisorAuditRecord): void;
}

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface CodexSdkLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface PlanaCodexRuntimeAdvisorOptions {
  /**
   * Codex client options used to authenticate the advisor's lightweight
   * single-shot calls. Typically the same CodexOptions used by the dispatched
   * Codex driver in single-auth deployments.
   */
  readonly codexOptions?: CodexOptions;
  /**
   * Optional Codex SDK factory — defaults to `new Codex(opts)`. Tests inject
   * a stub. Mirrors `CodexRuntimeDriverOptions.sdkFactory`.
   */
  readonly sdkFactory?: (options?: CodexOptions) => CodexSdkLike;
  /** Optional model override for advisor prompts (advisor-only; lightweight). */
  readonly model?: string;
  /** Optional reasoning effort override (advisor-only; lightweight). */
  readonly modelReasoningEffort?: CodexReasoningEffort;
  /** Per-instance call cap. Default 5 (matches Claude advisor). */
  readonly maxAdvisorCallsPerInstance?: number;
  readonly onAdvise?: (info: {
    readonly instanceId: string;
    readonly eventKind: string;
    readonly prompt: string;
    readonly responseText: string;
    readonly verdict: PlanaAdvisorVerdict;
  }) => void;
  readonly auditLedger?: PlanaCodexAdvisorAuditLedger;
  readonly auditClock?: () => string;
  /**
   * Optional predicate that promotes the catch path from fail-open to
   * fail-closed for risk-tier-specific events. When `failClosedOnCatch(input,
   * error)` returns `true`, the catch block emits `'veto'` with consultation
   * outcome `'advisor-error-fail-closed'` instead of `'approve'` /
   * `'advisor-error-fail-open'`. Predicate failures are swallowed and treated
   * as `false` so the advisor remains fail-open by default.
   */
  readonly failClosedOnCatch?: (
    input: PlanaAdvisorInput,
    error: unknown,
  ) => boolean;
  /**
   * Optional observer fired when the consecutive-advisor-error counter
   * crosses one of `advisorErrorBurstThresholds`. The counter increments on
   * every fail-open OR fail-closed catch and resets to 0 on a successful
   * consultation. Observer exceptions are swallowed so the advisor remains
   * fail-open.
   */
  readonly onAdvisorErrorBurst?: (count: number) => void;
  /**
   * Ascending positive integer thresholds at which `onAdvisorErrorBurst`
   * fires (default `[3, 10]`).
   */
  readonly advisorErrorBurstThresholds?: readonly number[];
  /**
   * P2-C-2 — optional callback that re-resolves the bootstrap auth
   * fingerprint from the *current* process env at probe time. The
   * bootstrap-time fingerprint is captured once on construction;
   * `authFreshnessSnapshot()` compares the two and surfaces drift
   * (different `authSource`, `cliPath`, `apiKeyEnvVarName`, or
   * `settingsFilePath`) so operators see when the advisor's locked-in
   * credential no longer matches the environment without a restart.
   * Probe failures are treated as "freshness unknown" (returned as
   * `current: undefined`, `stale: false`) so a broken probe never
   * crashes /doctor.
   */
  readonly currentAuthFingerprint?: () => AuthFingerprint;
  /**
   * P2-C-2 — bootstrap-time auth fingerprint captured at construction
   * time. When omitted, the advisor falls back to a `none` fingerprint
   * so the `currentAuthFingerprint` probe (if supplied) still has a
   * baseline to compare against.
   */
  readonly bootstrapAuthFingerprint?: AuthFingerprint;
}

const DEFAULT_MAX_ADVISOR_CALLS = 5;

export class PlanaCodexRuntimeAdvisor implements PlanaRuntimeAdvisor {
  private readonly sdk: CodexSdkLike;
  private readonly model: string | undefined;
  private readonly modelReasoningEffort: CodexReasoningEffort | undefined;
  private readonly maxAdvisorCalls: number;
  private readonly onAdvise:
    | PlanaCodexRuntimeAdvisorOptions['onAdvise']
    | undefined;
  private readonly auditLedger:
    | PlanaCodexRuntimeAdvisorOptions['auditLedger']
    | undefined;
  private readonly auditClock: () => string;
  private readonly failClosedOnCatch:
    | PlanaCodexRuntimeAdvisorOptions['failClosedOnCatch']
    | undefined;
  private readonly onAdvisorErrorBurst:
    | PlanaCodexRuntimeAdvisorOptions['onAdvisorErrorBurst']
    | undefined;
  private readonly advisorErrorBurstThresholds: readonly number[];
  private readonly bootstrapAuthFingerprint: AuthFingerprint;
  private readonly currentAuthFingerprint:
    | (() => AuthFingerprint)
    | undefined;
  private consecutiveErrorCount = 0;
  private readonly callCounts = new Map<string, number>();

  constructor(options: PlanaCodexRuntimeAdvisorOptions = {}) {
    const codexOptions = options.codexOptions ?? {};
    this.sdk =
      options.sdkFactory?.(codexOptions) ?? new Codex(codexOptions);
    this.model = options.model;
    this.modelReasoningEffort = options.modelReasoningEffort;
    this.maxAdvisorCalls = Math.max(
      0,
      Math.floor(options.maxAdvisorCallsPerInstance ?? DEFAULT_MAX_ADVISOR_CALLS),
    );
    this.onAdvise = options.onAdvise;
    this.auditLedger = options.auditLedger;
    this.auditClock = options.auditClock ?? (() => new Date().toISOString());
    this.failClosedOnCatch = options.failClosedOnCatch;
    this.onAdvisorErrorBurst = options.onAdvisorErrorBurst;
    this.advisorErrorBurstThresholds = normalizeAdvisorErrorBurstThresholds(
      options.advisorErrorBurstThresholds,
    );
    this.bootstrapAuthFingerprint =
      options.bootstrapAuthFingerprint ?? { authSource: 'none' };
    this.currentAuthFingerprint = options.currentAuthFingerprint;
  }

  /**
   * Snapshot of consecutive advisor error catches. Resets to 0 on a successful
   * consultation; increments on every fail-open OR fail-closed catch.
   */
  consecutiveAdvisorErrors(): number {
    return this.consecutiveErrorCount;
  }

  /**
   * P2-C-2 — re-resolve the bootstrap auth fingerprint via the optional
   * `currentAuthFingerprint` callback and compare against the
   * fingerprint captured at construction time. Returns `{ stale: false,
   * bootstrap }` (legacy / no-probe behavior) when the callback is
   * undefined; `{ stale: false, bootstrap, current: undefined }` when
   * the callback throws. Otherwise compares fields and reports
   * `stale: true` if anything in `authSource | cliPath |
   * apiKeyEnvVarName | settingsFilePath` differs.
   */
  authFreshnessSnapshot(): AdvisorAuthFreshnessSnapshot {
    const bootstrap = this.bootstrapAuthFingerprint;
    if (this.currentAuthFingerprint === undefined) {
      return { stale: false, bootstrap };
    }
    let current: AuthFingerprint;
    try {
      current = this.currentAuthFingerprint();
    } catch {
      // Probe failure → freshness unknown.
      return { stale: false, bootstrap, current: undefined };
    }
    const stale = !authFingerprintsEqual(bootstrap, current);
    return { stale, bootstrap, current };
  }

  async review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict> {
    if (!shouldConsultPlanaAdvisor(input.event)) {
      return { status: 'skip' };
    }
    if (!this.tryClaim(input.instance)) {
      return { status: 'skip' };
    }

    const prompt = buildPlanaAdvisorPrompt(input);
    const threadOptions: ThreadOptions = {
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.modelReasoningEffort === undefined
        ? {}
        : { modelReasoningEffort: this.modelReasoningEffort }),
    };

    let responseText: string;
    try {
      const thread = this.sdk.startThread(threadOptions);
      const { events } = await thread.runStreamed(prompt);
      responseText = await collectAgentMessageText(events);
    } catch (error) {
      this.recordAdvisorErrorCatch();
      if (this.shouldFailClosed(input, error)) {
        const failClosed: PlanaAdvisorVerdict = {
          status: 'veto',
          reason: PLANA_ADVISOR_FAIL_CLOSED_REASON,
          provenance: PLANA_CODEX_ADVISOR_PROVENANCE,
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
      this.emitAudit(
        input,
        prompt,
        '<advisor error>',
        fallback,
        'advisor-error-fail-open',
      );
      return fallback;
    }

    const verdict = parsePlanaAdvisorVerdictText(
      responseText,
      PLANA_CODEX_ADVISOR_PROVENANCE,
    );
    this.consecutiveErrorCount = 0;
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

  private recordAdvisorErrorCatch(): void {
    this.consecutiveErrorCount += 1;
    if (this.advisorErrorBurstThresholds.includes(this.consecutiveErrorCount)) {
      this.fireAdvisorErrorBurst(this.consecutiveErrorCount);
    }
  }

  private fireAdvisorErrorBurst(count: number): void {
    const observer = this.onAdvisorErrorBurst;
    if (observer === undefined) {
      return;
    }
    try {
      observer(count);
    } catch {
      // Observer failures must remain contained so the advisor stays
      // fail-open per port invariants.
    }
  }

  private emitAudit(
    input: PlanaAdvisorInput,
    prompt: string,
    responseText: string,
    verdict: PlanaAdvisorVerdict,
    consultationOutcome: PlanaCodexAdvisorConsultationOutcome,
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
      const itemType = eventItemType(input.event);
      this.auditLedger?.append({
        schemaVersion: PLANA_CODEX_ADVISOR_AUDIT_SCHEMA_VERSION,
        recordId: randomUUID(),
        recordedAt: this.auditClock(),
        provider: 'codex',
        provenance: PLANA_CODEX_ADVISOR_PROVENANCE,
        taskId: input.plan.taskId,
        instanceId: input.instance.instanceId,
        eventKind: input.event.kind,
        eventTimestamp: input.event.timestamp,
        ...(itemType === undefined ? {} : { eventItemType: itemType }),
        verdictStatus: verdict.status,
        consultationOutcome,
        ...(this.model === undefined ? {} : { model: this.model }),
        ...(this.modelReasoningEffort === undefined
          ? {}
          : { modelReasoningEffort: this.modelReasoningEffort }),
      });
    } catch {
      // Audit ledger write failures must not convert advisor evidence into a
      // task-blocking failure.
    }
  }
}

async function collectAgentMessageText(
  events: AsyncGenerator<ThreadEvent>,
): Promise<string> {
  const parts: string[] = [];
  for await (const event of events) {
    if (event.type === 'item.completed') {
      const item = (event as { item: ThreadItem }).item;
      if (item.type === 'agent_message') {
        const text = (item as { text?: string }).text;
        if (typeof text === 'string' && text.length > 0) {
          parts.push(text);
        }
      }
    }
    if (event.type === 'turn.completed') {
      break;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      break;
    }
  }
  return parts.join('\n');
}

function eventItemType(event: PlanaAdvisorInput['event']): string | undefined {
  if (event.kind === 'item.completed' || event.kind === 'item.failed') {
    return event.item.type;
  }
  return undefined;
}
