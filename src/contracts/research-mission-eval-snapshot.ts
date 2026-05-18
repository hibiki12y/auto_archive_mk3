export const RESEARCH_MISSION_EVAL_SNAPSHOT_SCHEMA_VERSION = 1;

export type ResearchMissionAcceptanceCoverage = 'complete' | 'partial' | 'none';
export type ResearchMissionConstraintReportProvenance =
  | 'mission-ledger'
  | 'unavailable';
export type ResearchMissionLiveProofLinkageStatus =
  | 'pass'
  | 'warn'
  | 'fail'
  | 'unavailable';

export interface ResearchMissionEvalSnapshot {
  readonly schemaVersion: typeof RESEARCH_MISSION_EVAL_SNAPSHOT_SCHEMA_VERSION;
  readonly acceptanceCheckCoverage: {
    readonly complete: number;
    readonly warning: number;
    readonly pending: number;
    readonly total: number;
    readonly coverage: ResearchMissionAcceptanceCoverage;
  };
  readonly unresolvedClaims: {
    readonly uncertain: number;
    readonly challenged: number;
    readonly total: number;
  };
  readonly constraintReports: {
    /**
     * `provenance='unavailable'` means the constraint-report lane has not been
     * evaluated or wired for this mission yet; it is distinct from a
     * mission-ledger-backed count of zero.
     */
    readonly count: number;
    readonly provenance: ResearchMissionConstraintReportProvenance;
  };
  readonly liveProofLinkage: {
    readonly status: ResearchMissionLiveProofLinkageStatus;
    readonly missionProofPass: number;
    readonly missionProofWarn: number;
    readonly missionProofFail: number;
    readonly configuredReportStatus?: string;
  };
  readonly rawPromptRendered: false;
  readonly rawResponseRendered: false;
  readonly rawEvidenceContentRendered: false;
}

export interface ProjectResearchMissionEvalSnapshotInput {
  readonly acceptanceChecks: readonly {
    readonly state: 'complete' | 'warning' | 'pending';
  }[];
  readonly claims: {
    readonly uncertain: number;
    readonly challenged: number;
  };
  readonly proof: {
    readonly pass: number;
    readonly warn: number;
    readonly fail?: number;
  };
  readonly constraintReportCount?: number;
  readonly constraintReportProvenance?: ResearchMissionConstraintReportProvenance;
  readonly liveProofReportStatus?: string;
}

export function projectResearchMissionEvalSnapshot(
  input: ProjectResearchMissionEvalSnapshotInput,
): ResearchMissionEvalSnapshot {
  const complete = input.acceptanceChecks.filter(
    (check) => check.state === 'complete',
  ).length;
  const warning = input.acceptanceChecks.filter(
    (check) => check.state === 'warning',
  ).length;
  const pending = input.acceptanceChecks.filter(
    (check) => check.state === 'pending',
  ).length;
  const total = input.acceptanceChecks.length;
  const uncertain = requireNonNegativeInteger(
    input.claims.uncertain,
    'claims.uncertain',
  );
  const challenged = requireNonNegativeInteger(
    input.claims.challenged,
    'claims.challenged',
  );
  const missionProofPass = requireNonNegativeInteger(input.proof.pass, 'proof.pass');
  const missionProofWarn = requireNonNegativeInteger(input.proof.warn, 'proof.warn');
  const missionProofFail = requireNonNegativeInteger(
    input.proof.fail ?? 0,
    'proof.fail',
  );
  const constraintReportCount = requireNonNegativeInteger(
    input.constraintReportCount ?? 0,
    'constraintReportCount',
  );

  return Object.freeze({
    schemaVersion: RESEARCH_MISSION_EVAL_SNAPSHOT_SCHEMA_VERSION,
    acceptanceCheckCoverage: Object.freeze({
      complete,
      warning,
      pending,
      total,
      coverage: classifyAcceptanceCoverage({ complete, total, warning, pending }),
    }),
    unresolvedClaims: Object.freeze({
      uncertain,
      challenged,
      total: uncertain + challenged,
    }),
    constraintReports: Object.freeze({
      count: constraintReportCount,
      provenance: input.constraintReportProvenance ?? 'unavailable',
    }),
    liveProofLinkage: Object.freeze({
      status: classifyLiveProofLinkage({
        missionProofPass,
        missionProofWarn,
        missionProofFail,
        configuredReportStatus: input.liveProofReportStatus,
      }),
      missionProofPass,
      missionProofWarn,
      missionProofFail,
      ...(input.liveProofReportStatus === undefined
        ? {}
        : { configuredReportStatus: input.liveProofReportStatus }),
    }),
    rawPromptRendered: false,
    rawResponseRendered: false,
    rawEvidenceContentRendered: false,
  });
}

function classifyAcceptanceCoverage(input: {
  readonly complete: number;
  readonly total: number;
  readonly warning: number;
  readonly pending: number;
}): ResearchMissionAcceptanceCoverage {
  if (input.total === 0) return 'none';
  if (input.complete === input.total && input.warning === 0 && input.pending === 0) {
    return 'complete';
  }
  return 'partial';
}

function classifyLiveProofLinkage(input: {
  readonly missionProofPass: number;
  readonly missionProofWarn: number;
  readonly missionProofFail: number;
  readonly configuredReportStatus?: string;
}): ResearchMissionLiveProofLinkageStatus {
  if (input.missionProofFail > 0 || input.configuredReportStatus === 'fail') {
    return 'fail';
  }
  if (
    input.missionProofWarn > 0 ||
    input.configuredReportStatus === 'warn' ||
    input.configuredReportStatus === 'no-proof'
  ) {
    return 'warn';
  }
  if (input.missionProofPass > 0 || input.configuredReportStatus === 'complete') {
    return 'pass';
  }
  return 'unavailable';
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}
