import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  InMemoryPeekabooEvidenceLedger,
  JsonlPeekabooEvidenceLedger,
  buildPeekabooEvidenceDigest,
  buildPeekabooReadinessReport,
  filterPeekabooEvidenceRecords,
} from '../src/index.js';

describe('peekaboo evidence ledger', () => {
  it('appends JSONL records and skips torn or invalid lines on replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-evidence-ledger-'));
    try {
      const filePath = join(dir, 'peekaboo-evidence.jsonl');
      const ledger = new JsonlPeekabooEvidenceLedger(filePath);
      const readiness = buildPeekabooReadinessReport({
        phase: 'live',
        configOk: true,
        sshOk: true,
        bridgePresent: true,
        proxyReady: true,
        marker: 'RUN_LEDGER_T01',
        expectedTaskId: 'discord-task-123',
        submitAttempted: true,
        controlOk: true,
        restObservationAttempted: true,
        ack: {
          observedAt: '2026-04-27T00:00:02.000Z',
          taskId: 'discord-task-123',
          matchedOn: ['task-id', 'author'],
        },
        matchedReply: {
          observedAt: '2026-04-27T00:00:05.000Z',
          taskId: 'discord-task-123',
          marker: 'RUN_LEDGER_T01',
          matchedOn: ['marker', 'task-id'],
        },
      });
      const record = ledger.append({
        recordId: 'record-1',
        recordedAt: '2026-04-27T00:00:06.000Z',
        runId: 'RUN_LEDGER',
        turnMarker: 'RUN_LEDGER_T01',
        correlationId: 'corr-1',
        artifactPath: filePath,
        channelId: 'channel-1',
        readiness,
        evidence: readiness.evidence,
      });

      writeFileSync(
        filePath,
        `${readFileSync(filePath, 'utf8')}{"schemaVersion":1,"recordId":"broken"`,
        'utf8',
      );

      expect(new JsonlPeekabooEvidenceLedger(filePath).loadAll()).toEqual([record]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters in-memory records by run, turn, task, correlation, channel, phase, and bounded limit', () => {
    const ledger = new InMemoryPeekabooEvidenceLedger();
    const liveOne = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'RUN_A_T01',
      expectedTaskId: 'discord-task-a1',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-04-27T00:10:05.000Z',
        taskId: 'discord-task-a1',
        marker: 'RUN_A_T01',
        matchedOn: ['marker', 'task-id'],
      },
    });
    const liveTwo = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'RUN_A_T02',
      expectedTaskId: 'discord-task-a2',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-04-27T00:11:05.000Z',
        taskId: 'discord-task-a2',
        marker: 'RUN_A_T02',
        matchedOn: ['marker', 'task-id'],
      },
    });
    const probe = buildPeekabooReadinessReport({
      phase: 'probe',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      probeProxyReady: true,
      marker: 'RUN_B_T01',
      expectedTaskId: 'discord-task-b1',
    });

    ledger.append({
      recordId: 'record-a1',
      recordedAt: '2026-04-27T00:10:06.000Z',
      runId: 'RUN_A',
      turnMarker: 'RUN_A_T01',
      correlationId: 'corr-a1',
      channelId: 'channel-1',
      readiness: liveOne,
      evidence: liveOne.evidence,
    });
    ledger.append({
      recordId: 'record-a2',
      recordedAt: '2026-04-27T00:11:06.000Z',
      runId: 'RUN_A',
      turnMarker: 'RUN_A_T02',
      correlationId: 'corr-a2',
      channelId: 'channel-1',
      readiness: liveTwo,
      evidence: liveTwo.evidence,
    });
    ledger.append({
      recordId: 'record-b1',
      recordedAt: '2026-04-27T00:12:06.000Z',
      runId: 'RUN_B',
      turnMarker: 'RUN_B_T01',
      correlationId: 'corr-b1',
      channelId: 'channel-2',
      readiness: probe,
      evidence: probe.evidence,
    });

    const allRecords = ledger.loadAll();
    expect(filterPeekabooEvidenceRecords(allRecords, { runId: 'RUN_A' })).toHaveLength(2);
    expect(
      filterPeekabooEvidenceRecords(allRecords, { turnMarker: 'RUN_A_T02' })[0]?.recordId,
    ).toBe('record-a2');
    expect(
      filterPeekabooEvidenceRecords(allRecords, { taskId: 'discord-task-a1' })[0]?.recordId,
    ).toBe('record-a1');
    expect(
      filterPeekabooEvidenceRecords(allRecords, { correlationId: 'corr-b1' })[0]?.recordId,
    ).toBe('record-b1');
    expect(filterPeekabooEvidenceRecords(allRecords, { channelId: 'channel-1' })).toHaveLength(2);
    expect(filterPeekabooEvidenceRecords(allRecords, { phase: 'probe' })).toHaveLength(1);
    expect(filterPeekabooEvidenceRecords(allRecords, { runId: 'RUN_A', limit: 1 })).toEqual([
      expect.objectContaining({ recordId: 'record-a2' }),
    ]);
  });

  it('builds normalized digest records that preserve readiness split fields and correlation scoring', () => {
    const readiness = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'RUN_DIGEST_T01',
      expectedTaskId: 'discord-task-42',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      ack: {
        observedAt: '2026-04-27T00:20:02.000Z',
        taskId: 'discord-task-42',
        matchedOn: ['task-id', 'author'],
      },
      matchedReply: {
        observedAt: '2026-04-27T00:20:05.000Z',
        taskId: 'discord-task-42',
        marker: 'RUN_DIGEST_T01',
        matchedOn: ['marker', 'task-id'],
      },
    });

    const record = buildPeekabooEvidenceDigest({
      recordId: 'digest-1',
      recordedAt: '2026-04-27T00:20:06.000Z',
      runId: 'RUN_DIGEST',
      turnMarker: 'RUN_DIGEST_T01',
      correlationId: 'corr-digest-1',
      artifactPath: 'results/peekaboo-remote-evals/RUN_DIGEST.jsonl',
      channelId: 'channel-digest',
      mode: 'natural-ask',
      readinessReport: readiness,
      outcome: 'PASS',
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      recordId: 'digest-1',
      runId: 'RUN_DIGEST',
      turnMarker: 'RUN_DIGEST_T01',
      correlationId: 'corr-digest-1',
      artifactPath: 'results/peekaboo-remote-evals/RUN_DIGEST.jsonl',
      taskId: 'discord-task-42',
      phase: 'live',
      channelId: 'channel-digest',
      mode: 'natural-ask',
      readiness: {
        phase: 'live',
        proxyReady: true,
        probeProxyReady: false,
        liveProxyReady: true,
        submitReady: true,
        liveOk: true,
        matchedReplyObserved: true,
      },
      evidence: {
        taskCorrelation: {
          status: 'captured',
          correlationScore: 'strong',
        },
      },
      outcome: 'PASS',
    });
    expect(
      record.evidence.taskCorrelation.scoringFactors?.map((factor) => factor.signal),
    ).toEqual(['marker', 'task-id']);
    expect(record.readiness.summary).toContain('Live control reached');
  });
});
