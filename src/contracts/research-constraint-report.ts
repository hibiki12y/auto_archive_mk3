export const RESEARCH_CONSTRAINT_REPORT_SCHEMA_VERSION = 1;

export type ResearchConstraintReportLens =
  | 'methodology'
  | 'evidence'
  | 'counterargument'
  | 'reproducibility';

export type ResearchConstraintReportVerificationTargetKind =
  | 'mission'
  | 'claim'
  | 'evidence'
  | 'synthesis'
  | 'proof';

export type ResearchConstraintReportReusableSkillCandidateStatus =
  | 'not-evaluated'
  | 'candidate'
  | 'rejected';

export interface ResearchConstraintReportSnapshot {
  readonly schemaVersion: typeof RESEARCH_CONSTRAINT_REPORT_SCHEMA_VERSION;
  readonly reportId: string;
  readonly missionId: string;
  readonly lens: ResearchConstraintReportLens;
  readonly falsifiableClaimRef: string;
  readonly hiddenAssumptionCount: number;
  readonly counterexampleCount: number;
  readonly nextVerificationTarget: {
    readonly kind: ResearchConstraintReportVerificationTargetKind;
    readonly ref: string;
  };
  readonly reusableSkillCandidate: {
    readonly status: ResearchConstraintReportReusableSkillCandidateStatus;
    readonly promotionGate: 'operator-approval-required';
  };
  readonly rawPromptRendered: false;
  readonly rawResponseRendered: false;
  readonly rawUserContentRendered: false;
}

export interface ProjectResearchConstraintReportSnapshotInput {
  readonly reportId: string;
  readonly missionId: string;
  readonly lens: ResearchConstraintReportLens;
  readonly falsifiableClaimRef: string;
  readonly hiddenAssumptionCount: number;
  readonly counterexampleCount: number;
  readonly nextVerificationTarget: {
    readonly kind: ResearchConstraintReportVerificationTargetKind;
    readonly ref: string;
  };
  readonly reusableSkillCandidateStatus?: ResearchConstraintReportReusableSkillCandidateStatus;
}

export function projectResearchConstraintReportSnapshot(
  input: ProjectResearchConstraintReportSnapshotInput,
): ResearchConstraintReportSnapshot {
  return Object.freeze({
    schemaVersion: RESEARCH_CONSTRAINT_REPORT_SCHEMA_VERSION,
    reportId: requireNonEmptyString(input.reportId, 'reportId'),
    missionId: requireNonEmptyString(input.missionId, 'missionId'),
    lens: input.lens,
    falsifiableClaimRef: requireNonEmptyString(
      input.falsifiableClaimRef,
      'falsifiableClaimRef',
    ),
    hiddenAssumptionCount: requireNonNegativeInteger(
      input.hiddenAssumptionCount,
      'hiddenAssumptionCount',
    ),
    counterexampleCount: requireNonNegativeInteger(
      input.counterexampleCount,
      'counterexampleCount',
    ),
    nextVerificationTarget: Object.freeze({
      kind: input.nextVerificationTarget.kind,
      ref: requireNonEmptyString(input.nextVerificationTarget.ref, 'nextVerificationTarget.ref'),
    }),
    reusableSkillCandidate: Object.freeze({
      status: input.reusableSkillCandidateStatus ?? 'not-evaluated',
      promotionGate: 'operator-approval-required',
    }),
    rawPromptRendered: false,
    rawResponseRendered: false,
    rawUserContentRendered: false,
  });
}

function requireNonEmptyString(value: string, field: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}
