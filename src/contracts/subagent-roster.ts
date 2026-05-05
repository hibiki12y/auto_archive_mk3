import {
  assertResourceEnvelope,
  freezeResourceEnvelope,
  type ResourceEnvelope,
} from './resource-envelope.js';
import type {
  RuntimeApprovalPolicy,
  RuntimeSandboxMode,
} from './runtime-settings.js';

export type SubagentRole =
  | 'root-orchestrator'
  | 'explorer'
  | 'coder'
  | 'writer'
  | 'verifier'
  | 'executor';

export type SubagentState =
  | 'reserved'
  | 'spawning'
  | 'active'
  | 'terminating'
  | 'terminated'
  | 'failed';

export interface SubagentCorrelationKey {
  readonly taskId: string;
  readonly instanceId: string;
  readonly subagentId: string;
}

export interface SandboxOverride {
  readonly sandboxMode?: RuntimeSandboxMode;
  readonly approvalPolicy?: RuntimeApprovalPolicy;
  readonly networkAccessEnabled?: boolean;
}

export interface SpawnOptions {
  readonly role: SubagentRole;
  readonly workingDirectory?: string;
  readonly sandboxOverride?: SandboxOverride;
  /**
   * Optional advisory list of tool names the child subagent intends to use.
   * The current runtime does not grant a separate per-subagent toolset; this
   * list is admission metadata for the policy enforcer only, so blocked-tool
   * requests can fail closed before a descriptor is admitted. It is not a
   * runtime permission boundary and does not restrict inherited parent tools.
   */
  readonly requestedToolNames?: readonly string[];
}

export interface SubagentDescriptor {
  readonly subagentId: string;
  readonly role: SubagentRole;
  readonly parent: {
    readonly taskId: string;
    readonly instanceId: string;
  };
  readonly createdAt: string;
  readonly state: SubagentState;
  /**
   * Runtime-derived immutable envelope snapshot.
   * This value is deep-frozen with `Object.freeze`.
   */
  readonly envelope: Readonly<ResourceEnvelope>;
}

export const DEFAULT_ROSTER_MAX_CONCURRENCY = 6;

export const DEFAULT_PER_ROLE_CAPS = Object.freeze({
  'root-orchestrator': 1,
  executor: 1,
}) as Readonly<Partial<Record<SubagentRole, number>>>;

export interface RosterConfig {
  readonly maxConcurrent?: number;
  readonly perRoleCaps?: Partial<Record<SubagentRole, number>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSubagentRole(value: unknown): value is SubagentRole {
  return (
    value === 'root-orchestrator' ||
    value === 'explorer' ||
    value === 'coder' ||
    value === 'writer' ||
    value === 'verifier' ||
    value === 'executor'
  );
}

export function isSubagentCorrelationKey(
  value: unknown,
): value is SubagentCorrelationKey {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.taskId === 'string' &&
    value.taskId.length > 0 &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.subagentId === 'string' &&
    value.subagentId.length > 0
  );
}

export function assertSubagentRole(value: unknown): SubagentRole {
  if (!isSubagentRole(value)) {
    throw new TypeError(`Unsupported subagent role: ${String(value)}`);
  }
  return value;
}

export function freezeDescriptorEnvelope(
  envelope: unknown,
): Readonly<ResourceEnvelope> {
  return freezeResourceEnvelope(assertResourceEnvelope(envelope));
}
