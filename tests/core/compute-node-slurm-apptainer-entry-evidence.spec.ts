import { describe, expect, it } from 'vitest';

import { assertEntryScriptTerminalEvidence } from '../../src/core/compute-node-slurm-apptainer.js';

function validEvidence(): Record<string, unknown> {
  return {
    taskId: 'task-1',
    runtimeInstanceId: 'agent-task-1-2026-04-30',
    reason: 'driver completed',
    provenance: 'codex-runtime-driver',
    startedAt: '2026-04-30T00:00:00.000Z',
    endedAt: '2026-04-30T00:00:01.000Z',
    executionContext: {
      planCreatedAt: '2026-04-30T00:00:00.000Z',
      runtimeSettings: {},
    },
    resourceEnvelope: { requested: {}, effective: {} },
    cause: {
      kind: 'success',
      taskId: 'task-1',
      runtimeInstanceId: 'agent-task-1-2026-04-30',
      observedAt: '2026-04-30T00:00:01.000Z',
      provenance: 'codex-runtime-driver',
      reason: 'driver completed',
    },
  };
}

describe('assertEntryScriptTerminalEvidence', () => {
  it('accepts a minimally well-formed TerminalEvidence and returns it as the typed shape', () => {
    const evidence = validEvidence();
    expect(assertEntryScriptTerminalEvidence(evidence)).toBe(evidence);
  });

  it('rejects a non-object value', () => {
    expect(() => assertEntryScriptTerminalEvidence(null)).toThrow(
      /not a TerminalEvidence object/,
    );
    expect(() => assertEntryScriptTerminalEvidence('evidence')).toThrow(
      /not a TerminalEvidence object/,
    );
  });

  it('rejects when a required string field is missing', () => {
    const evidence = validEvidence();
    delete evidence.taskId;
    expect(() => assertEntryScriptTerminalEvidence(evidence)).toThrow(
      /taskId must be a non-empty string/,
    );
  });

  it('rejects an empty-string startedAt', () => {
    expect(() =>
      assertEntryScriptTerminalEvidence({ ...validEvidence(), startedAt: '' }),
    ).toThrow(/startedAt must be a non-empty string/);
  });

  it('rejects an executionContext that is not an object', () => {
    expect(() =>
      assertEntryScriptTerminalEvidence({
        ...validEvidence(),
        executionContext: 'plan',
      }),
    ).toThrow(/executionContext must be an object/);
  });

  it('rejects an artifactLocation that is provided as a non-string', () => {
    expect(() =>
      assertEntryScriptTerminalEvidence({
        ...validEvidence(),
        artifactLocation: 0,
      }),
    ).toThrow(/artifactLocation must be a string when provided/);
  });

  it('rejects when cause is missing entirely (delegates to assertTerminalCause)', () => {
    const evidence = validEvidence();
    delete evidence.cause;
    expect(() => assertEntryScriptTerminalEvidence(evidence)).toThrow();
  });

  it('rejects when cause.kind is not in the TerminalCause union', () => {
    expect(() =>
      assertEntryScriptTerminalEvidence({
        ...validEvidence(),
        cause: { kind: 'broadcast' },
      }),
    ).toThrow();
  });
});
