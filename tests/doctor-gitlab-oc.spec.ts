import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  renderDoctorReport,
  renderGitLabTaskProjectReadme,
  renderGitLabWorkResultMarkdown,
  createRuntimeSettingsBundle,
  type DispatchPlan,
  type TerminalEvidence,
} from '../src/index.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';
import { Arona, Dispatcher, Plana } from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { AgentRuntime, type RuntimeDriver } from '../src/index.js';

function plan(taskId: string): DispatchPlan {
  const driver: RuntimeDriver = {
    async run(context) {
      return {
        reason: 'ok',
        provenance: 'test',
        cause: {
          kind: 'success',
          taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: '2026-04-27T00:00:00.000Z',
          provenance: 'test',
        },
      };
    },
  };
  return new Arona(
    new Plana({ toolLoopDetector: false }),
    new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
  ).preparePlan(createTaskRequest(taskId, { instruction: 'test task' }));
}

function evidence(taskId: string): TerminalEvidence {
  return {
    taskId,
    runtimeInstanceId: 'runtime-1',
    reason: 'done',
    provenance: 'test',
      executionContext: {
        planCreatedAt: '2026-04-27T00:00:00.000Z',
        runtimeSettings: createRuntimeSettingsBundle({
          networkProfile: 'offline',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        }),
      },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    runtimeWarnings: [
      {
        kind: 'tool-loop',
        status: 'warn',
        reason: 'tool loop suspected',
        provenance: 'plana-tool-loop-detector',
        fingerprint: 'abcdef0123456789',
        count: 4,
        observedAt: '2026-04-27T00:00:01.000Z',
      },
    ],
    startedAt: '2026-04-27T00:00:00.000Z',
    endedAt: '2026-04-27T00:00:02.000Z',
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId: 'runtime-1',
      observedAt: '2026-04-27T00:00:02.000Z',
      provenance: 'test',
    },
  };
}

describe('OC-3 doctor and GitLab lifecycle rendering', () => {
  it('renders non-mutating doctor sections without leaking token-like probes', () => {
    const text = renderDoctorReport(
      buildDoctorReport({
        ledgerEnabled: false,
        accessPolicyEnabled: true,
        authDatabaseEnabled: false,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        executionApprovalPolicy: 'single-use',
        toolLoopDetectorEnabled: true,
        gitLabEnabled: true,
        gitLabTokenConfigured: false,
        redactionProbe: 'sk-secret glpat-secret',
        generatedAt: '2026-04-27T00:00:00.000Z',
      }),
    );
    expect(text).toContain('[WARN] Service readiness');
    expect(text).toContain('Approval registry status');
    expect(text).toContain('Tool-loop detector status');
    expect(text).toContain('GitLab recording/artifact publication status');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('glpat-secret');
  });

  it('renders GitLab task project README metadata and terminal warning provenance', () => {
    const p = plan('task-gitlab-readme');
    const e = evidence('task-gitlab-readme');
    const readme = renderGitLabTaskProjectReadme({
      plan: p,
      evidence: e,
      artifactPublication: {
        kind: 'commit-created',
        projectId: 42,
        branch: 'main',
        commitId: 'commit',
        destinationPrefix: 'artifacts/task-gitlab-readme',
        publishedFiles: ['artifacts/task-gitlab-readme/package.json'],
      },
    });
    expect(readme).toContain('Task ID: `task-gitlab-readme`');
    expect(readme).toContain('Optional test command: npm test');

    const issue = renderGitLabWorkResultMarkdown(p, e);
    expect(issue).toContain('## Terminal evidence');
    expect(issue).toContain('plana-tool-loop-detector');
    expect(issue).toContain('## Operator follow-up');
  });
});
