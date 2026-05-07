import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY,
  DEFAULT_RESEARCH_PLAN_DIRECTORY,
  ResearchPlanLoaderError,
  loadResearchPlan,
  resolveResearchPlanDirectory,
  resolveResearchPlanPath,
} from '../src/discord/research-plan-loader.js';

let workspaces: string[] = [];

afterEach(() => {
  for (const ws of workspaces) {
    rmSync(ws, { recursive: true, force: true });
  }
  workspaces = [];
});

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'research-plan-loader-'));
  workspaces.push(ws);
  return ws;
}

const VALID_PLAN = {
  subTasks: [
    { taskId: 'st1', instruction: 'do thing 1' },
    { taskId: 'st2', instruction: 'do thing 2' },
  ],
  synthesis: {
    taskId: 'synth',
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

describe('research-plan-loader', () => {
  it('defaults to runtime-state/research-plans relative to cwd', () => {
    const cwd = '/tmp/my-cwd';
    expect(resolveResearchPlanDirectory({}, cwd)).toBe(
      join(cwd, DEFAULT_RESEARCH_PLAN_DIRECTORY),
    );
  });

  it('honors AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY when set', () => {
    const cwd = '/tmp/my-cwd';
    expect(
      resolveResearchPlanDirectory(
        { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: 'custom/plans' },
        cwd,
      ),
    ).toBe(join(cwd, 'custom/plans'));
  });

  it('keeps absolute env paths intact', () => {
    expect(
      resolveResearchPlanDirectory(
        { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: '/var/research-plans' },
        '/some/cwd',
      ),
    ).toBe('/var/research-plans');
  });

  it('rejects plan-ids with path separators', () => {
    expect(() => resolveResearchPlanPath('../../etc/passwd', {}, '/x')).toThrow(
      /must match/,
    );
    expect(() => resolveResearchPlanPath('a/b', {}, '/x')).toThrow(/must match/);
    expect(() => resolveResearchPlanPath('a b', {}, '/x')).toThrow(/must match/);
  });

  it('accepts safe plan-ids', () => {
    expect(resolveResearchPlanPath('quickstart', {}, '/x')).toBe(
      '/x/runtime-state/research-plans/quickstart.json',
    );
    expect(resolveResearchPlanPath('multi-provider.audit_v2', {}, '/x')).toBe(
      '/x/runtime-state/research-plans/multi-provider.audit_v2.json',
    );
  });

  it('loads + validates a well-formed plan', () => {
    const ws = makeWorkspace();
    const dir = join(ws, 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'good.json'),
      JSON.stringify(VALID_PLAN),
      'utf8',
    );
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: dir };
    const plan = loadResearchPlan('good', env);
    expect(plan.subTasks).toHaveLength(2);
    expect(plan.synthesis.taskId).toBe('synth');
  });

  it('throws when the plan file is missing', () => {
    const ws = makeWorkspace();
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws };
    expect(() => loadResearchPlan('missing', env)).toThrow(ResearchPlanLoaderError);
    try {
      loadResearchPlan('missing', env);
    } catch (e) {
      expect((e as Error).message).toMatch(/failed to read plan/);
    }
  });

  it('throws on malformed JSON', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'bad.json'), '{not json', 'utf8');
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws };
    expect(() => loadResearchPlan('bad', env)).toThrow(/not valid JSON/);
  });

  it('throws when subTasks is empty', () => {
    const ws = makeWorkspace();
    const plan = { ...VALID_PLAN, subTasks: [] };
    writeFileSync(join(ws, 'empty.json'), JSON.stringify(plan), 'utf8');
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws };
    expect(() => loadResearchPlan('empty', env)).toThrow(/non-empty .subTasks/);
  });

  it('throws on duplicate sub-task ids', () => {
    const ws = makeWorkspace();
    const plan = {
      ...VALID_PLAN,
      subTasks: [
        { taskId: 'dup', instruction: 'a' },
        { taskId: 'dup', instruction: 'b' },
      ],
    };
    writeFileSync(join(ws, 'dup.json'), JSON.stringify(plan), 'utf8');
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws };
    expect(() => loadResearchPlan('dup', env)).toThrow(/duplicate taskId/);
  });

  it('throws when synthesis taskId collides with a sub-task', () => {
    const ws = makeWorkspace();
    const plan = {
      ...VALID_PLAN,
      synthesis: { taskId: 'st1', instructionTemplate: 'x' },
    };
    writeFileSync(join(ws, 'collide.json'), JSON.stringify(plan), 'utf8');
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws };
    expect(() => loadResearchPlan('collide', env)).toThrow(/collides with a sub-task/);
  });

  it('throws when runtimeSettings or resources is missing', () => {
    const ws = makeWorkspace();
    const plan = { ...VALID_PLAN } as Record<string, unknown>;
    delete plan.runtimeSettings;
    writeFileSync(join(ws, 'incomplete.json'), JSON.stringify(plan), 'utf8');
    const env = { [AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]: ws };
    expect(() => loadResearchPlan('incomplete', env)).toThrow(/runtimeSettings/);
  });
});
