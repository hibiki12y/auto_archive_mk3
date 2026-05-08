/**
 * P4 Stage 4-2 — `SubagentRosterRegistry`.
 *
 * Bridges the dispatch-scoped `SubagentRoster` (constructed once per
 * `AgentRuntime.execute(...)` when a `SubagentPolicyEnforcer` is wired)
 * with service-scope consumers like the Discord operator surface and the
 * `/doctor` active-subagent panel that need to enumerate every active
 * dispatch's roster across the bot lifetime.
 *
 * Lifetime contract:
 *   - `register(...)` is called from `AgentRuntime.execute(...)` *after*
 *     the dispatch-scoped roster is created.
 *   - `unregister(...)` is called from the dispatch's `finally` block,
 *     alongside the existing `roster.terminateAll(...)` cleanup.
 *
 * Both operations are idempotent so a defensive double-register or
 * duplicate-finally cannot poison the registry.
 *
 * @see src/runtime/agent-runtime.ts
 * @see src/discord/discord-service-bootstrap.ts
 * @see src/runtime/subagent-operator.ts
 */
import type { SubagentDescriptor } from '../contracts/subagent-roster.js';
import type { SubagentRoster } from './subagent-roster.js';

export interface SubagentRosterRegistration {
  readonly taskId: string;
  readonly instanceId: string;
  readonly roster: SubagentRoster;
}

/**
 * Aggregate counts across every registered roster, broken down by the
 * three observable lifecycle states the operator surface and `/doctor`
 * panel need to reason about.
 *
 * - `active`: descriptors currently doing work (`state === 'active'`).
 * - `spawning`: descriptors mid-handshake (`state === 'spawning'`).
 *   Stage 4-2 production code never moves a descriptor into this state
 *   long enough to observe; the counter exists so Stage 4-4 can spot
 *   stuck spawns without another contract change.
 * - `reserved`: descriptors holding a slot but not yet spawned
 *   (`state === 'reserved'`). Same Stage 4-4 forward-compat reasoning.
 */
export interface SubagentRosterTotals {
  readonly active: number;
  readonly spawning: number;
  readonly reserved: number;
}

export interface SubagentRosterRegistry {
  /**
   * Register a dispatch-scoped roster keyed by `taskId`. Re-registering
   * the same `taskId` replaces the existing entry atomically (the prior
   * roster is dropped without further interaction; the runtime's
   * `terminateAll` is the single source of truth for cleanup).
   */
  register(registration: SubagentRosterRegistration): void;
  /**
   * Remove the registration for `taskId`. No-op when no entry exists —
   * the dispatch's `finally` block runs even when the runtime never
   * registered (e.g. the policy enforcer was unwired).
   */
  unregister(taskId: string): void;
  /** Frozen snapshot of currently-registered rosters. */
  list(): readonly SubagentRosterRegistration[];
  /** Lookup by `taskId`. Returns `undefined` when not registered. */
  find(taskId: string): SubagentRosterRegistration | undefined;
  /**
   * Walk every registered roster's descriptors and aggregate counts by
   * state. Defensive: a roster whose `snapshot()` throws contributes
   * zero to the totals rather than poisoning the whole report (the
   * `/doctor` and operator panels depend on this never throwing).
   */
  totals(): SubagentRosterTotals;
}

function safeDescriptors(roster: SubagentRoster): readonly SubagentDescriptor[] {
  try {
    return roster.snapshot();
  } catch (error) {
    // Mirror the audit/lifecycle hook pattern: a broken roster MUST
    // NOT break the operator/doctor surfaces. Log a structured warn
    // line so the failure is observable without crashing.
    try {
      console.warn(
        'subagent-roster-registry.snapshot-threw',
        JSON.stringify({
          event: 'subagent-roster-registry.snapshot-threw',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } catch {
      // Stringification must never break the registry walk.
    }
    return [];
  }
}

export function createSubagentRosterRegistry(): SubagentRosterRegistry {
  const entries = new Map<string, SubagentRosterRegistration>();

  return {
    register(registration: SubagentRosterRegistration): void {
      // Idempotent replace: a duplicate `taskId` from a buggy caller
      // simply overwrites; no error is thrown so the dispatch path is
      // never aborted by registry bookkeeping.
      entries.set(registration.taskId, registration);
    },
    unregister(taskId: string): void {
      // Idempotent: missing key is a no-op.
      entries.delete(taskId);
    },
    list(): readonly SubagentRosterRegistration[] {
      // Frozen snapshot so callers cannot mutate the internal Map by
      // pushing into the returned array.
      return Object.freeze([...entries.values()]);
    },
    find(taskId: string): SubagentRosterRegistration | undefined {
      return entries.get(taskId);
    },
    totals(): SubagentRosterTotals {
      let active = 0;
      let spawning = 0;
      let reserved = 0;
      for (const registration of entries.values()) {
        const descriptors = safeDescriptors(registration.roster);
        for (const descriptor of descriptors) {
          if (descriptor.state === 'active') {
            active += 1;
          } else if (descriptor.state === 'spawning') {
            spawning += 1;
          } else if (descriptor.state === 'reserved') {
            reserved += 1;
          }
        }
      }
      return { active, spawning, reserved };
    },
  };
}
