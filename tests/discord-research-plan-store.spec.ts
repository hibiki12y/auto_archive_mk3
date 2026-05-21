import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DiscordResearchPlanStore,
} from '../src/index.js';
import { AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY } from '../src/discord/research-plan-loader.js';

const VALID_PLAN = {
  subTasks: [
    { taskId: 'collect-baseline', instruction: 'collect baseline' },
    { taskId: 'audit-current', instruction: 'audit current implementation' },
  ],
  synthesis: {
    taskId: 'synthesize',
    instructionTemplate: 'combine {{subTaskOutputs}}',
  },
  runtimeSettings: {
    networkProfile: 'provider-only',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    workingDirectory: '.',
  },
  resources: {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
  },
};

let workspaces: string[] = [];

afterEach(() => {
  for (const ws of workspaces) {
    rmSync(ws, { recursive: true, force: true });
  }
  workspaces = [];
});

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'discord-research-plan-store-'));
  workspaces.push(ws);
  return ws;
}

describe('DiscordResearchPlanStore', () => {
  it('loads an existing /research-plan JSON file and returns a compact summary', () => {
    const ws = makeWorkspace();
    const dir = join(ws, 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phase-1.json'), JSON.stringify(VALID_PLAN), 'utf8');

    const store = new DiscordResearchPlanStore({
      env: { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: dir },
    });

    const lookup = store.inspect('phase-1');

    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') {
      throw new Error('expected found lookup');
    }
    expect(lookup.summary).toMatchObject({
      planId: 'phase-1',
      subTaskCount: 2,
      synthesisTaskId: 'synthesize',
    });
    expect(lookup.summary.path).toBe(join(dir, 'phase-1.json'));
    expect(lookup.plan.subTasks[0]?.taskId).toBe('collect-baseline');
  });

  it('returns an unavailable result instead of throwing on invalid or missing plan ids', () => {
    const ws = makeWorkspace();
    const store = new DiscordResearchPlanStore({
      env: { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws },
    });

    expect(store.inspect('missing')).toMatchObject({
      status: 'unavailable',
      planId: 'missing',
    });
    expect(store.inspect('../unsafe')).toMatchObject({
      status: 'unavailable',
      planId: '../unsafe',
    });
  });

  it('rejects unsafe plan ids before invoking the plan loader', () => {
    let loadCalls = 0;
    const store = new DiscordResearchPlanStore({
      loadPlan: () => {
        loadCalls += 1;
        throw new Error('loader should not run for unsafe ids');
      },
    });

    expect(store.inspect('../unsafe')).toMatchObject({
      status: 'unavailable',
      planId: '../unsafe',
    });
    expect(loadCalls).toBe(0);
  });
});
