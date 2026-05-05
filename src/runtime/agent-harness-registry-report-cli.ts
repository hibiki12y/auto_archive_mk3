import { lstatSync, readFileSync } from 'node:fs';

import type { AgentHarnessPlugin } from '../contracts/agent-harness-plugin.js';
import type { RuntimeDriver } from '../contracts/runtime-driver.js';
import {
  buildAgentHarnessRegistryReport,
  type AgentHarnessRegistryReport,
} from './agent-harness-registry.js';
import type { AgentHarnessSelectionSource } from '../contracts/agent-harness-plugin.js';

export interface AgentHarnessRegistryReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface AgentHarnessRegistryReportCliOptions {
  readonly descriptorPath?: string;
  readonly provider: string;
  readonly source: AgentHarnessSelectionSource;
  readonly maxDescriptorBytes: number;
  readonly selectedAt?: string;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface AgentHarnessRegistryReportDescriptorFile {
  readonly schemaVersion: 1;
  readonly plugins: readonly AgentHarnessRegistryReportPluginDescriptor[];
}

export interface AgentHarnessRegistryReportPluginDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly defaultUnsupportedReason?: string;
  readonly supports: readonly AgentHarnessRegistryReportSupportDescriptor[];
}

export interface AgentHarnessRegistryReportSupportDescriptor {
  readonly provider: string;
  readonly priority?: number;
  readonly reason?: string;
}

export const AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES =
  1024 * 1024;

const USAGE = `Usage: pnpm agent:harness:registry:report -- --plugins <path> [options]
       pnpm agent:harness:registry:report -- --print-template [--provider <provider>] [--pretty]

Build a read-only AgentHarnessPlugin registry report from an operator-authored
JSON descriptor. The descriptor is metadata for diagnostics; the command does
not import runtime plugin modules, call wrapDriver(), create a RuntimeDriver, or
switch providers.

Use --print-template to emit a redacted descriptor skeleton before filling in
host-owned harness metadata.

Descriptor shape:
  {
    "schemaVersion": 1,
    "plugins": [
      {
        "id": "harness.codex.research",
        "label": "Codex research harness",
        "defaultUnsupportedReason": "provider is not declared by this harness",
        "supports": [
          { "provider": "codex", "priority": 10, "reason": "codex bootstrap wrapper" }
        ]
      }
    ]
  }

Options:
  --plugins <path>                Required JSON descriptor path unless --print-template is set.
  --print-template                Print a redacted descriptor skeleton instead of reading --plugins.
  --provider <provider>           Provider to evaluate (default: codex).
  --source <source>               Selection source: eager | lazy (default: eager).
  --selected-at <iso>             Optional selectedAt timestamp for the binding preview.
  --generated-at <iso>            Optional generatedAt timestamp to embed in the report.
  --max-descriptor-bytes <n>      Fail closed before reading beyond this many bytes (default: ${String(AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES)}).
  --pretty                       Pretty-print JSON output.
  --help                         Show this help text.

Boundary:
  This command is read-only. It does not load plugin code, wrap a driver,
  dispatch tasks, alter provider selection, reload environment variables,
  contact Discord/GitLab/provider services, install packages, fetch registries,
  or mutate the descriptor file. Treat descriptor text as operator-owned
  metadata; do not include secrets, prompts, responses, or raw task
  instructions.
`;

export function parseAgentHarnessRegistryReportCliArgs(
  argv: readonly string[],
): AgentHarnessRegistryReportCliOptions | 'help' {
  let descriptorPath: string | undefined;
  let provider = 'codex';
  let source: AgentHarnessSelectionSource = 'eager';
  let maxDescriptorBytes =
    AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES;
  let selectedAt: string | undefined;
  let generatedAt: string | undefined;
  let sourceProvided = false;
  let maxDescriptorBytesProvided = false;
  let pretty = false;
  let printTemplate = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        return 'help';
      case '--pretty':
        pretty = true;
        break;
      case '--print-template':
        printTemplate = true;
        break;
      case '--plugins':
        descriptorPath = requireCliValue(argv, index, '--plugins');
        index += 1;
        break;
      case '--provider': {
        const rawProvider = requireCliValue(argv, index, '--provider');
        if (rawProvider.trim().length === 0 || rawProvider !== rawProvider.trim()) {
          throw new Error('--provider must be a non-empty string without surrounding whitespace.');
        }
        provider = rawProvider;
        index += 1;
        break;
      }
      case '--source': {
        const rawSource = requireCliValue(argv, index, '--source');
        if (rawSource !== 'eager' && rawSource !== 'lazy') {
          throw new Error('--source must be one of: eager, lazy.');
        }
        source = rawSource;
        sourceProvided = true;
        index += 1;
        break;
      }
      case '--selected-at':
        selectedAt = requireCliValue(argv, index, '--selected-at');
        if (!isIsoInstant(selectedAt)) {
          throw new Error('--selected-at must be a valid ISO-8601 UTC timestamp.');
        }
        index += 1;
        break;
      case '--generated-at':
        generatedAt = requireCliValue(argv, index, '--generated-at');
        if (!isIsoInstant(generatedAt)) {
          throw new Error('--generated-at must be a valid ISO-8601 UTC timestamp.');
        }
        index += 1;
        break;
      case '--max-descriptor-bytes': {
        const rawMaxDescriptorBytes = requireCliValue(
          argv,
          index,
          '--max-descriptor-bytes',
        );
        const parsedMaxDescriptorBytes = Number(rawMaxDescriptorBytes);
        if (
          !Number.isSafeInteger(parsedMaxDescriptorBytes) ||
          parsedMaxDescriptorBytes <= 0
        ) {
          throw new Error(
            '--max-descriptor-bytes must be a positive safe integer.',
          );
        }
        maxDescriptorBytes = parsedMaxDescriptorBytes;
        maxDescriptorBytesProvided = true;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  if (printTemplate && descriptorPath !== undefined) {
    throw new Error('--print-template cannot be combined with --plugins.');
  }
  if (
    printTemplate &&
    (sourceProvided ||
      selectedAt !== undefined ||
      generatedAt !== undefined ||
      maxDescriptorBytesProvided)
  ) {
    throw new Error(
      '--print-template cannot be combined with report-only options: --source, --selected-at, --generated-at, or --max-descriptor-bytes.',
    );
  }

  if (!printTemplate && (descriptorPath === undefined || descriptorPath.length === 0)) {
    throw new Error('--plugins is required.');
  }

  return {
    ...(descriptorPath === undefined ? {} : { descriptorPath }),
    provider,
    source,
    maxDescriptorBytes,
    ...(selectedAt === undefined ? {} : { selectedAt }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildAgentHarnessRegistryDescriptorTemplateFromCliOptions(
  options: Pick<AgentHarnessRegistryReportCliOptions, 'provider'>,
): AgentHarnessRegistryReportDescriptorFile {
  const providerId = sanitizeHarnessProviderForId(options.provider);
  return {
    schemaVersion: 1,
    plugins: [
      {
        id: `harness.${providerId}.research`,
        label: `${options.provider} research harness`,
        defaultUnsupportedReason:
          'provider is not declared by this operator-owned harness descriptor',
        supports: [
          {
            provider: options.provider,
            priority: 10,
            reason:
              'operator-owned research harness wrapper; replace with host integration rationale before live use',
          },
        ],
      },
    ],
  };
}

export function buildAgentHarnessRegistryReportFromCliOptions(
  options: AgentHarnessRegistryReportCliOptions,
): AgentHarnessRegistryReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a registry report from --print-template options.');
  }
  if (options.descriptorPath === undefined || options.descriptorPath.length === 0) {
    throw new Error('--plugins is required.');
  }

  let descriptorStat;
  try {
    descriptorStat = lstatSync(options.descriptorPath);
  } catch (error) {
    throw new Error(`--plugins path does not exist: ${options.descriptorPath}`, {
      cause: error,
    });
  }
  if (!descriptorStat.isFile()) {
    throw new Error(
      `--plugins path is not a regular file: ${options.descriptorPath}`,
    );
  }
  if (descriptorStat.size > options.maxDescriptorBytes) {
    throw new Error(
      `--plugins file exceeds --max-descriptor-bytes (${descriptorStat.size} > ${options.maxDescriptorBytes}).`,
    );
  }

  const descriptorFile = parseAgentHarnessRegistryReportDescriptorFile(
    readFileSync(options.descriptorPath, 'utf8'),
  );
  const plugins = descriptorFile.plugins.map(descriptorToAgentHarnessPlugin);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return buildAgentHarnessRegistryReport({
    plugins,
    generatedAt,
    context: {
      provider: options.provider,
      source: options.source,
      selectedAt: options.selectedAt ?? generatedAt,
    },
  });
}

export function runAgentHarnessRegistryReportCli(
  argv: readonly string[],
  io: AgentHarnessRegistryReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseAgentHarnessRegistryReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const output = options.printTemplate
      ? buildAgentHarnessRegistryDescriptorTemplateFromCliOptions(options)
      : buildAgentHarnessRegistryReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(output, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `agent:harness:registry:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

export function parseAgentHarnessRegistryReportDescriptorFile(
  content: string,
): AgentHarnessRegistryReportDescriptorFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Agent harness registry descriptor must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error('Agent harness registry descriptor must be a JSON object.');
  }
  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error('Agent harness registry descriptor schemaVersion must be 1.');
  }
  const rawPlugins = parsed.plugins;
  if (!Array.isArray(rawPlugins)) {
    throw new Error('Agent harness registry descriptor plugins must be an array.');
  }

  return {
    schemaVersion: 1,
    plugins: rawPlugins.map((rawPlugin, index) =>
      parsePluginDescriptor(rawPlugin, `plugins[${String(index)}]`),
    ),
  };
}

function parsePluginDescriptor(
  value: unknown,
  path: string,
): AgentHarnessRegistryReportPluginDescriptor {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const id = requireStringField(value, 'id', path);
  const label = optionalStringField(value, 'label', path);
  const defaultUnsupportedReason = optionalStringField(
    value,
    'defaultUnsupportedReason',
    path,
  );
  const rawSupports = value.supports;
  if (rawSupports !== undefined && !Array.isArray(rawSupports)) {
    throw new Error(`${path}.supports must be an array when present.`);
  }
  const supports = (rawSupports ?? []).map((rawSupport, index) =>
    parseSupportDescriptor(rawSupport, `${path}.supports[${String(index)}]`),
  );

  return {
    id,
    ...(label === undefined ? {} : { label }),
    ...(defaultUnsupportedReason === undefined
      ? {}
      : { defaultUnsupportedReason }),
    supports,
  };
}

function parseSupportDescriptor(
  value: unknown,
  path: string,
): AgentHarnessRegistryReportSupportDescriptor {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const provider = requireStringField(value, 'provider', path);
  if (provider.trim().length === 0 || provider !== provider.trim()) {
    throw new Error(`${path}.provider must be a non-empty string without surrounding whitespace.`);
  }
  const priority = optionalNumberField(value, 'priority', path);
  if (priority !== undefined && !Number.isFinite(priority)) {
    throw new Error(`${path}.priority must be a finite number.`);
  }
  const reason = optionalStringField(value, 'reason', path);
  return {
    provider,
    ...(priority === undefined ? {} : { priority }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function descriptorToAgentHarnessPlugin(
  descriptor: AgentHarnessRegistryReportPluginDescriptor,
): AgentHarnessPlugin {
  return {
    id: descriptor.id,
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    supports(context) {
      const support = descriptor.supports.find(
        (candidate) => candidate.provider === context.provider,
      );
      if (support === undefined) {
        return {
          supported: false,
          reason:
            descriptor.defaultUnsupportedReason ??
            `provider "${context.provider}" is not declared by this harness descriptor`,
        };
      }
      return {
        supported: true,
        ...(support.priority === undefined ? {} : { priority: support.priority }),
        ...(support.reason === undefined ? {} : { reason: support.reason }),
      };
    },
    wrapDriver(input: { readonly driver: RuntimeDriver }) {
      return input.driver;
    },
  };
}

function sanitizeHarnessProviderForId(provider: string): string {
  const sanitized = provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return sanitized.length === 0 ? 'custom' : sanitized;
}

function requireCliValue(
  argv: readonly string[],
  index: number,
  optionName: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function requireStringField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(`${path}.${field} must be a string.`);
  }
  return value;
}

function optionalStringField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${path}.${field} must be a string when present.`);
  }
  return value;
}

function optionalNumberField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`${path}.${field} must be a number when present.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return false;
  }
  const canonicalInput = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return date.toISOString() === canonicalInput;
}
