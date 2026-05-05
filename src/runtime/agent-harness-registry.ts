import { BoundaryValidationError } from '../contracts/boundary-validators.js';
import type {
  AgentHarnessDriverBinding,
  AgentHarnessPlugin,
  AgentHarnessSupportContext,
  AgentHarnessSupportResult,
} from '../contracts/agent-harness-plugin.js';
import type { RuntimeDriver } from '../contracts/runtime-driver.js';

interface SupportedHarnessCandidate {
  readonly plugin: AgentHarnessPlugin;
  readonly priority: number;
  readonly declarationIndex: number;
}

interface SupportedHarnessReportCandidate {
  readonly pluginId: string;
  readonly label?: string;
  readonly priority: number;
  readonly reason?: string;
  readonly declarationIndex: number;
}

export interface SelectedAgentHarnessPlugin {
  readonly plugin: AgentHarnessPlugin;
  readonly binding: AgentHarnessDriverBinding;
}

export interface SelectAgentHarnessPluginInput {
  readonly plugins: ReadonlyArray<AgentHarnessPlugin>;
  readonly context: AgentHarnessSupportContext;
}

export interface BindAgentHarnessDriverInput
  extends SelectAgentHarnessPluginInput {
  readonly driver: RuntimeDriver;
}

export type AgentHarnessRegistryReportStatus =
  | 'selected'
  | 'no-plugins'
  | 'no-supported-plugin'
  | 'invalid-plugin-configuration';

export interface AgentHarnessRegistryReportEntry {
  readonly pluginId: string;
  readonly label?: string;
  readonly declarationIndex: number;
  readonly supported: boolean;
  readonly priority?: number;
  readonly reason?: string;
}

export interface AgentHarnessRegistryReportSelection {
  readonly pluginId: string;
  readonly label?: string;
  readonly declarationIndex: number;
  readonly priority: number;
  readonly reason?: string;
  readonly binding: AgentHarnessDriverBinding;
}

export interface AgentHarnessRegistryReportConfigurationError {
  readonly pluginId?: string;
  readonly declarationIndex: number;
  readonly message: string;
}

export interface AgentHarnessRegistryReport {
  readonly generatedAt: string;
  readonly context: AgentHarnessSupportContext;
  readonly pluginCount: number;
  readonly status: AgentHarnessRegistryReportStatus;
  readonly selected: AgentHarnessRegistryReportSelection | null;
  readonly entries: readonly AgentHarnessRegistryReportEntry[];
  readonly configurationErrors: readonly AgentHarnessRegistryReportConfigurationError[];
  readonly recommendations: readonly string[];
  readonly boundary: {
    readonly readOnly: true;
    readonly wrapDriverCalled: false;
    readonly providerSwitching: false;
  };
}

export interface BuildAgentHarnessRegistryReportInput
  extends SelectAgentHarnessPluginInput {
  readonly generatedAt?: string;
}

function formatPluginError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'non-Error value';
}

function assertPluginId(plugin: AgentHarnessPlugin): void {
  if (plugin.id.trim().length === 0 || plugin.id !== plugin.id.trim()) {
    throw new BoundaryValidationError(
      'B-SET',
      'AgentHarnessPlugin.id must be a non-empty string without surrounding whitespace.',
    );
  }
}

function assertRuntimeDriver(
  value: unknown,
  plugin: AgentHarnessPlugin,
): asserts value is RuntimeDriver {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoundaryValidationError(
      'B-SET',
      `AgentHarnessPlugin "${plugin.id}" wrapDriver() must return a RuntimeDriver object.`,
    );
  }

  const candidate = value as { readonly run?: unknown };
  if (typeof candidate.run !== 'function') {
    throw new BoundaryValidationError(
      'B-SET',
      `AgentHarnessPlugin "${plugin.id}" wrapDriver() result must expose run(context).`,
    );
  }
}

function assertUniquePluginIds(
  plugins: ReadonlyArray<AgentHarnessPlugin>,
): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    assertPluginId(plugin);
    if (seen.has(plugin.id)) {
      throw new BoundaryValidationError(
        'B-SET',
        `Duplicate AgentHarnessPlugin.id "${plugin.id}" is not allowed.`,
      );
    }
    seen.add(plugin.id);
  }
}

function readSupportResult(
  plugin: AgentHarnessPlugin,
  context: AgentHarnessSupportContext,
): AgentHarnessSupportResult {
  try {
    return plugin.supports(context);
  } catch (error: unknown) {
    throw new BoundaryValidationError(
      'B-SET',
      `AgentHarnessPlugin "${plugin.id}" supports() threw: ${formatPluginError(
        error,
      )}.`,
      error,
    );
  }
}

function readPriority(
  plugin: AgentHarnessPlugin,
  support: AgentHarnessSupportResult,
): number {
  if (!support.supported) return Number.NEGATIVE_INFINITY;
  const priority = support.priority ?? 0;
  if (!Number.isFinite(priority)) {
    throw new BoundaryValidationError(
      'B-SET',
      `AgentHarnessPlugin "${plugin.id}" priority must be a finite number.`,
    );
  }
  return priority;
}

function makeHarnessBinding(
  pluginId: string,
  context: AgentHarnessSupportContext,
): AgentHarnessDriverBinding {
  return {
    harnessId: pluginId,
    provider: context.provider,
    source: context.source,
    boundAt: context.selectedAt,
  };
}

function isInvalidPluginId(plugin: AgentHarnessPlugin): boolean {
  return plugin.id.trim().length === 0 || plugin.id !== plugin.id.trim();
}

function buildRegistryReportRecommendations(
  status: AgentHarnessRegistryReportStatus,
  input: BuildAgentHarnessRegistryReportInput,
  configurationErrors: readonly AgentHarnessRegistryReportConfigurationError[],
): readonly string[] {
  if (status === 'invalid-plugin-configuration') {
    return [
      `Fix ${configurationErrors.length} invalid AgentHarnessPlugin configuration issue(s) before binding a harness driver.`,
    ];
  }
  if (status === 'no-plugins') {
    return [
      'No AgentHarnessPlugin instances are configured; the bootstrap-selected RuntimeDriver will remain unwrapped.',
    ];
  }
  if (status === 'no-supported-plugin') {
    return [
      `No AgentHarnessPlugin supports provider "${input.context.provider}" (${input.context.source}); either add a compatible plugin or leave the plugin list empty to run unwrapped.`,
    ];
  }
  return [];
}

/**
 * Build a read-only diagnostic report for harness selection.
 *
 * The report intentionally evaluates only `supports(context)`: it never calls
 * `wrapDriver()`, never creates a runtime driver, and never changes the
 * bootstrap-selected provider.  It is therefore safe for `/doctor`-style
 * surfaces and local operator CLIs that need to explain which configured
 * harness would bind and why alternatives are unsupported.
 */
export function buildAgentHarnessRegistryReport(
  input: BuildAgentHarnessRegistryReportInput,
): AgentHarnessRegistryReport {
  const entries: AgentHarnessRegistryReportEntry[] = [];
  const configurationErrors: AgentHarnessRegistryReportConfigurationError[] = [];
  const supported: SupportedHarnessReportCandidate[] = [];
  const seenPluginIds = new Set<string>();

  input.plugins.forEach((plugin, declarationIndex) => {
    const pluginId = plugin.id;
    const baseEntry = {
      pluginId,
      ...(plugin.label === undefined ? {} : { label: plugin.label }),
      declarationIndex,
    } as const;

    if (isInvalidPluginId(plugin)) {
      const message =
        'AgentHarnessPlugin.id must be a non-empty string without surrounding whitespace.';
      configurationErrors.push({ pluginId, declarationIndex, message });
      entries.push({
        ...baseEntry,
        supported: false,
        reason: message,
      });
      return;
    }

    if (seenPluginIds.has(pluginId)) {
      const message = `Duplicate AgentHarnessPlugin.id "${pluginId}" is not allowed.`;
      configurationErrors.push({ pluginId, declarationIndex, message });
      entries.push({
        ...baseEntry,
        supported: false,
        reason: message,
      });
      return;
    }
    seenPluginIds.add(pluginId);

    let support: AgentHarnessSupportResult;
    try {
      support = plugin.supports(input.context);
    } catch (error: unknown) {
      const message = `AgentHarnessPlugin "${pluginId}" supports() threw: ${formatPluginError(
        error,
      )}.`;
      configurationErrors.push({ pluginId, declarationIndex, message });
      entries.push({
        ...baseEntry,
        supported: false,
        reason: message,
      });
      return;
    }

    if (!support.supported) {
      entries.push({
        ...baseEntry,
        supported: false,
        reason: support.reason,
      });
      return;
    }

    const priority = support.priority ?? 0;
    if (!Number.isFinite(priority)) {
      const message = `AgentHarnessPlugin "${pluginId}" priority must be a finite number.`;
      configurationErrors.push({ pluginId, declarationIndex, message });
      entries.push({
        ...baseEntry,
        supported: false,
        reason: message,
      });
      return;
    }

    entries.push({
      ...baseEntry,
      supported: true,
      priority,
      ...(support.reason === undefined ? {} : { reason: support.reason }),
    });
    supported.push({
      pluginId,
      ...(plugin.label === undefined ? {} : { label: plugin.label }),
      priority,
      ...(support.reason === undefined ? {} : { reason: support.reason }),
      declarationIndex,
    });
  });

  supported.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.declarationIndex - right.declarationIndex;
  });

  const status: AgentHarnessRegistryReportStatus =
    configurationErrors.length > 0
      ? 'invalid-plugin-configuration'
      : input.plugins.length === 0
        ? 'no-plugins'
        : supported.length === 0
          ? 'no-supported-plugin'
          : 'selected';
  const selectedCandidate = status === 'selected' ? supported[0] : undefined;
  const selected: AgentHarnessRegistryReportSelection | null =
    selectedCandidate === undefined
      ? null
      : {
          pluginId: selectedCandidate.pluginId,
          ...(selectedCandidate.label === undefined
            ? {}
            : { label: selectedCandidate.label }),
          declarationIndex: selectedCandidate.declarationIndex,
          priority: selectedCandidate.priority,
          ...(selectedCandidate.reason === undefined
            ? {}
            : { reason: selectedCandidate.reason }),
          binding: makeHarnessBinding(selectedCandidate.pluginId, input.context),
        };

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    context: input.context,
    pluginCount: input.plugins.length,
    status,
    selected,
    entries,
    configurationErrors,
    recommendations: buildRegistryReportRecommendations(
      status,
      input,
      configurationErrors,
    ),
    boundary: {
      readOnly: true,
      wrapDriverCalled: false,
      providerSwitching: false,
    },
  };
}

export function selectAgentHarnessPlugin(
  input: SelectAgentHarnessPluginInput,
): SelectedAgentHarnessPlugin {
  if (input.plugins.length === 0) {
    throw new BoundaryValidationError(
      'B-SET',
      'At least one AgentHarnessPlugin is required for harness selection.',
    );
  }

  assertUniquePluginIds(input.plugins);

  const supported: SupportedHarnessCandidate[] = [];
  input.plugins.forEach((plugin, declarationIndex) => {
    const support = readSupportResult(plugin, input.context);
    if (!support.supported) return;
    supported.push({
      plugin,
      priority: readPriority(plugin, support),
      declarationIndex,
    });
  });

  if (supported.length === 0) {
    throw new BoundaryValidationError(
      'B-SET',
      `No AgentHarnessPlugin supports provider "${input.context.provider}" (${input.context.source}).`,
    );
  }

  supported.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.declarationIndex - right.declarationIndex;
  });

  const selected = supported[0];
  return {
    plugin: selected.plugin,
    binding: makeHarnessBinding(selected.plugin.id, input.context),
  };
}

export function bindAgentHarnessDriver(
  input: BindAgentHarnessDriverInput,
): RuntimeDriver {
  if (input.plugins.length === 0) return input.driver;

  const selected = selectAgentHarnessPlugin(input);
  try {
    const wrapped = selected.plugin.wrapDriver({
      driver: input.driver,
      context: input.context,
      binding: selected.binding,
    });
    assertRuntimeDriver(wrapped, selected.plugin);
    return wrapped;
  } catch (error: unknown) {
    if (error instanceof BoundaryValidationError) {
      throw error;
    }
    throw new BoundaryValidationError(
      'B-SET',
      `AgentHarnessPlugin "${selected.plugin.id}" wrapDriver() threw: ${formatPluginError(
        error,
      )}.`,
      error,
    );
  }
}
