import { describe, expect, it } from 'vitest';

import { BoundaryValidationError } from '../src/contracts/boundary-validators.js';
import {
  bindAgentHarnessDriver,
  buildAgentHarnessRegistryReport,
  selectAgentHarnessPlugin,
} from '../src/runtime/agent-harness-registry.js';
import type {
  AgentHarnessPlugin,
  AgentHarnessSupportContext,
} from '../src/contracts/agent-harness-plugin.js';
import type { RuntimeDriver } from '../src/contracts/runtime-driver.js';

const context: AgentHarnessSupportContext = {
  provider: 'codex',
  source: 'eager',
  selectedAt: '2026-05-05T00:00:00.000Z',
};

const baseDriver: RuntimeDriver = {
  async run() {
    throw new Error('not exercised');
  },
};

function plugin(
  id: string,
  supported: boolean,
  priority = 0,
  wrappedDriver: RuntimeDriver = baseDriver,
): AgentHarnessPlugin {
  return {
    id,
    supports() {
      if (!supported) {
        return { supported: false, reason: 'provider not supported' };
      }
      return { supported: true, priority };
    },
    wrapDriver() {
      return wrappedDriver;
    },
  };
}

describe('selectAgentHarnessPlugin', () => {
  it('rejects duplicate harness plugin identifiers', () => {
    expect(() =>
      selectAgentHarnessPlugin({
        context,
        plugins: [
          plugin('harness.duplicate', true),
          plugin('harness.duplicate', true),
        ],
      }),
    ).toThrow(BoundaryValidationError);
  });

  it('rejects empty or whitespace-padded harness plugin identifiers', () => {
    expect(() =>
      selectAgentHarnessPlugin({
        context,
        plugins: [plugin('  ', true)],
      }),
    ).toThrow(BoundaryValidationError);

    expect(() =>
      selectAgentHarnessPlugin({
        context,
        plugins: [plugin(' harness.trim ', true)],
      }),
    ).toThrow(BoundaryValidationError);
  });

  it('selects the highest-priority supported plugin', () => {
    const selected = selectAgentHarnessPlugin({
      context,
      plugins: [
        plugin('harness.low', true, 1),
        plugin('harness.high', true, 3),
      ],
    });

    expect(selected.plugin.id).toBe('harness.high');
    expect(selected.binding).toEqual({
      harnessId: 'harness.high',
      provider: 'codex',
      source: 'eager',
      boundAt: '2026-05-05T00:00:00.000Z',
    });
  });

  it('preserves declaration order when supported plugins tie on priority', () => {
    const selected = selectAgentHarnessPlugin({
      context,
      plugins: [
        plugin('harness.first', true, 1),
        plugin('harness.second', true, 1),
      ],
    });

    expect(selected.plugin.id).toBe('harness.first');
  });

  it('fails closed when no configured plugin supports the selected provider', () => {
    expect(() =>
      selectAgentHarnessPlugin({
        context,
        plugins: [plugin('harness.unsupported', false)],
      }),
    ).toThrow(BoundaryValidationError);
  });

  it('normalizes supports() exceptions to BoundaryValidationError', () => {
    const throwingPlugin: AgentHarnessPlugin = {
      id: 'harness.supports.throws',
      supports() {
        throw new Error('supports exploded');
      },
      wrapDriver() {
        return baseDriver;
      },
    };

    expect(() =>
      selectAgentHarnessPlugin({
        context,
        plugins: [throwingPlugin],
      }),
    ).toThrow(BoundaryValidationError);
  });

  it('rejects non-finite supported priorities', () => {
    expect(() =>
      selectAgentHarnessPlugin({
        context,
        plugins: [plugin('harness.infinity', true, Number.POSITIVE_INFINITY)],
      }),
    ).toThrow(BoundaryValidationError);
  });
});

describe('buildAgentHarnessRegistryReport', () => {
  it('explains selected and unsupported harness plugins without wrapping a driver', () => {
    let wrapCalled = false;
    const report = buildAgentHarnessRegistryReport({
      context,
      generatedAt: '2026-05-05T00:01:00.000Z',
      plugins: [
        {
          id: 'harness.claude-only',
          label: 'Claude-only harness',
          supports(receivedContext) {
            if (receivedContext.provider !== 'claude-agent') {
              return { supported: false, reason: 'claude-agent only' };
            }
            return { supported: true, priority: 10 };
          },
          wrapDriver(input) {
            wrapCalled = true;
            return input.driver;
          },
        },
        {
          id: 'harness.codex-low',
          supports() {
            return { supported: true, priority: 1, reason: 'fallback codex' };
          },
          wrapDriver(input) {
            wrapCalled = true;
            return input.driver;
          },
        },
        {
          id: 'harness.codex-high',
          label: 'Codex research harness',
          supports() {
            return { supported: true, priority: 5, reason: 'research UX' };
          },
          wrapDriver(input) {
            wrapCalled = true;
            return input.driver;
          },
        },
      ],
    });

    expect(report).toMatchObject({
      generatedAt: '2026-05-05T00:01:00.000Z',
      pluginCount: 3,
      status: 'selected',
      context,
      boundary: {
        readOnly: true,
        wrapDriverCalled: false,
        providerSwitching: false,
      },
      selected: {
        pluginId: 'harness.codex-high',
        label: 'Codex research harness',
        declarationIndex: 2,
        priority: 5,
        reason: 'research UX',
        binding: {
          harnessId: 'harness.codex-high',
          provider: 'codex',
          source: 'eager',
          boundAt: '2026-05-05T00:00:00.000Z',
        },
      },
    });
    expect(report.entries).toEqual([
      {
        pluginId: 'harness.claude-only',
        label: 'Claude-only harness',
        declarationIndex: 0,
        supported: false,
        reason: 'claude-agent only',
      },
      {
        pluginId: 'harness.codex-low',
        declarationIndex: 1,
        supported: true,
        priority: 1,
        reason: 'fallback codex',
      },
      {
        pluginId: 'harness.codex-high',
        label: 'Codex research harness',
        declarationIndex: 2,
        supported: true,
        priority: 5,
        reason: 'research UX',
      },
    ]);
    expect(report.configurationErrors).toEqual([]);
    expect(report.recommendations).toEqual([]);
    expect(wrapCalled).toBe(false);
  });

  it('diagnoses no-plugin and no-supported-plugin registry states', () => {
    const noPluginsReport = buildAgentHarnessRegistryReport({
      context,
      plugins: [],
      generatedAt: '2026-05-05T00:01:00.000Z',
    });

    expect(noPluginsReport.status).toBe('no-plugins');
    expect(noPluginsReport.selected).toBeNull();
    expect(noPluginsReport.recommendations[0]).toContain(
      'RuntimeDriver will remain unwrapped',
    );

    const noSupportedReport = buildAgentHarnessRegistryReport({
      context,
      plugins: [plugin('harness.unsupported', false)],
      generatedAt: '2026-05-05T00:01:00.000Z',
    });

    expect(noSupportedReport.status).toBe('no-supported-plugin');
    expect(noSupportedReport.selected).toBeNull();
    expect(noSupportedReport.entries[0]).toMatchObject({
      pluginId: 'harness.unsupported',
      supported: false,
      reason: 'provider not supported',
    });
    expect(noSupportedReport.recommendations[0]).toContain(
      'No AgentHarnessPlugin supports provider "codex"',
    );
  });

  it('surfaces invalid registry configuration without selecting a harness', () => {
    const throwingPlugin: AgentHarnessPlugin = {
      id: 'harness.supports.throws',
      supports() {
        throw new Error('supports exploded');
      },
      wrapDriver(input) {
        return input.driver;
      },
    };

    const report = buildAgentHarnessRegistryReport({
      context,
      generatedAt: '2026-05-05T00:01:00.000Z',
      plugins: [
        plugin(' harness.trim ', true),
        plugin('harness.duplicate', true),
        plugin('harness.duplicate', true),
        throwingPlugin,
        plugin('harness.infinity', true, Number.POSITIVE_INFINITY),
      ],
    });

    expect(report.status).toBe('invalid-plugin-configuration');
    expect(report.selected).toBeNull();
    expect(report.configurationErrors).toHaveLength(4);
    expect(report.configurationErrors.map((error) => error.message)).toEqual([
      'AgentHarnessPlugin.id must be a non-empty string without surrounding whitespace.',
      'Duplicate AgentHarnessPlugin.id "harness.duplicate" is not allowed.',
      'AgentHarnessPlugin "harness.supports.throws" supports() threw: supports exploded.',
      'AgentHarnessPlugin "harness.infinity" priority must be a finite number.',
    ]);
    expect(report.recommendations[0]).toBe(
      'Fix 4 invalid AgentHarnessPlugin configuration issue(s) before binding a harness driver.',
    );
  });

  it('does not mutate plugin order while calculating report selection', () => {
    const first = plugin('harness.low', true, 1);
    const second = plugin('harness.high', true, 10);
    const third = plugin('harness.tie', true, 10);
    const plugins = [first, second, third] as const;

    const report = buildAgentHarnessRegistryReport({
      context,
      generatedAt: '2026-05-05T00:01:00.000Z',
      plugins,
    });

    expect(report.selected?.pluginId).toBe('harness.high');
    expect(plugins).toEqual([first, second, third]);
    expect(report.entries.map((entry) => entry.pluginId)).toEqual([
      'harness.low',
      'harness.high',
      'harness.tie',
    ]);
  });

  it('does not call wrapDriver on no-supported or invalid report paths', () => {
    let wrapCallCount = 0;
    const unsupported: AgentHarnessPlugin = {
      id: 'harness.unsupported.no-wrap',
      supports() {
        return { supported: false, reason: 'provider not supported' };
      },
      wrapDriver(input) {
        wrapCallCount += 1;
        return input.driver;
      },
    };
    const invalid: AgentHarnessPlugin = {
      id: 'harness.invalid.no-wrap',
      supports() {
        throw new Error('supports exploded');
      },
      wrapDriver(input) {
        wrapCallCount += 1;
        return input.driver;
      },
    };

    expect(
      buildAgentHarnessRegistryReport({
        context,
        generatedAt: '2026-05-05T00:01:00.000Z',
        plugins: [unsupported],
      }).status,
    ).toBe('no-supported-plugin');
    expect(
      buildAgentHarnessRegistryReport({
        context,
        generatedAt: '2026-05-05T00:01:00.000Z',
        plugins: [invalid],
      }).status,
    ).toBe('invalid-plugin-configuration');
    expect(wrapCallCount).toBe(0);
  });
});

describe('bindAgentHarnessDriver', () => {
  it('returns the base driver when no harness plugins are configured', () => {
    expect(
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [],
      }),
    ).toBe(baseDriver);
  });

  it('returns the selected plugin wrapped driver', () => {
    const wrappedDriver: RuntimeDriver = {
      async run() {
        throw new Error('not exercised');
      },
    };

    expect(
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [
          plugin('harness.low', true, 0),
          plugin('harness.wrapper', true, 2, wrappedDriver),
        ],
      }),
    ).toBe(wrappedDriver);
  });

  it('normalizes wrapDriver() exceptions to BoundaryValidationError', () => {
    const throwingPlugin: AgentHarnessPlugin = {
      id: 'harness.wrap.throws',
      supports() {
        return { supported: true, priority: 1 };
      },
      wrapDriver() {
        throw new Error('wrap exploded');
      },
    };

    expect(() =>
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [throwingPlugin],
      }),
    ).toThrow(BoundaryValidationError);
  });

  it('preserves BoundaryValidationError thrown by wrapDriver()', () => {
    const expected = new BoundaryValidationError(
      'B-SET',
      'custom harness boundary failure',
    );
    const throwingPlugin: AgentHarnessPlugin = {
      id: 'harness.wrap.boundary-throws',
      supports() {
        return { supported: true, priority: 1 };
      },
      wrapDriver() {
        throw expected;
      },
    };

    try {
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [throwingPlugin],
      });
      throw new Error('expected bindAgentHarnessDriver to throw');
    } catch (error: unknown) {
      expect(error).toBe(expected);
    }
  });

  it('fails closed when wrapDriver() returns a non-runtime-driver value', () => {
    const invalidPlugin = (wrappedDriver: RuntimeDriver): AgentHarnessPlugin => ({
      id: 'harness.wrap.invalid',
      supports() {
        return { supported: true, priority: 1 };
      },
      wrapDriver() {
        return wrappedDriver;
      },
    });

    expect(() =>
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [invalidPlugin(undefined as unknown as RuntimeDriver)],
      }),
    ).toThrow(BoundaryValidationError);

    expect(() =>
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [invalidPlugin(null as unknown as RuntimeDriver)],
      }),
    ).toThrow(BoundaryValidationError);

    expect(() =>
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [invalidPlugin([] as unknown as RuntimeDriver)],
      }),
    ).toThrow(BoundaryValidationError);

    expect(() =>
      bindAgentHarnessDriver({
        driver: baseDriver,
        context,
        plugins: [
          invalidPlugin({ run: 'not a function' } as unknown as RuntimeDriver),
        ],
      }),
    ).toThrow(BoundaryValidationError);
  });
});
