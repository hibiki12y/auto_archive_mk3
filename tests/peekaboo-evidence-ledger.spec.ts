import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  InMemoryPeekabooEvidenceLedger,
  JsonlPeekabooEvidenceLedger,
  PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildPeekabooEvidenceDigest,
  buildPeekabooEvidenceReportFromCliOptions,
  buildPeekabooQuantitativeReport,
  buildPeekabooQuantitativeScorecard,
  buildPeekabooReadinessReport,
  filterPeekabooEvidenceRecords,
  parsePeekabooEvidenceReportCliArgs,
  runPeekabooEvidenceReportCli,
} from '../src/index.js';

function makeIo(): {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  stdoutText(): string;
  stderrText(): string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
      },
    },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

function buildLivePeekabooReadiness(turn: number) {
  const marker = `RUN_REPORT_T${String(turn).padStart(2, '0')}`;
  const taskId = `discord-task-report-${String(turn)}`;
  return buildPeekabooReadinessReport({
    phase: 'live',
    configOk: true,
    sshOk: true,
    bridgePresent: true,
    proxyReady: true,
    marker,
    expectedTaskId: taskId,
    submitAttempted: true,
    controlOk: true,
    restObservationAttempted: true,
    ack: {
      observedAt: `2026-05-05T00:0${String(turn)}:02.000Z`,
      taskId,
      matchedOn: ['task-id', 'author'],
    },
    matchedReply: {
      observedAt: `2026-05-05T00:0${String(turn)}:05.000Z`,
      taskId,
      marker,
      matchedOn: ['marker', 'task-id'],
    },
  });
}

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
      const replay = new JsonlPeekabooEvidenceLedger(filePath).loadWithAudit();
      expect(replay.records).toEqual([record]);
      expect(replay.replayAudit).toMatchObject({
        source: 'jsonl',
        totalLineCount: 2,
        parsedRecordCount: 1,
        skippedMalformedLineCount: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps loadAll uncapped and tolerant while auditing chunk-boundary replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-evidence-chunk-'));
    try {
      const filePath = join(dir, 'peekaboo-evidence.jsonl');
      const ledger = new JsonlPeekabooEvidenceLedger(filePath);
      const readiness = buildLivePeekabooReadiness(1);
      const record = ledger.append({
        runId: 'RUN_CHUNK',
        turnMarker: 'RUN_CHUNK_T01',
        correlationId: 'corr-chunk-secret',
        readiness,
        evidence: readiness.evidence,
        outcome: 'PASS',
        notes: 'x'.repeat(70 * 1024),
      });
      writeFileSync(
        filePath,
        `${readFileSync(filePath, 'utf8').replace(/\n/gu, '\r\n')}{"schemaVersion":1,"recordId":"torn"`,
        'utf8',
      );

      const replay = new JsonlPeekabooEvidenceLedger(filePath).loadWithAudit({
        maxBytes: Buffer.byteLength(readFileSync(filePath, 'utf8')) + 1,
      });

      expect(new JsonlPeekabooEvidenceLedger(filePath).loadAll()).toEqual([
        record,
      ]);
      expect(replay.records).toEqual([record]);
      expect(replay.replayAudit).toMatchObject({
        totalLineCount: 2,
        parsedRecordCount: 1,
        skippedMalformedLineCount: 1,
      });
      expect(() =>
        new JsonlPeekabooEvidenceLedger(filePath).loadWithAudit({ maxBytes: 1 }),
      ).toThrow('Peekaboo evidence ledger exceeds maxBytes');
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

  it('builds a quantitative scorecard and baseline-vs-candidate improvement report', () => {
    const ledger = new InMemoryPeekabooEvidenceLedger();
    const baselineStrong = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'BASE_T01',
      expectedTaskId: 'discord-task-base-1',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-05-04T00:00:05.000Z',
        taskId: 'discord-task-base-1',
        marker: 'BASE_T01',
        matchedOn: ['marker', 'task-id'],
      },
    });
    const baselineWeak = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'BASE_T02',
      expectedTaskId: 'discord-task-base-2',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      relatedReplyCount: 1,
    });
    const candidateOne = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'CAND_T01',
      expectedTaskId: 'discord-task-cand-1',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-05-04T00:10:05.000Z',
        taskId: 'discord-task-cand-1',
        marker: 'CAND_T01',
        matchedOn: ['marker', 'task-id'],
      },
    });
    const candidateTwo = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'CAND_T02',
      expectedTaskId: 'discord-task-cand-2',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-05-04T00:11:05.000Z',
        taskId: 'discord-task-cand-2',
        marker: 'CAND_T02',
        matchedOn: ['marker', 'task-id'],
      },
    });

    for (const input of [
      {
        runId: 'BASE',
        marker: 'BASE_T01',
        readiness: baselineStrong,
        outcome: 'PASS',
      },
      {
        runId: 'BASE',
        marker: 'BASE_T02',
        readiness: baselineWeak,
        outcome: 'FAIL',
      },
      {
        runId: 'CAND',
        marker: 'CAND_T01',
        readiness: candidateOne,
        outcome: 'PASS',
      },
      {
        runId: 'CAND',
        marker: 'CAND_T02',
        readiness: candidateTwo,
        outcome: 'PASS',
      },
    ] as const) {
      ledger.append({
        runId: input.runId,
        turnMarker: input.marker,
        correlationId: `${input.runId}:${input.marker}`,
        readiness: input.readiness,
        evidence: input.readiness.evidence,
        outcome: input.outcome,
      });
    }

    const candidateScorecard = buildPeekabooQuantitativeScorecard(
      filterPeekabooEvidenceRecords(ledger.loadAll(), { runId: 'CAND' }),
    );
    expect(candidateScorecard.recordCount).toBe(2);
    expect(candidateScorecard.qualityScore.value).toBe(100);
    expect(candidateScorecard.evidence.strongCorrelation.rate).toBe(1);
    expect(candidateScorecard.confidence).toMatchObject({
      liveSampleSize: 2,
      minimumRecommendedLiveRecords: 5,
      sufficientForPromotion: false,
    });
    expect(
      candidateScorecard.qualityScore.components.map((component) => component.id),
    ).toContain('live-pass-outcome-rate');

    const report = buildPeekabooQuantitativeReport({
      records: ledger.loadAll(),
      baselineRunId: 'BASE',
      candidateRunId: 'CAND',
      generatedAt: '2026-05-04T00:12:00.000Z',
    });

    expect(report.method.primaryMetric).toContain('qualityScore');
    expect(report.method.scoringRubricVersion).toBe(
      '2026-05-04.initial-live-evidence-v1',
    );
    expect(report.comparison?.deltas.qualityScore).toBeGreaterThan(0);
    expect(report.comparison?.interpretation).toBe(
      'insufficient-live-sample-for-promotion',
    );
    expect(report.comparison?.promotionGate).toMatchObject({
      baselineSufficientForPromotion: false,
      candidateSufficientForPromotion: false,
      qualityDeltaMeetsThreshold: true,
      readinessGuardrailsPassed: true,
      eligibleForPromotion: false,
    });
    expect(report.comparison?.candidate.qualityScore.rubricVersion).toBe(
      '2026-05-04.initial-live-evidence-v1',
    );
    expect(report.comparison?.candidate.qualityScore.value).toBeGreaterThan(
      report.comparison?.baseline.qualityScore.value ?? 0,
    );
  });

  it('promotes only when baseline and candidate have sufficient live samples', () => {
    const ledger = new InMemoryPeekabooEvidenceLedger();
    const appendLiveTurn = (
      runId: string,
      turn: number,
      matched: boolean,
      outcome: string,
    ): void => {
      const marker = `${runId}_T${String(turn).padStart(2, '0')}`;
      const taskId = `discord-task-${runId.toLowerCase()}-${turn}`;
      const readiness = buildPeekabooReadinessReport({
        phase: 'live',
        configOk: true,
        sshOk: true,
        bridgePresent: true,
        proxyReady: true,
        marker,
        expectedTaskId: taskId,
        submitAttempted: true,
        controlOk: true,
        restObservationAttempted: true,
        ...(matched
          ? {
              matchedReply: {
                observedAt: `2026-05-04T00:${String(30 + turn).padStart(
                  2,
                  '0',
                )}:05.000Z`,
                taskId,
                marker,
                matchedOn: ['marker', 'task-id'] as const,
              },
            }
          : { relatedReplyCount: 1 }),
      });
      ledger.append({
        runId,
        turnMarker: marker,
        correlationId: `${runId}:${marker}`,
        readiness,
        evidence: readiness.evidence,
        outcome,
      });
    };

    for (let turn = 1; turn <= 5; turn += 1) {
      appendLiveTurn('BASE_OK', turn, turn === 1, turn === 1 ? 'PASS' : 'FAIL');
      appendLiveTurn('CAND_OK', turn, true, 'PASS');
    }

    const report = buildPeekabooQuantitativeReport({
      records: ledger.loadAll(),
      baselineRunId: 'BASE_OK',
      candidateRunId: 'CAND_OK',
    });

    expect(report.comparison?.baseline.confidence.sufficientForPromotion).toBe(
      true,
    );
    expect(report.comparison?.candidate.confidence.sufficientForPromotion).toBe(
      true,
    );
    expect(report.comparison?.promotionGate).toMatchObject({
      baselineSufficientForPromotion: true,
      candidateSufficientForPromotion: true,
      qualityDeltaMeetsThreshold: true,
      readinessGuardrailsPassed: true,
      eligibleForPromotion: true,
    });
    expect(report.comparison?.interpretation).toBe(
      'candidate-improved-without-readiness-regression',
    );
  });

  it('marks empty quantitative scorecards as insufficient without NaN values', () => {
    const scorecard = buildPeekabooQuantitativeScorecard([]);

    expect(scorecard.recordCount).toBe(0);
    expect(scorecard.confidence).toMatchObject({
      liveSampleSize: 0,
      minimumRecommendedLiveRecords: 5,
      sufficientForPromotion: false,
    });
    expect(scorecard.evidence.observationSourceCounts).toEqual({
      submit: {},
      taskCorrelation: {},
      ack: {},
      matchedReply: {},
    });
    expect(scorecard.qualityScore.value).toBe(0);
    expect(scorecard.qualityScore.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'live-pass-outcome-rate', rate: 0 }),
      ]),
    );
    expect(
      scorecard.qualityScore.components.every((component) =>
        Number.isFinite(component.contribution),
      ),
    ).toBe(true);
    expect(scorecard.recommendations.join('\n')).toContain(
      'Collect at least 5 bounded live Peekaboo turns',
    );
  });

  it('aggregates observation sources per evidence dimension and ignores non-captured fields', () => {
    const ledger = new InMemoryPeekabooEvidenceLedger();
    const live = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'SRC_T01',
      expectedTaskId: 'discord-task-src-1',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-05-04T00:21:00.000Z',
        taskId: 'discord-task-src-1',
        marker: 'SRC_T01',
        matchedOn: ['marker', 'task-id'],
      },
    });

    ledger.append({
      runId: 'SRC',
      turnMarker: 'SRC_T01',
      correlationId: 'src-1',
      readiness: live,
      evidence: {
        ...live.evidence,
        submit: { ...live.evidence.submit, status: 'captured', source: 'image' },
        taskCorrelation: { ...live.evidence.taskCorrelation, source: 'image' },
        ack: { ...live.evidence.ack, source: 'image' },
        matchedReply: { ...live.evidence.matchedReply, source: 'rest' },
      },
      outcome: 'PASS',
    });
    ledger.append({
      runId: 'SRC',
      turnMarker: 'SRC_T02',
      correlationId: 'src-2',
      readiness: live,
      evidence: {
        ...live.evidence,
        submit: { ...live.evidence.submit, status: 'captured', source: 'image' },
        taskCorrelation: { ...live.evidence.taskCorrelation, source: 'rest' },
        ack: { ...live.evidence.ack, status: 'missing' },
        matchedReply: { ...live.evidence.matchedReply, source: 'rest' },
      },
      outcome: 'PASS',
    });

    const scorecard = buildPeekabooQuantitativeScorecard(ledger.loadAll());
    expect(scorecard.evidence.observationSourceCounts).toEqual({
      submit: { image: 2 },
      taskCorrelation: { image: 1, rest: 1 },
      ack: { image: 1 },
      matchedReply: { rest: 2 },
    });
  });

  it('scores live PASS outcomes against live records instead of diluting with probe rows', () => {
    const ledger = new InMemoryPeekabooEvidenceLedger();
    const live = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'MIXED_T01',
      expectedTaskId: 'discord-task-mixed-1',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReply: {
        observedAt: '2026-05-04T00:20:05.000Z',
        taskId: 'discord-task-mixed-1',
        marker: 'MIXED_T01',
        matchedOn: ['marker', 'task-id'],
      },
    });
    const probe = buildPeekabooReadinessReport({
      phase: 'probe',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      probeProxyReady: true,
      marker: 'MIXED_PROBE',
      expectedTaskId: 'discord-task-mixed-probe',
    });

    ledger.append({
      runId: 'MIXED',
      turnMarker: 'MIXED_T01',
      correlationId: 'mixed-live',
      readiness: live,
      evidence: live.evidence,
      outcome: 'PASS',
    });
    ledger.append({
      runId: 'MIXED',
      turnMarker: 'MIXED_PROBE',
      correlationId: 'mixed-probe',
      readiness: probe,
      evidence: probe.evidence,
    });

    const scorecard = buildPeekabooQuantitativeScorecard(ledger.loadAll());
    const livePassComponent = scorecard.qualityScore.components.find(
      (component) => component.id === 'live-pass-outcome-rate',
    );

    expect(scorecard.recordCount).toBe(2);
    expect(scorecard.phaseCounts.probe).toBe(1);
    expect(scorecard.confidence.liveSampleSize).toBe(1);
    expect(livePassComponent).toMatchObject({
      rate: 1,
      contribution: 15,
    });
    expect(scorecard.qualityScore.value).toBe(100);
  });

  it('runs a bounded read-only Peekaboo evidence report CLI over JSONL evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-evidence-report-'));
    try {
      const filePath = join(dir, 'peekaboo-evidence.jsonl');
      const ledger = new JsonlPeekabooEvidenceLedger(filePath);
      for (let turn = 1; turn <= 5; turn += 1) {
        const readiness = buildLivePeekabooReadiness(turn);
        ledger.append({
          runId: 'RUN_REPORT',
          turnMarker: `RUN_REPORT_T${String(turn).padStart(2, '0')}`,
          correlationId: `corr-secret-${String(turn)}`,
          channelId: 'channel-report',
          readiness,
          evidence: readiness.evidence,
          outcome: 'PASS',
          notes: 'SECRET_NOT_RENDERED_BY_REPORT',
        });
      }
      writeFileSync(
        filePath,
        `${readFileSync(filePath, 'utf8')}{"schemaVersion":1,"recordId":"torn"`,
        'utf8',
      );

      const io = makeIo();
      const exitCode = runPeekabooEvidenceReportCli(
        [
          '--ledger',
          filePath,
          '--run-id',
          'RUN_REPORT',
          '--generated-at',
          '2026-05-05T01:00:00.000Z',
          '--pretty',
        ],
        io,
      );
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly replayAudit: {
          readonly skippedMalformedLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly qualityScore: { readonly value: number };
          readonly confidence: { readonly sufficientForPromotion: boolean };
        };
      };

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      expect(report.generatedAt).toBe('2026-05-05T01:00:00.000Z');
      expect(report.replayAudit.skippedMalformedLineCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(5);
      expect(report.scorecard.qualityScore.value).toBe(100);
      expect(report.scorecard.confidence.sufficientForPromotion).toBe(true);
      expect(io.stdoutText()).not.toContain('SECRET_NOT_RENDERED_BY_REPORT');
      expect(io.stdoutText()).not.toContain('corr-secret-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints a compact non-promoting dry-run evidence JSONL template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-evidence-template-'));
    try {
      const io = makeIo();

      const exitCode = runPeekabooEvidenceReportCli(
        ['--print-template', '--generated-at', '2026-05-05T12:10:00.000Z'],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      expect(io.stdoutText().endsWith('\n')).toBe(true);
      const lines = io.stdoutText().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('');
      expect(lines[0]).toBe(JSON.stringify(JSON.parse(lines[0])));
      const template = JSON.parse(lines[0]) as {
        readonly recordId: string;
        readonly recordedAt: string;
        readonly runId: string;
        readonly turnMarker: string;
        readonly correlationId: string;
        readonly taskId?: string;
        readonly phase?: string;
        readonly readiness: {
          readonly phase: string;
          readonly liveOk: boolean;
          readonly liveSubmitPerformed: boolean;
          readonly matchedReplyObserved: boolean;
        };
        readonly evidence: {
          readonly taskCorrelation: { readonly status: string };
          readonly ack: { readonly status: string };
          readonly matchedReply: { readonly status: string };
        };
        readonly outcome?: string;
      };
      expect(template.recordId).toBe('template-peekaboo-evidence');
      expect(template.recordedAt).toBe('2026-05-05T12:10:00.000Z');
      expect(template.runId).toBe('template-run-redacted');
      expect(template.turnMarker).toBe('template-turn-redacted');
      expect(template.correlationId).toBe('template-correlation-redacted');
      expect(template.taskId).toBe('template-task-redacted');
      expect(template.phase).toBe('dry-run');
      expect(template.readiness).toMatchObject({
        phase: 'dry-run',
        liveOk: false,
        liveSubmitPerformed: false,
        matchedReplyObserved: false,
      });
      expect(template.evidence.taskCorrelation.status).not.toBe('captured');
      expect(template.evidence.ack.status).not.toBe('captured');
      expect(template.evidence.matchedReply.status).not.toBe('captured');
      expect(template.outcome).toBe('WARN_TEMPLATE');
      expect(lines[0]).not.toContain('Discord message content');
      expect(lines[0]).not.toContain('prompt text');
      expect(lines[0]).not.toContain('response text');
      expect(lines[0]).not.toContain('SECRET');

      const secondIo = makeIo();
      const secondExitCode = runPeekabooEvidenceReportCli(
        ['--print-template', '--generated-at', '2026-05-05T12:10:00.000Z'],
        secondIo,
      );
      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());

      const ledgerPath = join(dir, 'peekaboo-evidence.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runPeekabooEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T12:11:00.000Z',
          '--pretty',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly generatedAt: string;
        readonly replayAudit: {
          readonly parsedRecordCount: number;
          readonly skippedMalformedLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly phaseCounts: Record<string, number>;
          readonly outcomeCounts: Record<string, number>;
          readonly confidence: {
            readonly liveSampleSize: number;
            readonly sufficientForPromotion: boolean;
          };
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T12:11:00.000Z');
      expect(report.replayAudit.parsedRecordCount).toBe(1);
      expect(report.replayAudit.skippedMalformedLineCount).toBe(0);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.phaseCounts['dry-run']).toBe(1);
      expect(report.scorecard.outcomeCounts.warn).toBe(1);
      expect(report.scorecard.confidence).toMatchObject({
        liveSampleSize: 0,
        sufficientForPromotion: false,
      });
      expect(report.scorecard.qualityScore.value).toBe(0);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'at least 5',
      );
      expect(reportIo.stdoutText()).not.toContain('template-correlation-redacted');
      expect(reportIo.stdoutText()).not.toContain('template-task-redacted');
      expect(reportIo.stdoutText()).not.toContain('Discord message content');
      expect(reportIo.stdoutText()).not.toContain('prompt text');
      expect(reportIo.stdoutText()).not.toContain('response text');

      const repeatedLedgerPath = join(dir, 'peekaboo-repeated-template.jsonl');
      writeFileSync(repeatedLedgerPath, io.stdoutText().repeat(5), 'utf8');
      const repeatedReportIo = makeIo();

      const repeatedReportExitCode = runPeekabooEvidenceReportCli(
        ['--ledger', repeatedLedgerPath],
        repeatedReportIo,
      );

      expect(repeatedReportExitCode).toBe(0);
      expect(repeatedReportIo.stderrText()).toBe('');
      const repeatedReport = JSON.parse(repeatedReportIo.stdoutText()) as {
        readonly scorecard: {
          readonly recordCount: number;
          readonly phaseCounts: Record<string, number>;
          readonly confidence: {
            readonly liveSampleSize: number;
            readonly sufficientForPromotion: boolean;
          };
        };
      };
      expect(repeatedReport.scorecard.recordCount).toBe(5);
      expect(repeatedReport.scorecard.phaseCounts['dry-run']).toBe(5);
      expect(repeatedReport.scorecard.confidence).toMatchObject({
        liveSampleSize: 0,
        sufficientForPromotion: false,
      });

      const mixedLedger = new JsonlPeekabooEvidenceLedger(repeatedLedgerPath);
      const liveReadiness = buildLivePeekabooReadiness(1);
      mixedLedger.append({
        runId: 'RUN_REAL',
        turnMarker: 'RUN_REAL_T01',
        correlationId: 'corr-real-mixed',
        channelId: 'channel-real',
        readiness: liveReadiness,
        evidence: liveReadiness.evidence,
        outcome: 'PASS',
      });
      const mixedReportIo = makeIo();

      const mixedReportExitCode = runPeekabooEvidenceReportCli(
        ['--ledger', repeatedLedgerPath],
        mixedReportIo,
      );

      expect(mixedReportExitCode).toBe(0);
      expect(mixedReportIo.stderrText()).toBe('');
      const mixedReport = JSON.parse(mixedReportIo.stdoutText()) as {
        readonly scorecard: {
          readonly recordCount: number;
          readonly phaseCounts: Record<string, number>;
          readonly confidence: {
            readonly liveSampleSize: number;
            readonly sufficientForPromotion: boolean;
          };
          readonly qualityScore: { readonly value: number };
        };
      };
      expect(mixedReport.scorecard.recordCount).toBe(6);
      expect(mixedReport.scorecard.phaseCounts['dry-run']).toBe(5);
      expect(mixedReport.scorecard.phaseCounts.live).toBe(1);
      expect(mixedReport.scorecard.confidence).toMatchObject({
        liveSampleSize: 1,
        sufficientForPromotion: false,
      });
      expect(mixedReport.scorecard.qualityScore.value).toBe(100);
      expect(mixedReportIo.stdoutText()).not.toContain('corr-real-mixed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for Peekaboo evidence CLI argument and byte-guard errors', () => {
    const parsed = parsePeekabooEvidenceReportCliArgs([
      '--ledger',
      'peekaboo-evidence.jsonl',
    ]);

    expect(parsed).toMatchObject({
      ledgerPath: 'peekaboo-evidence.jsonl',
      maxLedgerBytes: PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      filter: {},
      printTemplate: false,
    });
    expect(parsePeekabooEvidenceReportCliArgs(['--print-template'])).toEqual({
      filter: {},
      maxLedgerBytes: PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      pretty: false,
      printTemplate: true,
    });

    expect(() =>
      parsePeekabooEvidenceReportCliArgs([
        '--ledger',
        'peekaboo-evidence.jsonl',
        '--phase',
        'invalid',
      ]),
    ).toThrow('--phase must be one of: dry-run, probe, live.');
    expect(() =>
      parsePeekabooEvidenceReportCliArgs([
        '--ledger',
        'peekaboo-evidence.jsonl',
        '--baseline-run-id',
        'BASE',
      ]),
    ).toThrow(
      '--baseline-run-id and --candidate-run-id must be provided together.',
    );
    expect(() =>
      parsePeekabooEvidenceReportCliArgs([
        '--ledger',
        'peekaboo-evidence.jsonl',
        '--generated-at',
        'not-an-instant',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    for (const invalidGeneratedAt of [
      '2026-05-05T12:10:00.000+09:00',
      '2026-05-05T12:10:00',
      '2026-05-05',
    ]) {
      expect(() =>
        parsePeekabooEvidenceReportCliArgs([
          '--print-template',
          '--generated-at',
          invalidGeneratedAt,
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    }
    expect(() =>
      parsePeekabooEvidenceReportCliArgs([
        '--print-template',
        '--ledger',
        'peekaboo-evidence.jsonl',
      ]),
    ).toThrow('--print-template cannot be combined with --ledger');
    for (const reportOnlyArgs of [
      ['--run-id', 'RUN'],
      ['--turn-marker', 'RUN_T01'],
      ['--task-id', 'task-1'],
      ['--correlation-id', 'corr-1'],
      ['--channel-id', 'channel-1'],
      ['--phase', 'probe'],
      ['--limit', '1'],
      ['--baseline-run-id', 'BASE'],
      ['--candidate-run-id', 'CAND'],
      ['--max-ledger-bytes', '100'],
      ['--pretty'],
    ] as const) {
      expect(() =>
        parsePeekabooEvidenceReportCliArgs([
          '--print-template',
          ...reportOnlyArgs,
        ]),
      ).toThrow(
        new RegExp(
          `--print-template cannot be combined with report-only options: ${reportOnlyArgs[0]}`,
        ),
      );
    }
    expect(() =>
      buildPeekabooEvidenceReportFromCliOptions({
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(
      /Cannot build a Peekaboo evidence report from --print-template options/,
    );

    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-evidence-byte-guard-'));
    try {
      const filePath = join(dir, 'peekaboo-evidence.jsonl');
      const ledger = new JsonlPeekabooEvidenceLedger(filePath);
      const readiness = buildLivePeekabooReadiness(1);
      ledger.append({
        runId: 'RUN_BYTES',
        turnMarker: 'RUN_BYTES_T01',
        correlationId: 'corr-bytes',
        readiness,
        evidence: readiness.evidence,
      });

      const io = makeIo();
      const exitCode = runPeekabooEvidenceReportCli(
        ['--ledger', filePath, '--max-ledger-bytes', '1'],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stderrText()).toContain('peekaboo:evidence:report failed');
      expect(io.stderrText()).toContain('exceeds maxBytes');
      expect(io.stderrText()).not.toContain('corr-bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
