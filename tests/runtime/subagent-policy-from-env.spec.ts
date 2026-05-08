/**
 * P4 Stage 4-1 — `resolveSubagentPolicyFromEnv` unit tests.
 *
 * Coverage matrix:
 *   - defaults (no env vars set)
 *   - per-env-var override (positive)
 *   - allowed-roles parsing (single, multi, dedup, executor token)
 *   - malformed numeric / fraction rejection (RangeError)
 *   - root-orchestrator rejection in ALLOWED_ROLES
 *   - unknown SubagentRole rejection in ALLOWED_ROLES
 *   - empty / whitespace BLOCKED_TOOLS entry rejection
 *   - WARN_AT_PERCENT boundary rejection (0, 1)
 */
import { describe, expect, it } from 'vitest';

import {
  resolveSubagentPolicyFromEnv,
  SUBAGENT_POLICY_ENV_VARS,
} from '../../src/runtime/subagent-policy-enforcer.js';

const EMPTY_ENV: NodeJS.ProcessEnv = Object.freeze({});

describe('resolveSubagentPolicyFromEnv — defaults', () => {
  it('returns documented Stage 4-1 defaults when no env vars are set', () => {
    const policy = resolveSubagentPolicyFromEnv(EMPTY_ENV);
    expect(policy.maxDepth).toBe(1);
    expect(policy.maxConcurrent).toBe(2);
    expect([...policy.allowedRoles]).toEqual([
      'explorer',
      'coder',
      'writer',
      'verifier',
    ]);
    expect(policy.perRoleCaps).toEqual({});
    expect([...(policy.blockedToolNames ?? [])]).toEqual([]);
    expect(policy.warnAtPercent).toBeCloseTo(0.8, 6);
  });

  it('treats empty-string env vars as unset (defaults applied)', () => {
    const policy = resolveSubagentPolicyFromEnv({
      [SUBAGENT_POLICY_ENV_VARS.MAX_DEPTH]: '',
      [SUBAGENT_POLICY_ENV_VARS.MAX_CONCURRENT]: '',
      [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]: '',
      [SUBAGENT_POLICY_ENV_VARS.BLOCKED_TOOLS]: '',
      [SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT]: '',
    });
    expect(policy.maxDepth).toBe(1);
    expect(policy.maxConcurrent).toBe(2);
    expect(policy.warnAtPercent).toBeCloseTo(0.8, 6);
  });
});

describe('resolveSubagentPolicyFromEnv — overrides', () => {
  it('parses every override correctly', () => {
    const policy = resolveSubagentPolicyFromEnv({
      [SUBAGENT_POLICY_ENV_VARS.MAX_DEPTH]: '2',
      [SUBAGENT_POLICY_ENV_VARS.MAX_CONCURRENT]: '5',
      [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]: 'explorer, coder',
      [SUBAGENT_POLICY_ENV_VARS.BLOCKED_TOOLS]: 'shell,bash',
      [SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT]: '0.5',
    });
    expect(policy.maxDepth).toBe(2);
    expect(policy.maxConcurrent).toBe(5);
    expect([...policy.allowedRoles]).toEqual(['explorer', 'coder']);
    expect([...(policy.blockedToolNames ?? [])]).toEqual(['shell', 'bash']);
    expect(policy.warnAtPercent).toBeCloseTo(0.5, 6);
  });

  it('deduplicates ALLOWED_ROLES and BLOCKED_TOOLS while preserving order', () => {
    const policy = resolveSubagentPolicyFromEnv({
      [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]: 'coder,coder,explorer',
      [SUBAGENT_POLICY_ENV_VARS.BLOCKED_TOOLS]: 'shell,shell,bash',
    });
    expect([...policy.allowedRoles]).toEqual(['coder', 'explorer']);
    expect([...(policy.blockedToolNames ?? [])]).toEqual(['shell', 'bash']);
  });

  it('accepts the executor role in ALLOWED_ROLES (validated child role)', () => {
    const policy = resolveSubagentPolicyFromEnv({
      [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]: 'executor',
    });
    expect([...policy.allowedRoles]).toEqual(['executor']);
  });
});

describe('resolveSubagentPolicyFromEnv — malformed rejection', () => {
  it('rejects non-integer MAX_DEPTH', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.MAX_DEPTH]: '1.5',
      }),
    ).toThrow(RangeError);
  });

  it('rejects non-positive MAX_CONCURRENT', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.MAX_CONCURRENT]: '0',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.MAX_CONCURRENT]: '-3',
      }),
    ).toThrow(RangeError);
  });

  it('rejects "root-orchestrator" in ALLOWED_ROLES', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]:
          'explorer,root-orchestrator,coder',
      }),
    ).toThrow(/root-orchestrator/);
  });

  it('rejects unknown SubagentRole in ALLOWED_ROLES', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]: 'explorer,wizard',
      }),
    ).toThrow(/wizard/);
  });

  it('rejects an all-whitespace ALLOWED_ROLES value', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.ALLOWED_ROLES]: ' , , ',
      }),
    ).toThrow(RangeError);
  });

  it('rejects empty entry in BLOCKED_TOOLS', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.BLOCKED_TOOLS]: 'shell,,bash',
      }),
    ).toThrow(RangeError);
  });

  it('rejects WARN_AT_PERCENT outside the open interval (0, 1)', () => {
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT]: '0',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT]: '1',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSubagentPolicyFromEnv({
        [SUBAGENT_POLICY_ENV_VARS.WARN_AT_PERCENT]: 'NaN',
      }),
    ).toThrow(RangeError);
  });
});
