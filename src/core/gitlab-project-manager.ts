import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { TerminalEvidence } from '../contracts/terminal-evidence.js';
import { deriveOutcomeFromCause } from './derive-outcome.js';
import type { DispatchPlan } from './task.js';

export const AUTO_ARCHIVE_GITLAB_ENABLED = 'AUTO_ARCHIVE_GITLAB_ENABLED';
export const AUTO_ARCHIVE_GITLAB_URL = 'AUTO_ARCHIVE_GITLAB_URL';
export const AUTO_ARCHIVE_GITLAB_PROJECT_ID = 'AUTO_ARCHIVE_GITLAB_PROJECT_ID';
export const AUTO_ARCHIVE_GITLAB_TOKEN = 'AUTO_ARCHIVE_GITLAB_TOKEN';
export const AUTO_ARCHIVE_GITLAB_TOKEN_ENV = 'AUTO_ARCHIVE_GITLAB_TOKEN_ENV';
export const AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED =
  'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED';
export const AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS =
  'AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS';
export const AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID =
  'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID';
export const AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH =
  'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH';
export const AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX =
  'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX';
export const AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY =
  'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY';
export const AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README =
  'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README';
export const AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID =
  'AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID';
export const AUTO_ARCHIVE_GITLAB_WORK_RESULT_LABELS =
  'AUTO_ARCHIVE_GITLAB_WORK_RESULT_LABELS';
export const AUTO_ARCHIVE_GITLAB_WORK_RESULT_INTERNAL =
  'AUTO_ARCHIVE_GITLAB_WORK_RESULT_INTERNAL';
export const AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED =
  'AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED';
export const AUTO_ARCHIVE_GITLAB_ARTIFACT_DESTINATION_PREFIX =
  'AUTO_ARCHIVE_GITLAB_ARTIFACT_DESTINATION_PREFIX';
export const AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_TOTAL_BYTES =
  'AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_TOTAL_BYTES';
export const AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_FILE_BYTES =
  'AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_FILE_BYTES';

const DEFAULT_GITLAB_TOKEN_ENV = 'GITLAB_TOKEN';
const DEFAULT_ASSIGNMENT_PROJECT_PREFIX = 'auto-archive-task';
const DEFAULT_ARTIFACT_DESTINATION_PREFIX = 'artifacts';
const DEFAULT_ARTIFACT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_WORK_RESULT_LABELS = Object.freeze([
  'auto-archive',
  'agent-result',
]);
const MAX_RENDERED_INSTRUCTION_LENGTH = 4_000;
const MAX_RENDERED_REASON_LENGTH = 2_000;
const MAX_RENDERED_PUBLISHED_FILES = 30;
const TEST_MARKER_COMMANDS = Object.freeze({
  'package.json': 'npm test',
  'pnpm-lock.yaml': 'pnpm test',
  'pytest.ini': 'pytest',
  'run_tests.py': 'python run_tests.py',
} satisfies Record<string, string>);

type GitLabFetch = typeof fetch;

export class GitLabProjectManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLabProjectManagerError';
    Object.setPrototypeOf(this, GitLabProjectManagerError.prototype);
  }
}

export type GitLabProjectVisibility = 'private' | 'internal' | 'public';

export interface GitLabAssignmentConfig {
  readonly enabled: boolean;
  readonly autoCreateProjects: boolean;
  readonly namespaceId?: number;
  readonly namespacePath?: string;
  readonly projectPrefix: string;
  readonly projectVisibility: GitLabProjectVisibility;
  readonly initializeWithReadme: boolean;
}

export interface GitLabArtifactPublicationConfig {
  readonly enabled: boolean;
  readonly destinationPrefix: string;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export interface GitLabIntegrationConfig {
  readonly baseUrl: string;
  readonly projectId?: string;
  readonly token: string;
  readonly assignment: GitLabAssignmentConfig;
  readonly workResultIssueIid?: number;
  readonly workResultLabels: readonly string[];
  readonly workResultInternal: boolean;
  readonly artifactPublication: GitLabArtifactPublicationConfig;
}

export interface GitLabNamespaceReference {
  readonly id: number;
  readonly name?: string;
  readonly path?: string;
  readonly fullPath?: string;
}

export interface GitLabManagedProjectReference {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly pathWithNamespace: string;
  readonly visibility?: GitLabProjectVisibility;
  readonly webUrl?: string;
  readonly sshUrlToRepo?: string;
  readonly httpUrlToRepo?: string;
  readonly namespace?: GitLabNamespaceReference;
}

export interface GitLabIssueReference {
  readonly id: number;
  readonly iid: number;
  readonly projectId?: number;
  readonly title: string;
  readonly state: string;
  readonly webUrl?: string;
}

export interface GitLabIssueNoteReference {
  readonly id: number;
  readonly body: string;
  readonly internal: boolean;
  readonly webUrl?: string;
}

export interface GitLabCreateIssueInput {
  readonly title: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly confidential?: boolean;
}

export interface GitLabCreateIssueNoteInput {
  readonly issueIid: number;
  readonly body: string;
  readonly internal?: boolean;
}

export type GitLabCommitActionKind = 'create' | 'update';

export interface GitLabCommitActionInput {
  readonly action: GitLabCommitActionKind;
  readonly filePath: string;
  readonly content: string;
  readonly encoding?: 'base64' | 'text';
}

export interface GitLabCreateCommitInput {
  readonly branch: string;
  readonly commitMessage: string;
  readonly actions: readonly GitLabCommitActionInput[];
}

export interface GitLabCommitReference {
  readonly id: string;
  readonly shortId?: string;
  readonly title?: string;
  readonly webUrl?: string;
}

export interface GitLabProjectManager {
  createIssue(input: GitLabCreateIssueInput): Promise<GitLabIssueReference>;
  createIssueNote(input: GitLabCreateIssueNoteInput): Promise<GitLabIssueNoteReference>;
  closeIssue(issueIid: number): Promise<GitLabIssueReference>;
}

export interface GitLabCreateProjectInput {
  readonly name: string;
  readonly path?: string;
  readonly namespaceId?: number;
  readonly description?: string;
  readonly visibility?: GitLabProjectVisibility;
  readonly initializeWithReadme?: boolean;
}

export interface GitLabEnsureProjectInput extends GitLabCreateProjectInput {
  readonly lookupPath?: string;
}

export interface GitLabInstanceManager {
  getProject(projectId: string | number): Promise<GitLabManagedProjectReference>;
  tryGetProject(projectId: string | number): Promise<GitLabManagedProjectReference | undefined>;
  createProject(input: GitLabCreateProjectInput): Promise<GitLabManagedProjectReference>;
  ensureProject(input: GitLabEnsureProjectInput): Promise<GitLabManagedProjectReference>;
  createIssueInProject(
    projectId: string | number,
    input: GitLabCreateIssueInput,
  ): Promise<GitLabIssueReference>;
  createIssueNoteInProject(
    projectId: string | number,
    input: GitLabCreateIssueNoteInput,
  ): Promise<GitLabIssueNoteReference>;
  closeIssueInProject(
    projectId: string | number,
    issueIid: number,
  ): Promise<GitLabIssueReference>;
  repositoryFileExistsInProject(
    projectId: string | number,
    filePath: string,
    ref: string,
  ): Promise<boolean>;
  createCommitInProject(
    projectId: string | number,
    input: GitLabCreateCommitInput,
  ): Promise<GitLabCommitReference>;
  listProjects?(input?: {
    readonly search?: string;
    readonly membership?: boolean;
  }): Promise<readonly GitLabManagedProjectReference[]>;
  archiveProject?(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference>;
}

export interface GitLabProjectAssignment {
  readonly taskId: string;
  readonly assignee: string;
  readonly project: GitLabManagedProjectReference;
  readonly assignmentKind: 'existing-project' | 'created-or-reused-project';
  readonly assignedAt: string;
  readonly instructionBlock: string;
}

export interface GitLabProjectAssignmentManager {
  assignProjectForTask(plan: DispatchPlan): Promise<GitLabProjectAssignment>;
}

export type GitLabWorkResultRecord =
  | {
      readonly kind: 'issue-created';
      readonly issue: GitLabIssueReference;
      readonly artifactPublication?: GitLabArtifactPublication;
    }
  | {
      readonly kind: 'note-created';
      readonly issueIid: number;
      readonly note: GitLabIssueNoteReference;
      readonly artifactPublication?: GitLabArtifactPublication;
    };

export type GitLabWorkResultRecording =
  | GitLabWorkResultRecord
  | {
      readonly kind: 'failed';
      readonly reason: string;
    };

export type GitLabArtifactPublication =
  | {
      readonly kind: 'commit-created';
      readonly projectId: string | number;
      readonly branch: string;
      readonly commitId: string;
      readonly destinationPrefix: string;
      readonly publishedFiles: readonly string[];
    }
  | {
      readonly kind: 'skipped';
      readonly reason: string;
    }
  | {
      readonly kind: 'failed';
      readonly reason: string;
    };

export interface GitLabHttpProjectManagerOptions {
  readonly baseUrl: string;
  readonly projectId: string | number;
  readonly token: string;
  readonly fetchImpl?: GitLabFetch;
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

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
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

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseLabels(value: string | undefined): readonly string[] {
  const labels =
    value === undefined || value.trim().length === 0
      ? DEFAULT_WORK_RESULT_LABELS
      : value
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean);
  return [...new Set(labels)];
}

function parsePositiveIntegerWithDefault(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  return parsePositiveInteger(value, name) ?? defaultValue;
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

export function resolveGitLabIntegrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitLabIntegrationConfig | undefined {
  const enabled = parseBooleanFlag(
    env[AUTO_ARCHIVE_GITLAB_ENABLED],
    AUTO_ARCHIVE_GITLAB_ENABLED,
    false,
  );
  if (!enabled) {
    return undefined;
  }

  const tokenEnvName =
    env[AUTO_ARCHIVE_GITLAB_TOKEN_ENV]?.trim() || DEFAULT_GITLAB_TOKEN_ENV;
  const token =
    env[AUTO_ARCHIVE_GITLAB_TOKEN]?.trim() ||
    requireNonEmpty(env[tokenEnvName], tokenEnvName);
  const assignment: GitLabAssignmentConfig = {
    enabled: parseBooleanFlag(
      env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED],
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED,
      false,
    ),
    autoCreateProjects: parseBooleanFlag(
      env[AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS],
      AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS,
      false,
    ),
    namespaceId: parsePositiveInteger(
      env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID],
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID,
    ),
    namespacePath: optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH]),
    projectPrefix:
      optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX]) ??
      DEFAULT_ASSIGNMENT_PROJECT_PREFIX,
    projectVisibility: parseVisibility(
      env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY],
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY,
      'private',
    ),
    initializeWithReadme: parseBooleanFlag(
      env[AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README],
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README,
      true,
    ),
  };

  if (
    assignment.enabled &&
    assignment.autoCreateProjects &&
    assignment.namespaceId === undefined
  ) {
    throw new GitLabProjectManagerError(
      `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID} is required when ${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED}=true and ${AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS}=true.`,
    );
  }

  return {
    baseUrl: normalizeBaseUrl(requireNonEmpty(env[AUTO_ARCHIVE_GITLAB_URL], AUTO_ARCHIVE_GITLAB_URL)),
    projectId: optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_PROJECT_ID]),
    token,
    assignment,
    workResultIssueIid: parsePositiveInteger(
      env[AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID],
      AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID,
    ),
    workResultLabels: parseLabels(env[AUTO_ARCHIVE_GITLAB_WORK_RESULT_LABELS]),
    workResultInternal: parseBooleanFlag(
      env[AUTO_ARCHIVE_GITLAB_WORK_RESULT_INTERNAL],
      AUTO_ARCHIVE_GITLAB_WORK_RESULT_INTERNAL,
      false,
    ),
    artifactPublication: {
      enabled: parseBooleanFlag(
        env[AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED],
        AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED,
        false,
      ),
      destinationPrefix:
        optionalNonEmpty(env[AUTO_ARCHIVE_GITLAB_ARTIFACT_DESTINATION_PREFIX]) ??
        DEFAULT_ARTIFACT_DESTINATION_PREFIX,
      maxTotalBytes: parsePositiveIntegerWithDefault(
        env[AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_TOTAL_BYTES],
        AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_TOTAL_BYTES,
        DEFAULT_ARTIFACT_MAX_TOTAL_BYTES,
      ),
      maxFileBytes: parsePositiveIntegerWithDefault(
        env[AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_FILE_BYTES],
        AUTO_ARCHIVE_GITLAB_ARTIFACT_MAX_FILE_BYTES,
        DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      ),
    },
  };
}

function encodeProjectId(projectId: string | number): string {
  return encodeURIComponent(String(projectId));
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

function optionalNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapIssueReference(raw: unknown): GitLabIssueReference {
  assertObject(raw, 'GitLab issue');
  return {
    id: requireNumberField(raw, 'id'),
    iid: requireNumberField(raw, 'iid'),
    projectId: optionalNumberField(raw, 'project_id'),
    title: requireStringField(raw, 'title'),
    state: requireStringField(raw, 'state'),
    webUrl: optionalStringField(raw, 'web_url'),
  };
}

function mapIssueNoteReference(raw: unknown): GitLabIssueNoteReference {
  assertObject(raw, 'GitLab issue note');
  return {
    id: requireNumberField(raw, 'id'),
    body: requireStringField(raw, 'body'),
    internal: raw['internal'] === true,
    webUrl: optionalStringField(raw, 'web_url'),
  };
}

function mapCommitReference(raw: unknown): GitLabCommitReference {
  assertObject(raw, 'GitLab commit');
  return {
    id: requireStringField(raw, 'id'),
    shortId: optionalStringField(raw, 'short_id'),
    title: optionalStringField(raw, 'title'),
    webUrl: optionalStringField(raw, 'web_url'),
  };
}

function mapNamespaceReference(raw: unknown): GitLabNamespaceReference | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = optionalNumberField(record, 'id');
  if (id === undefined) {
    return undefined;
  }
  return {
    id,
    name: optionalStringField(record, 'name'),
    path: optionalStringField(record, 'path'),
    fullPath: optionalStringField(record, 'full_path'),
  };
}

function mapProjectVisibility(value: unknown): GitLabProjectVisibility | undefined {
  return value === 'private' || value === 'internal' || value === 'public'
    ? value
    : undefined;
}

function mapManagedProjectReference(raw: unknown): GitLabManagedProjectReference {
  assertObject(raw, 'GitLab project');
  return {
    id: requireNumberField(raw, 'id'),
    name: requireStringField(raw, 'name'),
    path: requireStringField(raw, 'path'),
    pathWithNamespace: requireStringField(raw, 'path_with_namespace'),
    visibility: mapProjectVisibility(raw['visibility']),
    webUrl: optionalStringField(raw, 'web_url'),
    sshUrlToRepo: optionalStringField(raw, 'ssh_url_to_repo'),
    httpUrlToRepo: optionalStringField(raw, 'http_url_to_repo'),
    namespace: mapNamespaceReference(raw['namespace']),
  };
}

function redactSecret(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join('[REDACTED_SECRET]');
}

function describeHttpFailure(
  status: number,
  statusText: string,
  body: string,
  secret: string,
): string {
  const compactBody = redactSecret(body, secret)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return compactBody.length === 0
    ? `${status} ${statusText}`
    : `${status} ${statusText}: ${compactBody}`;
}

export class GitLabHttpProjectManager implements GitLabProjectManager {
  private readonly baseUrl: string;
  private readonly projectId: string | number;
  private readonly token: string;
  private readonly fetchImpl: GitLabFetch;

  constructor(options: GitLabHttpProjectManagerOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.projectId = options.projectId;
    this.token = requireNonEmpty(options.token, AUTO_ARCHIVE_GITLAB_TOKEN);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createIssue(input: GitLabCreateIssueInput): Promise<GitLabIssueReference> {
    const body: Record<string, unknown> = {
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.labels === undefined || input.labels.length === 0
        ? {}
        : { labels: input.labels.join(',') }),
      ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
    };
    return mapIssueReference(await this.request('POST', 'issues', body));
  }

  async createIssueNote(
    input: GitLabCreateIssueNoteInput,
  ): Promise<GitLabIssueNoteReference> {
    const body: Record<string, unknown> = {
      body: input.body,
      ...(input.internal === undefined ? {} : { internal: input.internal }),
    };
    return mapIssueNoteReference(
      await this.request('POST', `issues/${input.issueIid}/notes`, body),
    );
  }

  async closeIssue(issueIid: number): Promise<GitLabIssueReference> {
    return mapIssueReference(
      await this.request('PUT', `issues/${issueIid}`, { state_event: 'close' }),
    );
  }

  private createUrl(path: string): string {
    return createApiUrl(
      this.baseUrl,
      `projects/${encodeProjectId(this.projectId)}/${path}`,
    );
  }

  private async request(
    method: 'POST' | 'PUT',
    path: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.createUrl(path);
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'PRIVATE-TOKEN': this.token,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GitLabProjectManagerError(
        `GitLab API ${method} ${path} failed: ${describeHttpFailure(
          response.status,
          response.statusText,
          text,
          this.token,
        )}`,
      );
    }
    return text.length === 0 ? {} : JSON.parse(text);
  }
}

function createIssuePayload(input: GitLabCreateIssueInput): Record<string, unknown> {
  return {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.labels === undefined || input.labels.length === 0
      ? {}
      : { labels: input.labels.join(',') }),
    ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
  };
}

function createIssueNotePayload(
  input: GitLabCreateIssueNoteInput,
): Record<string, unknown> {
  return {
    body: input.body,
    ...(input.internal === undefined ? {} : { internal: input.internal }),
  };
}

function createProjectPayload(
  input: GitLabCreateProjectInput,
): Record<string, unknown> {
  return {
    name: input.name,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.namespaceId === undefined
      ? {}
      : { namespace_id: input.namespaceId }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    ...(input.initializeWithReadme === undefined
      ? {}
      : { initialize_with_readme: input.initializeWithReadme }),
  };
}

function createCommitPayload(input: GitLabCreateCommitInput): Record<string, unknown> {
  return {
    branch: input.branch,
    commit_message: input.commitMessage,
    actions: input.actions.map((action) => ({
      action: action.action,
      file_path: action.filePath,
      content: action.content,
      ...(action.encoding === undefined ? {} : { encoding: action.encoding }),
    })),
  };
}

export interface GitLabHttpInstanceManagerOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: GitLabFetch;
}

export class GitLabHttpInstanceManager implements GitLabInstanceManager {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: GitLabFetch;

  constructor(options: GitLabHttpInstanceManagerOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = requireNonEmpty(options.token, AUTO_ARCHIVE_GITLAB_TOKEN);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getProject(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference> {
    return mapManagedProjectReference(
      await this.request('GET', `projects/${encodeProjectId(projectId)}`),
    );
  }

  async tryGetProject(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference | undefined> {
    const raw = await this.request(
      'GET',
      `projects/${encodeProjectId(projectId)}`,
      undefined,
      { allowNotFound: true },
    );
    return raw === undefined ? undefined : mapManagedProjectReference(raw);
  }

  async createProject(
    input: GitLabCreateProjectInput,
  ): Promise<GitLabManagedProjectReference> {
    return mapManagedProjectReference(
      await this.request('POST', 'projects', createProjectPayload(input)),
    );
  }

  async ensureProject(
    input: GitLabEnsureProjectInput,
  ): Promise<GitLabManagedProjectReference> {
    if (input.lookupPath !== undefined) {
      const existing = await this.tryGetProject(input.lookupPath);
      if (existing !== undefined) {
        return existing;
      }
    }
    return this.createProject(input);
  }

  async createIssueInProject(
    projectId: string | number,
    input: GitLabCreateIssueInput,
  ): Promise<GitLabIssueReference> {
    return mapIssueReference(
      await this.request(
        'POST',
        `projects/${encodeProjectId(projectId)}/issues`,
        createIssuePayload(input),
      ),
    );
  }

  async createIssueNoteInProject(
    projectId: string | number,
    input: GitLabCreateIssueNoteInput,
  ): Promise<GitLabIssueNoteReference> {
    return mapIssueNoteReference(
      await this.request(
        'POST',
        `projects/${encodeProjectId(projectId)}/issues/${input.issueIid}/notes`,
        createIssueNotePayload(input),
      ),
    );
  }

  async closeIssueInProject(
    projectId: string | number,
    issueIid: number,
  ): Promise<GitLabIssueReference> {
    return mapIssueReference(
      await this.request(
        'PUT',
        `projects/${encodeProjectId(projectId)}/issues/${issueIid}`,
        { state_event: 'close' },
      ),
    );
  }

  async repositoryFileExistsInProject(
    projectId: string | number,
    filePath: string,
    ref: string,
  ): Promise<boolean> {
    const raw = await this.request(
      'GET',
      `projects/${encodeProjectId(projectId)}/repository/files/${encodeURIComponent(
        filePath,
      )}?ref=${encodeURIComponent(ref)}`,
      undefined,
      { allowNotFound: true },
    );
    return raw !== undefined;
  }

  async createCommitInProject(
    projectId: string | number,
    input: GitLabCreateCommitInput,
  ): Promise<GitLabCommitReference> {
    return mapCommitReference(
      await this.request(
        'POST',
        `projects/${encodeProjectId(projectId)}/repository/commits`,
        createCommitPayload(input),
      ),
    );
  }

  async listProjects(input: {
    readonly search?: string;
    readonly membership?: boolean;
  } = {}): Promise<readonly GitLabManagedProjectReference[]> {
    const params = new URLSearchParams();
    if (input.search !== undefined) {
      params.set('search', input.search);
    }
    if (input.membership !== undefined) {
      params.set('membership', input.membership ? 'true' : 'false');
    }
    const suffix = params.toString();
    const raw = await this.request('GET', `projects${suffix.length === 0 ? '' : `?${suffix}`}`);
    if (!Array.isArray(raw)) {
      throw new GitLabProjectManagerError('GitLab projects response must be an array.');
    }
    return raw.map(mapManagedProjectReference);
  }

  async archiveProject(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference> {
    return mapManagedProjectReference(
      await this.request(
        'POST',
        `projects/${encodeProjectId(projectId)}/archive`,
        {},
      ),
    );
  }

  createProjectManager(projectId: string | number): GitLabProjectManager {
    return new GitLabHttpProjectManager({
      baseUrl: this.baseUrl,
      projectId,
      token: this.token,
      fetchImpl: this.fetchImpl,
    });
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: Record<string, unknown>,
    options: { readonly allowNotFound?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(createApiUrl(this.baseUrl, path), {
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        'PRIVATE-TOKEN': this.token,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    if (response.status === 404 && options.allowNotFound === true) {
      return undefined;
    }
    if (!response.ok) {
      throw new GitLabProjectManagerError(
        `GitLab API ${method} ${path} failed: ${describeHttpFailure(
          response.status,
          response.statusText,
          text,
          this.token,
        )}`,
      );
    }
    return text.length === 0 ? {} : JSON.parse(text);
  }
}

function truncateForGitLab(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

function renderMaybe(value: string | undefined): string {
  return value === undefined ? '(none)' : value;
}

function renderRuntimeWarnings(evidence: TerminalEvidence): string[] {
  const warnings = evidence.runtimeWarnings ?? [];
  if (warnings.length === 0) {
    return ['- Runtime warnings: none'];
  }
  return [
    `- Runtime warnings: ${warnings.length}`,
    ...warnings
      .slice(0, 10)
      .map(
        (warning) =>
          `  - ${warning.status}: ${warning.reason} (provenance=${warning.provenance}, count=${warning.count}, fingerprint=${warning.fingerprint.slice(0, 16)})`,
      ),
  ];
}

function detectTestCommandFromPublishedFiles(
  publishedFiles: readonly string[] | undefined,
): string | undefined {
  if (publishedFiles === undefined) {
    return undefined;
  }
  for (const filePath of publishedFiles) {
    const fileName = path.posix.basename(filePath);
    const command = TEST_MARKER_COMMANDS[fileName as keyof typeof TEST_MARKER_COMMANDS];
    if (command !== undefined) {
      return command;
    }
  }
  return undefined;
}

export function renderGitLabTaskProjectReadme(input: {
  readonly plan: DispatchPlan;
  readonly evidence?: TerminalEvidence;
  readonly assignment?: GitLabProjectAssignment;
  readonly artifactPublication?: GitLabArtifactPublication;
}): string {
  const publication = input.artifactPublication;
  const issueHint =
    input.evidence === undefined
      ? '(pending)'
      : `Auto Archive task ${input.evidence.taskId}`;
  const testCommand =
    publication?.kind === 'commit-created'
      ? detectTestCommandFromPublishedFiles(publication.publishedFiles)
      : undefined;
  const artifactPrefix =
    publication?.kind === 'commit-created'
      ? `\`${publication.destinationPrefix}\``
      : '(pending or unavailable)';
  return [
    `# Auto Archive task project — ${input.plan.taskId}`,
    '',
    `- Task ID: \`${input.plan.taskId}\``,
    `- Status: \`${input.evidence === undefined ? 'assigned' : deriveOutcomeFromCause(input.evidence.cause)}\``,
    `- Artifact prefix: ${artifactPrefix}`,
    `- Latest result issue: ${issueHint}`,
    `- GitLab assignment: ${input.assignment?.assignmentKind ?? 'unassigned'}`,
    `- Optional test command: ${testCommand ?? '(none detected)'}`,
    '',
    '## Notes',
    '',
    '- This README is generated by Auto Archive and is non-secret by construction.',
    '- GitLab CI generation is intentionally deferred; detected test commands are metadata only.',
  ].join('\\n');
}

export function renderGitLabWorkResultMarkdown(
  plan: DispatchPlan,
  evidence: TerminalEvidence,
  artifactPublication?: GitLabArtifactPublication,
): string {
  const outcome = deriveOutcomeFromCause(evidence.cause);
  const sections = [
    `# Auto Archive agent result — ${outcome}`,
    '',
    `- Task ID: \`${evidence.taskId}\``,
    `- Runtime instance: \`${evidence.runtimeInstanceId}\``,
    `- Outcome: \`${outcome}\``,
    `- Cause kind: \`${evidence.cause.kind}\``,
    `- Provenance: \`${evidence.provenance}\``,
    `- Started: ${evidence.startedAt}`,
    `- Ended: ${evidence.endedAt}`,
    `- Artifact location: ${renderMaybe(evidence.artifactLocation)}`,
    `- Execution checkpoint: ${renderMaybe(evidence.executionContext.executionCheckpoint?.revision)}`,
    ...renderRuntimeWarnings(evidence),
    '',
    '## Reason',
    '',
    truncateForGitLab(evidence.reason, MAX_RENDERED_REASON_LENGTH),
    '',
    '## Original instruction',
    '',
    '~~~text',
    truncateForGitLab(plan.instruction, MAX_RENDERED_INSTRUCTION_LENGTH),
    '~~~',
  ];

  if (artifactPublication !== undefined) {
    sections.push('', renderGitLabArtifactPublicationMarkdown(artifactPublication));
  }

  sections.push(
    '',
    '## Terminal evidence',
    '',
    `- Terminal cause: \`${evidence.cause.kind}\``,
    `- Runtime veto: ${evidence.abort?.veto.provenance ?? '(none)'}`,
    `- Transcript events: ${evidence.transcript?.events.length ?? 0}`,
    '',
    '## Operator follow-up',
    '',
    '- Use Discord `/status`, `/history`, `/context`, `/focus`, and `/unfocus` for bounded follow-up routing.',
  );

  return sections.join('\n');
}

function renderGitLabArtifactPublicationMarkdown(
  publication: GitLabArtifactPublication,
): string {
  if (publication.kind === 'commit-created') {
    const hiddenCount = Math.max(
      0,
      publication.publishedFiles.length - MAX_RENDERED_PUBLISHED_FILES,
    );
    return [
      '## Artifact publication',
      '',
      `- Status: \`${publication.kind}\``,
      `- Project ID: \`${publication.projectId}\``,
      `- Branch: \`${publication.branch}\``,
      `- Commit: \`${publication.commitId}\``,
      `- Destination prefix: \`${publication.destinationPrefix}\``,
      `- Published files: ${publication.publishedFiles.length}`,
      '',
      ...publication.publishedFiles
        .slice(0, MAX_RENDERED_PUBLISHED_FILES)
        .map((filePath) => `- \`${filePath}\``),
      ...(hiddenCount === 0 ? [] : [`- ... ${hiddenCount} more file(s)`]),
    ].join('\n');
  }

  return [
    '## Artifact publication',
    '',
    `- Status: \`${publication.kind}\``,
    `- Reason: ${publication.reason}`,
  ].join('\n');
}

function sanitizeGitLabProjectPath(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized.length === 0 ? 'task' : normalized.slice(0, 255);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength)}…`;
}

export function renderGitLabProjectAssignmentInstruction(
  assignment: GitLabProjectAssignment,
): string {
  return [
    '',
    '---',
    'AUTO_ARCHIVE GITLAB ASSIGNMENT',
    '',
    'Arona assigned a GitLab project for durable task notes, code/artifact references, and subagent coordination when GitLab is needed.',
    'Use the numeric project ID below for GitLab API calls; full project paths and clone URLs are intentionally kept out of this prompt and remain in Arona control-plane metadata.',
    `- Assignment kind: ${assignment.assignmentKind}`,
    `- Assigned at: ${assignment.assignedAt}`,
    `- Assignee: ${assignment.assignee}`,
    `- Task ID: ${assignment.taskId}`,
    `- GitLab project ID: ${assignment.project.id}`,
    `- Visibility: ${renderMaybe(assignment.project.visibility)}`,
    `- GitLab origin: ${renderMaybe(renderGitLabOrigin(assignment.project.webUrl))}`,
    `- GitLab API project selector: ${assignment.project.id}`,
    '',
    'Do not create unmanaged GitLab projects for this task. If another project is required, ask Arona/Auto Archive for a new assignment.',
    '---',
  ].join('\n');
}

function renderGitLabOrigin(webUrl: string | undefined): string | undefined {
  if (webUrl === undefined) {
    return undefined;
  }
  try {
    return new URL(webUrl).origin;
  } catch {
    return undefined;
  }
}

export function appendGitLabProjectAssignmentInstruction(
  instruction: string,
  assignment: GitLabProjectAssignment,
): string {
  return `${instruction.trimEnd()}${assignment.instructionBlock}`;
}

export interface GitLabProjectAssignmentServiceOptions {
  readonly defaultProjectId?: string | number;
  readonly autoCreateProjects: boolean;
  readonly namespaceId?: number;
  readonly namespacePath?: string;
  readonly projectPrefix: string;
  readonly projectVisibility: GitLabProjectVisibility;
  readonly initializeWithReadme: boolean;
  readonly assignee?: string;
}

export class GitLabProjectAssignmentService
  implements GitLabProjectAssignmentManager
{
  private readonly defaultProjectId: string | number | undefined;
  private readonly autoCreateProjects: boolean;
  private readonly namespaceId: number | undefined;
  private readonly namespacePath: string | undefined;
  private readonly projectPrefix: string;
  private readonly projectVisibility: GitLabProjectVisibility;
  private readonly initializeWithReadme: boolean;
  private readonly assignee: string;

  constructor(
    private readonly manager: GitLabInstanceManager,
    options: GitLabProjectAssignmentServiceOptions,
  ) {
    this.defaultProjectId = options.defaultProjectId;
    this.autoCreateProjects = options.autoCreateProjects;
    this.namespaceId = options.namespaceId;
    this.namespacePath = options.namespacePath;
    this.projectPrefix = options.projectPrefix;
    this.projectVisibility = options.projectVisibility;
    this.initializeWithReadme = options.initializeWithReadme;
    this.assignee = options.assignee ?? 'subagent';
  }

  async assignProjectForTask(plan: DispatchPlan): Promise<GitLabProjectAssignment> {
    const project = this.autoCreateProjects
      ? await this.ensureTaskProject(plan)
      : await this.getDefaultProject();
    const assignmentWithoutBlock = {
      taskId: plan.taskId,
      assignee: this.assignee,
      project,
      assignmentKind: this.autoCreateProjects
        ? 'created-or-reused-project'
        : 'existing-project',
      assignedAt: new Date().toISOString(),
      instructionBlock: '',
    } satisfies GitLabProjectAssignment;

    const instructionBlock = renderGitLabProjectAssignmentInstruction({
      ...assignmentWithoutBlock,
      instructionBlock: '',
    });

    return {
      ...assignmentWithoutBlock,
      instructionBlock,
    };
  }

  private async getDefaultProject(): Promise<GitLabManagedProjectReference> {
    if (this.defaultProjectId === undefined) {
      throw new GitLabProjectManagerError(
        `${AUTO_ARCHIVE_GITLAB_PROJECT_ID} is required for GitLab assignment when ${AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS}=false.`,
      );
    }
    return this.manager.getProject(this.defaultProjectId);
  }

  private async ensureTaskProject(
    plan: DispatchPlan,
  ): Promise<GitLabManagedProjectReference> {
    if (this.namespaceId === undefined) {
      throw new GitLabProjectManagerError(
        `${AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID} is required to create task projects.`,
      );
    }

    const path = sanitizeGitLabProjectPath(`${this.projectPrefix}-${plan.taskId}`);
    const lookupPath =
      this.namespacePath === undefined ? undefined : `${this.namespacePath}/${path}`;
    return this.manager.ensureProject({
      lookupPath,
      name: truncateSingleLine(`${this.projectPrefix} ${plan.taskId}`, 255),
      path,
      namespaceId: this.namespaceId,
      description: truncateSingleLine(
        `Auto Archive task project for ${plan.taskId}: ${plan.instruction}`,
        1_000,
      ),
      visibility: this.projectVisibility,
      initializeWithReadme: this.initializeWithReadme,
    });
  }
}

function isGitLabInstanceManager(
  manager: GitLabProjectManager | GitLabInstanceManager,
): manager is GitLabInstanceManager {
  return 'createIssueInProject' in manager;
}

interface CollectedArtifactFile {
  readonly relativePath: string;
  readonly content: Buffer;
}

export interface GitLabArtifactPublisherOptions {
  readonly enabled?: boolean;
  readonly projectId?: string | number;
  readonly branch?: string;
  readonly destinationPrefix?: string;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
}

function normalizeDestinationPrefix(value: string | undefined): string {
  const trimmed =
    value === undefined || value.trim().length === 0
      ? DEFAULT_ARTIFACT_DESTINATION_PREFIX
      : value.trim();
  return trimmed.replace(/^\/+|\/+$/g, '') || DEFAULT_ARTIFACT_DESTINATION_PREFIX;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function shouldSkipArtifactEntry(relativePath: string, isDirectory: boolean): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  if (
    segments.includes('.git') ||
    segments.includes('node_modules') ||
    segments.includes('__pycache__')
  ) {
    return true;
  }
  if (isDirectory) {
    return false;
  }
  const fileName = segments.at(-1) ?? '';
  return fileName === '.DS_Store' || fileName.endsWith('.pyc');
}

function resolveArtifactRoot(plan: DispatchPlan, evidence: TerminalEvidence): string {
  const artifactLocation = evidence.artifactLocation ?? plan.artifactLocation;
  if (artifactLocation === undefined || artifactLocation.trim().length === 0) {
    throw new GitLabProjectManagerError(
      'GitLab artifact publication requires a terminal artifactLocation.',
    );
  }
  return path.resolve(artifactLocation);
}

async function collectArtifactFiles(params: {
  readonly root: string;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}): Promise<CollectedArtifactFile[]> {
  const files: CollectedArtifactFile[] = [];
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(params.root, absolutePath));
      if (relativePath.length === 0 || shouldSkipArtifactEntry(relativePath, entry.isDirectory())) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fileStats = await stat(absolutePath);
      if (fileStats.size > params.maxFileBytes) {
        throw new GitLabProjectManagerError(
          `Artifact file ${relativePath} exceeds ${params.maxFileBytes} bytes.`,
        );
      }
      totalBytes += fileStats.size;
      if (totalBytes > params.maxTotalBytes) {
        throw new GitLabProjectManagerError(
          `Artifact publication exceeds ${params.maxTotalBytes} total bytes.`,
        );
      }
      files.push({
        relativePath,
        content: await readFile(absolutePath),
      });
    }
  };

  await walk(params.root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export class GitLabArtifactPublisher {
  private readonly enabled: boolean;
  private readonly projectId: string | number | undefined;
  private readonly branch: string;
  private readonly destinationPrefix: string;
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly manager: GitLabInstanceManager,
    options: GitLabArtifactPublisherOptions = {},
  ) {
    this.enabled = options.enabled ?? false;
    this.projectId = options.projectId;
    this.branch = options.branch ?? 'main';
    this.destinationPrefix = normalizeDestinationPrefix(options.destinationPrefix);
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_ARTIFACT_MAX_TOTAL_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_ARTIFACT_MAX_FILE_BYTES;
  }

  async publish(
    plan: DispatchPlan,
    evidence: TerminalEvidence,
    assignment?: GitLabProjectAssignment,
  ): Promise<GitLabArtifactPublication> {
    if (!this.enabled) {
      return { kind: 'skipped', reason: 'GitLab artifact publishing is disabled.' };
    }
    if (deriveOutcomeFromCause(evidence.cause) !== 'success') {
      return {
        kind: 'skipped',
        reason: 'GitLab artifact publishing only runs for successful terminal tasks.',
      };
    }

    try {
      const projectId = assignment?.project.id ?? this.projectId;
      if (projectId === undefined) {
        throw new GitLabProjectManagerError(
          'GitLab artifact publication requires a project id or project assignment.',
        );
      }

      const artifactRoot = resolveArtifactRoot(plan, evidence);
      const files = await collectArtifactFiles({
        root: artifactRoot,
        maxFileBytes: this.maxFileBytes,
        maxTotalBytes: this.maxTotalBytes,
      });
      if (files.length === 0) {
        throw new GitLabProjectManagerError(
          `No publishable artifact files found under ${artifactRoot}.`,
        );
      }

      const actions: GitLabCommitActionInput[] = [];
      const publishedFiles: string[] = [];
      for (const file of files) {
        const destinationPath = `${this.destinationPrefix}/${plan.taskId}/${file.relativePath}`;
        const exists = await this.manager.repositoryFileExistsInProject(
          projectId,
          destinationPath,
          this.branch,
        );
        actions.push({
          action: exists ? 'update' : 'create',
          filePath: destinationPath,
          content: file.content.toString('base64'),
          encoding: 'base64',
        });
        publishedFiles.push(destinationPath);
      }
      if (assignment !== undefined) {
        const readmePath = 'README.md';
        const readmeExists = await this.manager.repositoryFileExistsInProject(
          projectId,
          readmePath,
          this.branch,
        );
        actions.push({
          action: readmeExists ? 'update' : 'create',
          filePath: readmePath,
          content: renderGitLabTaskProjectReadme({
            plan,
            evidence,
            assignment,
            artifactPublication: {
              kind: 'commit-created',
              projectId,
              branch: this.branch,
              commitId: '(pending)',
              destinationPrefix: `${this.destinationPrefix}/${plan.taskId}`,
              publishedFiles,
            },
          }),
        });
      }

      const commit = await this.manager.createCommitInProject(projectId, {
        branch: this.branch,
        commitMessage: `Publish artifacts for ${plan.taskId}`,
        actions,
      });

      return {
        kind: 'commit-created',
        projectId,
        branch: this.branch,
        commitId: commit.id,
        destinationPrefix: `${this.destinationPrefix}/${plan.taskId}`,
        publishedFiles,
      };
    } catch (error) {
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface GitLabWorkResultRecorderOptions {
  readonly issueIid?: number;
  readonly labels?: readonly string[];
  readonly internal?: boolean;
  readonly projectId?: string | number;
  readonly artifactPublisher?: GitLabArtifactPublisher;
}

export class GitLabWorkResultRecorder {
  private readonly issueIid: number | undefined;
  private readonly labels: readonly string[];
  private readonly internal: boolean;
  private readonly projectId: string | number | undefined;
  private readonly artifactPublisher: GitLabArtifactPublisher | undefined;

  constructor(
    private readonly manager: GitLabProjectManager | GitLabInstanceManager,
    options: GitLabWorkResultRecorderOptions = {},
  ) {
    this.issueIid = options.issueIid;
    this.labels = options.labels ?? DEFAULT_WORK_RESULT_LABELS;
    this.internal = options.internal ?? false;
    this.projectId = options.projectId;
    this.artifactPublisher = options.artifactPublisher;
  }

  async record(
    plan: DispatchPlan,
    evidence: TerminalEvidence,
    assignment?: GitLabProjectAssignment,
  ): Promise<GitLabWorkResultRecord> {
    const artifactPublication = await this.artifactPublisher?.publish(
      plan,
      evidence,
      assignment,
    );
    const body = renderGitLabWorkResultMarkdown(plan, evidence, artifactPublication);
    const projectId = assignment?.project.id ?? this.projectId;
    if (isGitLabInstanceManager(this.manager)) {
      if (projectId === undefined) {
        throw new GitLabProjectManagerError(
          'GitLab work-result recording requires a project id or project assignment when using an instance manager.',
        );
      }
      if (this.issueIid !== undefined) {
        return {
          kind: 'note-created',
          issueIid: this.issueIid,
          note: await this.manager.createIssueNoteInProject(projectId, {
            issueIid: this.issueIid,
            body,
            internal: this.internal,
          }),
          ...(artifactPublication === undefined ? {} : { artifactPublication }),
        };
      }

      return {
        kind: 'issue-created',
        issue: await this.manager.createIssueInProject(projectId, {
          title: `Auto Archive task ${evidence.taskId}: ${deriveOutcomeFromCause(evidence.cause)}`,
          description: body,
          labels: this.labels,
        }),
        ...(artifactPublication === undefined ? {} : { artifactPublication }),
      };
    }

    if (this.issueIid !== undefined) {
      return {
        kind: 'note-created',
        issueIid: this.issueIid,
        note: await this.manager.createIssueNote({
          issueIid: this.issueIid,
          body,
          internal: this.internal,
        }),
        ...(artifactPublication === undefined ? {} : { artifactPublication }),
      };
    }

    return {
      kind: 'issue-created',
      issue: await this.manager.createIssue({
        title: `Auto Archive task ${evidence.taskId}: ${deriveOutcomeFromCause(evidence.cause)}`,
        description: body,
        labels: this.labels,
      }),
      ...(artifactPublication === undefined ? {} : { artifactPublication }),
    };
  }

  async recordCompletion(
    plan: DispatchPlan,
    completion: Promise<TerminalEvidence>,
    assignment?: GitLabProjectAssignment,
  ): Promise<GitLabWorkResultRecording> {
    try {
      return await this.record(plan, await completion, assignment);
    } catch (error) {
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createGitLabProjectManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitLabProjectManager | undefined {
  const config = resolveGitLabIntegrationConfig(env);
  if (config === undefined) {
    return undefined;
  }
  if (config.projectId === undefined) {
    throw new GitLabProjectManagerError(
      `${AUTO_ARCHIVE_GITLAB_PROJECT_ID} is required to create a fixed-project GitLab manager.`,
    );
  }
  return new GitLabHttpProjectManager({
    baseUrl: config.baseUrl,
    projectId: config.projectId,
    token: config.token,
  });
}

export function createGitLabInstanceManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitLabInstanceManager | undefined {
  const config = resolveGitLabIntegrationConfig(env);
  return config === undefined
    ? undefined
    : new GitLabHttpInstanceManager({
        baseUrl: config.baseUrl,
        token: config.token,
      });
}

export function createGitLabProjectAssignmentManagerFromEnv(
  manager: GitLabInstanceManager,
  env: NodeJS.ProcessEnv = process.env,
): GitLabProjectAssignmentManager | undefined {
  const config = resolveGitLabIntegrationConfig(env);
  if (config === undefined || !config.assignment.enabled) {
    return undefined;
  }
  return new GitLabProjectAssignmentService(manager, {
    defaultProjectId: config.projectId,
    autoCreateProjects: config.assignment.autoCreateProjects,
    namespaceId: config.assignment.namespaceId,
    namespacePath: config.assignment.namespacePath,
    projectPrefix: config.assignment.projectPrefix,
    projectVisibility: config.assignment.projectVisibility,
    initializeWithReadme: config.assignment.initializeWithReadme,
  });
}

export function createGitLabWorkResultRecorderFromEnv(
  manager: GitLabProjectManager | GitLabInstanceManager,
  env: NodeJS.ProcessEnv = process.env,
  artifactPublisher?: GitLabArtifactPublisher,
): GitLabWorkResultRecorder {
  const config = resolveGitLabIntegrationConfig(env);
  return new GitLabWorkResultRecorder(manager, {
    projectId: config?.projectId,
    issueIid: config?.workResultIssueIid,
    labels: config?.workResultLabels,
    internal: config?.workResultInternal,
    artifactPublisher,
  });
}

export function createGitLabArtifactPublisherFromEnv(
  manager: GitLabInstanceManager,
  env: NodeJS.ProcessEnv = process.env,
): GitLabArtifactPublisher | undefined {
  const config = resolveGitLabIntegrationConfig(env);
  if (config === undefined || !config.artifactPublication.enabled) {
    return undefined;
  }
  return new GitLabArtifactPublisher(manager, {
    enabled: true,
    projectId: config.projectId,
    destinationPrefix: config.artifactPublication.destinationPrefix,
    maxTotalBytes: config.artifactPublication.maxTotalBytes,
    maxFileBytes: config.artifactPublication.maxFileBytes,
  });
}
