import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeExecutionContext,
} from '../src/index.js';
import { renderResearchPlanHeartbeat } from '../src/discord/discord-result-renderer.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

// UX-11 — tool-use heartbeat in `/research-plan` Discord progress.
//
// Two test layers:
//  1. Pure renderer shape (no orchestrator wiring).
//  2. Integration: drive `/research-plan` with a stub driver that emits
//     >5 tool-use events in one sub-task and assert that at least one
//     "🔧" heartbeat follow-up lands before the per-sub-task completion
//     follow-up.

describe('renderResearchPlanHeartbeat (UX-11)', () => {
  it('renders the per-tool-class breakdown sorted alphabetically', () => {
    const payload = renderResearchPlanHeartbeat({
      planId: 'audit-1',
      subTaskId: 'audit-01',
      index: 1,
      total: 12,
      toolCounts: {
        mcp_tool_call: 5,
        agent_message: 2,
        command_execution: 3,
      },
      elapsedMs: 47_500,
    });
    expect(payload.content).toContain('🔧');
    expect(payload.content).toContain('audit-01');
    expect(payload.content).toContain('1/12');
    // Alphabetical: agent_message, command_execution, mcp_tool_call.
    const breakdownIdx = payload.content.indexOf('agent_message');
    expect(breakdownIdx).toBeGreaterThanOrEqual(0);
    expect(payload.content.indexOf('command_execution')).toBeGreaterThan(
      breakdownIdx,
    );
    expect(payload.content.indexOf('mcp_tool_call')).toBeGreaterThan(
      payload.content.indexOf('command_execution'),
    );
    expect(payload.content).toContain('47.5s elapsed');
  });
  it('omits zero-count entries from the breakdown', () => {
    const payload = renderResearchPlanHeartbeat({
      planId: 'p',
      subTaskId: 's',
      index: 1,
      total: 1,
      toolCounts: { mcp_tool_call: 3, web_search: 0, file_change: 0 },
      elapsedMs: 5_000,
    });
    expect(payload.content).toContain('mcp_tool_call=3');
    expect(payload.content).not.toContain('web_search=0');
    expect(payload.content).not.toContain('file_change=0');
  });
  it('falls back to a no-tool-yet sentinel when every count is zero', () => {
    const payload = renderResearchPlanHeartbeat({
      planId: 'p',
      subTaskId: 's',
      index: 1,
      total: 1,
      toolCounts: {},
      elapsedMs: 60_000,
    });
    expect(payload.content).toContain('no tool use yet');
    expect(payload.content).toContain('60.0s elapsed');
  });
});

// Integration suite: dispatch `/research-plan` and observe heartbeat
// follow-ups. The factoryOptions / VALID_PLAN copy the shape used by
// `tests/discord-handle-research-plan.spec.ts`.

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
  const ws = mkdtempSync(join(tmpdir(), 'discord-research-plan-heartbeat-'));
  workspaces.push(ws);
  return ws;
}

function writePlan(ws: string, planId: string, body: unknown): void {
  const dir = join(ws, 'plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${planId}.json`), JSON.stringify(body), 'utf8');
  void existsSync;
}

function createHandlers(driver: RuntimeDriver): DiscordCommandHandlers {
  const dispatcher = {
    requestDispatch: vi.fn(),
    cancel: vi.fn(),
  };
  return new DiscordCommandHandlers({
    arona: { dispatchTask: vi.fn() } as never,
    dispatcher: dispatcher as never,
    taskRegistry: new DiscordTaskRegistry(),
    requestFactory: new DefaultDiscordTaskRequestFactory({
      ...factoryOptions,
      taskIdFactory: () => 'fixed',
    }),
    researchPlanRuntimeDriver: driver,
  });
}

function makeBurstingDriver(toolUsesPerSubTask: number): RuntimeDriver {
  // Stub driver that emits `toolUsesPerSubTask` mcp_tool_call events
  // before completing each sub-task. Exceeds the heartbeat tool-use
  // threshold (5) so at least one heartbeat is expected per sub-task.
  return {
    run: vi.fn(async (context: RuntimeExecutionContext) => {
      for (let i = 0; i < toolUsesPerSubTask; i++) {
        await context.emit({
          kind: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            tool: 'fake_tool',
            arguments: {},
          },
        } as never);
      }
      await context.emit({
        kind: 'item.completed',
        item: {
          type: 'agent_message',
          text: `${context.plan.taskId}-out`,
        },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      } as RuntimeDriverResult;
    }),
  };
}

describe('dispatchResearchPlan heartbeat integration (UX-11)', () => {
  it('emits at least one 🔧 heartbeat per sub-task that exceeds the tool-use threshold', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'burst', VALID_PLAN);
    // 6 mcp_tool_call events crosses the HEARTBEAT_TOOL_THRESHOLD=5
    // gate exactly once per sub-task, so we expect at least 2
    // heartbeat follow-ups (one per sub-task). The synthesis sub-task
    // also bursts, so the total is at least 3.
    const driver = makeBurstingDriver(6);
    const handlers = createHandlers(driver);
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'burst',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      // Allow microtask + 1 flush for the in-process driver to emit
      // every event and for the void this.deliver(...) calls inside
      // the onEvent observer to land on followUpReplies.
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const heartbeatReplies = interaction.followUpReplies.filter((p) =>
      p.content.startsWith('🔧'),
    );
    expect(heartbeatReplies.length).toBeGreaterThanOrEqual(2);
    // Each heartbeat carries the per-tool-class breakdown.
    for (const reply of heartbeatReplies) {
      expect(reply.content).toContain('mcp_tool_call=');
    }
  });
  it('emits a heartbeat when the 60s time-gate is crossed even though the count-gate (5 tools) is not', async () => {
    // UX-18: pin the time-gate invariant. The pre-existing burst test
    // crosses the count-gate; this one isolates the time-gate by keeping
    // tool-uses well under 5 and advancing the spy on Date.now() past
    // 60_000 ms between events. Without the time-gate, the test would
    // observe zero heartbeats; with it, at least the second event in
    // each sub-task (whose Date.now() lies past the 60s mark) trips the
    // gate and posts a 🔧 follow-up.
    let mockNow = 0;
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => mockNow);
    try {
      const ws = makeWorkspace();
      writePlan(ws, 'time-gate', VALID_PLAN);
      const driver: RuntimeDriver = {
        run: vi.fn(async (context: RuntimeExecutionContext) => {
          // Reset mockNow at the start of each sub-task driver call so
          // the heartbeat-state init captures startedMs=0 for each
          // sub-task. The dispatcher's per-sub-task heartbeat reset
          // (onSubTaskCompleted) plus a clean clock here keeps each
          // sub-task isolated.
          mockNow = 0;
          // First tool use — initializes heartbeat state at t=0;
          // toolGate not crossed (1 < 5), timeGate not crossed (sinceLastPost=0).
          await context.emit({
            kind: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              tool: 'fake',
              arguments: {},
            },
          } as never);
          // Advance past the 60s time-gate threshold.
          mockNow = 65_000;
          // Second tool use — toolUseTotal=2 still < 5; sinceLastPost=65000 ≥ 60000 → gate fires.
          await context.emit({
            kind: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              tool: 'fake',
              arguments: {},
            },
          } as never);
          await context.emit({
            kind: 'item.completed',
            item: {
              type: 'agent_message',
              text: `${context.plan.taskId}-out`,
            },
          } as never);
          return {
            cause: { kind: 'success' as const },
            provenance: 'stub',
            reason: 'ok',
          } as RuntimeDriverResult;
        }),
      };
      const handlers = createHandlers(driver);
      const interaction = new FakeDiscordInteraction('research-plan', {
        'plan-id': 'time-gate',
      });
      process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
      try {
        await handlers.handleInteraction(interaction);
        await new Promise((r) => setTimeout(r, 30));
      } finally {
        delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
      }
      const heartbeatReplies = interaction.followUpReplies.filter((p) =>
        p.content.startsWith('🔧'),
      );
      // 2 sub-tasks + 1 synthesis = up to 3 heartbeats; the test only
      // requires that at least one fired (proving the time-gate works).
      expect(heartbeatReplies.length).toBeGreaterThanOrEqual(1);
      // Each heartbeat must carry the per-tool-class breakdown.
      for (const reply of heartbeatReplies) {
        expect(reply.content).toContain('mcp_tool_call=');
      }
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('does not emit a heartbeat for sub-tasks that stay under the threshold', async () => {
    const ws = makeWorkspace();
    writePlan(ws, 'quiet', VALID_PLAN);
    // 2 mcp_tool_call events stay well under the threshold of 5.
    const driver = makeBurstingDriver(2);
    const handlers = createHandlers(driver);
    const interaction = new FakeDiscordInteraction('research-plan', {
      'plan-id': 'quiet',
    });
    process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = join(ws, 'plans');
    try {
      await handlers.handleInteraction(interaction);
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
    }
    const heartbeatReplies = interaction.followUpReplies.filter((p) =>
      p.content.startsWith('🔧'),
    );
    expect(heartbeatReplies.length).toBe(0);
    // The per-sub-task completion follow-ups (✅) still arrive.
    const completedReplies = interaction.followUpReplies.filter((p) =>
      p.content.startsWith('✅'),
    );
    expect(completedReplies.length).toBeGreaterThanOrEqual(2);
  });
});
