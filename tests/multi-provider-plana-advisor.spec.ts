import { describe, expect, it, vi } from 'vitest';

import {
  MultiProviderPlanaAdvisor,
  type MultiProviderPlanaSettingsProvider,
} from '../src/core/multi-provider-plana-advisor.js';
import type {
  PlanaAdvisorInput,
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from '../src/core/plana-runtime-advisor.js';
import { createDispatchPlan } from '../src/core/task.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function trivialInput(): PlanaAdvisorInput {
  const plan = createDispatchPlan(createTaskRequest('task-pa'));
  return {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: 'instance-pa',
      createdAt: '2026-05-07T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    event: {
      kind: 'item.completed',
      timestamp: '2026-05-07T00:00:00.000Z',
      instanceId: 'instance-pa',
      item: {
        type: 'agent_message',
        summary: 'agent reply',
      },
    } as unknown as PlanaAdvisorInput['event'],
  };
}

function stubAdvisor(provenance: string): {
  advisor: PlanaRuntimeAdvisor;
  review: ReturnType<typeof vi.fn>;
} {
  const verdict: PlanaAdvisorVerdict = {
    status: 'veto',
    reason: `${provenance}-said-no`,
    provenance,
  };
  const review = vi.fn().mockResolvedValue(verdict);
  return { advisor: { review }, review };
}

describe('MultiProviderPlanaAdvisor (spec §1.5.0)', () => {
  it('routes to claude advisor when no override is set and default is claude', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'claude-agent',
    });
    const verdict = await advisor.review(trivialInput());
    expect(claude.review).toHaveBeenCalledTimes(1);
    expect(codex.review).not.toHaveBeenCalled();
    expect(verdict.status).toBe('veto');
    if (verdict.status === 'veto') {
      expect(verdict.provenance).toBe('plana-claude-runtime-advisor');
    }
  });

  it('routes to codex advisor when plana provider override is set', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    const provider: MultiProviderPlanaSettingsProvider = {
      readSettings: () => ({ provider: 'codex' }),
    };
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'claude-agent',
      settingsProvider: provider,
    });
    await advisor.review(trivialInput());
    expect(codex.review).toHaveBeenCalledTimes(1);
    expect(claude.review).not.toHaveBeenCalled();
  });

  it('toggles per call as the override flips', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    let active: 'codex' | 'claude-agent' | undefined = undefined;
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'claude-agent',
      settingsProvider: {
        readSettings: () => (active === undefined ? {} : { provider: active }),
      },
    });
    await advisor.review(trivialInput()); // default → claude
    active = 'codex';
    await advisor.review(trivialInput()); // override → codex
    active = 'claude-agent';
    await advisor.review(trivialInput()); // override → claude
    active = undefined;
    await advisor.review(trivialInput()); // default → claude
    expect(claude.review).toHaveBeenCalledTimes(3);
    expect(codex.review).toHaveBeenCalledTimes(1);
  });

  it('falls back to default when the settings provider throws', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'codex',
      settingsProvider: {
        readSettings: () => {
          throw new Error('store broken');
        },
      },
    });
    await advisor.review(trivialInput());
    expect(codex.review).toHaveBeenCalledTimes(1);
    expect(claude.review).not.toHaveBeenCalled();
  });

  it('emits the optional onProviderSelected hook with source attribution', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    const observed: Array<Record<string, unknown>> = [];
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'claude-agent',
      settingsProvider: { readSettings: () => ({ provider: 'codex' }) },
      onProviderSelected: (sel) => observed.push({ ...sel }),
    });
    await advisor.review(trivialInput());
    expect(observed).toEqual([
      {
        provider: 'codex',
        source: 'override',
        defaultProvider: 'claude-agent',
      },
    ]);
  });

  it('swallows observer errors so advisor calls are never broken by audit failures', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'claude-agent',
      onProviderSelected: () => {
        throw new Error('audit hook broken');
      },
    });
    const verdict = await advisor.review(trivialInput());
    expect(verdict.status).toBe('veto');
  });

  it('rejects unknown override values with a fallback to default', async () => {
    const codex = stubAdvisor('plana-codex-runtime-advisor');
    const claude = stubAdvisor('plana-claude-runtime-advisor');
    const advisor = new MultiProviderPlanaAdvisor({
      codexAdvisor: codex.advisor,
      claudeAdvisor: claude.advisor,
      defaultProvider: 'claude-agent',
      settingsProvider: {
        // @ts-expect-error testing wide-input branch
        readSettings: () => ({ provider: 'gemini' }),
      },
    });
    await advisor.review(trivialInput());
    expect(claude.review).toHaveBeenCalledTimes(1);
    expect(codex.review).not.toHaveBeenCalled();
  });
});
