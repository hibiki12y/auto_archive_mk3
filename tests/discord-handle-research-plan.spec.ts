import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeExecutionContext,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const factoryOptions = {
  resources: {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
  },
  runtimeSettings: {
    networkProfile: 'provider-only' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    workingDirectory: 'results/task-artifacts',
  },
  artifactLocation: 'results/task-artifacts',
};

const VALID_PLAN = {
  subTasks: [
    { taskId: 'st1', instruction: 'do thing 1' },
    { taskId: 'st2', instruction: 'do thing 2' },
  ],
  synthesis: {
    taskId: 'synth',
    instructionTemplate: 'combine {{subTaskOutputs}}',
  },
  runtimeSettings: factoryOptions.runtimeSettings,
  resources: factoryOptions.resources,
};

let workspaces: string[] = [];

afterEach(() => {
  for (const ws of workspaces) {
    rmSync(ws, { recursive: true, force: true });
  }
  workspaces = [];
});

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'discord-research-plan-handler-'));
  workspaces.push(ws);
  return ws;
}

function createHandlers(options: {
  researchPlanRuntimeDriver?: RuntimeDriver;
  researchPlanWorkingDirectory?: string;
  researchPlanArtifactRoot?: string;
}) {
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'offline',
          } as never);
          return {
            cause: {
              kind: 'success',
              taskId: context.instance.taskId,
              runtimeInstanceId: context.instance.instanceId,
              observedAt: '2026-05-07T00:00:00.000Z',
              provenance: 'offline',
            },
            provenance: 'offline',
            reason: 'ok',
          };
        },
      }),
    ),
  );
  const handlers = new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry: new DiscordTaskRegistry(),
    requestFactory: new DefaultDiscordTaskRequestFactory({
      ...factoryOptions,
      taskIdFactory: () => 'fixed',
    }),
    ...(options.researchPlanRuntimeDriver === undefined
      ? {}
      : { researchPlanRuntimeDriver: options.researchPlanRuntimeDriver }),
    ...(options.researchPlanWorkingDirectory === undefined
      ? {}
      : { researchPlanWorkingDirectory: options.researchPlanWorkingDirectory }),
    ...(options.researchPlanArtifactRoot === undefined
      ? {}
      : { researchPlanArtifactRoot: options.researchPlanArtifactRoot }),
  });
  return handlers;
}

function makeStubDriver(
  finalTextBySubTaskId: Record<string, string>,
  resultsBySubTaskId: Record<string, RuntimeDriverResult> = {},
): RuntimeDriver {
  const run = vi.fn(async (context: RuntimeExecutionContext) => {
    const id = context.plan.taskId;
    await context.emit({
      kind: 'item.completed',
      item: { type: 'agent_message', text: finalTextBySubTaskId[id] ?? `${id}-out` },
    } as never);
    return (
      resultsBySubTaskId[id] ?? {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      }
    );
  });
  return { run };
}

function writePlan(ws: string, planId: string, body: unknown): void {
  const dir = join(ws, 'plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${planId}.json`), JSON.stringify(body), 'utf8');
}

describe('handleResearchPlan', () => {
  it('rejects when no runtime driver is wired (operator-CLI fallback path)', async () => {
    const handlers = createHandlers({});
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'whatever',
    });
    await handlers.handleInteraction(interaction);
    expect(interaction.deferredReplies).toHaveLength(1);
    expect(interaction.editedReplies).toHaveLength(1);
    const text =
      interaction.editedReplies[0]?.content ??
      JSON.stringify(interaction.editedReplies[0]);
    expect(text).toContain('runtime driver is not wired');
    expect(text).toContain('pnpm research:plan:run');
  });

  it('rejects malformed plan-ids before touching the filesystem', async () => {
    const ws = makeWorkspace();
    const driver = makeStubDriver({});
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanWorkingDirectory: ws,
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      const interaction = new FakeDiscordInteraction('research-plan', {
        'plan-id': '../../etc/passwd',
      });
      await handlers.handleInteraction(interaction);
      const text =
        interaction.editedReplies[0]?.content ??
        JSON.stringify(interaction.editedReplies[0]);
      expect(text).toMatch(/must match/);
      expect(driver.run).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
  });

  it('rejects when the plan file is missing', async () => {
    const ws = makeWorkspace();
    const driver = makeStubDriver({});
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      const interaction = new FakeDiscordInteraction('research-plan', {
        'plan-id': 'missing',
      });
      await handlers.handleInteraction(interaction);
      const text =
        interaction.editedReplies[0]?.content ??
        JSON.stringify(interaction.editedReplies[0]);
      expect(text).toContain('Research plan');
      expect(text).toContain('failed to read plan');
      expect(driver.run).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
  });

  it('dispatches a happy-path plan and posts per-sub-task progress + final aggregated report', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'good', VALID_PLAN);
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: 'final aggregated synthesis',
    });
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'good',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      // The handler dispatches the orchestrator in the background; await the
      // microtask + ensure followUps land. Because the stub driver completes
      // synchronously after one microtask, we need a small flush.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    expect(interaction.editedReplies).toHaveLength(1);
    const accepted =
      interaction.editedReplies[0]?.content ??
      JSON.stringify(interaction.editedReplies[0]);
    expect(accepted).toContain('Research plan `good` accepted');
    expect(accepted).toContain('Sub-tasks queued: **2**');
    // Three progress + one final = four follow-ups.
    expect(interaction.followUpReplies.length).toBeGreaterThanOrEqual(4);
    const followText = interaction.followUpReplies
      .map((p) => p?.content ?? JSON.stringify(p))
      .join('\n');
    expect(followText).toContain('`st1`');
    expect(followText).toContain('`st2`');
    expect(followText).toContain('`synth`');
    expect(followText).toContain('Research plan `good` complete');
    expect(followText).toContain('final aggregated synthesis');
    expect(driver.run).toHaveBeenCalledTimes(3);
  });

  it('reports stoppedEarly when a sub-task fails and never invokes synthesis', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'fails', VALID_PLAN);
    const driver = makeStubDriver(
      { st1: 'st1-out' },
      {
        st1: {
          cause: {
            kind: 'provider-failure',
            taskId: 'st1',
            runtimeInstanceId: 'instance-st1',
            observedAt: '2026-05-07T00:00:00.000Z',
            provenance: 'stub',
            classification: 'rate-limit',
            provider: 'codex',
            retryable: true,
            message: 'rate-limited',
          },
          provenance: 'stub',
          reason: 'st1-failed',
        },
      },
    );
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'fails',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    // 1 progress (the failed sub-task) + 1 error final
    expect(interaction.followUpReplies.length).toBeGreaterThanOrEqual(2);
    const followText = interaction.followUpReplies
      .map((p) => p?.content ?? JSON.stringify(p))
      .join('\n');
    expect(followText).toContain('`st1`');
    expect(followText).toContain('cause=`provider-failure`');
    expect(followText).toContain('plan stopped early');
    expect(driver.run).toHaveBeenCalledTimes(1);
  });

  it('writes full report to disk when aggregated report exceeds Discord budget', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'big', VALID_PLAN);
    // Synthesize a report >1900 chars so the persist branch fires.
    const big = 'X'.repeat(5000);
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: big,
    });
    const artifactRoot = join(ws, 'artifacts');
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanArtifactRoot: artifactRoot,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'big',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const reportDir = join(artifactRoot, 'research-plan-reports');
    expect(existsSync(reportDir)).toBe(true);
    const entries = readdirSync(reportDir).sort();
    // One .md report + one .meta.json sidecar.
    expect(entries.length).toBe(2);
    const mdEntry = entries.find((e) => e.endsWith('.md'));
    const metaEntry = entries.find((e) => e.endsWith('.meta.json'));
    expect(mdEntry).toBeDefined();
    expect(metaEntry).toBeDefined();
    expect(mdEntry).toMatch(/^big-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/);
    const mdBody = readFileSync(join(reportDir, mdEntry as string), 'utf8');
    expect(mdBody).toBe(big);
    const meta = JSON.parse(
      readFileSync(join(reportDir, metaEntry as string), 'utf8'),
    );
    expect(meta).toMatchObject({
      planId: 'big',
      subTaskCount: 2,
      partialSynthesis: false,
      stoppedEarly: false,
      fileSize: Buffer.byteLength(big, 'utf8'),
    });
    expect(typeof meta.totalElapsedMs).toBe('number');
    expect(Array.isArray(meta.skippedSubTaskIds)).toBe(true);
  });

  it('Discord follow-up text contains the artifact path when report exceeds budget', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'big2', VALID_PLAN);
    const big = 'Y'.repeat(4000);
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: big,
    });
    const artifactRoot = join(ws, 'artifacts2');
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanArtifactRoot: artifactRoot,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'big2',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const followText = interaction.followUpReplies
      .map((p) => p?.content ?? JSON.stringify(p))
      .join('\n');
    // Inline body must NOT contain the giant repeated-Y blob.
    expect(followText).not.toContain(big);
    // But the message must reference the artifact path with the plan id
    // in it and the byte-size hint.
    expect(followText).toMatch(/Full report saved to `[^`]+big2-[^`]+\.md`/);
    expect(followText).toContain(`(${big.length} chars)`);
    expect(followText).toContain('Run `cat ');
    expect(followText).toContain('scp');
    // Final follow-up no longer carries the legacy "(truncated N chars)" hint.
    expect(followText).not.toMatch(/truncated \d+ chars\)/);
  });

  it('does not write a research-plan report file when the report fits in the Discord budget', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'small', VALID_PLAN);
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: 'tiny aggregated synthesis',
    });
    const artifactRoot = join(ws, 'artifacts3');
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanArtifactRoot: artifactRoot,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'small',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const reportDir = join(artifactRoot, 'research-plan-reports');
    expect(existsSync(reportDir)).toBe(false);
    const followText = interaction.followUpReplies
      .map((p) => p?.content ?? JSON.stringify(p))
      .join('\n');
    expect(followText).toContain('tiny aggregated synthesis');
    expect(followText).not.toContain('Full report saved to');
  });
});
