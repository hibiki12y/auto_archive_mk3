/**
 * P4 Stage 4-3 — append-side subagent operator evidence ledger.
 *
 * Verifies the redaction shape and JSONL append behavior:
 *   - Spawn / progress events round-trip through the redactor with all
 *     safe metadata preserved.
 *   - Terminal events strip free-text/unsafe fields (`reason`,
 *     `message`, `phase`, `cancelDetail`, `requestContext`, `stack`).
 *   - JSONL writer creates the parent directory and appends one line
 *     per event in-order.
 *   - The bootstrap helper returns `undefined` when the env var is
 *     unset and a working sink lambda when it is set.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RosterEvent } from '../../src/contracts/subagent-roster-event.js';
import {
  InMemorySubagentOperatorEvidenceLedger,
  JsonlSubagentOperatorEvidenceLedger,
  redactSubagentOperatorEvidenceRecord,
} from '../../src/runtime/subagent-operator-evidence-ledger.js';
import { createSubagentOperatorEvidenceLedgerSinkFromEnv } from '../../src/discord/discord-service-bootstrap.js';
import { AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH } from '../../src/core/doctor.js';

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'subagent-op-ledger-test-'));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const correlationKey = {
  taskId: 'task-evidence-ledger',
  instanceId: 'instance-evidence-ledger',
  subagentId: 'subagent-1',
};

const spawnedEvent: RosterEvent = {
  kind: 'subagent.spawned',
  correlationKey,
  timestamp: '2026-05-08T00:00:00.000Z',
  descriptor: {
    subagentId: 'subagent-1',
    role: 'explorer',
    parent: { taskId: correlationKey.taskId, instanceId: correlationKey.instanceId },
    createdAt: '2026-05-08T00:00:00.000Z',
    state: 'active',
    envelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
  },
};

const completedEvent: RosterEvent = {
  kind: 'subagent.completed',
  correlationKey,
  timestamp: '2026-05-08T00:01:00.000Z',
  artifact: { digest: 'sha256:abc', ref: 'gs://bucket/path' },
  cause: {
    kind: 'success',
    taskId: correlationKey.taskId,
    runtimeInstanceId: correlationKey.instanceId,
    observedAt: '2026-05-08T00:01:00.000Z',
    provenance: 'evidence-ledger-test',
    artifactLocation: 'gs://bucket/path',
  },
};

const abortedEvent: RosterEvent = {
  kind: 'subagent.aborted',
  correlationKey,
  timestamp: '2026-05-08T00:02:00.000Z',
  partialArtifact: { digest: 'sha256:def' },
  cause: {
    kind: 'runtime-veto',
    taskId: correlationKey.taskId,
    runtimeInstanceId: correlationKey.instanceId,
    observedAt: '2026-05-08T00:02:00.000Z',
    provenance: 'evidence-ledger-test',
    reason: 'must-not-leak-this-reason',
    veto: {
      reason: 'must-not-leak-this-veto-reason',
      provenance: 'evidence-ledger-test',
      origin: 'runtime',
      propagation: {
        blocksSubmission: false,
        requestsCancellation: true,
        requestsTermination: false,
      },
    },
    cancellation: {
      requestedAt: '2026-05-08T00:02:00.000Z',
      cancelMode: 'preemptive',
      cancelDetail: { mustNotLeak: 'this-detail' } as unknown as never,
    },
    vetoSource: 'admission',
  },
};

const failedEvent: RosterEvent = {
  kind: 'subagent.failed',
  correlationKey,
  timestamp: '2026-05-08T00:03:00.000Z',
  cause: {
    kind: 'driver-failure',
    taskId: correlationKey.taskId,
    runtimeInstanceId: correlationKey.instanceId,
    observedAt: '2026-05-08T00:03:00.000Z',
    provenance: 'evidence-ledger-test',
    phase: 'must-not-leak-this-phase',
    message: 'must-not-leak-this-message',
    stack: 'must-not-leak-this-stack',
    requestContext: { mustNotLeak: 'this-context' },
  },
};

const progressEvent: RosterEvent = {
  kind: 'roster.progress',
  correlationKey,
  timestamp: '2026-05-08T00:04:00.000Z',
  completed: 1,
  aborted: 0,
  failed: 0,
  total: 1,
  inFlight: 0,
};

describe('SubagentOperatorEvidenceLedger redaction', () => {
  it('preserves spawn descriptor metadata verbatim', () => {
    const redacted = redactSubagentOperatorEvidenceRecord(spawnedEvent);
    expect(redacted.kind).toBe('subagent.spawned');
    if (redacted.kind === 'subagent.spawned') {
      expect(redacted.descriptor.role).toBe('explorer');
      expect(redacted.descriptor.subagentId).toBe('subagent-1');
      expect(redacted.descriptor.envelope).toBeDefined();
    }
  });

  it('preserves roster.progress counters verbatim', () => {
    const redacted = redactSubagentOperatorEvidenceRecord(progressEvent);
    expect(redacted.kind).toBe('roster.progress');
    if (redacted.kind === 'roster.progress') {
      expect(redacted.completed).toBe(1);
      expect(redacted.total).toBe(1);
    }
  });

  it('strips reason / cancellation detail from subagent.aborted cause', () => {
    const redacted = redactSubagentOperatorEvidenceRecord(abortedEvent);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('must-not-leak-this-reason');
    expect(serialized).not.toContain('must-not-leak-this-veto-reason');
    expect(serialized).not.toContain('this-detail');
    expect(redacted.kind).toBe('subagent.aborted');
    if (redacted.kind === 'subagent.aborted') {
      expect(redacted.cause.kind).toBe('runtime-veto');
      if (redacted.cause.kind === 'runtime-veto') {
        expect(redacted.cause.vetoSource).toBe('admission');
        expect(redacted.cause.cancellation?.cancelMode).toBe('preemptive');
      }
    }
  });

  it('strips message / phase / stack / requestContext from subagent.failed cause', () => {
    const redacted = redactSubagentOperatorEvidenceRecord(failedEvent);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('must-not-leak-this-phase');
    expect(serialized).not.toContain('must-not-leak-this-message');
    expect(serialized).not.toContain('must-not-leak-this-stack');
    expect(serialized).not.toContain('this-context');
    expect(redacted.kind).toBe('subagent.failed');
  });
});

describe('JsonlSubagentOperatorEvidenceLedger', () => {
  it('appends one redacted line per event preserving order', () => {
    const ledgerPath = join(workspace, 'nested', 'ledger.jsonl');
    const ledger = new JsonlSubagentOperatorEvidenceLedger(ledgerPath);
    ledger.append(spawnedEvent);
    ledger.append(completedEvent);
    ledger.append(progressEvent);
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as { kind: string });
    expect(parsed.map((p) => p.kind)).toEqual([
      'subagent.spawned',
      'subagent.completed',
      'roster.progress',
    ]);
  });

  it('rejects empty file path', () => {
    expect(() => new JsonlSubagentOperatorEvidenceLedger('')).toThrow();
    expect(() => new JsonlSubagentOperatorEvidenceLedger('   ')).toThrow();
  });
});

describe('InMemorySubagentOperatorEvidenceLedger', () => {
  it('captures appended records in order', () => {
    const ledger = new InMemorySubagentOperatorEvidenceLedger();
    ledger.append(spawnedEvent);
    ledger.append(failedEvent);
    const all = ledger.loadAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.kind).toBe('subagent.spawned');
    expect(all[1]?.kind).toBe('subagent.failed');
  });
});

describe('createSubagentOperatorEvidenceLedgerSinkFromEnv', () => {
  it('returns undefined when the env var is unset', () => {
    expect(
      createSubagentOperatorEvidenceLedgerSinkFromEnv({} as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(
      createSubagentOperatorEvidenceLedgerSinkFromEnv({
        [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: '   ',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('returns a sink that appends redacted records when the env var is set', () => {
    const ledgerPath = join(workspace, 'env-sink', 'ledger.jsonl');
    const sink = createSubagentOperatorEvidenceLedgerSinkFromEnv({
      [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: ledgerPath,
    } as unknown as NodeJS.ProcessEnv);
    expect(sink).toBeDefined();
    sink?.(spawnedEvent);
    sink?.(failedEvent);
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    // Failed event redaction must hold through the env-sink path too.
    expect(lines[1]).not.toContain('must-not-leak-this-message');
  });
});
