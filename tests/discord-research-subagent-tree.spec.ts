import { describe, expect, it } from 'vitest';

import {
  renderResearchSubagentSpawnPreflight,
  renderResearchSubagentTreePreflight,
} from '../src/discord/discord-result-renderer.js';
import type { SubagentDescriptor } from '../src/contracts/subagent-roster.js';

function descriptor(
  override: Partial<SubagentDescriptor> = {},
): SubagentDescriptor {
  return {
    subagentId: override.subagentId ?? 'subagent-collector-1',
    role: override.role ?? 'collector',
    parent: override.parent ?? {
      taskId: 'discord-research-mission-plan-R-20260510-tree-1',
      instanceId: 'inst-1',
    },
    createdAt: override.createdAt ?? '2026-05-10T00:00:00.000Z',
    state: override.state ?? 'active',
    envelope: Object.freeze({
      capabilities: Object.freeze({}),
      compute: Object.freeze({}),
    }) as unknown as SubagentDescriptor['envelope'],
  };
}

describe('renderResearchSubagentTreePreflight', () => {
  it('renders the research role map and active mission matches without mutation claims', () => {
    const payload = renderResearchSubagentTreePreflight({
      missionId: 'R-20260510-tree',
      operatorConfigured: true,
      descriptors: [
        descriptor(),
        descriptor({
          subagentId: 'subagent-critic-1',
          role: 'critic',
          state: 'reserved',
        }),
      ],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain(
      'Research subagent tree preflight for `R-20260510-tree`',
    );
    expect(payload.content).toContain('- planner:');
    expect(payload.content).toContain('- collector:');
    expect(payload.content).toContain('- experimenter:');
    expect(payload.content).toContain('- critic:');
    expect(payload.content).toContain('- synthesizer:');
    expect(payload.content).toContain('- archivist:');
    expect(payload.content).toContain(
      'Expected child output: summary, claims, evidence, uncertainties, recommendedNextSteps.',
    );
    expect(payload.content).toContain(
      '- subagent-collector-1 role=collector state=active parent=discord-research-mission-plan-R-20260510-tree-1/inst-1',
    );
    expect(payload.content).toContain(
      '- subagent-critic-1 role=critic state=reserved parent=discord-research-mission-plan-R-20260510-tree-1/inst-1',
    );
    expect(payload.content).toContain('no spawn, kill, steer, log read');
    expect(payload.content).toContain('no proof mutation');
    expect(payload.content).toContain('no archive mutation');
    expect(payload.content).toContain('no live service contact');
  });

  it('surfaces operator-unavailable and empty-match states explicitly', () => {
    const unavailable = renderResearchSubagentTreePreflight({
      missionId: '<@1234567890>',
      operatorConfigured: false,
    });
    expect(unavailable.content).toContain('R');
    expect(unavailable.content).toContain(
      'subagent operator surface is not configured',
    );
    expect(unavailable.content).not.toContain('<@1234567890>');

    const empty = renderResearchSubagentTreePreflight({
      missionId: 'R-20260510-tree',
      operatorConfigured: true,
      descriptors: [],
    });
    expect(empty.content).toContain('none matched');
    expect(empty.content).toContain('/subagents action:tree mission_id:<id>');
  });

  it('sanitizes descriptor fields before rendering active matches', () => {
    const payload = renderResearchSubagentTreePreflight({
      missionId: 'R-20260510-tree',
      operatorConfigured: true,
      descriptors: [
        descriptor({
          subagentId: '<@1234567890> `collector`',
          role: '@everyone `critic`',
          parent: {
            taskId: 'discord-research-mission-plan-R-20260510-tree-<@&123>',
            instanceId: '`inst`',
          },
        }),
      ],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('<@​1234567890>');
    expect(payload.content).toContain('@​everyone');
    expect(payload.content).toContain('ʼcollectorʼ');
    expect(payload.content).toContain('ʼcriticʼ');
    expect(payload.content).toContain('ʼinstʼ');
    expect(payload.content).not.toContain('<@1234567890>');
    expect(payload.content).not.toContain('@everyone');
  });
});

describe('renderResearchSubagentSpawnPreflight', () => {
  it('renders a role-specific spawn envelope preview without claiming live spawn', () => {
    const payload = renderResearchSubagentSpawnPreflight({
      missionId: 'R-20260510-spawn',
      role: 'collector',
      task: 'OpenClaw subagent UX 근거 정리',
      operatorConfigured: true,
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain(
      'Research subagent spawn preflight for `R-20260510-spawn`',
    );
    expect(payload.content).toContain('Status: role envelope preview only');
    expect(payload.content).toContain(
      'Role: collector — collect sources, artifacts, and retained evidence candidates',
    );
    expect(payload.content).toContain('Task: OpenClaw subagent UX 근거 정리');
    expect(payload.content).toContain(
      'Depth policy (informational; no spawn occurs here): depth 1 root-owned only',
    );
    expect(payload.content).toContain(
      'Planned child output schema (when later wired): summary, claims[], evidence[], uncertainties[], recommendedNextSteps[].',
    );
    expect(payload.content).toContain('no subagent spawn');
    expect(payload.content).toContain('no provider session');
    expect(payload.content).toContain('no proof/archive mutation');
    expect(payload.content).toContain('no live service contact');
  });

  it('sanitizes mission and task text in the spawn preflight', () => {
    const payload = renderResearchSubagentSpawnPreflight({
      missionId: '<@1234567890>',
      role: 'critic',
      task: '@everyone `challenge the claim`',
      operatorConfigured: false,
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('<@​1234567890>');
    expect(payload.content).toContain('@​everyone');
    expect(payload.content).toContain('ʼchallenge the claimʼ');
    expect(payload.content).toContain('not configured');
    expect(payload.content).not.toContain('<@1234567890>');
    expect(payload.content).not.toContain('@everyone');
    expect(payload.content).not.toContain('`challenge the claim`');
  });
});
