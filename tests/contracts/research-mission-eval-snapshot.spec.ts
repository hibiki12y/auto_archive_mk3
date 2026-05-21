import { describe, expect, it } from 'vitest';

import {
  RESEARCH_MISSION_EVAL_SNAPSHOT_SCHEMA_VERSION,
  projectResearchMissionEvalSnapshot,
} from '../../src/contracts/research-mission-eval-snapshot.js';

describe('projectResearchMissionEvalSnapshot', () => {
  it('projects closeout eval coverage without raw prompt, response, or evidence content', () => {
    const snapshot = projectResearchMissionEvalSnapshot({
      acceptanceChecks: [
        { state: 'complete' },
        { state: 'warning' },
        { state: 'pending' },
      ],
      claims: { uncertain: 2, challenged: 1 },
      proof: { pass: 1, warn: 1, fail: 0 },
      constraintReportCount: 3,
      constraintReportProvenance: 'mission-ledger',
      liveProofReportStatus: 'warn',
    });

    expect(snapshot).toEqual({
      schemaVersion: RESEARCH_MISSION_EVAL_SNAPSHOT_SCHEMA_VERSION,
      acceptanceCheckCoverage: {
        complete: 1,
        warning: 1,
        pending: 1,
        total: 3,
        coverage: 'partial',
      },
      unresolvedClaims: { uncertain: 2, challenged: 1, total: 3 },
      constraintReports: { count: 3, provenance: 'mission-ledger' },
      liveProofLinkage: {
        status: 'warn',
        missionProofPass: 1,
        missionProofWarn: 1,
        missionProofFail: 0,
        configuredReportStatus: 'warn',
      },
      rawPromptRendered: false,
      rawResponseRendered: false,
      rawEvidenceContentRendered: false,
    });
  });

  it('classifies complete acceptance coverage and rejects negative counts', () => {
    const snapshot = projectResearchMissionEvalSnapshot({
      acceptanceChecks: [{ state: 'complete' }],
      claims: { uncertain: 0, challenged: 0 },
      proof: { pass: 1, warn: 0 },
      liveProofReportStatus: 'complete',
    });

    expect(snapshot.acceptanceCheckCoverage.coverage).toBe('complete');
    expect(snapshot.constraintReports).toEqual({
      count: 0,
      provenance: 'unavailable',
    });
    expect(snapshot.liveProofLinkage.status).toBe('pass');

    expect(() =>
      projectResearchMissionEvalSnapshot({
        acceptanceChecks: [],
        claims: { uncertain: -1, challenged: 0 },
        proof: { pass: 0, warn: 0 },
      }),
    ).toThrow('claims.uncertain must be a non-negative safe integer.');
  });

  it('pins empty acceptance coverage and live-proof linkage status edges', () => {
    const unavailable = projectResearchMissionEvalSnapshot({
      acceptanceChecks: [],
      claims: { uncertain: 0, challenged: 0 },
      proof: { pass: 0, warn: 0, fail: 0 },
    });

    expect(unavailable.acceptanceCheckCoverage).toMatchObject({
      complete: 0,
      warning: 0,
      pending: 0,
      total: 0,
      coverage: 'none',
    });
    expect(unavailable.liveProofLinkage.status).toBe('unavailable');

    expect(
      projectResearchMissionEvalSnapshot({
        acceptanceChecks: [{ state: 'complete' }],
        claims: { uncertain: 0, challenged: 0 },
        proof: { pass: 0, warn: 0, fail: 1 },
        liveProofReportStatus: 'complete',
      }).liveProofLinkage.status,
    ).toBe('fail');
    expect(
      projectResearchMissionEvalSnapshot({
        acceptanceChecks: [{ state: 'complete' }],
        claims: { uncertain: 0, challenged: 0 },
        proof: { pass: 0, warn: 0, fail: 0 },
        liveProofReportStatus: 'no-proof',
      }).liveProofLinkage.status,
    ).toBe('warn');
  });
});
