/**
 * WU-M AC-M3 — `taskId` persistence-layer round-trip (I-M6).
 *
 * Spec: `specs/wu-m-task-identity-invariant.md` AC-M3 + I-M6.
 *
 *   I-M6  ∀ persistence layer P, ∀ task t:
 *           read_P(write_P(id(t))) = id(t)  byte-exact.
 *
 * The spec enumerates "log writer, archive writer, checkpoint writer" as
 * the persistence surfaces of interest. The current codebase materializes
 * the first two as in-memory record types serialized through the standard
 * JSON write/read cycle, which is the canonical persistence shape today:
 *
 *   • TerminalEvidence              — the "archive writer" record;
 *                                     emitted by ComputeNode dispatch and
 *                                     consumed downstream (Discord
 *                                     delivery, audit log).
 *   • LifecyclePhaseObservation     — the "log writer" record; emitted by
 *                                     advisory observers and consumed by
 *                                     log sinks.
 *   • ExecutionCheckpoint           — the "checkpoint writer" surface
 *                                     (`gitlab-checkpoint-publisher`).
 *                                     **Does NOT carry `taskId`**: it
 *                                     records repository revision only,
 *                                     not task identity. Documented here
 *                                     so the inapplicability is explicit
 *                                     and grep-discoverable; the test
 *                                     below pins the absence.
 *
 * BC-6 opacity is preserved: every assertion is byte-equality over the
 * post-round-trip string. No parsing, no substring inspection, no version-
 * nibble extraction.
 */

import { describe, expect, it } from 'vitest';

import {
  createExecutionCheckpoint,
  createRuntimeSettingsBundle,
  createTerminalEvidence,
  type LifecyclePhaseObservation,
  type TerminalEvidence,
} from '../../src/index.js';
import { generateTaskId, isValidTaskId } from '../../src/contracts/task-id.js';

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeEvidence(taskId: string): TerminalEvidence {
  const now = new Date().toISOString();
  return createTerminalEvidence({
    taskId,
    runtimeInstanceId: `instance-${taskId}`,
    reason: 'wu-m-ac-m3 round-trip fixture',
    provenance: 'task-id-persistence-spec',
    executionContext: {
      planCreatedAt: now,
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        workingDirectory: 'results/task-artifacts',
      }),
    },
    resourceEnvelope: {
      requested: {
        cpuCores: 1,
        memoryMiB: 256,
        wallTimeSec: 60,
        gpuCards: 0,
      },
      effective: {
        cpuCores: 1,
        memoryMiB: 256,
        wallTimeSec: 60,
        gpuCards: 0,
      },
    },
    startedAt: now,
    endedAt: now,
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId: `instance-${taskId}`,
      observedAt: now,
      provenance: 'task-id-persistence-spec',
    },
  });
}

function makeObservation(taskId: string): LifecyclePhaseObservation {
  return {
    phase: 'runtime-running',
    taskId,
    observedAt: new Date().toISOString(),
    instanceId: `instance-${taskId}`,
  };
}

describe('WU-M AC-M3 — taskId persistence round-trip (I-M6)', () => {
  it('TerminalEvidence (archive writer surface): JSON write/read preserves taskId byte-exact', () => {
    const id = generateTaskId();
    const evidence = makeEvidence(id);
    const restored = jsonRoundTrip(evidence);
    expect(restored.taskId).toBe(id);
    expect(restored.taskId).toBe(evidence.taskId);
    // BC-2 (c) byte-stable representation: round-trip preserves byte length.
    expect(restored.taskId.length).toBe(id.length);
  });

  it('LifecyclePhaseObservation (log writer surface): JSON write/read preserves taskId byte-exact', () => {
    const id = generateTaskId();
    const observation = makeObservation(id);
    const restored = jsonRoundTrip(observation);
    expect(restored.taskId).toBe(id);
    expect(restored.taskId).toBe(observation.taskId);
    expect(restored.taskId.length).toBe(id.length);
  });

  it('ExecutionCheckpoint (checkpoint writer surface): explicitly does NOT carry taskId — inapplicability pinned', () => {
    // Spec note (AC-M3): the gitlab/local-repo execution checkpoint records
    // *repository* identity (revision + URL), not task identity. WU-M
    // permanence flows through TerminalEvidence + admission acceptance, NOT
    // through the execution-checkpoint surface. This test pins that absence
    // so a future schema change that adds `taskId` to ExecutionCheckpoint
    // is forced to consciously update this spec assertion (BC-3 immutability
    // protection extends to schema additions that would create a second
    // identity-bearing surface).
    const checkpoint = createExecutionCheckpoint({
      source: 'local-repo',
      repositoryUrl: '/tmp/wu-m-ac-m3-fixture-repo',
      revision: '0000000000000000000000000000000000000000',
      publishedAt: new Date().toISOString(),
    });
    const restored = jsonRoundTrip(checkpoint);
    expect(restored).toEqual(checkpoint);
    expect(Object.keys(restored).sort()).toEqual(
      ['publishedAt', 'repositoryUrl', 'revision', 'source'].sort(),
    );
    // The absence is the assertion: no `taskId` member on the canonical
    // checkpoint surface. If this fails because someone added one, WU-M
    // AC-M3 must be re-evaluated against the new persistence shape.
    expect(Object.prototype.hasOwnProperty.call(restored, 'taskId')).toBe(
      false,
    );
  });

  it('round-trip preserves UUIDv7 validity (composes BC-2 (c) + BC-6)', () => {
    const id = generateTaskId();
    const evidence = makeEvidence(id);
    const restored = jsonRoundTrip(evidence);
    expect(isValidTaskId(restored.taskId)).toBe(true);
  });

  it('I-M6 batched: 32 distinct ids survive a JSON write/read cycle byte-exact', () => {
    const ids = Array.from({ length: 32 }, () => generateTaskId());
    const records = ids.map(makeEvidence);
    const restored = jsonRoundTrip(records);
    expect(restored.length).toBe(ids.length);
    for (let i = 0; i < ids.length; i++) {
      expect(restored[i]?.taskId).toBe(ids[i]);
    }
  });
});
