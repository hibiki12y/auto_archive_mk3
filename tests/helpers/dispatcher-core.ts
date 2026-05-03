import { AgentRuntime } from '../../src/index.js';
import type { RuntimeDriver, TaskRequest } from '../../src/index.js';
import { InProcessComputeNode } from '../../src/core/__test__/compute-node-test-doubles.js';

/**
 * Builds an `InProcessComputeNode` whose underlying runtime driver
 * throws on invocation. Used by tests that exercise pre-runtime rejection
 * paths (admission veto, plana veto, duplicate submission, no-active
 * cancel) and never reach the dispatch boundary. Replaces the historical
 * `new InProcessComputeNode()` parameterless form, which relied on the
 * AgentRuntime default-driver fallback that pulled `CodexRuntimeDriver`
 * (and its Codex SDK initialization side effects) into `src/core/`.
 */
export function inProcessNodeForRejectionTest(): InProcessComputeNode {
  const throwingDriver: RuntimeDriver = {
    async run() {
      throw new Error(
        'tests/helpers/dispatcher-core: throwingDriver invoked; this driver is for pre-runtime rejection tests only.',
      );
    },
  };
  return new InProcessComputeNode(new AgentRuntime(throwingDriver));
}

export function createTaskRequest(
  taskId: string,
  overrides: Partial<TaskRequest> = {},
): TaskRequest {
  const baseRequest: TaskRequest = {
    taskId,
    instruction: 'Execute contract-first runtime skeleton',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: 'results/task-artifacts',
    },
    artifactLocation: 'results/task-artifacts',
    resources: {
      requested: {
        cpuCores: 4,
        memoryMiB: 8192,
        wallTimeSec: 900,
        gpuCards: 0,
      },
    },
  };

  return {
    ...baseRequest,
    ...overrides,
    taskId,
    runtimeSettings: overrides.runtimeSettings ?? baseRequest.runtimeSettings,
    resources: overrides.resources ?? baseRequest.resources,
  };
}

export function createControlledPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
