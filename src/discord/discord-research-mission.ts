import { randomUUID } from 'node:crypto';

import type {
  ControlPlaneEvent,
  ControlPlaneLedgerPort,
} from '../control/control-plane-ledger.js';
import type {
  RenderResearchMissionSummaryInput,
  ResearchMissionPlanStepState,
} from './discord-result-renderer.js';

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
  | 'research.synthesis_generated';

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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
  return {
    ...record,
    planDraft: clonePlanDraft(record.planDraft),
    claims: { ...record.claims },
    proof: { ...record.proof },
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

function summarizeClaimRecords(
  claims: readonly ResearchClaimRecord[],
): ResearchMissionClaimSummary {
  return {
    supported: claims.filter((claim) => claim.status === 'supported').length,
    uncertain: claims.filter((claim) => claim.status === 'uncertain').length,
    challenged: claims.filter((claim) => claim.status === 'challenged').length,
  };
}

function buildUniqueResearchRecordId(
  prefix: 'E' | 'C' | 'S',
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

export class DiscordResearchMissionStore {
  private readonly missions = new Map<string, ResearchMissionRecord>();
  private readonly evidenceByMission = new Map<string, ResearchEvidenceItem[]>();
  private readonly claimsByMission = new Map<string, ResearchClaimRecord[]>();
  private readonly synthesesByMission = new Map<string, ResearchSynthesisRecord[]>();
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
    value === 'research.synthesis_generated'
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
