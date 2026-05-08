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

/**
 * P4 Stage 4-1 — env-derived `SubagentPolicy` factory.
 *
 * Returns the documented Stage 4-1 defaults (refined plan, "사전 결정 사항"):
 *   - maxDepth=1, maxConcurrent=2
 *   - allowedRoles=['explorer','coder','writer','verifier']
 *   - perRoleCaps={}, blockedToolNames=[], warnAtPercent=0.8
 *
 * Each default may be overridden via env vars. Malformed values throw
 * `RangeError` so a misconfigured operator surface fails closed at boot
 * rather than at first dispatch:
 *
 *   - AUTO_ARCHIVE_SUBAGENT_MAX_DEPTH         positive integer
 *   - AUTO_ARCHIVE_SUBAGENT_MAX_CONCURRENT    positive integer
 *   - AUTO_ARCHIVE_SUBAGENT_ALLOWED_ROLES     comma-separated SubagentRole
 *                                             list (excluding root-orchestrator)
 *   - AUTO_ARCHIVE_SUBAGENT_BLOCKED_TOOLS     comma-separated trimmed
 *                                             non-empty tool names
 *   - AUTO_ARCHIVE_SUBAGENT_WARN_AT_PERCENT   number in (0, 1)
 */
export const SUBAGENT_POLICY_ENV_VARS = Object.freeze({
  MAX_DEPTH: 'AUTO_ARCHIVE_SUBAGENT_MAX_DEPTH',
  MAX_CONCURRENT: 'AUTO_ARCHIVE_SUBAGENT_MAX_CONCURRENT',
  ALLOWED_ROLES: 'AUTO_ARCHIVE_SUBAGENT_ALLOWED_ROLES',
  BLOCKED_TOOLS: 'AUTO_ARCHIVE_SUBAGENT_BLOCKED_TOOLS',
  WARN_AT_PERCENT: 'AUTO_ARCHIVE_SUBAGENT_WARN_AT_PERCENT',
} as const);

const DEFAULT_ALLOWED_SUBAGENT_ROLES: ReadonlyArray<SubagentRole> = Object.freeze(
  ['explorer', 'coder', 'writer', 'verifier'],
);

const ALLOWABLE_CHILD_SUBAGENT_ROLES: ReadonlySet<SubagentRole> = new Set<SubagentRole>([
  'explorer',
  'coder',
  'writer',
  'verifier',
  'executor',
]);

function parsePositiveInteger(
  raw: string,
  envName: string,
): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RangeError(`${envName} must be a positive integer; got empty string`);
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new RangeError(
      `${envName} must be a positive integer; got "${raw}"`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(
      `${envName} must be a positive integer; got "${raw}"`,
    );
  }
  return value;
}

function parseAllowedRoles(
  raw: string,
  envName: string,
): ReadonlyArray<SubagentRole> {
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new RangeError(
      `${envName} must contain at least one SubagentRole; got "${raw}"`,
    );
  }
  const result: SubagentRole[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token === 'root-orchestrator') {
      throw new RangeError(
        `${envName} must not include "root-orchestrator"; the root role cannot be allowed as a child`,
      );
    }
    if (!ALLOWABLE_CHILD_SUBAGENT_ROLES.has(token as SubagentRole)) {
      throw new RangeError(
        `${envName} contains unknown SubagentRole "${token}"`,
      );
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token as SubagentRole);
  }
  return Object.freeze(result);
}

function parseBlockedTools(
  raw: string,
  envName: string,
): ReadonlyArray<string> {
  const tokens = raw.split(',').map((token) => token.trim());
  const result: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length === 0) {
      throw new RangeError(
        `${envName} entries must be non-empty trimmed strings; got "${raw}"`,
      );
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token);
  }
  return Object.freeze(result);
}

function parseWarnAtPercent(
  raw: string,
  envName: string,
): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RangeError(
      `${envName} must be a number in (0, 1); got empty string`,
    );
  }
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(
      `${envName} must be a number in the open interval (0, 1); got "${raw}"`,
    );
  }
  return value;
}

export function resolveSubagentPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SubagentPolicy {
  const rawMaxDepth = env[SUBAGENT_POLICY_ENV_VARS.MAX_DEPTH];
  const maxDepth =
    rawMaxDepth === undefined || rawMaxDepth === ''
      ? 1
      : parsePositiveInteger(rawMaxDepth, SUBAGENT_POLICY_ENV_VARS.MAX_DEPTH);

  const rawMaxConcurrent = env[SUBAGENT_POLICY_ENV_VARS.MAX_CONCURRENT];
  const maxConcurrent =
    rawMaxConcurrent === undefined || rawMaxConcurrent === ''
      ? 2
      : parsePositiveInteger(
          rawMaxConcurrent,
          SUBAGENT_POLICY_ENV_VARS.MAX_CONCURRENT,
        );

  const rawAllowedRoles = env[SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES];
  const allowedRoles =
    rawAllowedRoles === undefined || rawAllowedRoles === ''
      ? DEFAULT_ALLOWED_SUBAGENT_ROLES
      : parseAllowedRoles(
          rawAllowedRoles,
          SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES,
        );

  const rawBlockedTools = env[SUBAGENT_POLICY_ENV_VARS.BLOCKED_TOOLS];
  const blockedToolNames =
    rawBlockedTools === undefined || rawBlockedTools === ''
      ? Object.freeze<string[]>([])
      : parseBlockedTools(
          rawBlockedTools,
          SUBAGENT_POLICY_ENV_VARS.BLOCKED_TOOLS,
        );

  const rawWarnAtPercent = env[SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT];
  const warnAtPercent =
    rawWarnAtPercent === undefined || rawWarnAtPercent === ''
      ? DEFAULT_WARN_AT_PERCENT
      : parseWarnAtPercent(
          rawWarnAtPercent,
          SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT,
        );

  return Object.freeze({
    maxDepth,
    maxConcurrent,
    allowedRoles,
    perRoleCaps: Object.freeze({}),
    blockedToolNames,
    warnAtPercent,
  } satisfies SubagentPolicy);
}
