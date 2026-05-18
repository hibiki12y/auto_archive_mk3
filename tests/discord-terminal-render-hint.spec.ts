import { describe, expect, it } from 'vitest';

import {
  buildTerminalNextStepHint,
  renderRestartRecipeSummary,
  renderTaskRerunAccepted,
  renderTerminalResult,
} from '../src/discord/discord-result-renderer.js';
import type { DiscordTaskRecord } from '../src/discord/discord-task-registry.js';
import type { TerminalCause } from '../src/contracts/terminal-cause.js';

// UX-21 — terminal-result humanization + next-step hint.

describe('buildTerminalNextStepHint', () => {
  it('returns undefined for success (no hint needed)', () => {
    expect(buildTerminalNextStepHint('success', 'task-1')).toBeUndefined();
  });
  it('returns undefined for external-cancel (operator already knows)', () => {
    expect(buildTerminalNextStepHint('external-cancel', 'task-2'))
      .toBeUndefined();
  });
  it('returns a /doctor + /rerun hint for provider-failure', () => {
    const hint = buildTerminalNextStepHint('provider-failure', 'task-3');
    expect(hint).toContain('Provider error');
    expect(hint).toContain('/rerun task_id:task-3');
    expect(hint).toContain('/doctor');
  });
  it('returns a /doctor advisor-health hint for runtime-veto', () => {
    const hint = buildTerminalNextStepHint('runtime-veto', 'task-4');
    expect(hint).toContain('Advisor vetoed');
    expect(hint).toContain('/doctor');
  });
  it('returns a wallTime hint for timeout', () => {
    const hint = buildTerminalNextStepHint('timeout', 'task-5');
    expect(hint).toContain('wallTime budget');
  });
  it('falls through to a generic /rerun + /doctor hint for unknown kinds', () => {
    const hint = buildTerminalNextStepHint('something-novel', 'task-6');
    expect(hint).toContain('/rerun task_id:task-6');
    expect(hint).toContain('/doctor');
  });
});

function makeTerminalRecord(causeKind: string, options: {
  reason?: string;
  provenance?: string;
  classification?: string;
  retryable?: boolean;
} = {}): DiscordTaskRecord {
  const cause: Record<string, unknown> = {
    kind: causeKind,
    taskId: 'discord-task-fixture',
    runtimeInstanceId: 'runtime-fixture',
    observedAt: '2026-05-09T00:00:00Z',
    provenance: options.provenance ?? 'stub',
    ...(options.classification === undefined
      ? {}
      : { classification: options.classification }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
  if (causeKind === 'provider-failure') {
    cause['provider'] = 'codex';
    cause['message'] = 'SECRET provider diagnostic must not render';
    cause['retryable'] = options.retryable ?? false;
  }
  return {
    taskId: 'discord-task-fixture',
    coarseState: 'terminal' as const,
    lastLifecyclePhase: 'completed',
    updatedAt: '2026-05-09T00:00:00Z',
    commandName: 'ask' as const,
    instruction: 'fixture instruction',
    userId: 'discord-user-1',
    acceptance: undefined,
    terminalEvidence: {
      cause,
      reason: options.reason ?? `${causeKind}-reason`,
      provenance: options.provenance ?? 'stub',
    },
  } as unknown as DiscordTaskRecord;
}

describe('renderTerminalResult includes the humanized cause + hint', () => {
  it('omits the Cause line on success (the success outcome already carries it)', () => {
    const record = makeTerminalRecord('success');
    const payload = renderTerminalResult(record);
    expect(payload.content).toContain('finished with `success`.');
    expect(payload.content).not.toContain('Cause:');
    // No hint on success.
    expect(payload.content).not.toContain('💡');
  });
  it('renders the humanized Cause line on provider-failure + appends a hint', () => {
    const record = makeTerminalRecord('provider-failure');
    const payload = renderTerminalResult(record);
    expect(payload.content).toContain('Cause: provider error');
    expect(payload.content).toContain('`provider-failure`');
    expect(payload.content).toContain('💡 Provider error');
    expect(payload.content).toContain('/rerun task_id:discord-task-fixture');
  });
  it('renders Cause + hint on runtime-veto', () => {
    const record = makeTerminalRecord('runtime-veto');
    const payload = renderTerminalResult(record);
    expect(payload.content).toContain('Cause: advisor veto');
    expect(payload.content).toContain('💡 Advisor vetoed');
  });
  it('renders Cause line on external-cancel but omits the hint', () => {
    const record = makeTerminalRecord('external-cancel');
    const payload = renderTerminalResult(record);
    expect(payload.content).toContain('Cause: cancelled');
    expect(payload.content).not.toContain('💡');
  });
  it('renders the wallTime hint on timeout', () => {
    const record = makeTerminalRecord('timeout');
    const payload = renderTerminalResult(record);
    expect(payload.content).toContain('Cause: timeout');
    expect(payload.content).toContain('💡');
    expect(payload.content).toContain('wallTime budget');
  });
});

describe('rerun restart recipe rendering', () => {
  it('summarizes RestartRecipeSnapshot fields without raw provider diagnostics', () => {
    const source = makeTerminalRecord('provider-failure', {
      classification: 'transient-server',
      retryable: true,
    });
    const rerun = {
      ...source,
      taskId: 'discord-task-rerun',
      terminalEvidence: undefined,
    } as DiscordTaskRecord;

    const payload = renderTaskRerunAccepted(source, rerun);

    expect(payload.content).toContain(
      'Restart recipe: retryability=`retryable`, action=`inspect-provider-failure`, operatorActionRequired=`false`, providerFailure=`transient-server`.',
    );
    expect(payload.content).not.toContain('SECRET provider diagnostic');
  });

  it('uses the shared RestartRecipeSnapshot projector for timeout summaries', () => {
    const cause: TerminalCause = {
      kind: 'timeout',
      taskId: 'task-timeout',
      runtimeInstanceId: 'runtime-timeout',
      observedAt: '2026-05-09T00:00:00Z',
      provenance: 'test',
      deadlineMs: 60000,
      firedAt: '2026-05-09T00:01:00Z',
    };

    expect(renderRestartRecipeSummary(cause)).toBe(
      'Restart recipe: retryability=`retryable`, action=`increase-deadline-or-reduce-scope`, operatorActionRequired=`false`.',
    );
  });

  it('renders an explicit unavailable recipe when retained terminal cause is absent', () => {
    const source = {
      ...makeTerminalRecord('success'),
      terminalEvidence: undefined,
    } as DiscordTaskRecord;
    const rerun = {
      ...source,
      taskId: 'discord-task-rerun',
    } as DiscordTaskRecord;

    const payload = renderTaskRerunAccepted(source, rerun);

    expect(payload.content).toContain(
      'Restart recipe: unavailable — no retained TerminalEvidence cause.',
    );
    expect(
      payload.content.match(/Restart recipe:/gu),
    ).toHaveLength(1);
  });
});
