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

  create(record: ExecutionApprovalRecord): ExecutionApprovalRecord {
    if (this.records.has(record.approvalId)) {
      throw new Error(`Execution approval ${record.approvalId} already exists.`);
    }
    const cloned = cloneRecord(record);
    this.records.set(record.approvalId, cloned);
    return cloneRecord(cloned);
  }

  get(approvalId: string): ExecutionApprovalRecord | undefined {
    const record = this.records.get(approvalId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  consume(input: ExecutionApprovalConsumeRequest): ExecutionApprovalConsumeResult {
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
}
