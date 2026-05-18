import { describe, expect, it } from 'vitest';

import { projectResearchConstraintReportSnapshot } from '../../src/index.js';

describe('ResearchConstraintReportSnapshot', () => {
  it('projects a metadata-only constraint report without raw prompts or content', () => {
    const snapshot = projectResearchConstraintReportSnapshot({
      reportId: 'CR-20260518-a1',
      missionId: 'R-20260518-a1',
      lens: 'counterargument',
      falsifiableClaimRef: 'C-20260518-a1',
      hiddenAssumptionCount: 2,
      counterexampleCount: 1,
      nextVerificationTarget: {
        kind: 'claim',
        ref: 'C-20260518-a1',
      },
      reusableSkillCandidateStatus: 'candidate',
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      reportId: 'CR-20260518-a1',
      missionId: 'R-20260518-a1',
      lens: 'counterargument',
      falsifiableClaimRef: 'C-20260518-a1',
      hiddenAssumptionCount: 2,
      counterexampleCount: 1,
      nextVerificationTarget: {
        kind: 'claim',
        ref: 'C-20260518-a1',
      },
      reusableSkillCandidate: {
        status: 'candidate',
        promotionGate: 'operator-approval-required',
      },
      rawPromptRendered: false,
      rawResponseRendered: false,
      rawUserContentRendered: false,
    });
  });

  it('fails closed on invalid counters and empty refs', () => {
    expect(() =>
      projectResearchConstraintReportSnapshot({
        reportId: 'CR-1',
        missionId: 'R-1',
        lens: 'evidence',
        falsifiableClaimRef: '',
        hiddenAssumptionCount: 0,
        counterexampleCount: 0,
        nextVerificationTarget: { kind: 'mission', ref: 'R-1' },
      }),
    ).toThrow(/falsifiableClaimRef must be a non-empty string/);

    expect(() =>
      projectResearchConstraintReportSnapshot({
        reportId: 'CR-1',
        missionId: 'R-1',
        lens: 'evidence',
        falsifiableClaimRef: 'R-1',
        hiddenAssumptionCount: -1,
        counterexampleCount: 0,
        nextVerificationTarget: { kind: 'mission', ref: 'R-1' },
      }),
    ).toThrow(/hiddenAssumptionCount must be a non-negative safe integer/);
  });
});
