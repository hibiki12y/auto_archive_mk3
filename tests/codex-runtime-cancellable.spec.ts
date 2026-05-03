/**
 * WU-J-INT (driver-local scope) — tests for
 * `mapCodexTurnOutcomeToCancellableResult`.
 *
 * Spec: `specs/wu-j-cancellable-result-wrap.md` — exercises the driver-side
 * mapper that translates Codex turn outcomes (success / AbortError-shaped
 * external cancellation / `CodexProviderFailureError`) into the typed
 * `CancellableResultAsync` three-branch envelope.
 *
 * Per AC-J9 this header explicitly cites WU-J.
 */

import { describe, expect, it } from 'vitest';

import { generateTaskId } from '../src/contracts/task-id.js';
import { CodexProviderFailureError } from '../src/runtime/codex-runtime-adapter.js';
import {
  mapCodexTurnOutcomeToCancellableResult,
  type CodexTurnOutcomeMapperContext,
  type ExternalCancellationObservation,
} from '../src/runtime/codex-runtime-cancellable.js';

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function makeContext(
  overrides: Partial<CodexTurnOutcomeMapperContext> = {},
): CodexTurnOutcomeMapperContext {
  return {
    taskId: overrides.taskId ?? generateTaskId(),
    runtimeInstanceId: overrides.runtimeInstanceId ?? 'agent-instance-test',
    provenance: overrides.provenance,
    observedAtNow:
      overrides.observedAtNow ?? (() => '2026-04-20T00:00:00.000Z'),
    observeExternalCancellation:
      overrides.observeExternalCancellation ?? (() => undefined),
  };
}

describe('mapCodexTurnOutcomeToCancellableResult (WU-J driver-local)', () => {
  it('maps a successful turn into the success branch', async () => {
    const taskId = generateTaskId();
    const context = makeContext({ taskId });

    const result = await mapCodexTurnOutcomeToCancellableResult<string>(
      context,
      async () => 'final agent message',
    );

    expect(result).toEqual({
      kind: 'success',
      taskId,
      value: 'final agent message',
    });
  });

  it('maps an AbortError-shaped turn failure to the cancelled branch with TerminalCauseExternalCancel', async () => {
    const taskId = generateTaskId();
    const observation: ExternalCancellationObservation = {
      reason: 'operator cancellation requested',
      requestedAt: '2026-04-19T23:59:59.500Z',
      cancelMode: 'cooperative',
    };
    const context = makeContext({
      taskId,
      runtimeInstanceId: 'agent-instance-cancel',
      observeExternalCancellation: () => observation,
    });

    const result = await mapCodexTurnOutcomeToCancellableResult<string>(
      context,
      async () => {
        throw createAbortError('stream aborted');
      },
    );

    expect(result.kind).toBe('cancelled');
    if (result.kind !== 'cancelled') return;
    expect(result.taskId).toBe(taskId);
    expect(result.cause).toEqual({
      kind: 'external-cancel',
      taskId,
      runtimeInstanceId: 'agent-instance-cancel',
      observedAt: '2026-04-20T00:00:00.000Z',
      provenance: 'codex-runtime-driver',
      reason: 'operator cancellation requested',
      requestedAt: '2026-04-19T23:59:59.500Z',
      cancelMode: 'cooperative',
    });
  });

  it('rethrows AbortError when no external cancellation observation is paired with it', async () => {
    const context = makeContext({
      observeExternalCancellation: () => undefined,
    });
    const aborted = createAbortError('stream aborted by veto controller');

    await expect(
      mapCodexTurnOutcomeToCancellableResult<string>(context, async () => {
        throw aborted;
      }),
    ).rejects.toBe(aborted);
  });

  it('maps a rate-limit CodexProviderFailureError to the failure branch (retryable=true)', async () => {
    const taskId = generateTaskId();
    const context = makeContext({
      taskId,
      runtimeInstanceId: 'agent-instance-rate-limit',
    });

    const error = new CodexProviderFailureError(
      '429 Too Many Requests — slow down',
      'turn.failed',
    );

    const result = await mapCodexTurnOutcomeToCancellableResult<string>(
      context,
      async () => {
        throw error;
      },
    );

    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.taskId).toBe(taskId);
    expect(result.error).toBe(error);
    expect(result.cause).toEqual({
      kind: 'provider-failure',
      taskId,
      runtimeInstanceId: 'agent-instance-rate-limit',
      observedAt: '2026-04-20T00:00:00.000Z',
      provenance: 'codex-runtime-driver',
      provider: 'codex',
      classification: 'rate-limit',
      retryable: true,
      message: '429 Too Many Requests — slow down',
    });
  });

  it('maps a permanent CodexProviderFailureError to the failure branch (retryable=false)', async () => {
    const taskId = generateTaskId();
    const context = makeContext({
      taskId,
      runtimeInstanceId: 'agent-instance-permanent',
    });

    const error = new CodexProviderFailureError(
      'hallucinated tool call shape',
      'error',
    );

    const result = await mapCodexTurnOutcomeToCancellableResult<string>(
      context,
      async () => {
        throw error;
      },
    );

    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.error).toBe(error);
    expect(result.cause).toMatchObject({
      kind: 'provider-failure',
      provider: 'codex',
      classification: 'unknown',
      retryable: false,
      message: 'hallucinated tool call shape',
      provenance: 'codex-runtime-driver',
    });
  });

  it('rethrows unrelated thrown values unchanged (no synthetic cause)', async () => {
    const context = makeContext();
    const surprise = new Error('unexpected runtime fault');

    await expect(
      mapCodexTurnOutcomeToCancellableResult<string>(context, async () => {
        throw surprise;
      }),
    ).rejects.toBe(surprise);
  });
});
