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

import type { RosterEvent } from '../src/contracts/subagent-roster-event.js';
import {
  AgentRuntime,
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordResearchMissionStore,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeExecutionContext,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import type { SubagentEvidenceLedgerSink } from '../src/runtime/agent-runtime.js';
import {
  createSubagentRosterRegistry,
  type SubagentRosterRegistry,
} from '../src/runtime/subagent-roster-registry.js';
import { FakeDiscordInteraction, flushDiscordAsyncWork } from './helpers/discord.js';

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
  researchPlanSubagentPolicyEnforcer?: import('../src/runtime/subagent-policy-enforcer.js').SubagentPolicyEnforcer;
  researchPlanUseSubagentRoster?: boolean;
  researchPlanSubagentRosterRegistry?: SubagentRosterRegistry;
  researchPlanSubagentEvidenceLedgerSink?: SubagentEvidenceLedgerSink;
  researchMissions?: DiscordResearchMissionStore;
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
    ...(options.researchPlanSubagentPolicyEnforcer === undefined
      ? {}
      : {
          researchPlanSubagentPolicyEnforcer:
            options.researchPlanSubagentPolicyEnforcer,
        }),
    ...(options.researchPlanUseSubagentRoster === undefined
      ? {}
      : {
          researchPlanUseSubagentRoster: options.researchPlanUseSubagentRoster,
        }),
    ...(options.researchPlanSubagentRosterRegistry === undefined
      ? {}
      : {
          researchPlanSubagentRosterRegistry:
            options.researchPlanSubagentRosterRegistry,
        }),
    ...(options.researchPlanSubagentEvidenceLedgerSink === undefined
      ? {}
      : {
          researchPlanSubagentEvidenceLedgerSink:
            options.researchPlanSubagentEvidenceLedgerSink,
        }),
    ...(options.researchMissions === undefined
      ? {}
      : { researchMissions: options.researchMissions }),
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

  it('keeps standalone /research-plan dispatch detached from mission evidence', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'standalone', VALID_PLAN);
    const researchMissions = new DiscordResearchMissionStore({
      idFactory: () => 'standalone',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    const mission = researchMissions.createDraft({
      goal: 'Standalone research-plan should not mutate mission evidence',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: 'standalone synthesis',
    });
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchMissions,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'standalone',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await flushDiscordAsyncWork();
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }

    expect(driver.run).toHaveBeenCalledTimes(3);
    expect(researchMissions.listEvidence(mission.missionId)).toEqual([]);
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
    // UX-5: humanized cause label replaces the legacy `cause=…` form.
    expect(followText).toContain('provider error');
    // UX-2: the early-stop message includes the cause kind in plain text
    // and a 💡 actionable hint line.
    expect(followText).toContain('Last cause: provider-failure');
    expect(followText).toContain('plan stopped early');
    expect(followText).toContain('💡');
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
    // P3-def-2: with attachment-attached text, the message references the
    // attachment first and the artifact path as a fallback. The plan-id-
    // bearing artifact filename is still surfaced verbatim so operators
    // who prefer host-side access can locate it without scp.
    expect(followText).toMatch(
      /Full report attached above; also at `[^`]+big2-[^`]+\.md`/,
    );
    expect(followText).toContain(`(${big.length} chars)`);
    // Fallback hint still mentions cat for operators without Discord
    // download capability.
    expect(followText).toContain('`cat ');
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

  it('research-plan final follow-up includes attachment when report exceeds budget', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'attached', VALID_PLAN);
    const big = 'Z'.repeat(4500);
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: big,
    });
    const artifactRoot = join(ws, 'artifacts-attached');
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanArtifactRoot: artifactRoot,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'attached',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    // The final follow-up payload — the one referencing the artifact —
    // must carry an attachments array with a single { name, path } entry.
    const finalPayloads = interaction.followUpReplies.filter((p) =>
      p.content.includes('Full report attached above'),
    );
    expect(finalPayloads).toHaveLength(1);
    const finalPayload = finalPayloads[0];
    expect(finalPayload).toBeDefined();
    expect(finalPayload?.attachments).toBeDefined();
    expect(finalPayload?.attachments).toHaveLength(1);
    const attachment = finalPayload?.attachments?.[0];
    // Discord-visible filename uses the plan id with .md suffix.
    expect(attachment?.name).toBe('attached.md');
    // Path points to the on-disk artifact root we configured.
    expect(typeof attachment?.path).toBe('string');
    expect(attachment?.path.startsWith(artifactRoot)).toBe(true);
    expect(attachment?.path.endsWith('.md')).toBe(true);
    // The persisted artifact actually exists at the named path so a
    // downstream Discord upload would succeed.
    expect(existsSync(attachment?.path as string)).toBe(true);
  });

  it('research-plan final follow-up has no attachment when report fits in budget', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'small-noattach', VALID_PLAN);
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: 'tiny synthesis under the budget',
    });
    const artifactRoot = join(ws, 'artifacts-small');
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanArtifactRoot: artifactRoot,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'small-noattach',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    // No follow-up should carry an attachments array — the report fits
    // inline so no on-disk artifact was persisted.
    for (const reply of interaction.followUpReplies) {
      expect(reply.attachments).toBeUndefined();
    }
    // And the existing inline-text path is preserved.
    const followText = interaction.followUpReplies
      .map((p) => p?.content ?? JSON.stringify(p))
      .join('\n');
    expect(followText).toContain('tiny synthesis under the budget');
    expect(followText).not.toContain('Full report attached above');
  });

  // P4 Stage 4-6 Commit 3 — production caller activation invariants.
  it('routes sub-tasks through roster.spawnAndRun when researchPlanUseSubagentRoster is true', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'roster-on', VALID_PLAN);
    const seenChildTaskIds: string[] = [];
    const registry = createSubagentRosterRegistry();
    const registrySnapshots: Array<{
      readonly registered: number;
      readonly active: number;
    }> = [];
    const registeredTaskIds: string[] = [];
    const rosterEvents: RosterEvent[] = [];
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: 'synth-output',
    });
    const originalRun = driver.run;
    const wrappedRun: RuntimeDriver['run'] = async (
      context: RuntimeExecutionContext,
    ) => {
      seenChildTaskIds.push(context.plan.taskId);
      registrySnapshots.push({
        registered: registry.list().length,
        active: registry.totals().active,
      });
      const registration = registry.list()[0];
      if (registration !== undefined) {
        registeredTaskIds.push(registration.taskId);
      }
      return originalRun(context);
    };
    const wrappedDriver: RuntimeDriver = { run: wrappedRun };
    const { SubagentPolicyEnforcer } = await import(
      '../src/runtime/subagent-policy-enforcer.js'
    );
    const policyEnforcer = new SubagentPolicyEnforcer({
      policy: {
        maxDepth: 1,
        maxConcurrent: 2,
        allowedRoles: ['explorer', 'coder', 'writer', 'verifier'],
        blockedToolNames: [],
        warnAtPercent: 0.8,
      },
    });
    const handlers = createHandlers({
      researchPlanRuntimeDriver: wrappedDriver,
      researchPlanSubagentPolicyEnforcer: policyEnforcer,
      researchPlanUseSubagentRoster: true,
      researchPlanSubagentRosterRegistry: registry,
      researchPlanSubagentEvidenceLedgerSink: (event) => {
        rosterEvents.push(event);
      },
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'roster-on',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 20));
      await flushDiscordAsyncWork();
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    // The roster-routed dispatch path constructs child task ids of the
    // form `${parentTaskId}.sub-${subagentId}`. Every sub-task driver
    // run must therefore see a child id containing `.sub-` rather than
    // the raw plan sub-task id (`st1`/`st2`/`synth`).
    expect(seenChildTaskIds.length).toBeGreaterThanOrEqual(2);
    for (const seen of seenChildTaskIds) {
      expect(seen).toContain('.sub-');
    }
    // The direct `/research-plan` roster must be visible through the same
    // service-scope registry used by `/subagents list` while each child is
    // in flight, then unregister after dispatch cleanup.
    expect(
      registrySnapshots.some(
        (snapshot) => snapshot.registered === 1 && snapshot.active >= 1,
      ),
    ).toBe(true);
    expect(registry.list()).toHaveLength(0);

    const eventKinds = rosterEvents.map((event) => event.kind);
    expect(eventKinds.filter((kind) => kind === 'subagent.spawned')).toHaveLength(
      3,
    );
    expect(
      eventKinds.filter((kind) => kind === 'subagent.completed'),
    ).toHaveLength(3);
    expect(
      eventKinds.filter((kind) => kind === 'roster.progress').length,
    ).toBeGreaterThanOrEqual(3);
    const eventParentTaskIds = new Set(
      rosterEvents.map((event) => event.correlationKey.taskId),
    );
    expect(eventParentTaskIds.size).toBe(1);
    expect(registeredTaskIds).toContain([...eventParentTaskIds][0]);
  });

  it('keeps legacy driver.run path when researchPlanUseSubagentRoster is omitted', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'roster-off', VALID_PLAN);
    const seenChildTaskIds: string[] = [];
    const driver = makeStubDriver({
      st1: 'st1-output',
      st2: 'st2-output',
      synth: 'synth-output',
    });
    const originalRun = driver.run;
    const wrappedRun: RuntimeDriver['run'] = async (
      context: RuntimeExecutionContext,
    ) => {
      seenChildTaskIds.push(context.plan.taskId);
      return originalRun(context);
    };
    const wrappedDriver: RuntimeDriver = { run: wrappedRun };
    const handlers = createHandlers({
      researchPlanRuntimeDriver: wrappedDriver,
      // policy enforcer + flag both omitted → legacy path
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'roster-off',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    // The legacy path uses the plan's sub-task taskIds directly with no
    // `.sub-` prefix — preserving the bit-for-bit pre-Stage-4-6 behavior
    // when the operator has not opted in.
    expect(seenChildTaskIds.length).toBeGreaterThanOrEqual(2);
    for (const seen of seenChildTaskIds) {
      expect(seen).not.toContain('.sub-');
    }
  });

  // UX-6 — accepted reply enrichment.
  it('accepted reply mentions per-sub-task progress and the 15-min warning', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'enriched', VALID_PLAN);
    const driver = makeStubDriver({
      st1: 'a',
      st2: 'b',
      synth: 'c',
    });
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'enriched',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const accepted =
      interaction.editedReplies[0]?.content ??
      JSON.stringify(interaction.editedReplies[0]);
    expect(accepted).toContain('Per-sub-task progress will follow');
    expect(accepted).toContain('15-min');
    // Subagent-roster line is omitted when the opt-in flag is off.
    expect(accepted).not.toContain('/subagents list');
  });

  it('accepted reply mentions /subagents surfaces when the roster opt-in is active', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'roster-accepted', VALID_PLAN);
    const driver = makeStubDriver({
      st1: 'a',
      st2: 'b',
      synth: 'c',
    });
    const { SubagentPolicyEnforcer } = await import(
      '../src/runtime/subagent-policy-enforcer.js'
    );
    const policyEnforcer = new SubagentPolicyEnforcer({
      policy: {
        maxDepth: 1,
        maxConcurrent: 2,
        allowedRoles: ['explorer', 'coder', 'writer', 'verifier'],
        blockedToolNames: [],
        warnAtPercent: 0.8,
      },
    });
    const handlers = createHandlers({
      researchPlanRuntimeDriver: driver,
      researchPlanSubagentPolicyEnforcer: policyEnforcer,
      researchPlanUseSubagentRoster: true,
    });
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'roster-accepted',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const accepted =
      interaction.editedReplies[0]?.content ??
      JSON.stringify(interaction.editedReplies[0]);
    expect(accepted).toContain('/subagents list');
    expect(accepted).toContain('/subagents kill');
  });
});
