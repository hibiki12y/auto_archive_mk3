/**
 * M4 — Subagent policy enforcer (Hermes-derived).
 *
 * Adds an operator-configurable policy layer on top of the existing
 * roster caps (`maxConcurrent`, `perRoleCaps`):
 *   - role allowlist (deny on disallowed role)
 *   - depth cap (currently structurally 1 in auto_archive_mk3; surface
 *     prepared for future multi-hop dispatch)
 *   - blocked tool-name gate for requested subagent tool metadata
 *   - 80% utilization warning channel (evidence-only emit before hitting
 *     the hard 100% cap)
 *
 * Hermes anchor: `resource/hermes-agent/tools/delegate_tool.py`
 * `DELEGATE_BLOCKED_TOOLS` for the conceptual "blocked" surface. The current
 * slice is an admission gate only: auto_archive_mk3 subagents still inherit the
 * parent toolset rather than carrying a per-subagent grant.
 */
import type { SubagentRole } from '../contracts/subagent-roster.js';

export interface SubagentPolicy {
  readonly maxDepth: number;
  readonly maxConcurrent: number;
  readonly allowedRoles: ReadonlyArray<SubagentRole>;
  readonly perRoleCaps?: Readonly<Partial<Record<SubagentRole, number>>>;
  /**
   * Exact tool names that a subagent request must not include. This is an
   * admission policy over requested metadata only, not a runtime tool grant or
   * permission system.
   */
  readonly blockedToolNames?: ReadonlyArray<string>;
  /** Emit a warning when utilization reaches this fraction (default 0.8). */
  readonly warnAtPercent?: number;
}

export type SubagentPolicyDecisionStatus =
  | 'allowed'
  | 'allowed-with-warning'
  | 'denied';

export interface SubagentPolicyDecision {
  readonly status: SubagentPolicyDecisionStatus;
  readonly reason?: string;
  readonly utilization: {
    readonly concurrentPercent: number;
    readonly perRolePercent: number;
  };
  readonly warnings: ReadonlyArray<string>;
}

export interface SubagentPolicyEvaluationInput {
  readonly role: SubagentRole;
  readonly depth: number;
  readonly currentConcurrent: number;
  readonly currentPerRole: number;
  readonly requestedToolNames?: ReadonlyArray<string>;
}

export interface SubagentPolicyEnforcerOptions {
  readonly policy: SubagentPolicy;
  readonly logger?: (label: string, payload: Record<string, unknown>) => void;
}

const DEFAULT_WARN_AT_PERCENT = 0.8;

export class SubagentPolicyEnforcer {
  private readonly policy: SubagentPolicy;
  private readonly warnAtPercent: number;
  private readonly logger: (label: string, payload: Record<string, unknown>) => void;
  private readonly allowedRoleSet: ReadonlySet<SubagentRole>;
  private readonly blockedToolSet: ReadonlySet<string>;

  constructor(options: SubagentPolicyEnforcerOptions) {
    if (options.policy.maxDepth < 1) {
      throw new RangeError('SubagentPolicy.maxDepth must be >= 1');
    }
    if (options.policy.maxConcurrent < 1) {
      throw new RangeError('SubagentPolicy.maxConcurrent must be >= 1');
    }
    if (options.policy.allowedRoles.length === 0) {
      throw new RangeError(
        'SubagentPolicy.allowedRoles must contain at least one role',
      );
    }
    for (const toolName of options.policy.blockedToolNames ?? []) {
      if (
        typeof toolName !== 'string' ||
        toolName.length === 0 ||
        toolName.trim() !== toolName
      ) {
        throw new RangeError(
          'SubagentPolicy.blockedToolNames entries must be non-empty trimmed strings',
        );
      }
    }
    const warnAtPercent = options.policy.warnAtPercent ?? DEFAULT_WARN_AT_PERCENT;
    if (warnAtPercent <= 0 || warnAtPercent >= 1) {
      throw new RangeError(
        'SubagentPolicy.warnAtPercent must be in the open interval (0, 1)',
      );
    }
    this.policy = options.policy;
    this.warnAtPercent = warnAtPercent;
    this.logger =
      options.logger ??
      ((label, payload) => {
        console.warn(label, JSON.stringify(payload));
      });
    this.allowedRoleSet = new Set(options.policy.allowedRoles);
    this.blockedToolSet = new Set(options.policy.blockedToolNames ?? []);
  }

  evaluate(input: SubagentPolicyEvaluationInput): SubagentPolicyDecision {
    const warnings: string[] = [];

    if (input.depth > this.policy.maxDepth) {
      return this.deny(
        input,
        warnings,
        `depth ${input.depth} exceeds maxDepth ${this.policy.maxDepth}`,
      );
    }

    if (!this.allowedRoleSet.has(input.role)) {
      return this.deny(
        input,
        warnings,
        `role "${input.role}" is not in policy allowlist`,
      );
    }

    const blockedRequestedTools = (input.requestedToolNames ?? []).filter(
      (toolName) => this.blockedToolSet.has(toolName),
    );
    if (blockedRequestedTools.length > 0) {
      const uniqueBlockedRequestedTools = [...new Set(blockedRequestedTools)];
      return this.deny(
        input,
        warnings,
        `requested tool "${uniqueBlockedRequestedTools[0]}" is blocked by policy`,
        {
          requestedToolNames: input.requestedToolNames ?? [],
          blockedToolNames: uniqueBlockedRequestedTools,
        },
      );
    }

    if (input.currentConcurrent >= this.policy.maxConcurrent) {
      return this.deny(
        input,
        warnings,
        `concurrent ${input.currentConcurrent} reached maxConcurrent ${this.policy.maxConcurrent}`,
      );
    }

    const roleCap = this.policy.perRoleCaps?.[input.role];
    if (roleCap !== undefined && input.currentPerRole >= roleCap) {
      return this.deny(
        input,
        warnings,
        `per-role count ${input.currentPerRole} reached cap ${roleCap} for role "${input.role}"`,
      );
    }

    // After-spawn projected counts.
    const projectedConcurrent = input.currentConcurrent + 1;
    const concurrentPercent = projectedConcurrent / this.policy.maxConcurrent;

    let perRolePercent = 0;
    if (roleCap !== undefined && roleCap > 0) {
      perRolePercent = (input.currentPerRole + 1) / roleCap;
    }

    if (concurrentPercent >= this.warnAtPercent) {
      const warning = `concurrent utilization ${(concurrentPercent * 100).toFixed(0)}% >= ${(this.warnAtPercent * 100).toFixed(0)}% warning threshold`;
      warnings.push(warning);
      this.logger('subagent-policy-warn', {
        kind: 'concurrent-utilization',
        role: input.role,
        concurrentPercent,
        warnAtPercent: this.warnAtPercent,
        projectedConcurrent,
        maxConcurrent: this.policy.maxConcurrent,
      });
    }

    if (perRolePercent >= this.warnAtPercent) {
      const warning = `per-role utilization ${(perRolePercent * 100).toFixed(0)}% >= ${(this.warnAtPercent * 100).toFixed(0)}% warning threshold for role "${input.role}"`;
      warnings.push(warning);
      this.logger('subagent-policy-warn', {
        kind: 'per-role-utilization',
        role: input.role,
        perRolePercent,
        warnAtPercent: this.warnAtPercent,
        projectedPerRole: input.currentPerRole + 1,
        roleCap,
      });
    }

    return {
      status: warnings.length === 0 ? 'allowed' : 'allowed-with-warning',
      utilization: {
        concurrentPercent,
        perRolePercent,
      },
      warnings,
    };
  }

  private deny(
    input: SubagentPolicyEvaluationInput,
    warnings: string[],
    reason: string,
    extraPayload: Record<string, unknown> = {},
  ): SubagentPolicyDecision {
    this.logger('subagent-policy-deny', {
      role: input.role,
      depth: input.depth,
      currentConcurrent: input.currentConcurrent,
      currentPerRole: input.currentPerRole,
      reason,
      ...extraPayload,
    });
    return {
      status: 'denied',
      reason,
      utilization: {
        concurrentPercent: input.currentConcurrent / this.policy.maxConcurrent,
        perRolePercent: 0,
      },
      warnings,
    };
  }
}

export function createSubagentPolicyEnforcer(
  options: SubagentPolicyEnforcerOptions,
): SubagentPolicyEnforcer {
  return new SubagentPolicyEnforcer(options);
}
