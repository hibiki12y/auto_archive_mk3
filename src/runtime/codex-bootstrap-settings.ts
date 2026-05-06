import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodexOptions } from '@openai/codex-sdk';

import {
  BoundaryValidationError,
  requireObject,
  requireString,
  validateSettingsLoad,
} from '../contracts/boundary-validators.js';

export const CODEX_SETTINGS_FILE_PATH_ENV = 'AUTO_ARCHIVE_CODEX_SETTINGS_FILE';
export const CODEX_API_KEY_ENV = 'AUTO_ARCHIVE_CODEX_API_KEY';
export const CODEX_CLI_PATH_ENV = 'AUTO_ARCHIVE_CODEX_CLI_PATH';
export const CODEX_AUTH_SOURCE_ENV = 'AUTO_ARCHIVE_CODEX_AUTH_SOURCE';
export const CODEX_CLI_HOME_MODE_ENV = 'AUTO_ARCHIVE_CODEX_CLI_HOME_MODE';
export const CODEX_ISOLATED_HOME_ENV = 'AUTO_ARCHIVE_CODEX_ISOLATED_HOME';
export const CODEX_MODEL_ENV = 'AUTO_ARCHIVE_CODEX_MODEL';
export const CODEX_MODEL_FALLBACK_ENV = 'AUTO_ARCHIVE_CODEX_MODEL_FALLBACK';
export const CODEX_REASONING_EFFORT_ENV =
  'AUTO_ARCHIVE_CODEX_REASONING_EFFORT';

export type CodexBootstrapAuthSource = 'codex-cli' | 'api-key' | 'none';
export type CodexBootstrapAuthPreference = 'auto' | 'codex-cli' | 'api-key';
export type CodexCliHomeMode = 'default' | 'isolated-auth';

export interface CodexBootstrapResolution {
  readonly options: CodexOptions;
  readonly runtimeConfig: CodexRuntimeConfigOverrides;
  readonly authSource: CodexBootstrapAuthSource;
}

export interface CodexRuntimeConfigOverrides {
  readonly model?: string;
  readonly modelFallback?: string;
  readonly modelReasoningEffort?: CodexReasoningEffort;
}

type SupportedCodexBootstrapSettings = Pick<
  CodexOptions,
  'apiKey' | 'codexPathOverride'
>;
type CodexBootstrapEnvOptions = Pick<
  CodexOptions,
  'apiKey' | 'codexPathOverride'
>;
export type CodexReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

const SUPPORTED_CODEX_BOOTSTRAP_KEYS = [
  'apiKey',
  'codexPathOverride',
] as const satisfies ReadonlyArray<keyof SupportedCodexBootstrapSettings>;
const CODEX_REASONING_EFFORT_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies ReadonlyArray<CodexReasoningEffort>;
const CODEX_AUTH_SOURCE_VALUES = [
  'auto',
  'codex-cli',
  'api-key',
] as const satisfies ReadonlyArray<CodexBootstrapAuthPreference>;
const CODEX_CLI_HOME_MODE_VALUES = [
  'default',
  'isolated-auth',
] as const satisfies ReadonlyArray<CodexCliHomeMode>;
const ISOLATED_CODEX_ENV_PASSTHROUGH_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'TMPDIR',
  'TEMP',
  'TMP',
] as const;
const DEFAULT_ISOLATED_CODEX_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export class CodexBootstrapSettingsLoadError extends Error {
  public readonly settingsFilePath: string;
  public override readonly cause?: unknown;

  constructor(settingsFilePath: string, message: string, cause?: unknown) {
    super(
      `codex bootstrap settings load failed for "${settingsFilePath}": ${message}`,
    );
    this.name = 'CodexBootstrapSettingsLoadError';
    this.settingsFilePath = settingsFilePath;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, CodexBootstrapSettingsLoadError.prototype);
  }
}

export class CodexCliAuthLoadError extends Error {
  public readonly authFilePath: string;
  public override readonly cause?: unknown;

  constructor(authFilePath: string, message: string, cause?: unknown) {
    super(`codex CLI auth load failed for "${authFilePath}": ${message}`);
    this.name = 'CodexCliAuthLoadError';
    this.authFilePath = authFilePath;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, CodexCliAuthLoadError.prototype);
  }
}

export class CodexCliHomeIsolationError extends Error {
  public readonly codexHomePath: string;
  public readonly authFilePath: string;
  public override readonly cause?: unknown;

  constructor(
    codexHomePath: string,
    authFilePath: string,
    message: string,
    cause?: unknown,
  ) {
    super(
      `codex CLI isolated home preparation failed for "${codexHomePath}" from "${authFilePath}": ${message}`,
    );
    this.name = 'CodexCliHomeIsolationError';
    this.codexHomePath = codexHomePath;
    this.authFilePath = authFilePath;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, CodexCliHomeIsolationError.prototype);
  }
}

function readEnvCodexOptions(
  env: NodeJS.ProcessEnv = process.env,
): CodexBootstrapEnvOptions {
  const apiKey = readNonEmptyEnvValue(env, CODEX_API_KEY_ENV);
  const codexPathOverride = readNonEmptyEnvValue(env, CODEX_CLI_PATH_ENV);
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(codexPathOverride === undefined ? {} : { codexPathOverride }),
  };
}

function readCodexAuthPreference(
  env: NodeJS.ProcessEnv = process.env,
): CodexBootstrapAuthPreference {
  const value = readNonEmptyEnvValue(env, CODEX_AUTH_SOURCE_ENV);
  if (value === undefined) {
    return 'auto';
  }
  if (!CODEX_AUTH_SOURCE_VALUES.includes(value as CodexBootstrapAuthPreference)) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CODEX_AUTH_SOURCE_ENV} must be one of: ${CODEX_AUTH_SOURCE_VALUES.join(', ')}.`,
    );
  }
  return value as CodexBootstrapAuthPreference;
}

function readCodexCliHomeMode(
  env: NodeJS.ProcessEnv = process.env,
): CodexCliHomeMode {
  const value = readNonEmptyEnvValue(env, CODEX_CLI_HOME_MODE_ENV);
  if (value === undefined) {
    return 'default';
  }
  if (!CODEX_CLI_HOME_MODE_VALUES.includes(value as CodexCliHomeMode)) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CODEX_CLI_HOME_MODE_ENV} must be one of: ${CODEX_CLI_HOME_MODE_VALUES.join(', ')}.`,
    );
  }
  return value as CodexCliHomeMode;
}

function readEnvCodexRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): CodexRuntimeConfigOverrides {
  const model = readModelEnvValue(env, CODEX_MODEL_ENV);
  const modelFallback = readModelEnvValue(env, CODEX_MODEL_FALLBACK_ENV);
  const modelReasoningEffort = readNonEmptyEnvValue(
    env,
    CODEX_REASONING_EFFORT_ENV,
  );
  if (
    modelReasoningEffort !== undefined &&
    !CODEX_REASONING_EFFORT_VALUES.includes(
      modelReasoningEffort as CodexReasoningEffort,
    )
  ) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CODEX_REASONING_EFFORT_ENV} must be one of: ${CODEX_REASONING_EFFORT_VALUES.join(', ')}.`,
    );
  }

  if (
    model !== undefined &&
    modelFallback !== undefined &&
    modelFallback === model
  ) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CODEX_MODEL_FALLBACK_ENV} must differ from ${CODEX_MODEL_ENV}.`,
    );
  }

  return {
    ...(model === undefined ? {} : { model }),
    ...(modelFallback === undefined ? {} : { modelFallback }),
    ...(modelReasoningEffort === undefined
      ? {}
      : { modelReasoningEffort: modelReasoningEffort as CodexReasoningEffort }),
  };
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
      `${key} must be a single Codex model id without whitespace; use an exact id such as "gpt-5.4", not "gpt 5.4".`,
    );
  }
  return value;
}

function assertCodexBootstrapSettings(
  raw: unknown,
): asserts raw is SupportedCodexBootstrapSettings {
  requireObject(raw, 'B-SET', []);

  for (const [key, value] of Object.entries(raw)) {
    if (!SUPPORTED_CODEX_BOOTSTRAP_KEYS.includes(key as never)) {
      throw new BoundaryValidationError(
        'B-SET',
        `${key} is not a supported Codex bootstrap setting.`,
      );
    }
    if (value !== undefined) {
      requireString(value, 'B-SET', [key]);
    }
  }
}

function loadCodexSettingsFile(
  settingsFilePath: string,
): SupportedCodexBootstrapSettings {
  let rawFile: string;
  try {
    rawFile = fs.readFileSync(settingsFilePath, 'utf8');
  } catch (error) {
    throw new CodexBootstrapSettingsLoadError(
      settingsFilePath,
      'unable to read settings file.',
      error,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFile);
  } catch (error) {
    const validationError = new BoundaryValidationError(
      'B-SET',
      'settings file must contain valid JSON.',
      error,
    );
    throw new CodexBootstrapSettingsLoadError(
      settingsFilePath,
      validationError.message,
      validationError,
    );
  }

  try {
    return validateSettingsLoad(parsed, assertCodexBootstrapSettings);
  } catch (error) {
    if (error instanceof BoundaryValidationError) {
      throw new CodexBootstrapSettingsLoadError(
        settingsFilePath,
        error.message,
        error,
      );
    }
    throw error;
  }
}

function requirePlainObject(
  value: unknown,
  fieldName: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object.`);
  }
}

function requireNonEmptyString(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function resolveCodexCliAuthFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredHome = env['HOME']?.trim();
  const homeDirectory =
    configuredHome && configuredHome.length > 0 ? configuredHome : os.homedir();
  return path.join(homeDirectory, '.codex', 'auth.json');
}

function hasFileNotFoundCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function resolveDefaultIsolatedCodexHomePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredHome = env['HOME']?.trim();
  const homeDirectory =
    configuredHome && configuredHome.length > 0 ? configuredHome : os.homedir();
  return path.join(homeDirectory, '.auto-archive', 'codex-home');
}

function resolveIsolatedCodexHomePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    readNonEmptyEnvValue(env, CODEX_ISOLATED_HOME_ENV) ??
    resolveDefaultIsolatedCodexHomePath(env)
  );
}

function prepareIsolatedCodexHome(
  authFilePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHomePath = resolveIsolatedCodexHomePath(env);
  const isolatedAuthPath = path.join(codexHomePath, 'auth.json');

  try {
    fs.mkdirSync(codexHomePath, { recursive: true, mode: 0o700 });
    fs.chmodSync(codexHomePath, 0o700);
    try {
      const existingAuthPath = fs.lstatSync(isolatedAuthPath);
      if (existingAuthPath.isDirectory()) {
        throw new Error('isolated auth path is a directory.');
      }
      if (
        existingAuthPath.isSymbolicLink() &&
        fs.readlinkSync(isolatedAuthPath) === authFilePath
      ) {
        return codexHomePath;
      }
      fs.rmSync(isolatedAuthPath, { force: true });
    } catch (error) {
      if (!hasFileNotFoundCode(error)) {
        throw error;
      }
    }
    fs.symlinkSync(authFilePath, isolatedAuthPath);
  } catch (error) {
    throw new CodexCliHomeIsolationError(
      codexHomePath,
      authFilePath,
      error instanceof Error ? error.message : 'unable to prepare isolated home.',
      error,
    );
  }

  return codexHomePath;
}

function buildIsolatedCodexChildEnv(
  env: NodeJS.ProcessEnv,
  codexHomePath: string,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const key of ISOLATED_CODEX_ENV_PASSTHROUGH_KEYS) {
    const value = readNonEmptyEnvValue(env, key);
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  childEnv['HOME'] = readNonEmptyEnvValue(env, 'HOME') ?? os.homedir();
  childEnv['CODEX_HOME'] = codexHomePath;
  childEnv['PATH'] =
    childEnv['PATH'] ??
    readNonEmptyEnvValue(process.env, 'PATH') ??
    DEFAULT_ISOLATED_CODEX_PATH;

  return childEnv;
}

function applyCodexCliHomeMode(
  options: CodexOptions,
  env: NodeJS.ProcessEnv,
  authFilePath: string,
): CodexOptions {
  if (readCodexCliHomeMode(env) === 'default') {
    return options;
  }
  const codexHomePath = prepareIsolatedCodexHome(authFilePath, env);
  return {
    ...options,
    env: buildIsolatedCodexChildEnv(env, codexHomePath),
  };
}

function assertSupportedCliAuthPayload(raw: unknown): void {
  requirePlainObject(raw, 'auth.json');
  requireNonEmptyString(raw['auth_mode'], 'auth.json.auth_mode');

  switch (raw['auth_mode']) {
    case 'chatgpt': {
      requirePlainObject(raw['tokens'], 'auth.json.tokens');
      requireNonEmptyString(
        raw['tokens']['id_token'],
        'auth.json.tokens.id_token',
      );
      requireNonEmptyString(
        raw['tokens']['access_token'],
        'auth.json.tokens.access_token',
      );
      requireNonEmptyString(
        raw['tokens']['refresh_token'],
        'auth.json.tokens.refresh_token',
      );
      requireNonEmptyString(
        raw['tokens']['account_id'],
        'auth.json.tokens.account_id',
      );
      if (raw['last_refresh'] !== undefined) {
        requireNonEmptyString(raw['last_refresh'], 'auth.json.last_refresh');
      }
      return;
    }
    case 'apikey': {
      requireNonEmptyString(
        raw['OPENAI_API_KEY'],
        'auth.json.OPENAI_API_KEY',
      );
      return;
    }
    default:
      throw new TypeError('auth.json.auth_mode must be a supported Codex auth mode.');
  }
}

function hasValidCodexCliAuth(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const authFilePath = resolveCodexCliAuthFilePath(env);

  let rawFile: string;
  try {
    rawFile = fs.readFileSync(authFilePath, 'utf8');
  } catch (error) {
    if (hasFileNotFoundCode(error)) {
      return false;
    }
    throw new CodexCliAuthLoadError(
      authFilePath,
      'unable to read auth file.',
      error,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFile);
  } catch (error) {
    throw new CodexCliAuthLoadError(
      authFilePath,
      'auth file must contain valid JSON.',
      error,
    );
  }

  try {
    assertSupportedCliAuthPayload(parsed);
  } catch (error) {
    throw new CodexCliAuthLoadError(
      authFilePath,
      error instanceof Error ? error.message : 'auth file is invalid.',
      error,
    );
  }

  return true;
}

export function resolveCodexBootstrapResolution(
  env: NodeJS.ProcessEnv = process.env,
): CodexBootstrapResolution {
  const envOptions = readEnvCodexOptions(env);
  const runtimeConfig = readEnvCodexRuntimeConfig(env);
  const authPreference = readCodexAuthPreference(env);
  const settingsFilePath = readNonEmptyEnvValue(
    env,
    CODEX_SETTINGS_FILE_PATH_ENV,
  );
  const fileOptions =
    settingsFilePath === undefined
      ? {}
      : loadCodexSettingsFile(settingsFilePath);
  const mergedOptions = {
    ...fileOptions,
    ...envOptions,
  };

  if (authPreference === 'api-key') {
    if (mergedOptions.apiKey === undefined) {
      throw new BoundaryValidationError(
        'B-SET',
        `${CODEX_AUTH_SOURCE_ENV}=api-key requires ${CODEX_API_KEY_ENV} or an apiKey in ${CODEX_SETTINGS_FILE_PATH_ENV}.`,
      );
    }
    return {
      options: mergedOptions,
      runtimeConfig,
      authSource: 'api-key',
    };
  }

  const cliAuthFilePath = resolveCodexCliAuthFilePath(env);
  const cliAuthValid = hasValidCodexCliAuth(env);

  if (authPreference === 'codex-cli' && !cliAuthValid) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CODEX_AUTH_SOURCE_ENV}=codex-cli requires a valid Codex CLI auth file at ${cliAuthFilePath}.`,
    );
  }

  if (cliAuthValid) {
    const { apiKey: _apiKey, ...options } = mergedOptions;
    return {
      options: applyCodexCliHomeMode(options, env, cliAuthFilePath),
      runtimeConfig,
      authSource: 'codex-cli',
    };
  }

  if (mergedOptions.apiKey !== undefined) {
    return {
      options: mergedOptions,
      runtimeConfig,
      authSource: 'api-key',
    };
  }

  return {
    options: mergedOptions,
    runtimeConfig,
    authSource: 'none',
  };
}

export function resolveCodexBootstrapOptions(
  env: NodeJS.ProcessEnv = process.env,
): CodexOptions {
  return resolveCodexBootstrapResolution(env).options;
}
