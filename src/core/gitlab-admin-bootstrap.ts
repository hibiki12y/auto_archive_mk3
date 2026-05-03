import {
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY,
  AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED,
  AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS,
  AUTO_ARCHIVE_GITLAB_ENABLED,
  AUTO_ARCHIVE_GITLAB_TOKEN_ENV,
  AUTO_ARCHIVE_GITLAB_URL,
  GitLabProjectManagerError,
  type GitLabProjectVisibility,
} from './gitlab-project-manager.js';

export const AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED =
  'AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED';
export const AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN =
  'AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN';
export const AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV =
  'AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV';
export const AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_DISCARD_ADMIN_TOKEN =
  'AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_DISCARD_ADMIN_TOKEN';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_NAME =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_NAME';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_NAME =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_NAME';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_SCOPES =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_SCOPES';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_ACCESS_LEVEL =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_ACCESS_LEVEL';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_EXPIRES_AT =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_EXPIRES_AT';
export const AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_ENV =
  'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_ENV';

const DEFAULT_ADMIN_TOKEN_ENV = 'GITLAB_ADMIN_TOKEN';
const DEFAULT_RUNTIME_TOKEN_ENV = 'GITLAB_TOKEN';
const DEFAULT_BOOTSTRAP_RUNTIME_TOKEN_NAME = 'auto-archive-runtime';
const DEFAULT_BOOTSTRAP_RUNTIME_ACCESS_LEVEL = 50;
const DEFAULT_ASSIGNMENT_PROJECT_PREFIX = 'auto-archive-task';

type GitLabFetch = typeof fetch;

export interface GitLabAdminBootstrapConfig {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly discardAdminToken: boolean;
  readonly groupName: string;
  readonly groupPath: string;
  readonly groupVisibility: GitLabProjectVisibility;
  readonly runtimeTokenName: string;
  readonly runtimeTokenScopes: readonly string[];
  readonly runtimeAccessLevel: number;
  readonly runtimeTokenExpiresAt?: string;
  readonly runtimeTokenEnvName: string;
  readonly assignmentProjectPrefix: string;
  readonly assignmentProjectVisibility: GitLabProjectVisibility;
  readonly assignmentInitializeWithReadme: boolean;
}

export interface GitLabBootstrapGroupReference {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly fullPath: string;
  readonly webUrl?: string;
  readonly visibility?: GitLabProjectVisibility;
}

export interface GitLabGroupAccessTokenReference {
  readonly id: number;
  readonly name: string;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly accessLevel: number;
  readonly expiresAt?: string;
}

export interface GitLabPersonalAccessTokenReference {
  readonly id: number;
  readonly name?: string;
}

export interface GitLabAdminBootstrapResult {
  readonly group: GitLabBootstrapGroupReference;
  readonly runtimeToken: GitLabGroupAccessTokenReference;
  readonly adminTokenDiscarded: boolean;
  readonly runtimeEnv: string;
}

export interface GitLabAdminBootstrapRunOptions {
  /**
   * Called after GitLab has produced the runtime token and env block, but before
   * the one-time admin PAT is revoked. Use this for durable persistence of the
   * runtime secret so admin-token disposal only happens after setup completion.
   */
  readonly onRuntimeEnvReady?: (
    result: GitLabAdminBootstrapResult,
  ) => Promise<void> | void;
}

export interface GitLabAdminBootstrapClient {
  ensureGroup(input: {
    readonly name: string;
    readonly path: string;
    readonly visibility: GitLabProjectVisibility;
  }): Promise<GitLabBootstrapGroupReference>;
  createGroupAccessToken(
    groupId: number,
    input: {
      readonly name: string;
      readonly scopes: readonly string[];
      readonly accessLevel: number;
      readonly expiresAt?: string;
    },
  ): Promise<GitLabGroupAccessTokenReference>;
  validateRuntimeToken(input: {
    readonly groupId: number;
    readonly token: string;
  }): Promise<void>;
  getCurrentPersonalAccessToken(): Promise<GitLabPersonalAccessTokenReference>;
  revokePersonalAccessToken(tokenId: number): Promise<void>;
}

function parseBooleanFlag(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return defaultValue;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new GitLabProjectManagerError(
    `${name} must be one of: 1, true, yes, on, 0, false, no, off; received "${value}".`,
  );
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new GitLabProjectManagerError(`Missing required environment variable ${name}.`);
  }
  return trimmed;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return defaultValue;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GitLabProjectManagerError(
      `${name} must be a positive integer; received "${value}".`,
    );
  }
  return parsed;
}

function parseVisibility(
  value: string | undefined,
  name: string,
  defaultValue: GitLabProjectVisibility,
): GitLabProjectVisibility {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return defaultValue;
  }
  if (
    normalized === 'private' ||
    normalized === 'internal' ||
    normalized === 'public'
  ) {
    return normalized;
  }
  throw new GitLabProjectManagerError(
    `${name} must be one of: private, internal, public; received "${value}".`,
  );
}

function parseScopes(value: string | undefined): readonly string[] {
  const scopes =
    value === undefined || value.trim().length === 0
      ? ['api']
      : value
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
  if (scopes.length === 0) {
    throw new GitLabProjectManagerError(
      `${AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_SCOPES} must contain at least one scope.`,
    );
  }
  return [...new Set(scopes)];
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitLabProjectManagerError(
      `${AUTO_ARCHIVE_GITLAB_URL} must be an absolute URL without credentials.`,
    );
  }
  if (url.username || url.password) {
    throw new GitLabProjectManagerError(
      `${AUTO_ARCHIVE_GITLAB_URL} must not contain credentials.`,
    );
  }
  url.hash = '';
  url.search = '';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function createApiUrl(baseUrl: string, path: string): string {
  return new URL(`api/v4/${path}`, baseUrl).toString();
}

function encodeGitLabPath(path: string | number): string {
  return encodeURIComponent(String(path));
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) =>
      secret.length === 0 ? redacted : redacted.split(secret).join('[REDACTED_SECRET]'),
    value,
  );
}

function describeHttpFailure(
  status: number,
  statusText: string,
  body: string,
  secrets: readonly string[],
): string {
  const compactBody = redactSecrets(body, secrets)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return compactBody.length === 0
    ? `${status} ${statusText}`
    : `${status} ${statusText}: ${compactBody}`;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitLabProjectManagerError(`${label} response must be an object.`);
  }
}

function requireNumberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GitLabProjectManagerError(`GitLab response field ${field} must be a number.`);
  }
  return value;
}

function requireStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitLabProjectManagerError(`GitLab response field ${field} must be a string.`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapVisibility(value: unknown): GitLabProjectVisibility | undefined {
  return value === 'private' || value === 'internal' || value === 'public'
    ? value
    : undefined;
}

function mapGroup(raw: unknown): GitLabBootstrapGroupReference {
  assertObject(raw, 'GitLab group');
  return {
    id: requireNumberField(raw, 'id'),
    name: requireStringField(raw, 'name'),
    path: requireStringField(raw, 'path'),
    fullPath:
      optionalStringField(raw, 'full_path') ?? requireStringField(raw, 'path'),
    webUrl: optionalStringField(raw, 'web_url'),
    visibility: mapVisibility(raw['visibility']),
  };
}

function mapGroupAccessToken(raw: unknown): GitLabGroupAccessTokenReference {
  assertObject(raw, 'GitLab group access token');
  return {
    id: requireNumberField(raw, 'id'),
    name: requireStringField(raw, 'name'),
    token: requireStringField(raw, 'token'),
    scopes: Array.isArray(raw['scopes'])
      ? raw['scopes'].filter((scope): scope is string => typeof scope === 'string')
      : [],
    accessLevel: requireNumberField(raw, 'access_level'),
    expiresAt: optionalStringField(raw, 'expires_at'),
  };
}

function mapPersonalAccessToken(raw: unknown): GitLabPersonalAccessTokenReference {
  assertObject(raw, 'GitLab personal access token');
  return {
    id: requireNumberField(raw, 'id'),
    name: optionalStringField(raw, 'name'),
  };
}

export function resolveGitLabAdminBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitLabAdminBootstrapConfig | undefined {
  const enabled = parseBooleanFlag(
    env[AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED],
    AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED,
    false,
  );
  if (!enabled) {
    return undefined;
  }

  const adminTokenEnvName =
    optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV]) ??
    DEFAULT_ADMIN_TOKEN_ENV;
  const adminToken =
    optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN]) ??
    requireNonEmpty(env[adminTokenEnvName], adminTokenEnvName);
  const groupPath = requireNonEmpty(
    env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH],
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH,
  );

  return {
    baseUrl: normalizeBaseUrl(
      requireNonEmpty(env[AUTO_ARCHIVE_GITLAB_URL], AUTO_ARCHIVE_GITLAB_URL),
    ),
    adminToken,
    discardAdminToken: parseBooleanFlag(
      env[AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_DISCARD_ADMIN_TOKEN],
      AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_DISCARD_ADMIN_TOKEN,
      true,
    ),
    groupName:
      optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_NAME]) ??
      groupPath,
    groupPath,
    groupVisibility: parseVisibility(
      env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY],
      AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY,
      'private',
    ),
    runtimeTokenName:
      optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_NAME]) ??
      DEFAULT_BOOTSTRAP_RUNTIME_TOKEN_NAME,
    runtimeTokenScopes: parseScopes(
      env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_SCOPES],
    ),
    runtimeAccessLevel: parsePositiveInteger(
      env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_ACCESS_LEVEL],
      AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_ACCESS_LEVEL,
      DEFAULT_BOOTSTRAP_RUNTIME_ACCESS_LEVEL,
    ),
    runtimeTokenExpiresAt: optionalNonEmpty(
      env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_EXPIRES_AT],
    ),
    runtimeTokenEnvName:
      optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_ENV]) ??
      DEFAULT_RUNTIME_TOKEN_ENV,
    assignmentProjectPrefix:
      optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX]) ??
      DEFAULT_ASSIGNMENT_PROJECT_PREFIX,
    assignmentProjectVisibility: parseVisibility(
      env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY],
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY,
      'private',
    ),
    assignmentInitializeWithReadme: parseBooleanFlag(
      env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README],
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README,
      true,
    ),
  };
}

export class GitLabHttpAdminBootstrapClient implements GitLabAdminBootstrapClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: GitLabFetch;

  constructor(options: {
    readonly baseUrl: string;
    readonly adminToken: string;
    readonly fetchImpl?: GitLabFetch;
  }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.adminToken = requireNonEmpty(
      options.adminToken,
      AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ensureGroup(input: {
    readonly name: string;
    readonly path: string;
    readonly visibility: GitLabProjectVisibility;
  }): Promise<GitLabBootstrapGroupReference> {
    const existing = await this.request(
      'GET',
      `groups/${encodeGitLabPath(input.path)}`,
      undefined,
      { allowNotFound: true },
    );
    if (existing !== undefined) {
      return mapGroup(existing);
    }
    return mapGroup(
      await this.request('POST', 'groups', {
        name: input.name,
        path: input.path,
        visibility: input.visibility,
      }),
    );
  }

  async createGroupAccessToken(
    groupId: number,
    input: {
      readonly name: string;
      readonly scopes: readonly string[];
      readonly accessLevel: number;
      readonly expiresAt?: string;
    },
  ): Promise<GitLabGroupAccessTokenReference> {
    return mapGroupAccessToken(
      await this.request('POST', `groups/${groupId}/access_tokens`, {
        name: input.name,
        scopes: input.scopes,
        access_level: input.accessLevel,
        ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
      }),
    );
  }

  async getCurrentPersonalAccessToken(): Promise<GitLabPersonalAccessTokenReference> {
    return mapPersonalAccessToken(
      await this.request('GET', 'personal_access_tokens/self'),
    );
  }

  async validateRuntimeToken(input: {
    readonly groupId: number;
    readonly token: string;
  }): Promise<void> {
    await this.request('GET', `groups/${input.groupId}`, undefined, {
      privateToken: input.token,
      redactionSecrets: [this.adminToken, input.token],
    });
  }

  async revokePersonalAccessToken(tokenId: number): Promise<void> {
    await this.request('DELETE', `personal_access_tokens/${tokenId}`);
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    payload?: Record<string, unknown>,
    options: {
      readonly allowNotFound?: boolean;
      readonly privateToken?: string;
      readonly redactionSecrets?: readonly string[];
    } = {},
  ): Promise<unknown | undefined> {
    const privateToken = options.privateToken ?? this.adminToken;
    const response = await this.fetchImpl(createApiUrl(this.baseUrl, path), {
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        'PRIVATE-TOKEN': privateToken,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    if (response.status === 404 && options.allowNotFound === true) {
      return undefined;
    }
    if (!response.ok) {
      throw new GitLabProjectManagerError(
        `GitLab admin API ${method} ${path} failed: ${describeHttpFailure(
          response.status,
          response.statusText,
          text,
          options.redactionSecrets ?? [privateToken],
        )}`,
      );
    }
    return text.length === 0 ? {} : JSON.parse(text);
  }
}

export function renderGitLabRuntimeEnv(
  config: GitLabAdminBootstrapConfig,
  result: Pick<GitLabAdminBootstrapResult, 'group' | 'runtimeToken'>,
): string {
  return [
    '# Generated by Auto Archive GitLab admin bootstrap.',
    '# Store this in your secret manager or .env, then remove the admin bootstrap token.',
    `${AUTO_ARCHIVE_GITLAB_ENABLED}=true`,
    `${AUTO_ARCHIVE_GITLAB_URL}=${config.baseUrl}`,
    `${AUTO_ARCHIVE_GITLAB_TOKEN_ENV}=${config.runtimeTokenEnvName}`,
    `${config.runtimeTokenEnvName}=${result.runtimeToken.token}`,
    'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED=true',
    `${AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS}=true`,
    `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID}=${result.group.id}`,
    `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH}=${result.group.fullPath}`,
    `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX}=${config.assignmentProjectPrefix}`,
    `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY}=${config.assignmentProjectVisibility}`,
    `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README}=${config.assignmentInitializeWithReadme}`,
    `${AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED}=true`,
  ].join('\n');
}

export function redactGitLabAdminBootstrapResult(
  result: GitLabAdminBootstrapResult,
): GitLabAdminBootstrapResult {
  return {
    ...result,
    runtimeToken: {
      ...result.runtimeToken,
      token: '[REDACTED_SECRET]',
    },
    runtimeEnv: result.runtimeEnv.replace(
      result.runtimeToken.token,
      '[REDACTED_SECRET]',
    ),
  };
}

export async function runGitLabAdminBootstrap(
  config: GitLabAdminBootstrapConfig,
  client: GitLabAdminBootstrapClient = new GitLabHttpAdminBootstrapClient({
    baseUrl: config.baseUrl,
    adminToken: config.adminToken,
  }),
  options: GitLabAdminBootstrapRunOptions = {},
): Promise<GitLabAdminBootstrapResult> {
  const group = await client.ensureGroup({
    name: config.groupName,
    path: config.groupPath,
    visibility: config.groupVisibility,
  });
  const runtimeToken = await client.createGroupAccessToken(group.id, {
    name: config.runtimeTokenName,
    scopes: config.runtimeTokenScopes,
    accessLevel: config.runtimeAccessLevel,
    expiresAt: config.runtimeTokenExpiresAt,
  });
  const partialResult = {
    group,
    runtimeToken,
  };
  const result = {
    ...partialResult,
    adminTokenDiscarded: false,
    runtimeEnv: renderGitLabRuntimeEnv(config, partialResult),
  };

  await options.onRuntimeEnvReady?.(result);
  if (!config.discardAdminToken) {
    return result;
  }

  await client.validateRuntimeToken({
    groupId: group.id,
    token: runtimeToken.token,
  });
  const currentToken = await client.getCurrentPersonalAccessToken();
  await client.revokePersonalAccessToken(currentToken.id);

  return {
    ...result,
    adminTokenDiscarded: true,
  };
}

export async function runGitLabAdminBootstrapFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: GitLabAdminBootstrapRunOptions = {},
): Promise<GitLabAdminBootstrapResult | undefined> {
  const config = resolveGitLabAdminBootstrapConfig(env);
  return config === undefined
    ? undefined
    : runGitLabAdminBootstrap(config, undefined, options);
}
