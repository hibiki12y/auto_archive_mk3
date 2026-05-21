import { randomUUID } from 'node:crypto';

import type {
  ControlPlaneEvent,
  ControlPlaneLedgerPort,
} from '../control/control-plane-ledger.js';
import type {
  RenderResearchMissionSummaryInput,
  ResearchMissionPlanStepState,
} from './discord-result-renderer.js';
import {
  projectResearchConstraintReportSnapshot,
  type ResearchConstraintReportLens,
  type ResearchConstraintReportSnapshot,
  type ResearchConstraintReportVerificationTargetKind,
} from '../contracts/research-constraint-report.js';

export type ResearchMissionStatus =
  | 'draft'
  | 'approved'
  | 'running'
  | 'blocked'
  | 'synthesizing'
  | 'completed'
  | 'archived';

export interface ResearchMissionPlanDraftStep {
  readonly label: string;
  readonly state: ResearchMissionPlanStepState;
}

export interface ResearchMissionClaimSummary {
  readonly supported: number;
  readonly uncertain: number;
  readonly challenged: number;
}

export interface ResearchMissionProofSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail?: number;
}

export type ResearchMissionProofLinkStatus = 'pass' | 'warn' | 'fail';

export interface ResearchMissionProofLink {
  readonly proofId: string;
  readonly missionId: string;
  readonly surface: string;
  readonly status: ResearchMissionProofLinkStatus;
  readonly artifactTokens: readonly string[];
  readonly summary: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ResearchEvidenceItem {
  readonly evidenceId: string;
  readonly missionId: string;
  readonly summary: string;
  readonly source: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type ResearchClaimStatus = 'uncertain' | 'supported' | 'challenged';

export interface ResearchClaimRecord {
  readonly claimId: string;
  readonly missionId: string;
  readonly text: string;
  readonly status: ResearchClaimStatus;
  readonly supportEvidenceIds: readonly string[];
  readonly challengeEvidenceIds: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchSynthesisEvidenceDigest {
  readonly evidenceId: string;
  readonly summary: string;
  readonly source: string;
}

export interface ResearchSynthesisClaimDigest {
  readonly claimId: string;
  readonly text: string;
  readonly status: ResearchClaimStatus;
  readonly supportEvidenceIds: readonly string[];
  readonly challengeEvidenceIds: readonly string[];
}

export interface ResearchSynthesisRecord {
  readonly synthesisId: string;
  readonly missionId: string;
  readonly body: string;
  readonly evidence: readonly ResearchSynthesisEvidenceDigest[];
  readonly claims: readonly ResearchSynthesisClaimDigest[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ResearchConstraintReportRecord
  extends ResearchConstraintReportSnapshot {
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ResearchMissionRecord {
  readonly missionId: string;
  readonly title: string;
  readonly goal: string;
  readonly ownerId: string;
  readonly discordChannelId: string;
  readonly discordThreadId?: string;
  readonly status: ResearchMissionStatus;
  readonly phase: string;
  readonly planId?: string;
  readonly planDraft: readonly ResearchMissionPlanDraftStep[];
  readonly evidenceItemCount: number;
  readonly claims: ResearchMissionClaimSummary;
  readonly proof: ResearchMissionProofSummary;
  readonly proofLinks: readonly ResearchMissionProofLink[];
  readonly constraintReportCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedAt?: string;
  readonly latestSynthesisId?: string;
}

export interface CreateResearchMissionDraftInput {
  readonly goal: string;
  readonly title?: string;
  readonly ownerId: string;
  readonly discordChannelId: string;
  readonly discordThreadId?: string;
  readonly planDraft?: readonly ResearchMissionPlanDraftStep[];
}

export interface DiscordResearchMissionStoreOptions {
  readonly ledger?: ControlPlaneLedgerPort;
  readonly replayLedger?: boolean;
  readonly idFactory?: () => string;
  readonly now?: () => string;
}

export interface ListResearchMissionsOptions {
  readonly ownerId?: string;
  readonly discordChannelId?: string;
  readonly status?: ResearchMissionStatus | 'all';
  readonly limit?: number;
}

export interface AddResearchEvidenceInput {
  readonly missionId: string;
  readonly summary: string;
  readonly source?: string;
  readonly actorId: string;
}

export interface AddResearchEvidenceResult {
  readonly mission: ResearchMissionRecord;
  readonly evidence: ResearchEvidenceItem;
}

export interface AddResearchClaimInput {
  readonly missionId: string;
  readonly text: string;
  readonly actorId: string;
}

export interface AddResearchClaimResult {
  readonly mission: ResearchMissionRecord;
  readonly claim: ResearchClaimRecord;
}

export interface GenerateResearchSynthesisResult {
  readonly mission: ResearchMissionRecord;
  readonly synthesis: ResearchSynthesisRecord;
}

export interface RecordResearchConstraintReportInput {
  readonly missionId: string;
  readonly lens: ResearchConstraintReportLens;
  readonly claimId?: string;
  readonly actorId: string;
}

export type RecordResearchConstraintReportResult =
  | {
      readonly status: 'recorded';
      readonly mission: ResearchMissionRecord;
      readonly constraintReport: ResearchConstraintReportRecord;
    }
  | {
      readonly status: 'mission-not-found' | 'claim-not-found';
      readonly missionId: string;
      readonly claimId?: string;
    };

export interface LinkResearchProofInput {
  readonly missionId: string;
  readonly proofId: string;
  readonly surface: string;
  readonly status: ResearchMissionProofLinkStatus;
  readonly artifactTokens?: readonly string[];
  readonly summary?: string;
  readonly actorId: string;
}

export type LinkResearchProofResult =
  | {
      readonly status: 'linked';
      readonly mission: ResearchMissionRecord;
      readonly proofLink: ResearchMissionProofLink;
    }
  | {
      readonly status: 'mission-not-found';
      readonly missionId: string;
    };

export type ResearchClaimEvidenceLinkMode = 'support' | 'challenge';

export type LinkResearchClaimEvidenceResult =
  | {
      readonly status: 'linked';
      readonly mission: ResearchMissionRecord;
      readonly claim: ResearchClaimRecord;
      readonly evidence: ResearchEvidenceItem;
      readonly mode: ResearchClaimEvidenceLinkMode;
    }
  | {
      readonly status: 'mission-not-found' | 'claim-not-found' | 'evidence-not-found';
      readonly missionId: string;
      readonly claimId?: string;
      readonly evidenceId?: string;
    };

type ResearchMissionLedgerEventType =
  | 'research.mission_draft_created'
  | 'research.mission_thread_bound'
  | 'research.mission_approved'
  | 'research.mission_status_updated'
  | 'research.evidence_added'
  | 'research.claim_added'
  | 'research.claim_supported'
  | 'research.claim_challenged'
  | 'research.synthesis_generated'
  | 'research.constraint_report_recorded'
  | 'research.proof_linked';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResearchMissionStatus(value: unknown): value is ResearchMissionStatus {
  return (
    value === 'draft' ||
    value === 'approved' ||
    value === 'running' ||
    value === 'blocked' ||
    value === 'synthesizing' ||
    value === 'completed' ||
    value === 'archived'
  );
}

function isResearchMissionPlanStepState(
  value: unknown,
): value is ResearchMissionPlanStepState {
  return value === 'complete' || value === 'current' || value === 'pending';
}

function isPlanDraftStep(value: unknown): value is ResearchMissionPlanDraftStep {
  return (
    isRecord(value) &&
    typeof value['label'] === 'string' &&
    isResearchMissionPlanStepState(value['state'])
  );
}

function isClaimSummary(value: unknown): value is ResearchMissionClaimSummary {
  return (
    isRecord(value) &&
    Number.isInteger(value['supported']) &&
    Number.isInteger(value['uncertain']) &&
    Number.isInteger(value['challenged'])
  );
}

function isProofSummary(value: unknown): value is ResearchMissionProofSummary {
  return (
    isRecord(value) &&
    Number.isInteger(value['pass']) &&
    Number.isInteger(value['warn']) &&
    (value['fail'] === undefined || Number.isInteger(value['fail']))
  );
}

function isResearchMissionProofLinkStatus(
  value: unknown,
): value is ResearchMissionProofLinkStatus {
  return value === 'pass' || value === 'warn' || value === 'fail';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isResearchMissionProofLink(
  value: unknown,
): value is ResearchMissionProofLink {
  return (
    isRecord(value) &&
    typeof value['proofId'] === 'string' &&
    typeof value['missionId'] === 'string' &&
    typeof value['surface'] === 'string' &&
    isResearchMissionProofLinkStatus(value['status']) &&
    isStringArray(value['artifactTokens']) &&
    typeof value['summary'] === 'string' &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function isResearchEvidenceItem(value: unknown): value is ResearchEvidenceItem {
  return (
    isRecord(value) &&
    typeof value['evidenceId'] === 'string' &&
    typeof value['missionId'] === 'string' &&
    typeof value['summary'] === 'string' &&
    typeof value['source'] === 'string' &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function isResearchClaimStatus(value: unknown): value is ResearchClaimStatus {
  return value === 'uncertain' || value === 'supported' || value === 'challenged';
}

function isResearchClaimRecord(value: unknown): value is ResearchClaimRecord {
  return (
    isRecord(value) &&
    typeof value['claimId'] === 'string' &&
    typeof value['missionId'] === 'string' &&
    typeof value['text'] === 'string' &&
    isResearchClaimStatus(value['status']) &&
    isStringArray(value['supportEvidenceIds']) &&
    isStringArray(value['challengeEvidenceIds']) &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function isResearchSynthesisEvidenceDigest(
  value: unknown,
): value is ResearchSynthesisEvidenceDigest {
  return (
    isRecord(value) &&
    typeof value['evidenceId'] === 'string' &&
    typeof value['summary'] === 'string' &&
    typeof value['source'] === 'string'
  );
}

function isResearchSynthesisClaimDigest(
  value: unknown,
): value is ResearchSynthesisClaimDigest {
  return (
    isRecord(value) &&
    typeof value['claimId'] === 'string' &&
    typeof value['text'] === 'string' &&
    isResearchClaimStatus(value['status']) &&
    isStringArray(value['supportEvidenceIds']) &&
    isStringArray(value['challengeEvidenceIds'])
  );
}

function isResearchSynthesisRecord(value: unknown): value is ResearchSynthesisRecord {
  return (
    isRecord(value) &&
    typeof value['synthesisId'] === 'string' &&
    typeof value['missionId'] === 'string' &&
    typeof value['body'] === 'string' &&
    Array.isArray(value['evidence']) &&
    value['evidence'].every(isResearchSynthesisEvidenceDigest) &&
    Array.isArray(value['claims']) &&
    value['claims'].every(isResearchSynthesisClaimDigest) &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function isResearchConstraintReportLens(
  value: unknown,
): value is ResearchConstraintReportLens {
  return (
    value === 'methodology' ||
    value === 'evidence' ||
    value === 'counterargument' ||
    value === 'reproducibility'
  );
}

function isResearchConstraintReportVerificationTargetKind(
  value: unknown,
): value is ResearchConstraintReportVerificationTargetKind {
  return (
    value === 'mission' ||
    value === 'claim' ||
    value === 'evidence' ||
    value === 'synthesis' ||
    value === 'proof'
  );
}

function isResearchConstraintReportRecord(
  value: unknown,
): value is ResearchConstraintReportRecord {
  if (!isRecord(value)) {
    return false;
  }
  const nextVerificationTarget = value['nextVerificationTarget'];
  const reusableSkillCandidate = value['reusableSkillCandidate'];
  return (
    value['schemaVersion'] === 1 &&
    typeof value['reportId'] === 'string' &&
    typeof value['missionId'] === 'string' &&
    isResearchConstraintReportLens(value['lens']) &&
    typeof value['falsifiableClaimRef'] === 'string' &&
    Number.isInteger(value['hiddenAssumptionCount']) &&
    Number.isInteger(value['counterexampleCount']) &&
    isRecord(nextVerificationTarget) &&
    isResearchConstraintReportVerificationTargetKind(
      nextVerificationTarget['kind'],
    ) &&
    typeof nextVerificationTarget['ref'] === 'string' &&
    isRecord(reusableSkillCandidate) &&
    reusableSkillCandidate['promotionGate'] === 'operator-approval-required' &&
    typeof reusableSkillCandidate['status'] === 'string' &&
    value['rawPromptRendered'] === false &&
    value['rawResponseRendered'] === false &&
    value['rawUserContentRendered'] === false &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function isResearchMissionRecord(value: unknown): value is ResearchMissionRecord {
  return (
    isRecord(value) &&
    typeof value['missionId'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['goal'] === 'string' &&
    typeof value['ownerId'] === 'string' &&
    typeof value['discordChannelId'] === 'string' &&
    (value['discordThreadId'] === undefined ||
      typeof value['discordThreadId'] === 'string') &&
    isResearchMissionStatus(value['status']) &&
    typeof value['phase'] === 'string' &&
    (value['planId'] === undefined || typeof value['planId'] === 'string') &&
    Array.isArray(value['planDraft']) &&
    value['planDraft'].every(isPlanDraftStep) &&
    Number.isInteger(value['evidenceItemCount']) &&
    isClaimSummary(value['claims']) &&
    isProofSummary(value['proof']) &&
    (value['proofLinks'] === undefined ||
      (Array.isArray(value['proofLinks']) &&
        value['proofLinks'].every(isResearchMissionProofLink))) &&
    (value['constraintReportCount'] === undefined ||
      Number.isInteger(value['constraintReportCount'])) &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string' &&
    (value['approvedAt'] === undefined || typeof value['approvedAt'] === 'string') &&
    (value['latestSynthesisId'] === undefined ||
      typeof value['latestSynthesisId'] === 'string')
  );
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    throw new TypeError(`Research mission ${field} must be non-empty.`);
  }
  return normalized;
}

function redactFilesystemPaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s`'")\]]+/gu, '[path]')
    .replace(/(^|[\s("'=])\/[^\s`'")\]]+/gu, '$1[path]');
}

function normalizeProofMetadataText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizeRequiredText(value, field);
  const redacted = redactFilesystemPaths(normalized)
    .replace(/@/gu, '@\u200B')
    .replace(/`/gu, 'ʼ');
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}…`;
}

function normalizeProofArtifactToken(value: string): string | undefined {
  const redacted = redactFilesystemPaths(value);
  const normalized = (redacted.includes('[path]') ? 'path' : redacted)
    .replace(/\s+/gu, '-')
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeProofArtifactTokens(
  values: readonly string[] | undefined,
): readonly string[] {
  const tokens: string[] = [];
  for (const value of values ?? []) {
    const token = normalizeProofArtifactToken(value);
    if (token !== undefined && !tokens.includes(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

function buildDefaultPlanDraft(goal: string): readonly ResearchMissionPlanDraftStep[] {
  const goalPreview = goal.length <= 80 ? goal : `${goal.slice(0, 79)}…`;
  return [
    { label: `Clarify scope for ${goalPreview}`, state: 'current' },
    { label: 'Baseline comparison', state: 'pending' },
    { label: 'Current state audit', state: 'pending' },
    { label: 'Gap analysis', state: 'pending' },
    { label: 'Implementation roadmap', state: 'pending' },
  ];
}

function clonePlanDraft(
  planDraft: readonly ResearchMissionPlanDraftStep[],
): readonly ResearchMissionPlanDraftStep[] {
  return planDraft.map((step) => ({ ...step }));
}

function cloneMission(record: ResearchMissionRecord): ResearchMissionRecord {
  const recordWithLegacyProofLinks = record as ResearchMissionRecord & {
    readonly proofLinks?: readonly ResearchMissionProofLink[];
    readonly constraintReportCount?: number;
  };
  return {
    ...record,
    planDraft: clonePlanDraft(record.planDraft),
    claims: { ...record.claims },
    proof: { ...record.proof },
    proofLinks: (recordWithLegacyProofLinks.proofLinks ?? []).map(cloneProofLink),
    constraintReportCount: recordWithLegacyProofLinks.constraintReportCount ?? 0,
  };
}

function cloneProofLink(proofLink: ResearchMissionProofLink): ResearchMissionProofLink {
  return {
    ...proofLink,
    artifactTokens: [...proofLink.artifactTokens],
  };
}

function cloneEvidence(item: ResearchEvidenceItem): ResearchEvidenceItem {
  return { ...item };
}

function cloneClaim(claim: ResearchClaimRecord): ResearchClaimRecord {
  return {
    ...claim,
    supportEvidenceIds: [...claim.supportEvidenceIds],
    challengeEvidenceIds: [...claim.challengeEvidenceIds],
  };
}

function cloneSynthesis(
  synthesis: ResearchSynthesisRecord,
): ResearchSynthesisRecord {
  return {
    ...synthesis,
    evidence: synthesis.evidence.map((item) => ({ ...item })),
    claims: synthesis.claims.map((claim) => ({
      ...claim,
      supportEvidenceIds: [...claim.supportEvidenceIds],
      challengeEvidenceIds: [...claim.challengeEvidenceIds],
    })),
  };
}

function cloneConstraintReport(
  report: ResearchConstraintReportRecord,
): ResearchConstraintReportRecord {
  return {
    ...report,
    nextVerificationTarget: { ...report.nextVerificationTarget },
    reusableSkillCandidate: { ...report.reusableSkillCandidate },
  };
}

function summarizeClaimRecords(
  claims: readonly ResearchClaimRecord[],
): ResearchMissionClaimSummary {
  return {
    supported: claims.filter((claim) => claim.status === 'supported').length,
    uncertain: claims.filter((claim) => claim.status === 'uncertain').length,
    challenged: claims.filter((claim) => claim.status === 'challenged').length,
  };
}

function summarizeProofLinks(
  proofLinks: readonly ResearchMissionProofLink[],
): ResearchMissionProofSummary {
  return {
    pass: proofLinks.filter((proofLink) => proofLink.status === 'pass').length,
    warn: proofLinks.filter((proofLink) => proofLink.status === 'warn').length,
    fail: proofLinks.filter((proofLink) => proofLink.status === 'fail').length,
  };
}

function buildUniqueResearchRecordId(
  prefix: 'E' | 'C' | 'S' | 'CR',
  seed: string,
  existingIds: readonly string[],
): string {
  const base = `${prefix}-${normalizeRequiredText(seed, `${prefix} id`)}`;
  if (!existingIds.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (existingIds.includes(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function evidenceToDigest(
  evidence: ResearchEvidenceItem,
): ResearchSynthesisEvidenceDigest {
  return {
    evidenceId: evidence.evidenceId,
    summary: evidence.summary,
    source: evidence.source,
  };
}

function claimToSynthesisDigest(
  claim: ResearchClaimRecord,
): ResearchSynthesisClaimDigest {
  return {
    claimId: claim.claimId,
    text: claim.text,
    status: claim.status,
    supportEvidenceIds: [...claim.supportEvidenceIds],
    challengeEvidenceIds: [...claim.challengeEvidenceIds],
  };
}

function formatSynthesisClaimLine(
  claim: ResearchSynthesisClaimDigest,
  evidenceById: ReadonlyMap<string, ResearchSynthesisEvidenceDigest>,
): string {
  const support = claim.supportEvidenceIds.filter((id) => evidenceById.has(id));
  const challenge = claim.challengeEvidenceIds.filter((id) => evidenceById.has(id));
  const evidenceNote =
    support.length === 0 && challenge.length === 0
      ? 'evidence: none linked'
      : [
          support.length === 0 ? undefined : `support: ${support.join(', ')}`,
          challenge.length === 0 ? undefined : `challenge: ${challenge.join(', ')}`,
        ]
          .filter((item): item is string => item !== undefined)
          .join('; ');
  return `- ${claim.claimId} [${claim.status}] ${claim.text} (${evidenceNote})`;
}

function buildSynthesisSection(
  title: string,
  claims: readonly ResearchSynthesisClaimDigest[],
  evidenceById: ReadonlyMap<string, ResearchSynthesisEvidenceDigest>,
): readonly string[] {
  return [
    `${title} (${claims.length}):`,
    ...(claims.length === 0
      ? ['- none']
      : claims.map((claim) => formatSynthesisClaimLine(claim, evidenceById))),
  ];
}

function buildResearchSynthesisBody(input: {
  readonly mission: ResearchMissionRecord;
  readonly evidence: readonly ResearchSynthesisEvidenceDigest[];
  readonly claims: readonly ResearchSynthesisClaimDigest[];
}): string {
  const evidenceById = new Map(input.evidence.map((item) => [item.evidenceId, item]));
  const supported = input.claims.filter((claim) => claim.status === 'supported');
  const challenged = input.claims.filter((claim) => claim.status === 'challenged');
  const uncertain = input.claims.filter((claim) => claim.status === 'uncertain');
  const unlinkedClaimCount = input.claims.filter(
    (claim) =>
      claim.supportEvidenceIds.length === 0 && claim.challengeEvidenceIds.length === 0,
  ).length;

  return [
    `Evidence-backed synthesis draft for ${input.mission.missionId}: ${input.mission.title}`,
    `Evidence basis: ${input.evidence.length} item${input.evidence.length === 1 ? '' : 's'}.`,
    `Claim coverage: ${supported.length} supported, ${uncertain.length} uncertain, ${challenged.length} challenged; ${unlinkedClaimCount} claim${unlinkedClaimCount === 1 ? '' : 's'} without linked evidence.`,
    ...buildSynthesisSection('Supported claims', supported, evidenceById),
    ...buildSynthesisSection('Challenged claims', challenged, evidenceById),
    ...buildSynthesisSection('Uncertain claims', uncertain, evidenceById),
    'Next: run critique on unsupported or challenged claims before archive closeout.',
  ].join('\n');
}

function chooseConstraintReportClaimRef(input: {
  readonly mission: ResearchMissionRecord;
  readonly claims: readonly ResearchClaimRecord[];
  readonly claimId?: string;
}): string | undefined {
  if (input.claimId !== undefined) {
    return input.claimId;
  }
  return (
    input.claims.find((claim) => claim.status === 'challenged')?.claimId ??
    input.claims.find((claim) => claim.status === 'uncertain')?.claimId ??
    input.claims[0]?.claimId ??
    `mission:${input.mission.missionId}`
  );
}

function buildConstraintReportNextVerificationTarget(input: {
  readonly mission: ResearchMissionRecord;
  readonly lens: ResearchConstraintReportLens;
  readonly claimRef: string;
}): {
  readonly kind: ResearchConstraintReportVerificationTargetKind;
  readonly ref: string;
} {
  switch (input.lens) {
    case 'methodology':
      return input.mission.latestSynthesisId === undefined
        ? { kind: 'mission', ref: input.mission.missionId }
        : { kind: 'synthesis', ref: input.mission.latestSynthesisId };
    case 'evidence':
      return { kind: 'evidence', ref: `mission:${input.mission.missionId}` };
    case 'counterargument':
      return { kind: 'claim', ref: input.claimRef };
    case 'reproducibility':
      return { kind: 'proof', ref: `mission:${input.mission.missionId}` };
  }
  const exhaustive: never = input.lens;
  return exhaustive;
}

function estimateHiddenAssumptionCount(input: {
  readonly mission: ResearchMissionRecord;
  readonly lens: ResearchConstraintReportLens;
}): number {
  const missingPlan = input.mission.planId === undefined ? 1 : 0;
  const missingSynthesis = input.mission.latestSynthesisId === undefined ? 1 : 0;
  const missingEvidence = input.mission.evidenceItemCount === 0 ? 1 : 0;
  const missingProof =
    input.lens === 'reproducibility' &&
    input.mission.proof.pass === 0 &&
    input.mission.proof.warn === 0 &&
    (input.mission.proof.fail ?? 0) === 0
      ? 1
      : 0;
  return missingPlan + missingSynthesis + missingEvidence + missingProof;
}

function estimateCounterexampleCount(input: {
  readonly mission: ResearchMissionRecord;
  readonly lens: ResearchConstraintReportLens;
}): number {
  if (input.lens === 'counterargument') {
    return Math.max(1, input.mission.claims.supported + input.mission.claims.uncertain);
  }
  if (input.lens === 'evidence') {
    return input.mission.claims.uncertain + input.mission.claims.challenged;
  }
  return input.mission.claims.challenged;
}

export class DiscordResearchMissionStore {
  private readonly missions = new Map<string, ResearchMissionRecord>();
  private readonly evidenceByMission = new Map<string, ResearchEvidenceItem[]>();
  private readonly claimsByMission = new Map<string, ResearchClaimRecord[]>();
  private readonly synthesesByMission = new Map<string, ResearchSynthesisRecord[]>();
  private readonly constraintReportsByMission = new Map<
    string,
    ResearchConstraintReportRecord[]
  >();
  private readonly ledger: ControlPlaneLedgerPort | undefined;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private replaying = false;

  constructor(options: DiscordResearchMissionStoreOptions = {}) {
    this.ledger = options.ledger;
    this.idFactory = options.idFactory ?? (() => randomUUID().slice(0, 8));
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.ledger !== undefined && (options.replayLedger ?? true)) {
      this.replayFromLedger(this.ledger.loadAll());
    }
  }

  createDraft(input: CreateResearchMissionDraftInput): ResearchMissionRecord {
    const goal = normalizeRequiredText(input.goal, 'goal');
    const title = normalizeRequiredText(input.title ?? goal, 'title');
    const ownerId = normalizeRequiredText(input.ownerId, 'ownerId');
    const discordChannelId = normalizeRequiredText(
      input.discordChannelId,
      'discordChannelId',
    );
    const now = this.now();
    const mission: ResearchMissionRecord = {
      missionId: `R-${this.idFactory()}`,
      title,
      goal,
      ownerId,
      discordChannelId,
      ...(input.discordThreadId === undefined
        ? {}
        : {
            discordThreadId: normalizeRequiredText(
              input.discordThreadId,
              'discordThreadId',
            ),
          }),
      status: 'draft',
      phase: 'plan draft',
      planDraft: clonePlanDraft(input.planDraft ?? buildDefaultPlanDraft(goal)),
      evidenceItemCount: 0,
      claims: { supported: 0, uncertain: 0, challenged: 0 },
      proof: { pass: 0, warn: 0 },
      proofLinks: [],
      constraintReportCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.missions.set(mission.missionId, mission);
    this.appendLedgerEvent('research.mission_draft_created', mission, ownerId);
    return cloneMission(mission);
  }

  get(missionId: string | undefined): ResearchMissionRecord | undefined {
    if (missionId === undefined) {
      return undefined;
    }
    const mission = this.missions.get(missionId);
    return mission === undefined ? undefined : cloneMission(mission);
  }

  list(options: ListResearchMissionsOptions = {}): ResearchMissionRecord[] {
    const status = options.status ?? 'all';
    const records = Array.from(this.missions.values())
      .filter((mission) => {
        if (options.ownerId !== undefined && mission.ownerId !== options.ownerId) {
          return false;
        }
        if (
          options.discordChannelId !== undefined &&
          mission.discordChannelId !== options.discordChannelId
        ) {
          return false;
        }
        if (status !== 'all' && mission.status !== status) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneMission);
    return options.limit === undefined
      ? records
      : records.slice(0, Math.max(0, options.limit));
  }

  bindThread(input: {
    readonly missionId: string;
    readonly discordThreadId: string;
    readonly actorId: string;
  }): ResearchMissionRecord | undefined {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return undefined;
    }
    const updated: ResearchMissionRecord = {
      ...existing,
      discordThreadId: normalizeRequiredText(
        input.discordThreadId,
        'discordThreadId',
      ),
      updatedAt: this.now(),
    };
    this.missions.set(updated.missionId, updated);
    this.appendLedgerEvent('research.mission_thread_bound', updated, input.actorId);
    return cloneMission(updated);
  }

  approve(input: {
    readonly missionId: string;
    readonly planId: string;
    readonly actorId: string;
  }): ResearchMissionRecord | undefined {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return undefined;
    }
    const now = this.now();
    const updated: ResearchMissionRecord = {
      ...existing,
      status: 'approved',
      phase: 'approved',
      planId: normalizeRequiredText(input.planId, 'planId'),
      approvedAt: now,
      updatedAt: now,
    };
    this.missions.set(updated.missionId, updated);
    this.appendLedgerEvent('research.mission_approved', updated, input.actorId);
    return cloneMission(updated);
  }

  setStatus(input: {
    readonly missionId: string;
    readonly status: ResearchMissionStatus;
    readonly phase?: string;
    readonly actorId: string;
  }): ResearchMissionRecord | undefined {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return undefined;
    }
    const updated: ResearchMissionRecord = {
      ...existing,
      status: input.status,
      phase: normalizeRequiredText(input.phase ?? input.status, 'phase'),
      updatedAt: this.now(),
    };
    this.missions.set(updated.missionId, updated);
    this.appendLedgerEvent(
      'research.mission_status_updated',
      updated,
      input.actorId,
    );
    return cloneMission(updated);
  }

  addEvidence(
    input: AddResearchEvidenceInput,
  ): AddResearchEvidenceResult | undefined {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return undefined;
    }
    const now = this.now();
    const existingEvidence = this.evidenceByMission.get(existing.missionId) ?? [];
    const evidence: ResearchEvidenceItem = {
      evidenceId: buildUniqueResearchRecordId(
        'E',
        this.idFactory(),
        existingEvidence.map((item) => item.evidenceId),
      ),
      missionId: existing.missionId,
      summary: normalizeRequiredText(input.summary, 'evidence summary'),
      source: normalizeRequiredText(input.source ?? 'operator note', 'evidence source'),
      createdBy: normalizeRequiredText(input.actorId, 'actorId'),
      createdAt: now,
    };
    const nextEvidence = [...existingEvidence, evidence];
    const updated: ResearchMissionRecord = {
      ...existing,
      evidenceItemCount: nextEvidence.length,
      updatedAt: now,
    };
    this.evidenceByMission.set(existing.missionId, nextEvidence);
    this.missions.set(existing.missionId, updated);
    this.appendLedgerEvent('research.evidence_added', updated, input.actorId, {
      evidence,
    });
    return {
      mission: cloneMission(updated),
      evidence: cloneEvidence(evidence),
    };
  }

  listEvidence(
    missionId: string | undefined,
    options: { readonly limit?: number } = {},
  ): ResearchEvidenceItem[] | undefined {
    if (missionId === undefined || !this.missions.has(missionId)) {
      return undefined;
    }
    const records = (this.evidenceByMission.get(missionId) ?? []).map(cloneEvidence);
    return options.limit === undefined
      ? records
      : records.slice(0, Math.max(0, options.limit));
  }

  addClaim(input: AddResearchClaimInput): AddResearchClaimResult | undefined {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return undefined;
    }
    const now = this.now();
    const existingClaims = this.claimsByMission.get(existing.missionId) ?? [];
    const claim: ResearchClaimRecord = {
      claimId: buildUniqueResearchRecordId(
        'C',
        this.idFactory(),
        existingClaims.map((item) => item.claimId),
      ),
      missionId: existing.missionId,
      text: normalizeRequiredText(input.text, 'claim text'),
      status: 'uncertain',
      supportEvidenceIds: [],
      challengeEvidenceIds: [],
      createdBy: normalizeRequiredText(input.actorId, 'actorId'),
      createdAt: now,
      updatedAt: now,
    };
    const nextClaims = [...existingClaims, claim];
    const updated: ResearchMissionRecord = {
      ...existing,
      claims: summarizeClaimRecords(nextClaims),
      updatedAt: now,
    };
    this.claimsByMission.set(existing.missionId, nextClaims);
    this.missions.set(existing.missionId, updated);
    this.appendLedgerEvent('research.claim_added', updated, input.actorId, {
      claim,
    });
    return {
      mission: cloneMission(updated),
      claim: cloneClaim(claim),
    };
  }

  listClaims(
    missionId: string | undefined,
    options: { readonly limit?: number } = {},
  ): ResearchClaimRecord[] | undefined {
    if (missionId === undefined || !this.missions.has(missionId)) {
      return undefined;
    }
    const records = (this.claimsByMission.get(missionId) ?? []).map(cloneClaim);
    return options.limit === undefined
      ? records
      : records.slice(0, Math.max(0, options.limit));
  }

  linkEvidenceToClaim(input: {
    readonly missionId: string;
    readonly claimId: string;
    readonly evidenceId: string;
    readonly mode: ResearchClaimEvidenceLinkMode;
    readonly actorId: string;
  }): LinkResearchClaimEvidenceResult {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return {
        status: 'mission-not-found',
        missionId: input.missionId,
        claimId: input.claimId,
        evidenceId: input.evidenceId,
      };
    }
    const evidence = (this.evidenceByMission.get(input.missionId) ?? []).find(
      (candidate) => candidate.evidenceId === input.evidenceId,
    );
    if (evidence === undefined) {
      return {
        status: 'evidence-not-found',
        missionId: input.missionId,
        claimId: input.claimId,
        evidenceId: input.evidenceId,
      };
    }
    const claims = this.claimsByMission.get(input.missionId) ?? [];
    const claim = claims.find((candidate) => candidate.claimId === input.claimId);
    if (claim === undefined) {
      return {
        status: 'claim-not-found',
        missionId: input.missionId,
        claimId: input.claimId,
        evidenceId: input.evidenceId,
      };
    }
    const now = this.now();
    const linkedClaim: ResearchClaimRecord =
      input.mode === 'support'
        ? {
            ...claim,
            status: 'supported',
            supportEvidenceIds: appendUniqueId(
              claim.supportEvidenceIds,
              input.evidenceId,
            ),
            updatedAt: now,
          }
        : {
            ...claim,
            status: 'challenged',
            challengeEvidenceIds: appendUniqueId(
              claim.challengeEvidenceIds,
              input.evidenceId,
            ),
            updatedAt: now,
          };
    const nextClaims = claims.map((candidate) =>
      candidate.claimId === linkedClaim.claimId ? linkedClaim : candidate,
    );
    const updated: ResearchMissionRecord = {
      ...existing,
      claims: summarizeClaimRecords(nextClaims),
      updatedAt: now,
    };
    this.claimsByMission.set(input.missionId, nextClaims);
    this.missions.set(input.missionId, updated);
    this.appendLedgerEvent(
      input.mode === 'support' ? 'research.claim_supported' : 'research.claim_challenged',
      updated,
      input.actorId,
      { claim: linkedClaim, evidence },
    );
    return {
      status: 'linked',
      mission: cloneMission(updated),
      claim: cloneClaim(linkedClaim),
      evidence: cloneEvidence(evidence),
      mode: input.mode,
    };
  }

  generateSynthesis(input: {
    readonly missionId: string;
    readonly actorId: string;
  }): GenerateResearchSynthesisResult | undefined {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return undefined;
    }
    const now = this.now();
    const existingSyntheses = this.synthesesByMission.get(existing.missionId) ?? [];
    const evidence = (this.evidenceByMission.get(existing.missionId) ?? []).map(
      evidenceToDigest,
    );
    const claims = (this.claimsByMission.get(existing.missionId) ?? []).map(
      claimToSynthesisDigest,
    );
    const synthesis: ResearchSynthesisRecord = {
      synthesisId: buildUniqueResearchRecordId(
        'S',
        this.idFactory(),
        existingSyntheses.map((item) => item.synthesisId),
      ),
      missionId: existing.missionId,
      body: buildResearchSynthesisBody({ mission: existing, evidence, claims }),
      evidence,
      claims,
      createdBy: normalizeRequiredText(input.actorId, 'actorId'),
      createdAt: now,
    };
    const updated: ResearchMissionRecord = {
      ...existing,
      status: 'synthesizing',
      phase: 'claim/evidence synthesis',
      latestSynthesisId: synthesis.synthesisId,
      updatedAt: now,
    };
    this.synthesesByMission.set(existing.missionId, [
      ...existingSyntheses,
      synthesis,
    ]);
    this.missions.set(existing.missionId, updated);
    this.appendLedgerEvent(
      'research.synthesis_generated',
      updated,
      input.actorId,
      { synthesis },
    );
    return {
      mission: cloneMission(updated),
      synthesis: cloneSynthesis(synthesis),
    };
  }

  getLatestSynthesis(
    missionId: string | undefined,
  ): ResearchSynthesisRecord | undefined {
    if (missionId === undefined || !this.missions.has(missionId)) {
      return undefined;
    }
    const records = this.synthesesByMission.get(missionId) ?? [];
    const latest = records.at(-1);
    return latest === undefined ? undefined : cloneSynthesis(latest);
  }

  recordConstraintReport(
    input: RecordResearchConstraintReportInput,
  ): RecordResearchConstraintReportResult {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return {
        status: 'mission-not-found',
        missionId: input.missionId,
        ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
      };
    }
    const claims = this.claimsByMission.get(input.missionId) ?? [];
    const requestedClaimId =
      input.claimId === undefined || input.claimId.trim().length === 0
        ? undefined
        : normalizeProofMetadataText(input.claimId, 'claimId', 120);
    if (
      requestedClaimId !== undefined &&
      !claims.some((claim) => claim.claimId === requestedClaimId)
    ) {
      return {
        status: 'claim-not-found',
        missionId: existing.missionId,
        claimId: requestedClaimId,
      };
    }
    const existingReports =
      this.constraintReportsByMission.get(existing.missionId) ?? [];
    const now = this.now();
    const reportId = buildUniqueResearchRecordId(
      'CR',
      this.idFactory(),
      existingReports.map((report) => report.reportId),
    );
    const claimRef = chooseConstraintReportClaimRef({
      mission: existing,
      claims,
      ...(requestedClaimId === undefined ? {} : { claimId: requestedClaimId }),
    });
    const snapshot = projectResearchConstraintReportSnapshot({
      reportId,
      missionId: existing.missionId,
      lens: input.lens,
      falsifiableClaimRef: claimRef ?? `mission:${existing.missionId}`,
      hiddenAssumptionCount: estimateHiddenAssumptionCount({
        mission: existing,
        lens: input.lens,
      }),
      counterexampleCount: estimateCounterexampleCount({
        mission: existing,
        lens: input.lens,
      }),
      nextVerificationTarget: buildConstraintReportNextVerificationTarget({
        mission: existing,
        lens: input.lens,
        claimRef: claimRef ?? `mission:${existing.missionId}`,
      }),
    });
    const constraintReport: ResearchConstraintReportRecord = {
      ...snapshot,
      createdBy: normalizeProofMetadataText(input.actorId, 'actorId', 120),
      createdAt: now,
    };
    const nextReports = [...existingReports, constraintReport];
    const updated: ResearchMissionRecord = {
      ...existing,
      constraintReportCount: nextReports.length,
      updatedAt: now,
    };
    this.constraintReportsByMission.set(existing.missionId, nextReports);
    this.missions.set(existing.missionId, updated);
    this.appendLedgerEvent(
      'research.constraint_report_recorded',
      updated,
      input.actorId,
      { constraintReport },
    );
    return {
      status: 'recorded',
      mission: cloneMission(updated),
      constraintReport: cloneConstraintReport(constraintReport),
    };
  }

  listConstraintReports(
    missionId: string | undefined,
    options: { readonly limit?: number } = {},
  ): ResearchConstraintReportRecord[] | undefined {
    if (missionId === undefined || !this.missions.has(missionId)) {
      return undefined;
    }
    const reports = (this.constraintReportsByMission.get(missionId) ?? []).map(
      cloneConstraintReport,
    );
    return options.limit === undefined
      ? reports
      : reports.slice(0, Math.max(0, options.limit));
  }

  linkProof(input: LinkResearchProofInput): LinkResearchProofResult {
    const existing = this.missions.get(input.missionId);
    if (existing === undefined) {
      return {
        status: 'mission-not-found',
        missionId: input.missionId,
      };
    }
    const now = this.now();
    const proofId = normalizeProofMetadataText(input.proofId, 'proofId', 120);
    const surface = normalizeProofMetadataText(input.surface, 'proof surface', 80);
    const summary = normalizeProofMetadataText(
      input.summary ?? `linked proof ${proofId}`,
      'proof summary',
      240,
    );
    const actorId = normalizeProofMetadataText(input.actorId, 'actorId', 120);
    const existingProofLinks = existing.proofLinks ?? [];
    const proofLink: ResearchMissionProofLink = {
      proofId,
      missionId: existing.missionId,
      surface,
      status: input.status,
      artifactTokens: normalizeProofArtifactTokens(input.artifactTokens),
      summary,
      createdBy: actorId,
      createdAt: now,
    };
    const nextProofLinks = [
      ...existingProofLinks.filter((item) => item.proofId !== proofId),
      proofLink,
    ];
    const updated: ResearchMissionRecord = {
      ...existing,
      proof: summarizeProofLinks(nextProofLinks),
      proofLinks: nextProofLinks,
      updatedAt: now,
    };
    this.missions.set(existing.missionId, updated);
    this.appendLedgerEvent('research.proof_linked', updated, actorId, {
      proofLink,
    });
    return {
      status: 'linked',
      mission: cloneMission(updated),
      proofLink: cloneProofLink(proofLink),
    };
  }

  toSummaryInput(missionId: string): RenderResearchMissionSummaryInput | undefined {
    const mission = this.missions.get(missionId);
    return mission === undefined
      ? undefined
      : researchMissionToSummaryInput(mission);
  }

  private appendLedgerEvent(
    type: ResearchMissionLedgerEventType,
    mission: ResearchMissionRecord,
    actorId: string,
    payload: Record<string, unknown> = {},
  ): void {
    if (this.ledger === undefined || this.replaying) {
      return;
    }
    this.ledger.append({
      type,
      actor: { kind: 'discord-user', userId: actorId },
      channel: {
        kind: 'discord',
        channelId: mission.discordChannelId,
      },
      conversationId: mission.discordThreadId ?? mission.discordChannelId,
      correlationId: mission.missionId,
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: { mission, ...payload },
    });
  }

  private replayFromLedger(events: readonly ControlPlaneEvent[]): void {
    this.replaying = true;
    try {
      for (const event of events) {
        if (isResearchMissionLedgerEventType(event.type)) {
          const mission = event.payload['mission'];
          if (isResearchMissionRecord(mission)) {
            this.missions.set(mission.missionId, cloneMission(mission));
          }
          const evidence = event.payload['evidence'];
          if (isResearchEvidenceItem(evidence)) {
            this.upsertEvidence(evidence);
          }
          const claim = event.payload['claim'];
          if (isResearchClaimRecord(claim)) {
            this.upsertClaim(claim);
          }
          const synthesis = event.payload['synthesis'];
          if (isResearchSynthesisRecord(synthesis)) {
            this.upsertSynthesis(synthesis);
          }
          const constraintReport = event.payload['constraintReport'];
          if (isResearchConstraintReportRecord(constraintReport)) {
            this.upsertConstraintReport(constraintReport);
          }
          const proofLink = event.payload['proofLink'];
          if (isResearchMissionProofLink(proofLink)) {
            this.upsertProofLink(proofLink);
          }
        }
      }
    } finally {
      this.replaying = false;
    }
  }

  private upsertEvidence(evidence: ResearchEvidenceItem): void {
    const existing = this.evidenceByMission.get(evidence.missionId) ?? [];
    const next = existing.some((item) => item.evidenceId === evidence.evidenceId)
      ? existing.map((item) =>
          item.evidenceId === evidence.evidenceId ? cloneEvidence(evidence) : item,
        )
      : [...existing, cloneEvidence(evidence)];
    this.evidenceByMission.set(evidence.missionId, next);
  }

  private upsertClaim(claim: ResearchClaimRecord): void {
    const existing = this.claimsByMission.get(claim.missionId) ?? [];
    const next = existing.some((item) => item.claimId === claim.claimId)
      ? existing.map((item) =>
          item.claimId === claim.claimId ? cloneClaim(claim) : item,
        )
      : [...existing, cloneClaim(claim)];
    this.claimsByMission.set(claim.missionId, next);
  }

  private upsertSynthesis(synthesis: ResearchSynthesisRecord): void {
    const existing = this.synthesesByMission.get(synthesis.missionId) ?? [];
    const next = existing.some((item) => item.synthesisId === synthesis.synthesisId)
      ? existing.map((item) =>
          item.synthesisId === synthesis.synthesisId
            ? cloneSynthesis(synthesis)
            : item,
        )
      : [...existing, cloneSynthesis(synthesis)];
    this.synthesesByMission.set(synthesis.missionId, next);
  }

  private upsertConstraintReport(
    constraintReport: ResearchConstraintReportRecord,
  ): void {
    const mission = this.missions.get(constraintReport.missionId);
    if (mission === undefined) {
      return;
    }
    const existing =
      this.constraintReportsByMission.get(constraintReport.missionId) ?? [];
    const next = existing.some((item) => item.reportId === constraintReport.reportId)
      ? existing.map((item) =>
          item.reportId === constraintReport.reportId
            ? cloneConstraintReport(constraintReport)
            : item,
        )
      : [...existing, cloneConstraintReport(constraintReport)];
    this.constraintReportsByMission.set(constraintReport.missionId, next);
    this.missions.set(mission.missionId, {
      ...mission,
      constraintReportCount: next.length,
    });
  }

  private upsertProofLink(proofLink: ResearchMissionProofLink): void {
    const mission = this.missions.get(proofLink.missionId);
    if (mission === undefined) {
      return;
    }
    const existing = mission.proofLinks ?? [];
    const next = existing.some((item) => item.proofId === proofLink.proofId)
      ? existing.map((item) =>
          item.proofId === proofLink.proofId
            ? cloneProofLink(proofLink)
            : item,
        )
      : [...existing, cloneProofLink(proofLink)];
    this.missions.set(mission.missionId, {
      ...mission,
      proof: summarizeProofLinks(next),
      proofLinks: next,
    });
  }
}

function appendUniqueId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

function isResearchMissionLedgerEventType(
  value: string,
): value is ResearchMissionLedgerEventType {
  return (
    value === 'research.mission_draft_created' ||
    value === 'research.mission_thread_bound' ||
    value === 'research.mission_approved' ||
    value === 'research.mission_status_updated' ||
    value === 'research.evidence_added' ||
    value === 'research.claim_added' ||
    value === 'research.claim_supported' ||
    value === 'research.claim_challenged' ||
    value === 'research.synthesis_generated' ||
    value === 'research.constraint_report_recorded' ||
    value === 'research.proof_linked'
  );
}

export function researchMissionToSummaryInput(
  mission: ResearchMissionRecord,
): RenderResearchMissionSummaryInput {
  return {
    missionId: mission.missionId,
    title: mission.title,
    status: mission.status,
    phase:
      mission.planId === undefined
        ? mission.phase
        : `${mission.phase} (/research-plan plan-id:${mission.planId})`,
    owner: `@${mission.ownerId}`,
    threadLabel:
      mission.discordThreadId === undefined
        ? mission.discordChannelId
        : `${mission.discordChannelId} / ${mission.discordThreadId}`,
    plan: clonePlanDraft(mission.planDraft),
    evidenceCount: mission.evidenceItemCount,
    claims: { ...mission.claims },
    proof: { ...mission.proof },
    nextActions:
      mission.status === 'draft'
        ? [
            { verb: 'approve', label: 'Approve plan', style: 'success' },
            { verb: 'show-plan', label: 'Show plan' },
            { verb: 'cancel', label: 'Cancel', style: 'danger' },
          ]
        : [
            { verb: 'status', label: 'Status' },
            { verb: 'synthesize', label: 'Synthesize', style: 'primary' },
            { verb: 'show-evidence', label: 'Show evidence' },
            { verb: 'archive', label: 'Archive', style: 'danger' },
          ],
  };
}
