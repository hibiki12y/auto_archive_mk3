import {
  assertNetworkPolicyProfile,
  projectNetworkPolicyProfile,
  type NetworkPolicyProfile,
  type RuntimeNetworkProjection,
} from './network-policy.js';

export type RuntimeSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type RuntimeApprovalPolicy = 'never' | 'on-request';

export interface RuntimeSettingsInput {
  networkProfile: NetworkPolicyProfile;
  sandboxMode: RuntimeSandboxMode;
  approvalPolicy: RuntimeApprovalPolicy;
  workingDirectory?: string;
  deadlineMs?: number;
}

export interface RuntimeSettingsBundle extends RuntimeSettingsInput {
  networkProjection: RuntimeNetworkProjection;
}

const RUNTIME_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly RuntimeSandboxMode[];
const RUNTIME_APPROVAL_POLICIES = [
  'never',
  'on-request',
] as const satisfies readonly RuntimeApprovalPolicy[];

function assertRuntimeSandboxMode(
  value: unknown,
): asserts value is RuntimeSandboxMode {
  if (
    typeof value !== 'string' ||
    !RUNTIME_SANDBOX_MODES.includes(value as RuntimeSandboxMode)
  ) {
    throw new Error(
      `sandboxMode must be one of: ${RUNTIME_SANDBOX_MODES.join(', ')}`,
    );
  }
}

function assertRuntimeApprovalPolicy(
  value: unknown,
): asserts value is RuntimeApprovalPolicy {
  if (
    typeof value !== 'string' ||
    !RUNTIME_APPROVAL_POLICIES.includes(value as RuntimeApprovalPolicy)
  ) {
    throw new Error(
      `approvalPolicy must be one of: ${RUNTIME_APPROVAL_POLICIES.join(', ')}`,
    );
  }
}

function validateWorkingDirectory(value: unknown): value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('workingDirectory must be a string when provided');
  }

  return true;
}

function validateDeadlineMs(value: unknown): value is number | undefined {
  if (value === undefined) {
    return true;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      'deadlineMs must be a finite positive integer when provided',
    );
  }
  return true;
}

export function createRuntimeSettingsBundle(
  input: RuntimeSettingsInput,
): RuntimeSettingsBundle {
  if (typeof input !== 'object' || input === null) {
    throw new Error('runtimeSettings must be an object');
  }

  assertNetworkPolicyProfile(input.networkProfile);
  assertRuntimeSandboxMode(input.sandboxMode);
  assertRuntimeApprovalPolicy(input.approvalPolicy);
  validateWorkingDirectory(input.workingDirectory);
  validateDeadlineMs(input.deadlineMs);

  const bundle: RuntimeSettingsBundle = {
    networkProfile: input.networkProfile,
    sandboxMode: input.sandboxMode,
    approvalPolicy: input.approvalPolicy,
    networkProjection: projectNetworkPolicyProfile(input.networkProfile),
    ...(input.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.workingDirectory }),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
  };

  return Object.freeze(bundle);
}
