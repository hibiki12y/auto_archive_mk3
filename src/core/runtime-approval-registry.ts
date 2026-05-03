/**
 * @version 1.0.0
 * @stability frozen
 *
 * Wave 1 Control Proof Freeze 후보. Public surface 변경은 SemVer minor 이상 bump 필요.
 */

import type { ApprovalHookDecision } from '../contracts/runtime-event.js';
import type { ControlPlaneLedgerPort } from '../control/control-plane-ledger.js';
import type { ApprovalReviewContext } from './plana.js';

export type RuntimeApprovalCommandKind = 'shell' | 'mcp-tool' | 'compute-node';
export type RuntimeApprovalDecisionProvenance =
  | 'discord-slash'
  | 'discord-natural-language'
  | 'plana-policy';

export interface PendingRuntimeApproval {
  readonly approvalId: string;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly turnSequence: number;
  readonly commandKind: RuntimeApprovalCommandKind;
  readonly argvDigest?: string;
  readonly rawCommandDigest?: string;
  readonly canonicalCwd: string;
  readonly envDigest: string;
  readonly executablePath?: string;
  readonly executableDigest?: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly reason: string;
}

export interface ApprovalResolutionInput {
  readonly approvalId: string;
  readonly decision: 'approved' | 'denied';
  readonly resolvedAt?: string;
  readonly resolvedByUserId?: string;
  readonly reason?: string;
  readonly provenance: RuntimeApprovalDecisionProvenance;
}

export interface ResolvedRuntimeApproval extends PendingRuntimeApproval {
  readonly status: 'approved' | 'denied' | 'expired';
  readonly resolvedAt?: string;
  readonly resolvedByUserId?: string;
  readonly decisionReason?: string;
  readonly decisionProvenance?: RuntimeApprovalDecisionProvenance;
}

export type ApprovalResolutionResult =
  | { readonly status: 'resolved'; readonly record: ResolvedRuntimeApproval }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'duplicate'; readonly reason: string; readonly record: ResolvedRuntimeApproval }
  | { readonly status: 'expired'; readonly reason: string; readonly record: ResolvedRuntimeApproval };

export interface ExpiredApproval {
  readonly record: ResolvedRuntimeApproval;
}

export interface RuntimeApprovalRegistrySnapshot {
  readonly pending: readonly PendingRuntimeApproval[];
  readonly resolved: readonly ResolvedRuntimeApproval[];
}

export interface RuntimeApprovalRegistry {
  register(request: PendingRuntimeApproval): void;
  resolve(input: ApprovalResolutionInput): ApprovalResolutionResult;
  expire(now: Date): ExpiredApproval[];
  waitForDecision(approvalId: string): Promise<ApprovalHookDecision>;
  snapshot(): RuntimeApprovalRegistrySnapshot;
}

interface RegistryEntry {
  record: PendingRuntimeApproval | ResolvedRuntimeApproval;
  settle?: (decision: ApprovalHookDecision) => void;
  promise: Promise<ApprovalHookDecision>;
}

function clonePending(record: PendingRuntimeApproval): PendingRuntimeApproval {
  return { ...record };
}

function cloneResolved(record: ResolvedRuntimeApproval): ResolvedRuntimeApproval {
  return { ...record };
}

function toRejected(record: ResolvedRuntimeApproval): ApprovalHookDecision {
  if (record.status === 'approved') {
    return { status: 'approved' };
  }
  return {
    status: 'rejected',
    reason:
      record.decisionReason ??
      (record.status === 'expired' ? 'approval request expired' : 'approval denied'),
  };
}

export class InMemoryRuntimeApprovalRegistry implements RuntimeApprovalRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(request: PendingRuntimeApproval): void {
    const existing = this.entries.get(request.approvalId);
    if (existing !== undefined) {
      if ('status' in existing.record) {
        throw new Error(`Approval ${request.approvalId} was already resolved.`);
      }
      throw new Error(`Approval ${request.approvalId} is already pending.`);
    }
    let settle!: (decision: ApprovalHookDecision) => void;
    const promise = new Promise<ApprovalHookDecision>((resolve) => {
      settle = resolve;
    });
    this.entries.set(request.approvalId, {
      record: clonePending(request),
      settle,
      promise,
    });
  }

  resolve(input: ApprovalResolutionInput): ApprovalResolutionResult {
    const entry = this.entries.get(input.approvalId);
    if (entry === undefined) {
      return {
        status: 'unknown',
        reason: `Unknown approval id: ${input.approvalId}`,
      };
    }
    if ('status' in entry.record) {
      const resolved = cloneResolved(entry.record);
      if (resolved.status === 'expired') {
        return {
          status: 'expired',
          reason: `Approval ${input.approvalId} already expired.`,
          record: resolved,
        };
      }
      return {
        status: 'duplicate',
        reason: `Approval ${input.approvalId} was already resolved as ${resolved.status}.`,
        record: resolved,
      };
    }

    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    if (Date.parse(resolvedAt) > Date.parse(entry.record.expiresAt)) {
      const expired = this.expireOne(entry, resolvedAt, 'approval resolution arrived after expiry');
      return {
        status: 'expired',
        reason: `Approval ${input.approvalId} expired before it could be resolved.`,
        record: cloneResolved(expired),
      };
    }

    const record: ResolvedRuntimeApproval = {
      ...entry.record,
      status: input.decision === 'approved' ? 'approved' : 'denied',
      resolvedAt,
      ...(input.resolvedByUserId === undefined
        ? {}
        : { resolvedByUserId: input.resolvedByUserId }),
      ...(input.reason === undefined ? {} : { decisionReason: input.reason }),
      decisionProvenance: input.provenance,
    };
    entry.record = record;
    const settle = entry.settle;
    entry.settle = undefined;
    settle?.(toRejected(record));
    return { status: 'resolved', record: cloneResolved(record) };
  }

  expire(now: Date): ExpiredApproval[] {
    const expired: ExpiredApproval[] = [];
    const nowIso = now.toISOString();
    for (const entry of this.entries.values()) {
      if ('status' in entry.record) {
        continue;
      }
      if (Date.parse(entry.record.expiresAt) <= now.getTime()) {
        expired.push({
          record: cloneResolved(
            this.expireOne(entry, nowIso, 'approval request expired'),
          ),
        });
      }
    }
    return expired;
  }

  waitForDecision(approvalId: string): Promise<ApprovalHookDecision> {
    const entry = this.entries.get(approvalId);
    if (entry === undefined) {
      return Promise.resolve({
        status: 'rejected',
        reason: `Unknown approval id: ${approvalId}`,
      });
    }
    if ('status' in entry.record) {
      return Promise.resolve(toRejected(entry.record));
    }
    const delayMs = Math.max(0, Date.parse(entry.record.expiresAt) - Date.now());
    if (delayMs === 0) {
      const expired = this.expireOne(entry, new Date().toISOString(), 'approval request expired');
      return Promise.resolve(toRejected(expired));
    }
    return new Promise<ApprovalHookDecision>((resolve) => {
      const timer = setTimeout(() => {
        const current = this.entries.get(approvalId);
        if (current === undefined) {
          resolve({ status: 'rejected', reason: `Unknown approval id: ${approvalId}` });
          return;
        }
        if ('status' in current.record) {
          resolve(toRejected(current.record));
          return;
        }
        resolve(toRejected(this.expireOne(current, new Date().toISOString(), 'approval request expired')));
      }, delayMs);
      this.promiseWithTimer(entry.promise, timer).then(resolve, () => {
        clearTimeout(timer);
        resolve({ status: 'rejected', reason: 'approval registry failed' });
      });
    });
  }

  snapshot(): RuntimeApprovalRegistrySnapshot {
    const pending: PendingRuntimeApproval[] = [];
    const resolved: ResolvedRuntimeApproval[] = [];
    for (const entry of this.entries.values()) {
      if ('status' in entry.record) {
        resolved.push(cloneResolved(entry.record));
      } else {
        pending.push(clonePending(entry.record));
      }
    }
    return { pending, resolved };
  }

  private expireOne(
    entry: RegistryEntry,
    expiredAt: string,
    reason: string,
  ): ResolvedRuntimeApproval {
    if ('status' in entry.record) {
      return entry.record;
    }
    const record: ResolvedRuntimeApproval = {
      ...entry.record,
      status: 'expired',
      resolvedAt: expiredAt,
      decisionReason: reason,
      decisionProvenance: 'plana-policy',
    };
    entry.record = record;
    const settle = entry.settle;
    entry.settle = undefined;
    settle?.(toRejected(record));
    return record;
  }

  private async promiseWithTimer(
    promise: Promise<ApprovalHookDecision>,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<ApprovalHookDecision> {
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }
}

function commandKindFromRuntimeKind(kind: ApprovalReviewContext['event']['request']['kind']): RuntimeApprovalCommandKind {
  switch (kind) {
    case 'command_execution':
      return 'shell';
    case 'mcp_tool_call':
      return 'mcp-tool';
    default:
      return 'compute-node';
  }
}

function digestPlaceholder(value: string | undefined): string {
  return value === undefined || value.trim().length === 0
    ? 'sha256:unset'
    : `sha256:${Buffer.from(value).toString('base64url').slice(0, 32)}`;
}

export function createRegistryBackedApprovalHook(
  registry: RuntimeApprovalRegistry,
  options: { readonly ledger?: ControlPlaneLedgerPort } = {},
): (ctx: ApprovalReviewContext) => Promise<ApprovalHookDecision> {
  return async (ctx) => {
    const request = ctx.event.request;
    const pending: PendingRuntimeApproval = {
      approvalId: ctx.event.approvalRequestId,
      taskId: ctx.plan.taskId,
      runtimeInstanceId: ctx.instance.instanceId,
      turnSequence: ctx.event.turnSequence,
      commandKind: commandKindFromRuntimeKind(request.kind),
      ...(request.command === undefined ? {} : { rawCommandDigest: digestPlaceholder(request.command) }),
      canonicalCwd: request.workingDirectory ?? ctx.plan.runtimeSettings.workingDirectory ?? '.',
      envDigest: 'sha256:runtime-env-redacted',
      ...(request.toolName === undefined ? {} : { executablePath: request.toolName }),
      requestedAt: ctx.event.timestamp,
      expiresAt: ctx.event.deadline,
      reason: request.reason,
    };
    registry.register(pending);
    options.ledger?.append({
      type: 'approval.requested',
      actor: { kind: 'plana' },
      channel: { kind: 'system' },
      conversationId: ctx.plan.taskId,
      taskId: ctx.plan.taskId,
      correlationId: pending.approvalId,
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: {
        approvalId: pending.approvalId,
        commandKind: pending.commandKind,
        canonicalCwd: pending.canonicalCwd,
        requestedAt: pending.requestedAt,
        expiresAt: pending.expiresAt,
        reason: pending.reason,
      },
    });
    return registry.waitForDecision(pending.approvalId);
  };
}
