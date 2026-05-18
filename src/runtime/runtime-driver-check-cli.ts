import { BoundaryValidationError } from '../contracts/boundary-validators.js';
import {
  CODEX_API_KEY_ENV,
  CODEX_AUTH_SOURCE_ENV,
  CODEX_CLI_HOME_MODE_ENV,
  CODEX_CLI_PATH_ENV,
  CODEX_ISOLATED_HOME_ENV,
  CODEX_MODEL_ENV,
  CODEX_MODEL_FALLBACK_ENV,
  CODEX_REASONING_EFFORT_ENV,
  CODEX_SETTINGS_FILE_PATH_ENV,
  type CodexBootstrapAuthPreference,
  type CodexCliHomeMode,
  type CodexReasoningEffort,
} from './codex-bootstrap-settings.js';
import {
  CLAUDE_AGENT_API_KEY_ENV,
  CLAUDE_AGENT_CLI_PATH_ENV,
  CLAUDE_AGENT_FALLBACK_MODEL_ENV,
  CLAUDE_AGENT_MAX_BUDGET_USD_ENV,
  CLAUDE_AGENT_MAX_TURNS_ENV,
  CLAUDE_AGENT_MODEL_ENV,
  CLAUDE_AGENT_PERMISSION_MODE_ENV,
  CLAUDE_AGENT_REASONING_EFFORT_ENV,
  type ClaudeAgentPermissionMode,
  type ClaudeAgentReasoningEffort,
} from './claude-agent-bootstrap-settings.js';
import {
  RUNTIME_PROVIDER_ENV,
  resolveRuntimeProvider,
  type RuntimeProvider,
} from './runtime-driver-factory.js';

export const RUNTIME_DRIVER_CHECK_REPORT_SCHEMA_VERSION = 1;

type RuntimeDriverCheckStatus = 'ready' | 'warn' | 'fail';
type RuntimeDriverCheckStatusReasonCode =
  | 'ready'
  | 'codex-auto-auth-not-inspected'
  | 'credential-file-not-inspected'
  | 'settings-file-not-inspected'
  | 'missing-auth-signal'
  | 'unverified-auth-signal';
type RuntimeDriverCheckSelectionSource = 'default' | 'env';
type RuntimeDriverCheckAuthStatus = 'configured' | 'unverified' | 'missing';
type RuntimeDriverCheckAuthClassification =
  | 'api-key-env-present'
  | 'api-key-settings-file-configured-unverified'
  | 'auto-codex-cli-first-api-key-fallback-configured'
  | 'codex-cli-auth-file-required-unverified'
  | 'auto-codex-cli-default-candidate-unverified'
  | 'claude-cli-path-configured'
  | 'none';

const CODEX_AUTH_SOURCE_VALUES = [
  'auto',
  'codex-cli',
  'api-key',
] as const satisfies ReadonlyArray<CodexBootstrapAuthPreference>;
const CODEX_CLI_HOME_MODE_VALUES = [
  'default',
  'isolated-auth',
] as const satisfies ReadonlyArray<CodexCliHomeMode>;
const CODEX_REASONING_EFFORT_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies ReadonlyArray<CodexReasoningEffort>;
const CLAUDE_AGENT_REASONING_EFFORT_VALUES = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies ReadonlyArray<ClaudeAgentReasoningEffort>;
const CLAUDE_AGENT_PERMISSION_MODE_VALUES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const satisfies ReadonlyArray<ClaudeAgentPermissionMode>;

export interface RuntimeDriverCheckCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface RuntimeDriverCheckCliOptions {
  readonly generatedAt?: string;
  readonly pretty: boolean;
}

export interface RuntimeDriverCheckPublicValue {
  readonly envVarName: string;
  readonly configured: boolean;
  readonly valueRendered: boolean;
  readonly valueKind: 'non-secret';
  readonly value?: string;
}

export interface RuntimeDriverCheckSecretValue {
  readonly envVarName: string;
  readonly configured: boolean;
  readonly valueRendered: false;
  readonly valueKind: 'secret';
}

export interface RuntimeDriverCheckNumberValue {
  readonly envVarName: string;
  readonly configured: boolean;
  readonly valueRendered: boolean;
  readonly valueKind: 'non-secret';
  readonly value?: number;
}

export interface RuntimeDriverCheckAuthPlan {
  readonly classification: RuntimeDriverCheckAuthClassification;
  readonly status: RuntimeDriverCheckAuthStatus;
  readonly credentialEnvVarNames: readonly string[];
  readonly credentialValuesRendered: false;
  readonly credentialFilesRead: false;
  readonly settingsFilesRead: false;
  readonly settingsFile: {
    readonly envVarName?: string;
    readonly configured: boolean;
    readonly pathRendered: false;
  };
  readonly notes: readonly string[];
}

export interface RuntimeDriverCheckProviderPlan {
  readonly provider: RuntimeProvider;
  readonly driverProvenance:
    | 'codex-runtime-driver'
    | 'claude-agent-runtime-driver';
  readonly mode: 'bootstrap-selected-single-provider';
  readonly auth: RuntimeDriverCheckAuthPlan;
  readonly model: {
    readonly primary: RuntimeDriverCheckPublicValue;
    readonly fallback: RuntimeDriverCheckPublicValue;
    readonly reasoningEffort: RuntimeDriverCheckPublicValue;
  };
  readonly permission: {
    readonly mode?: RuntimeDriverCheckPublicValue;
    readonly maxTurns?: RuntimeDriverCheckNumberValue;
    readonly maxBudgetUsd?: RuntimeDriverCheckNumberValue;
  };
  readonly codex?: {
    readonly authPreference: RuntimeDriverCheckPublicValue;
    readonly cliPath: RuntimeDriverCheckSecretValue;
    readonly cliHomeMode: RuntimeDriverCheckPublicValue;
    readonly isolatedHome: RuntimeDriverCheckSecretValue;
  };
  readonly claudeAgent?: {
    readonly cliPath: RuntimeDriverCheckSecretValue;
  };
}

export interface RuntimeDriverCheckDiagnostic {
  readonly name: string;
  readonly status: RuntimeDriverCheckStatus;
  readonly summary: string;
}

export interface RuntimeDriverCheckReport {
  readonly schemaVersion: typeof RUNTIME_DRIVER_CHECK_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: RuntimeDriverCheckStatus;
  readonly statusReasonCode: RuntimeDriverCheckStatusReasonCode;
  readonly providerSelection: {
    readonly provider: RuntimeProvider;
    readonly envVarName: typeof RUNTIME_PROVIDER_ENV;
    readonly source: RuntimeDriverCheckSelectionSource;
    readonly providerSwitching: false;
    readonly runtimeFanOut: false;
  };
  readonly runPlan: RuntimeDriverCheckProviderPlan;
  readonly diagnostics: readonly RuntimeDriverCheckDiagnostic[];
  readonly recommendations: readonly string[];
  readonly boundary: {
    readonly readOnly: true;
    readonly runtimeDriverInstantiated: false;
    readonly providerContacted: false;
    readonly providerSwitched: false;
    readonly runtimeFanOutStarted: false;
    readonly environmentVariablesRead: true;
    readonly credentialFilesRead: false;
    readonly settingsFilesRead: false;
    readonly evidenceFilesRead: false;
    readonly filesMutated: false;
    readonly secretValuesRendered: false;
    readonly rawPromptsRendered: false;
    readonly rawResponsesRendered: false;
  };
}

export interface BuildRuntimeDriverCheckReportInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly generatedAt?: string;
}

const USAGE = `Usage: pnpm runtime:driver:check -- [options]

Print a read-only, redacted run-plan for the bootstrap-selected runtime
provider. This is a static configuration/introspection report: it does not
instantiate RuntimeDrivers, contact providers, switch providers, read
credential files, read settings files, or render secret values.

Options:
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command reads process environment variable presence/configuration only.
  It never reads .env files, Codex/Claude credential files, settings-file
  contents, retained evidence files, raw prompts, raw responses, or private
  artifact contents. It is not live provider proof; after an authenticated run,
  use runtime:provider:evidence:report on retained TerminalEvidence.

Exit code:
  0 means a run-plan report was generated, even when report status is warn or
  fail. 1 is reserved for CLI argument or configuration validation errors.
`;

export function parseRuntimeDriverCheckCliArgs(
  argv: readonly string[],
): RuntimeDriverCheckCliOptions | 'help' {
  let generatedAt: string | undefined;
  let pretty = false;

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
      case '--generated-at':
        generatedAt = requireCliValue(argv, index, '--generated-at');
        if (!isIsoInstant(generatedAt)) {
          throw new Error('--generated-at must be a valid ISO-8601 UTC timestamp.');
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  return {
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
  };
}

export function runRuntimeDriverCheckCli(
  argv: readonly string[],
  io: RuntimeDriverCheckCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  env: NodeJS.ProcessEnv = process.env,
): number {
  try {
    const options = parseRuntimeDriverCheckCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const report = buildRuntimeDriverCheckReport({
      env,
      ...(options.generatedAt === undefined
        ? {}
        : { generatedAt: options.generatedAt }),
    });
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `runtime:driver:check failed: ${
        error instanceof Error ? error.message : String(error)
      }\n\n${USAGE}`,
    );
    return 1;
  }
}

export function buildRuntimeDriverCheckReport(
  input: BuildRuntimeDriverCheckReportInput = {},
): RuntimeDriverCheckReport {
  const env = input.env ?? process.env;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const provider = resolveRuntimeProvider(env);
  const runPlan =
    provider === 'codex'
      ? buildCodexRunPlan(env)
      : buildClaudeAgentRunPlan(env);
  const diagnostics = buildDiagnostics(runPlan);
  const status = combineStatuses(diagnostics.map((item) => item.status));
  return {
    schemaVersion: RUNTIME_DRIVER_CHECK_REPORT_SCHEMA_VERSION,
    generatedAt,
    status,
    statusReasonCode: buildStatusReasonCode(runPlan, status),
    providerSelection: {
      provider,
      envVarName: RUNTIME_PROVIDER_ENV,
      source:
        readNonEmptyEnvValue(env, RUNTIME_PROVIDER_ENV) === undefined
          ? 'default'
          : 'env',
      providerSwitching: false,
      runtimeFanOut: false,
    },
    runPlan,
    diagnostics,
    recommendations: buildRecommendations(runPlan, status),
    boundary: {
      readOnly: true,
      runtimeDriverInstantiated: false,
      providerContacted: false,
      providerSwitched: false,
      runtimeFanOutStarted: false,
      environmentVariablesRead: true,
      credentialFilesRead: false,
      settingsFilesRead: false,
      evidenceFilesRead: false,
      filesMutated: false,
      secretValuesRendered: false,
      rawPromptsRendered: false,
      rawResponsesRendered: false,
    },
  };
}

function buildCodexRunPlan(env: NodeJS.ProcessEnv): RuntimeDriverCheckProviderPlan {
  const authPreference = readCodexAuthPreference(env);
  const authPreferenceConfigured =
    readNonEmptyEnvValue(env, CODEX_AUTH_SOURCE_ENV) !== undefined;
  const cliHomeMode = readCodexCliHomeMode(env);
  const cliHomeModeConfigured =
    readNonEmptyEnvValue(env, CODEX_CLI_HOME_MODE_ENV) !== undefined;
  const model = readModelEnvValue(env, CODEX_MODEL_ENV);
  const fallback = readModelEnvValue(env, CODEX_MODEL_FALLBACK_ENV);
  if (model !== undefined && fallback !== undefined && model === fallback) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CODEX_MODEL_FALLBACK_ENV} must differ from ${CODEX_MODEL_ENV}.`,
    );
  }

  return {
    provider: 'codex',
    driverProvenance: 'codex-runtime-driver',
    mode: 'bootstrap-selected-single-provider',
    auth: buildCodexAuthPlan(env, authPreference),
    model: {
      primary: publicStringValue(CODEX_MODEL_ENV, model),
      fallback: publicStringValue(CODEX_MODEL_FALLBACK_ENV, fallback),
      reasoningEffort: publicStringValue(
        CODEX_REASONING_EFFORT_ENV,
        readOptionalEnum(
          env,
          CODEX_REASONING_EFFORT_ENV,
          CODEX_REASONING_EFFORT_VALUES,
        ),
      ),
    },
    permission: {},
    codex: {
      authPreference: publicStringConfigValue(
        CODEX_AUTH_SOURCE_ENV,
        authPreference,
        authPreferenceConfigured,
      ),
      cliPath: secretPresenceValue(CODEX_CLI_PATH_ENV, env),
      cliHomeMode: publicStringConfigValue(
        CODEX_CLI_HOME_MODE_ENV,
        cliHomeMode,
        cliHomeModeConfigured,
      ),
      isolatedHome: secretPresenceValue(CODEX_ISOLATED_HOME_ENV, env),
    },
  };
}

function buildClaudeAgentRunPlan(
  env: NodeJS.ProcessEnv,
): RuntimeDriverCheckProviderPlan {
  const model = readModelEnvValue(env, CLAUDE_AGENT_MODEL_ENV);
  const fallback = readModelEnvValue(env, CLAUDE_AGENT_FALLBACK_MODEL_ENV);
  if (model !== undefined && fallback !== undefined && model === fallback) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CLAUDE_AGENT_FALLBACK_MODEL_ENV} must differ from ${CLAUDE_AGENT_MODEL_ENV}.`,
    );
  }

  return {
    provider: 'claude-agent',
    driverProvenance: 'claude-agent-runtime-driver',
    mode: 'bootstrap-selected-single-provider',
    auth: buildClaudeAgentAuthPlan(env),
    model: {
      primary: publicStringValue(CLAUDE_AGENT_MODEL_ENV, model),
      fallback: publicStringValue(CLAUDE_AGENT_FALLBACK_MODEL_ENV, fallback),
      reasoningEffort: publicStringValue(
        CLAUDE_AGENT_REASONING_EFFORT_ENV,
        readOptionalEnum(
          env,
          CLAUDE_AGENT_REASONING_EFFORT_ENV,
          CLAUDE_AGENT_REASONING_EFFORT_VALUES,
        ),
      ),
    },
    permission: {
      mode: publicStringValue(
        CLAUDE_AGENT_PERMISSION_MODE_ENV,
        readOptionalEnum(
          env,
          CLAUDE_AGENT_PERMISSION_MODE_ENV,
          CLAUDE_AGENT_PERMISSION_MODE_VALUES,
        ),
      ),
      maxTurns: publicNumberValue(
        CLAUDE_AGENT_MAX_TURNS_ENV,
        readOptionalPositiveInteger(env, CLAUDE_AGENT_MAX_TURNS_ENV),
      ),
      maxBudgetUsd: publicNumberValue(
        CLAUDE_AGENT_MAX_BUDGET_USD_ENV,
        readOptionalPositiveNumber(env, CLAUDE_AGENT_MAX_BUDGET_USD_ENV),
      ),
    },
    claudeAgent: {
      cliPath: secretPresenceValue(CLAUDE_AGENT_CLI_PATH_ENV, env),
    },
  };
}

function buildCodexAuthPlan(
  env: NodeJS.ProcessEnv,
  authPreference: CodexBootstrapAuthPreference,
): RuntimeDriverCheckAuthPlan {
  const apiKeyPresent = readNonEmptyEnvValue(env, CODEX_API_KEY_ENV) !== undefined;
  const settingsFileConfigured =
    readNonEmptyEnvValue(env, CODEX_SETTINGS_FILE_PATH_ENV) !== undefined;
  const settingsFile = {
    envVarName: CODEX_SETTINGS_FILE_PATH_ENV,
    configured: settingsFileConfigured,
    pathRendered: false,
  } as const;

  if (authPreference === 'api-key') {
    if (apiKeyPresent) {
      return {
        classification: 'api-key-env-present',
        status: 'configured',
        credentialEnvVarNames: [CODEX_API_KEY_ENV],
        credentialValuesRendered: false,
        credentialFilesRead: false,
        settingsFilesRead: false,
        settingsFile,
        notes: [
          `${CODEX_AUTH_SOURCE_ENV}=api-key selects the env-backed Codex API key path.`,
        ],
      };
    }
    if (settingsFileConfigured) {
      return {
        classification: 'api-key-settings-file-configured-unverified',
        status: 'unverified',
        credentialEnvVarNames: [CODEX_API_KEY_ENV],
        credentialValuesRendered: false,
        credentialFilesRead: false,
        settingsFilesRead: false,
        settingsFile,
        notes: [
          `${CODEX_AUTH_SOURCE_ENV}=api-key may use ${CODEX_SETTINGS_FILE_PATH_ENV}, but this checker does not read settings-file contents.`,
        ],
      };
    }
    return {
      classification: 'none',
      status: 'missing',
      credentialEnvVarNames: [CODEX_API_KEY_ENV],
      credentialValuesRendered: false,
      credentialFilesRead: false,
      settingsFilesRead: false,
      settingsFile,
      notes: [
        `${CODEX_AUTH_SOURCE_ENV}=api-key requires ${CODEX_API_KEY_ENV} or a settings file containing apiKey before a live run.`,
      ],
    };
  }

  if (authPreference === 'codex-cli') {
    return {
      classification: 'codex-cli-auth-file-required-unverified',
      status: 'unverified',
      credentialEnvVarNames: [],
      credentialValuesRendered: false,
      credentialFilesRead: false,
      settingsFilesRead: false,
      settingsFile,
      notes: [
        `${CODEX_AUTH_SOURCE_ENV}=codex-cli requires a valid Codex CLI auth file, but this checker intentionally does not read credential files.`,
      ],
    };
  }

  if (apiKeyPresent || settingsFileConfigured) {
    return {
      classification: 'auto-codex-cli-first-api-key-fallback-configured',
      status: 'unverified',
      credentialEnvVarNames: [CODEX_API_KEY_ENV],
      credentialValuesRendered: false,
      credentialFilesRead: false,
      settingsFilesRead: false,
      settingsFile,
      notes: [
        `${CODEX_AUTH_SOURCE_ENV}=auto prefers a valid Codex CLI auth file before API-key fallback; this checker does not inspect either credential file or settings file.`,
      ],
    };
  }

  return {
    classification: 'auto-codex-cli-default-candidate-unverified',
    status: 'unverified',
    credentialEnvVarNames: [],
    credentialValuesRendered: false,
    credentialFilesRead: false,
    settingsFilesRead: false,
    settingsFile,
    notes: [
      `${CODEX_AUTH_SOURCE_ENV}=auto will look for Codex CLI auth during live bootstrap, but this checker does not inspect credential files.`,
    ],
  };
}

function buildClaudeAgentAuthPlan(
  env: NodeJS.ProcessEnv,
): RuntimeDriverCheckAuthPlan {
  const apiKeyPresent =
    readNonEmptyEnvValue(env, CLAUDE_AGENT_API_KEY_ENV) !== undefined;
  const cliPathConfigured =
    readNonEmptyEnvValue(env, CLAUDE_AGENT_CLI_PATH_ENV) !== undefined;
  const settingsFile = {
    configured: false,
    pathRendered: false,
  } as const;

  if (apiKeyPresent) {
    return {
      classification: 'api-key-env-present',
      status: 'configured',
      credentialEnvVarNames: [CLAUDE_AGENT_API_KEY_ENV],
      credentialValuesRendered: false,
      credentialFilesRead: false,
      settingsFilesRead: false,
      settingsFile,
      notes: [
        `${CLAUDE_AGENT_API_KEY_ENV} is present; the API-key path is the production Claude Agent credential path.`,
      ],
    };
  }

  if (cliPathConfigured) {
    return {
      classification: 'claude-cli-path-configured',
      status: 'configured',
      credentialEnvVarNames: [],
      credentialValuesRendered: false,
      credentialFilesRead: false,
      settingsFilesRead: false,
      settingsFile,
      notes: [
        `${CLAUDE_AGENT_CLI_PATH_ENV} is configured for single-user local development; this checker does not inspect Claude OAuth state.`,
      ],
    };
  }

  return {
    classification: 'none',
    status: 'missing',
    credentialEnvVarNames: [CLAUDE_AGENT_API_KEY_ENV],
    credentialValuesRendered: false,
    credentialFilesRead: false,
    settingsFilesRead: false,
    settingsFile,
    notes: [
      `Claude Agent runtime requires ${CLAUDE_AGENT_API_KEY_ENV} for production or ${CLAUDE_AGENT_CLI_PATH_ENV} for local development before a live run.`,
    ],
  };
}

function buildDiagnostics(
  runPlan: RuntimeDriverCheckProviderPlan,
): readonly RuntimeDriverCheckDiagnostic[] {
  const authStatus: RuntimeDriverCheckStatus =
    runPlan.auth.status === 'configured'
      ? 'ready'
      : runPlan.auth.status === 'missing'
        ? 'fail'
        : 'warn';
  const authSummary =
    runPlan.auth.status === 'configured'
      ? `auth signal configured via ${runPlan.auth.classification}`
      : runPlan.auth.status === 'missing'
        ? `auth signal missing for ${runPlan.provider}`
        : `auth signal unverified via ${runPlan.auth.classification}`;
  return [
    {
      name: 'provider-selection',
      status: 'ready',
      summary:
        'single bootstrap-selected provider; provider switching and runtime fan-out disabled',
    },
    {
      name: 'auth-signal',
      status: authStatus,
      summary: authSummary,
    },
    {
      name: 'secret-boundary',
      status: 'ready',
      summary:
        'secret values, credential files, settings files, prompts, and responses are not rendered',
    },
  ];
}

function buildRecommendations(
  runPlan: RuntimeDriverCheckProviderPlan,
  status: RuntimeDriverCheckStatus,
): readonly string[] {
  const recommendations: string[] = [];
  if (status === 'fail') {
    recommendations.push(
      `Configure an auth signal for ${runPlan.provider} before attempting a live runtime run.`,
    );
  }
  if (runPlan.auth.status === 'unverified') {
    recommendations.push(
      'Run an authenticated provider smoke and score the retained TerminalEvidence with runtime:provider:evidence:report before promoting live proof.',
    );
  }
  recommendations.push(
    'Treat this report as static run-plan readiness only; it is not live provider proof.',
  );
  return recommendations;
}

function buildStatusReasonCode(
  runPlan: RuntimeDriverCheckProviderPlan,
  status: RuntimeDriverCheckStatus,
): RuntimeDriverCheckStatusReasonCode {
  if (status === 'ready') return 'ready';
  if (runPlan.auth.status === 'missing') return 'missing-auth-signal';
  switch (runPlan.auth.classification) {
    case 'auto-codex-cli-default-candidate-unverified':
    case 'auto-codex-cli-first-api-key-fallback-configured':
      return 'codex-auto-auth-not-inspected';
    case 'codex-cli-auth-file-required-unverified':
      return 'credential-file-not-inspected';
    case 'api-key-settings-file-configured-unverified':
      return 'settings-file-not-inspected';
    case 'api-key-env-present':
    case 'claude-cli-path-configured':
    case 'none':
      return 'unverified-auth-signal';
  }
}

function combineStatuses(
  statuses: readonly RuntimeDriverCheckStatus[],
): RuntimeDriverCheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'ready';
}

function publicStringValue(
  envVarName: string,
  value: string | undefined,
): RuntimeDriverCheckPublicValue {
  return publicStringConfigValue(envVarName, value, value !== undefined);
}

function publicStringConfigValue(
  envVarName: string,
  value: string | undefined,
  configured: boolean,
): RuntimeDriverCheckPublicValue {
  return {
    envVarName,
    configured,
    valueRendered: value !== undefined,
    valueKind: 'non-secret',
    ...(value === undefined ? {} : { value }),
  };
}

function publicNumberValue(
  envVarName: string,
  value: number | undefined,
): RuntimeDriverCheckNumberValue {
  return {
    envVarName,
    configured: value !== undefined,
    valueRendered: value !== undefined,
    valueKind: 'non-secret',
    ...(value === undefined ? {} : { value }),
  };
}

function secretPresenceValue(
  envVarName: string,
  env: NodeJS.ProcessEnv,
): RuntimeDriverCheckSecretValue {
  return {
    envVarName,
    configured: readNonEmptyEnvValue(env, envVarName) !== undefined,
    valueRendered: false,
    valueKind: 'secret',
  };
}

function readCodexAuthPreference(
  env: NodeJS.ProcessEnv,
): CodexBootstrapAuthPreference {
  return readEnumWithDefault(
    env,
    CODEX_AUTH_SOURCE_ENV,
    CODEX_AUTH_SOURCE_VALUES,
    'auto',
  );
}

function readCodexCliHomeMode(env: NodeJS.ProcessEnv): CodexCliHomeMode {
  return readEnumWithDefault(
    env,
    CODEX_CLI_HOME_MODE_ENV,
    CODEX_CLI_HOME_MODE_VALUES,
    'default',
  );
}

function readModelEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = readNonEmptyEnvValue(env, key);
  if (value === undefined) {
    return undefined;
  }
  if (/\s/u.test(value)) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be a single model id without whitespace.`,
    );
  }
  return value;
}

function readOptionalPositiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  const raw = readNonEmptyEnvValue(env, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be a positive integer.`,
    );
  }
  return parsed;
}

function readOptionalPositiveNumber(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  const raw = readNonEmptyEnvValue(env, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be a positive finite number.`,
    );
  }
  return parsed;
}

function readOptionalEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: ReadonlyArray<T>,
): T | undefined {
  const value = readNonEmptyEnvValue(env, key);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be one of: ${values.join(', ')}.`,
    );
  }
  return value as T;
}

function readEnumWithDefault<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: ReadonlyArray<T>,
  defaultValue: T,
): T {
  const value = readNonEmptyEnvValue(env, key);
  if (value === undefined) return defaultValue;
  if (!values.includes(value as T)) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be one of: ${values.join(', ')}.`,
    );
  }
  return value as T;
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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

function isIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
