import { createHash } from 'node:crypto';

export const HUMAN_GATE_SNAPSHOT_SCHEMA_VERSION = 1;

export type HumanGateDeliveryChannel = 'cli' | 'discord';
export type HumanGateAnswerProvenance =
  | 'operator-approved'
  | 'operator-denied'
  | 'operator-supplied'
  | 'timeout';

export interface HumanGateSnapshot {
  readonly schemaVersion: typeof HUMAN_GATE_SNAPSHOT_SCHEMA_VERSION;
  readonly gateIdHash: string;
  readonly rawGateIdRendered: false;
  readonly question: {
    readonly length: number;
    readonly sha256: string;
    readonly rawRendered: false;
  };
  readonly timeoutSec: number;
  readonly onTimeout: 'fail-closed';
  readonly port: {
    readonly ask: true;
    readonly notify: true;
    readonly supportedChannels: readonly HumanGateDeliveryChannel[];
    readonly multiChannel: false;
  };
  readonly answerProvenance: {
    readonly required: true;
    readonly allowed: readonly HumanGateAnswerProvenance[];
    readonly rawAnswerRendered: false;
  };
  readonly summary: {
    readonly required: true;
    readonly rawSummaryRendered: false;
  };
  readonly providerContactRequired: false;
}

export interface ProjectHumanGateSnapshotInput {
  readonly gateId: string;
  readonly question: string;
  readonly timeoutSec: number;
  readonly onTimeout: 'fail-closed';
}

const DEFAULT_SUPPORTED_CHANNELS = Object.freeze([
  'cli',
  'discord',
] as const satisfies readonly HumanGateDeliveryChannel[]);

const DEFAULT_ANSWER_PROVENANCE = Object.freeze([
  'operator-approved',
  'operator-denied',
  'operator-supplied',
  'timeout',
] as const satisfies readonly HumanGateAnswerProvenance[]);

export function projectHumanGateSnapshot(
  input: ProjectHumanGateSnapshotInput,
): HumanGateSnapshot {
  if (!Number.isSafeInteger(input.timeoutSec) || input.timeoutSec <= 0) {
    throw new TypeError('timeoutSec must be a positive safe integer.');
  }
  return Object.freeze({
    schemaVersion: HUMAN_GATE_SNAPSHOT_SCHEMA_VERSION,
    gateIdHash: sha256(input.gateId),
    rawGateIdRendered: false,
    question: Object.freeze({
      length: input.question.length,
      sha256: sha256(input.question),
      rawRendered: false,
    }),
    timeoutSec: input.timeoutSec,
    onTimeout: input.onTimeout,
    port: Object.freeze({
      ask: true,
      notify: true,
      supportedChannels: DEFAULT_SUPPORTED_CHANNELS,
      multiChannel: false,
    }),
    answerProvenance: Object.freeze({
      required: true,
      allowed: DEFAULT_ANSWER_PROVENANCE,
      rawAnswerRendered: false,
    }),
    summary: Object.freeze({
      required: true,
      rawSummaryRendered: false,
    }),
    providerContactRequired: false,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
