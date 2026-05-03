import type { TaskRequest } from '../../src/index.js';

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
