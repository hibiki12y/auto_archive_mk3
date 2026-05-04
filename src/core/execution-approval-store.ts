/**
 * @version 1.0.0
 * @stability frozen
 *
 * Wave 1 Control Proof Freeze 후보. Public surface 변경은 SemVer minor 이상 bump 필요.
 */

export type ExecutionApprovalCommandKind = 'shell' | 'mcp-tool' | 'compute-node';
export type ExecutionApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'consumed';

export interface ExecutionApprovalRecord {
  readonly approvalId: string;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly turnSequence: number;
  readonly commandKind: ExecutionApprovalCommandKind;
  readonly argvDigest?: string;
  readonly rawCommandDigest?: string;
  readonly canonicalCwd: string;
  readonly envDigest: string;
  readonly executablePath?: string;
  readonly executableDigest?: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly status: ExecutionApprovalStatus;
  readonly decisionProvenance?:
    | 'discord-slash'
    | 'discord-natural-language'
    | 'plana-policy';
}

export interface ExecutionApprovalConsumeRequest {
  readonly approvalId: string;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly commandKind: ExecutionApprovalCommandKind;
  readonly canonicalCwd: string;
  readonly envDigest: string;
  readonly argvDigest?: string;
  readonly rawCommandDigest?: string;
  readonly executablePath?: string;
  readonly executableDigest?: string;
  readonly now?: string;
  readonly requestedPersistence?: 'single-use' | 'allow-always';
}

export type ExecutionApprovalConsumeResult =
  | { readonly status: 'allowed'; readonly record: ExecutionApprovalRecord }
  | { readonly status: 'denied'; readonly reason: string; readonly record?: ExecutionApprovalRecord }
  | { readonly status: 'unsupported'; readonly reason: string };

export interface ExecutionApprovalStore {
  create(record: ExecutionApprovalRecord): ExecutionApprovalRecord;
  consume(input: ExecutionApprovalConsumeRequest): ExecutionApprovalConsumeResult;
  get(approvalId: string): ExecutionApprovalRecord | undefined;
}

export interface InMemoryExecutionApprovalStoreOptions {
  /**
   * Audit 2026-05-04 follow-up — same audit class as PR #18 / #19 /
   * #21 / #22. Without a retention bound, terminal records
   * (`consumed` / `denied` / `expired`) accumulate in `records` for
   * the lifetime of the store. The frozen public surface
   * (`create` / `consume` / `get`) does NOT enumerate records, so
   * eviction of terminal records past their `expiresAt` is observable
   * only through `get(approvalId)` returning `undefined` — the same
   * `'unknown approval id'` path that already exists for never-known
   * ids (see `consume` line 113).
   *
   * Opt-in: when undefined the store preserves pre-PR behaviour
   * (no eviction) and the leak persists. Production callers should
   * set this; tests can leave it unset to keep the no-eviction
   * contract.
   */
  readonly evictTerminalAfterExpiryMs?: number;
  /**
   * Test-injected clock so eviction windows can be exercised
   * deterministically. Defaults to `Date.now`.
   */
  readonly nowMs?: () => number;
}

const TERMINAL_STATUSES: readonly ExecutionApprovalStatus[] = [
  'consumed',
  'denied',
  'expired',
];

function isTerminalStatus(status: ExecutionApprovalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function cloneRecord(record: ExecutionApprovalRecord): ExecutionApprovalRecord {
  return { ...record };
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function driftReason(
  record: ExecutionApprovalRecord,
  input: ExecutionApprovalConsumeRequest,
): string | undefined {
  if (record.taskId !== input.taskId) return 'taskId drift';
  if (record.runtimeInstanceId !== input.runtimeInstanceId) return 'runtimeInstanceId drift';
  if (record.commandKind !== input.commandKind) return 'commandKind drift';
  if (record.canonicalCwd !== input.canonicalCwd) return 'cwd drift';
  if (record.envDigest !== input.envDigest) return 'environment digest drift';
  if (!sameOptional(record.argvDigest, input.argvDigest)) return 'argv digest drift';
  if (!sameOptional(record.rawCommandDigest, input.rawCommandDigest)) return 'raw command digest drift';
  if (!sameOptional(record.executablePath, input.executablePath)) return 'executable path drift';
  if (!sameOptional(record.executableDigest, input.executableDigest)) return 'executable digest drift';
  return undefined;
}

export class InMemoryExecutionApprovalStore implements ExecutionApprovalStore {
  private readonly records = new Map<string, ExecutionApprovalRecord>();
  private readonly evictTerminalAfterExpiryMs: number | undefined;
  private readonly nowMs: () => number;

  constructor(options: InMemoryExecutionApprovalStoreOptions = {}) {
    this.evictTerminalAfterExpiryMs = options.evictTerminalAfterExpiryMs;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  create(record: ExecutionApprovalRecord): ExecutionApprovalRecord {
    this.pruneTerminalRecords();
    if (this.records.has(record.approvalId)) {
      throw new Error(`Execution approval ${record.approvalId} already exists.`);
    }
    const cloned = cloneRecord(record);
    this.records.set(record.approvalId, cloned);
    return cloneRecord(cloned);
  }

  get(approvalId: string): ExecutionApprovalRecord | undefined {
    this.pruneTerminalRecords();
    const record = this.records.get(approvalId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  consume(input: ExecutionApprovalConsumeRequest): ExecutionApprovalConsumeResult {
    this.pruneTerminalRecords();
    if (input.requestedPersistence === 'allow-always') {
      return {
        status: 'unsupported',
        reason: 'allow-always execution approvals are not supported in this implementation batch',
      };
    }
    const record = this.records.get(input.approvalId);
    if (record === undefined) {
      return { status: 'denied', reason: 'unknown approval id' };
    }
    const now = Date.parse(input.now ?? new Date().toISOString());
    if (record.status === 'consumed') {
      return { status: 'denied', reason: 'approval already consumed', record: cloneRecord(record) };
    }
    if (record.status === 'denied') {
      return { status: 'denied', reason: 'approval denied', record: cloneRecord(record) };
    }
    if (record.status === 'expired' || now > Date.parse(record.expiresAt)) {
      const expired = { ...record, status: 'expired' as const };
      this.records.set(record.approvalId, expired);
      return { status: 'denied', reason: 'approval expired', record: cloneRecord(expired) };
    }
    if (record.status !== 'approved') {
      return { status: 'denied', reason: 'approval is not approved', record: cloneRecord(record) };
    }
    const drift = driftReason(record, input);
    if (drift !== undefined) {
      return { status: 'denied', reason: drift, record: cloneRecord(record) };
    }
    const consumed = { ...record, status: 'consumed' as const };
    this.records.set(record.approvalId, consumed);
    return { status: 'allowed', record: cloneRecord(consumed) };
  }

  /**
   * Lazy retention sweep. Called at the head of every public method
   * so the store stays bounded under the documented opt-in policy
   * without requiring a background timer. No-op when the option is
   * unset (preserves the pre-PR no-eviction contract).
   */
  private pruneTerminalRecords(): void {
    if (this.evictTerminalAfterExpiryMs === undefined) {
      return;
    }
    const cutoff = this.nowMs() - this.evictTerminalAfterExpiryMs;
    for (const [approvalId, record] of this.records) {
      if (!isTerminalStatus(record.status)) continue;
      if (Date.parse(record.expiresAt) > cutoff) continue;
      this.records.delete(approvalId);
    }
  }
}
