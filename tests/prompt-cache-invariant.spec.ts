/**
 * Unit tests for src/runtime/prompt-cache-invariant.ts
 *
 * Covers:
 *   - Mode resolution: explicit → env → default
 *   - `off` mode: complete no-op
 *   - `warn` mode: logs violations, never throws, records them
 *   - `enforce` mode: throws on violation
 *   - `observeSystemPrompt` / `freezeSystemPrompt` lifecycle
 *   - `rotateSession`: unfreezes so a new prompt can be frozen post-compaction
 *   - Multi-task isolation: independent per-task state
 *   - `getViolations()` returns a snapshot copy
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPromptCacheInvariant,
  PROMPT_CACHE_INVARIANT_ENV,
  type PromptCacheInvariantViolation,
  type SessionRotationEvent,
} from '../src/runtime/prompt-cache-invariant.js';

// Capture the original env value and restore after each test.
const ORIGINAL_ENV = process.env[PROMPT_CACHE_INVARIANT_ENV];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[PROMPT_CACHE_INVARIANT_ENV];
  } else {
    process.env[PROMPT_CACHE_INVARIANT_ENV] = ORIGINAL_ENV;
  }
});

// Fixed clock for deterministic timestamps in tests.
const FIXED_CLOCK = () => '2026-05-01T00:00:00.000Z';

describe('createPromptCacheInvariant — mode resolution', () => {
  it('defaults to warn when no env and no explicit mode', () => {
    delete process.env[PROMPT_CACHE_INVARIANT_ENV];
    const invariant = createPromptCacheInvariant({ clock: FIXED_CLOCK });
    expect(invariant.mode).toBe('warn');
  });

  it('respects explicit mode=enforce over env', () => {
    process.env[PROMPT_CACHE_INVARIANT_ENV] = 'warn';
    const invariant = createPromptCacheInvariant({ mode: 'enforce', clock: FIXED_CLOCK });
    expect(invariant.mode).toBe('enforce');
  });

  it('reads warn from env when no explicit mode', () => {
    process.env[PROMPT_CACHE_INVARIANT_ENV] = 'warn';
    const invariant = createPromptCacheInvariant({ clock: FIXED_CLOCK });
    expect(invariant.mode).toBe('warn');
  });

  it('reads enforce from env when no explicit mode', () => {
    process.env[PROMPT_CACHE_INVARIANT_ENV] = 'enforce';
    const invariant = createPromptCacheInvariant({ clock: FIXED_CLOCK });
    expect(invariant.mode).toBe('enforce');
  });

  it('reads off from env when no explicit mode', () => {
    process.env[PROMPT_CACHE_INVARIANT_ENV] = 'off';
    const invariant = createPromptCacheInvariant({ clock: FIXED_CLOCK });
    expect(invariant.mode).toBe('off');
  });

  it('ignores unknown env values and falls back to warn', () => {
    process.env[PROMPT_CACHE_INVARIANT_ENV] = 'verbose';
    const invariant = createPromptCacheInvariant({ clock: FIXED_CLOCK });
    expect(invariant.mode).toBe('warn');
  });
});

describe('createPromptCacheInvariant — off mode', () => {
  it('is a complete no-op: all methods succeed, violations is always empty', () => {
    const invariant = createPromptCacheInvariant({ mode: 'off' });
    expect(invariant.mode).toBe('off');
    expect(() => {
      invariant.observeSystemPrompt('task-1', 1, 'SYSTEM PROMPT A');
      invariant.freezeSystemPrompt('task-1');
      invariant.observeSystemPrompt('task-1', 2, 'DIFFERENT PROMPT MUTATED');
    }).not.toThrow();
    expect(invariant.getViolations()).toEqual([]);
  });

  it('rotateSession is a no-op in off mode', () => {
    const invariant = createPromptCacheInvariant({ mode: 'off' });
    const event: SessionRotationEvent = {
      taskId: 'task-1',
      previousSessionId: 'sess-a',
      nextSessionId: 'sess-b',
      reason: 'compaction',
      observedAt: FIXED_CLOCK(),
    };
    expect(() => invariant.rotateSession(event)).not.toThrow();
    expect(invariant.getViolations()).toEqual([]);
  });
});

describe('createPromptCacheInvariant — warn mode', () => {
  it('does not throw on violation — records it and logs', () => {
    const logEntries: Array<{ message: string; payload: unknown }> = [];
    const logger = (message: string, payload: unknown): void => {
      logEntries.push({ message, payload });
    };
    const invariant = createPromptCacheInvariant({ mode: 'warn', clock: FIXED_CLOCK, logger });

    invariant.observeSystemPrompt('task-1', 1, 'SYSTEM A');
    invariant.freezeSystemPrompt('task-1');
    // Mutate after freeze — should NOT throw.
    expect(() => {
      invariant.observeSystemPrompt('task-1', 2, 'SYSTEM B');
    }).not.toThrow();

    const violations = invariant.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('system-prompt-mutation');
    expect(violations[0]?.taskId).toBe('task-1');
    expect(violations[0]?.conversationTurn).toBe(2);

    // Logger was called.
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]?.message).toContain('system-prompt-mutation');
  });

  it('no violation when prompt is unchanged after freeze', () => {
    const logEntries: string[] = [];
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: (m) => logEntries.push(m),
    });

    invariant.observeSystemPrompt('task-1', 1, 'STABLE PROMPT');
    invariant.freezeSystemPrompt('task-1');
    invariant.observeSystemPrompt('task-1', 2, 'STABLE PROMPT');
    invariant.observeSystemPrompt('task-1', 3, 'STABLE PROMPT');

    expect(invariant.getViolations()).toHaveLength(0);
    expect(logEntries).toHaveLength(0);
  });

  it('no violation before freeze even if prompt changes', () => {
    const invariant = createPromptCacheInvariant({ mode: 'warn', clock: FIXED_CLOCK });

    invariant.observeSystemPrompt('task-1', 1, 'PROMPT A');
    invariant.observeSystemPrompt('task-1', 2, 'PROMPT B');
    // Not frozen yet — no violation.
    expect(invariant.getViolations()).toHaveLength(0);
  });

  it('freezeSystemPrompt is idempotent — second call does not reset frozen prompt', () => {
    const invariant = createPromptCacheInvariant({ mode: 'warn', clock: FIXED_CLOCK });

    invariant.observeSystemPrompt('task-1', 1, 'PROMPT A');
    invariant.freezeSystemPrompt('task-1');
    // Observe a different prompt, then call freeze again (which should be a no-op).
    // The invariant should detect mutation after the FIRST freeze.
    invariant.observeSystemPrompt('task-1', 2, 'PROMPT B');
    invariant.freezeSystemPrompt('task-1'); // no-op — already frozen

    const violations = invariant.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('system-prompt-mutation');
  });

  it('freeze without prior observe freezes to undefined — subsequent same-undefined observe is stable', () => {
    const invariant = createPromptCacheInvariant({ mode: 'warn', clock: FIXED_CLOCK });

    invariant.freezeSystemPrompt('task-1');
    // First observe after freeze: undefined → 'PROMPT' is a mutation.
    invariant.observeSystemPrompt('task-1', 1, 'FIRST PROMPT');

    const violations = invariant.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('system-prompt-mutation');
    expect(violations[0]?.detail).toContain('mutated after freeze');
  });
});

describe('createPromptCacheInvariant — enforce mode', () => {
  it('throws on violation', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'enforce',
      clock: FIXED_CLOCK,
      logger: () => undefined, // suppress console output in tests
    });

    invariant.observeSystemPrompt('task-1', 1, 'SYSTEM A');
    invariant.freezeSystemPrompt('task-1');

    expect(() => {
      invariant.observeSystemPrompt('task-1', 2, 'SYSTEM B — MUTATED');
    }).toThrow(/PromptCacheInvariant.*system-prompt-mutation/);
  });

  it('error message includes taskId and turn', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'enforce',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-x', 5, 'A');
    invariant.freezeSystemPrompt('task-x');

    expect(() => {
      invariant.observeSystemPrompt('task-x', 7, 'B');
    }).toThrow(/taskId=task-x.*turn=7/);
  });
});

describe('createPromptCacheInvariant — rotateSession', () => {
  it('unfreezes the task so a new prompt can be frozen after compaction', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    // Session A
    invariant.observeSystemPrompt('task-1', 1, 'ORIGINAL SYSTEM PROMPT');
    invariant.freezeSystemPrompt('task-1');

    // Compaction → session rotation
    const rotationEvent: SessionRotationEvent = {
      taskId: 'task-1',
      previousSessionId: 'sess-a',
      nextSessionId: 'sess-b',
      parentSessionId: 'sess-a',
      reason: 'compaction',
      observedAt: FIXED_CLOCK(),
    };
    invariant.rotateSession(rotationEvent);

    // Session B: new prompt after compaction — no violation because we rotated.
    invariant.observeSystemPrompt('task-1', 1, 'POST-COMPACTION SUMMARY PROMPT');
    invariant.freezeSystemPrompt('task-1');

    // Now mutate after re-freeze — THAT should be a violation.
    invariant.observeSystemPrompt('task-1', 2, 'MUTATED AGAIN');

    const violations = invariant.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('system-prompt-mutation');
  });

  it('does not record a violation if rotation precedes the prompt change', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-1', 1, 'PROMPT A');
    invariant.freezeSystemPrompt('task-1');

    invariant.rotateSession({
      taskId: 'task-1',
      previousSessionId: 'sess-a',
      nextSessionId: 'sess-b',
      reason: 'compaction',
      observedAt: FIXED_CLOCK(),
    });

    // No freeze after rotation — observe without freeze is always safe.
    invariant.observeSystemPrompt('task-1', 1, 'PROMPT B');

    expect(invariant.getViolations()).toHaveLength(0);
  });

  it('rotateSession without prior freeze is a no-op on state', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    // Never froze.
    invariant.rotateSession({
      taskId: 'task-1',
      previousSessionId: 'sess-a',
      nextSessionId: 'sess-b',
      reason: 'manual',
      observedAt: FIXED_CLOCK(),
    });

    // Still safe — prompt changes before first freeze are not violations.
    invariant.observeSystemPrompt('task-1', 1, 'PROMPT A');
    invariant.observeSystemPrompt('task-1', 2, 'PROMPT B');

    expect(invariant.getViolations()).toHaveLength(0);
  });
});

describe('createPromptCacheInvariant — multi-task isolation', () => {
  it('violations on task-1 do not affect task-2', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-1', 1, 'PROMPT A');
    invariant.freezeSystemPrompt('task-1');
    invariant.observeSystemPrompt('task-1', 2, 'PROMPT B'); // violation on task-1

    invariant.observeSystemPrompt('task-2', 1, 'PROMPT C');
    invariant.freezeSystemPrompt('task-2');
    invariant.observeSystemPrompt('task-2', 2, 'PROMPT C'); // same — no violation

    const violations = invariant.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.taskId).toBe('task-1');
  });

  it('rotate on task-1 does not unfreeze task-2', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-1', 1, 'A');
    invariant.freezeSystemPrompt('task-1');
    invariant.observeSystemPrompt('task-2', 1, 'B');
    invariant.freezeSystemPrompt('task-2');

    invariant.rotateSession({
      taskId: 'task-1',
      previousSessionId: 'sess-a',
      nextSessionId: 'sess-b',
      reason: 'compaction',
      observedAt: FIXED_CLOCK(),
    });

    // task-2 is still frozen — mutation here should be caught.
    invariant.observeSystemPrompt('task-2', 2, 'MUTATED B');

    const violations = invariant.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.taskId).toBe('task-2');
  });
});

describe('createPromptCacheInvariant — getViolations is a snapshot', () => {
  it('mutating the returned array does not affect the internal log', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-1', 1, 'A');
    invariant.freezeSystemPrompt('task-1');
    invariant.observeSystemPrompt('task-1', 2, 'B'); // violation

    const first = invariant.getViolations();
    // Cast to mutable to test mutation isolation.
    (first as PromptCacheInvariantViolation[]).push({
      kind: 'system-prompt-mutation',
      taskId: 'injected',
      conversationTurn: 99,
      observedAt: FIXED_CLOCK(),
      detail: 'injected from test',
    });

    const second = invariant.getViolations();
    // The internal log should still have only 1 violation.
    expect(second).toHaveLength(1);
    expect(second[0]?.taskId).toBe('task-1');
  });
});

describe('createPromptCacheInvariant — instance isolation', () => {
  it('two instances do not share state', () => {
    const a = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });
    const b = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    a.observeSystemPrompt('task-1', 1, 'PROMPT A');
    a.freezeSystemPrompt('task-1');
    a.observeSystemPrompt('task-1', 2, 'PROMPT B'); // violation in a

    // b should have no knowledge of a's state.
    expect(b.getViolations()).toHaveLength(0);
  });
});

describe('createPromptCacheInvariant — custom clock', () => {
  it('violation observedAt uses the supplied clock', () => {
    const customClock = () => '2025-01-15T12:00:00.000Z';
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: customClock,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-1', 1, 'A');
    invariant.freezeSystemPrompt('task-1');
    invariant.observeSystemPrompt('task-1', 2, 'B');

    const violations = invariant.getViolations();
    expect(violations[0]?.observedAt).toBe('2025-01-15T12:00:00.000Z');
  });
});

describe('createPromptCacheInvariant — forgetTask (audit 2026-05-03 follow-up)', () => {
  it('clears frozen-prompt state so a re-observed prompt no longer counts as mutation', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-leak', 1, 'PROMPT A');
    invariant.freezeSystemPrompt('task-leak');
    invariant.forgetTask?.('task-leak');

    // After forget, re-observing a different prompt under the same id is
    // treated as a fresh task — no frozen baseline, so no mutation violation.
    invariant.observeSystemPrompt('task-leak', 1, 'PROMPT B');
    expect(invariant.getViolations()).toEqual([]);
  });

  it('drops rotation log so a stale lineage cannot survive task end', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-rot', 1, 'PROMPT');
    invariant.freezeSystemPrompt('task-rot');
    invariant.rotateSession({
      taskId: 'task-rot',
      previousSessionId: 'sess-a',
      nextSessionId: 'sess-b',
      reason: 'compaction',
      observedAt: FIXED_CLOCK(),
    });
    invariant.forgetTask?.('task-rot');

    // Re-freeze should now capture a fresh baseline; subsequent
    // matching observations are clean (proves frozenPrompt was reset
    // along with the rotation log).
    invariant.observeSystemPrompt('task-rot', 1, 'NEW PROMPT');
    invariant.freezeSystemPrompt('task-rot');
    invariant.observeSystemPrompt('task-rot', 2, 'NEW PROMPT');
    expect(invariant.getViolations()).toEqual([]);
  });

  it('preserves recorded violations across forgetTask (append-only log)', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });

    invariant.observeSystemPrompt('task-v', 1, 'A');
    invariant.freezeSystemPrompt('task-v');
    invariant.observeSystemPrompt('task-v', 2, 'B');
    expect(invariant.getViolations()).toHaveLength(1);

    invariant.forgetTask?.('task-v');
    // Violations are intentionally retained — they are post-mortem
    // diagnostic data, not per-task state.
    expect(invariant.getViolations()).toHaveLength(1);
  });

  it('forgetTask on an unknown id is a no-op', () => {
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: () => undefined,
    });
    expect(() => invariant.forgetTask?.('never-seen')).not.toThrow();
    expect(invariant.getViolations()).toEqual([]);
  });

  it('forgetTask is provided in off mode (no-op)', () => {
    const invariant = createPromptCacheInvariant({ mode: 'off' });
    expect(typeof invariant.forgetTask).toBe('function');
    expect(() => invariant.forgetTask?.('task-x')).not.toThrow();
  });
});

describe('createPromptCacheInvariant — custom logger', () => {
  it('violation payload includes all expected fields', () => {
    const captured: Array<{ message: string; payload: unknown }> = [];
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      clock: FIXED_CLOCK,
      logger: (message, payload) => captured.push({ message, payload }),
    });

    invariant.observeSystemPrompt('task-xyz', 3, 'ORIGINAL');
    invariant.freezeSystemPrompt('task-xyz');
    invariant.observeSystemPrompt('task-xyz', 4, 'CHANGED');

    expect(captured).toHaveLength(1);
    const { message, payload } = captured[0];
    expect(message).toContain('prompt-cache-invariant');
    expect(message).toContain('system-prompt-mutation');
    expect(payload).toMatchObject({
      event: 'prompt-cache-invariant-violation',
      kind: 'system-prompt-mutation',
      taskId: 'task-xyz',
      conversationTurn: 4,
      observedAt: FIXED_CLOCK(),
    });
  });
});
