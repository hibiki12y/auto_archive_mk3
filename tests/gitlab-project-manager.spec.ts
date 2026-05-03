import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  GitLabArtifactPublisher,
  GitLabHttpProjectManager,
  GitLabHttpInstanceManager,
  GitLabProjectManagerError,
  GitLabProjectAssignmentService,
  GitLabWorkResultRecorder,
  Plana,
  resolveGitLabIntegrationConfig,
  type GitLabCreateIssueInput,
  type GitLabCreateIssueNoteInput,
  type GitLabCreateCommitInput,
  type GitLabCreateProjectInput,
  type GitLabEnsureProjectInput,
  type GitLabCommitReference,
  type GitLabInstanceManager,
  type GitLabIssueNoteReference,
  type GitLabIssueReference,
  type GitLabManagedProjectReference,
  type GitLabProjectAssignment,
  type GitLabProjectManager,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type TerminalCauseSuccess,
  type TerminalEvidence,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

function gitLabIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 123,
    iid: 7,
    project_id: 42,
    title: 'GitLab issue',
    state: 'opened',
    web_url: 'https://gitlab.example.com/group/project/-/issues/7',
    ...overrides,
  };
}

function gitLabNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 456,
    body: 'GitLab note',
    internal: false,
    web_url: 'https://gitlab.example.com/group/project/-/issues/7#note_456',
    ...overrides,
  };
}

function gitLabProject(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    name: 'Auto Archive Task',
    path: 'auto-archive-task',
    path_with_namespace: 'research/auto-archive-task',
    visibility: 'private',
    web_url: 'https://gitlab.example.com/research/auto-archive-task',
    ssh_url_to_repo: 'git@gitlab.example.com:research/auto-archive-task.git',
    http_url_to_repo: 'https://gitlab.example.com/research/auto-archive-task.git',
    namespace: {
      id: 5,
      name: 'research',
      path: 'research',
      full_path: 'research',
    },
    ...overrides,
  };
}

function createJsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  return (headers as Record<string, string> | undefined)?.[name];
}

class FakeGitLabProjectManager implements GitLabProjectManager {
  readonly createIssue = vi.fn(
    async (input: GitLabCreateIssueInput): Promise<GitLabIssueReference> => ({
      id: 123,
      iid: 9,
      projectId: 42,
      title: input.title,
      state: 'opened',
      webUrl: 'https://gitlab.example.com/issues/9',
    }),
  );

  readonly createIssueNote = vi.fn(
    async (input: GitLabCreateIssueNoteInput): Promise<GitLabIssueNoteReference> => ({
      id: 456,
      body: input.body,
      internal: input.internal ?? false,
      webUrl: `https://gitlab.example.com/issues/${input.issueIid}#note_456`,
    }),
  );

  readonly closeIssue = vi.fn(
    async (issueIid: number): Promise<GitLabIssueReference> => ({
      id: 123,
      iid: issueIid,
      projectId: 42,
      title: 'GitLab issue',
      state: 'closed',
      webUrl: `https://gitlab.example.com/issues/${issueIid}`,
    }),
  );
}

class FakeGitLabInstanceManager implements GitLabInstanceManager {
  readonly project: GitLabManagedProjectReference = {
    id: 42,
    name: 'Auto Archive Task',
    path: 'auto-archive-task',
    pathWithNamespace: 'research/auto-archive-task',
    visibility: 'private',
    webUrl: 'https://gitlab.example.com/research/auto-archive-task',
    sshUrlToRepo: 'git@gitlab.example.com:research/auto-archive-task.git',
    httpUrlToRepo: 'https://gitlab.example.com/research/auto-archive-task.git',
    namespace: {
      id: 5,
      name: 'research',
      path: 'research',
      fullPath: 'research',
    },
  };

  readonly getProject = vi.fn(
    async (_projectId: string | number): Promise<GitLabManagedProjectReference> =>
      this.project,
  );

  readonly tryGetProject = vi.fn(
    async (_projectId: string | number): Promise<GitLabManagedProjectReference | undefined> =>
      undefined,
  );

  readonly createProject = vi.fn(
    async (_input: GitLabCreateProjectInput): Promise<GitLabManagedProjectReference> =>
      this.project,
  );

  readonly ensureProject = vi.fn(
    async (_input: GitLabEnsureProjectInput): Promise<GitLabManagedProjectReference> =>
      this.project,
  );

  readonly createIssueInProject = vi.fn(
    async (
      _projectId: string | number,
      input: GitLabCreateIssueInput,
    ): Promise<GitLabIssueReference> => ({
      id: 123,
      iid: 9,
      projectId: 42,
      title: input.title,
      state: 'opened',
      webUrl: 'https://gitlab.example.com/issues/9',
    }),
  );

  readonly createIssueNoteInProject = vi.fn(
    async (
      _projectId: string | number,
      input: GitLabCreateIssueNoteInput,
    ): Promise<GitLabIssueNoteReference> => ({
      id: 456,
      body: input.body,
      internal: input.internal ?? false,
      webUrl: `https://gitlab.example.com/issues/${input.issueIid}#note_456`,
    }),
  );

  readonly closeIssueInProject = vi.fn(
    async (
      _projectId: string | number,
      issueIid: number,
    ): Promise<GitLabIssueReference> => ({
      id: 123,
      iid: issueIid,
      projectId: 42,
      title: 'GitLab issue',
      state: 'closed',
      webUrl: `https://gitlab.example.com/issues/${issueIid}`,
    }),
  );

  readonly repositoryFileExistsInProject = vi.fn(
    async (
      _projectId: string | number,
      _filePath: string,
      _ref: string,
    ): Promise<boolean> => false,
  );

  readonly createCommitInProject = vi.fn(
    async (
      _projectId: string | number,
      _input: GitLabCreateCommitInput,
    ): Promise<GitLabCommitReference> => ({
      id: 'commit-sha-123',
      shortId: 'commit-sha',
      title: 'Publish artifacts',
      webUrl: 'https://gitlab.example.com/commit/commit-sha-123',
    }),
  );
}

function createSuccessfulDispatcher(taskId: string): Dispatcher {
  const cause: TerminalCauseSuccess = {
    kind: 'success',
    taskId,
    runtimeInstanceId: 'gitlab-test-runtime',
    observedAt: '2026-04-26T00:00:00.000Z',
    provenance: 'gitlab-project-manager-test',
    artifactLocation: 'results/task-artifacts',
  };
  const driver: RuntimeDriver = {
    run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
      reason: 'agent completed gitlab integration test',
      provenance: 'gitlab-project-manager-test-driver',
      cause,
    })),
  };
  return new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver)));
}

describe('GitLab integration config', () => {
  it('stays disabled until explicitly enabled', () => {
    expect(resolveGitLabIntegrationConfig({})).toBeUndefined();
  });

  it('resolves explicit URL, project id, indirect token, labels, and note target', () => {
    const config = resolveGitLabIntegrationConfig({
      AUTO_ARCHIVE_GITLAB_ENABLED: 'true',
      AUTO_ARCHIVE_GITLAB_URL: 'https://gitlab.example.com/gitlab',
      AUTO_ARCHIVE_GITLAB_PROJECT_ID: 'group/project',
      AUTO_ARCHIVE_GITLAB_TOKEN_ENV: 'PROJECT_GITLAB_TOKEN',
      PROJECT_GITLAB_TOKEN: 'glpat-secret',
      AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID: '77',
      AUTO_ARCHIVE_GITLAB_WORK_RESULT_LABELS: 'agent-result, research,agent-result',
      AUTO_ARCHIVE_GITLAB_WORK_RESULT_INTERNAL: 'yes',
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED: 'true',
      AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS: 'true',
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID: '5',
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH: 'research',
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX: 'agent-task',
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY: 'internal',
      AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README: 'no',
    });

    expect(config).toEqual({
      baseUrl: 'https://gitlab.example.com/gitlab/',
      projectId: 'group/project',
      token: 'glpat-secret',
      assignment: {
        enabled: true,
        autoCreateProjects: true,
        namespaceId: 5,
        namespacePath: 'research',
        projectPrefix: 'agent-task',
        projectVisibility: 'internal',
        initializeWithReadme: false,
      },
      workResultIssueIid: 77,
      workResultLabels: ['agent-result', 'research'],
      workResultInternal: true,
      artifactPublication: {
        enabled: false,
        destinationPrefix: 'artifacts',
        maxTotalBytes: 10 * 1024 * 1024,
        maxFileBytes: 2 * 1024 * 1024,
      },
    });
  });

  it('fails closed on invalid enable flags and missing required fields', () => {
    expect(() =>
      resolveGitLabIntegrationConfig({
        AUTO_ARCHIVE_GITLAB_ENABLED: 'maybe',
      }),
    ).toThrowError(GitLabProjectManagerError);

    expect(() =>
      resolveGitLabIntegrationConfig({
        AUTO_ARCHIVE_GITLAB_ENABLED: 'true',
        AUTO_ARCHIVE_GITLAB_URL: 'https://gitlab.example.com',
        AUTO_ARCHIVE_GITLAB_PROJECT_ID: '42',
      }),
    ).toThrowError(
      new GitLabProjectManagerError('Missing required environment variable GITLAB_TOKEN.'),
    );

    expect(() =>
      resolveGitLabIntegrationConfig({
        AUTO_ARCHIVE_GITLAB_ENABLED: 'true',
        AUTO_ARCHIVE_GITLAB_URL: 'https://gitlab.example.com',
        AUTO_ARCHIVE_GITLAB_TOKEN: 'glpat-secret',
        AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED: 'true',
        AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS: 'true',
      }),
    ).toThrowError(
      new GitLabProjectManagerError(
        'AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID is required when AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED=true and AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS=true.',
      ),
    );
  });
});

describe('GitLab HTTP project manager', () => {
  it('creates issues through GitLab API v4 with private-token auth', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return createJsonResponse(gitLabIssue({ title: 'Recorded result' }));
    });
    const manager = new GitLabHttpProjectManager({
      baseUrl: 'https://gitlab.example.com/',
      projectId: 'group/project',
      token: 'glpat-secret',
      fetchImpl,
    });

    const issue = await manager.createIssue({
      title: 'Recorded result',
      description: 'result body',
      labels: ['auto-archive', 'agent-result'],
      confidential: true,
    });

    expect(issue).toMatchObject({
      iid: 7,
      title: 'Recorded result',
      state: 'opened',
      webUrl: 'https://gitlab.example.com/group/project/-/issues/7',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fproject/issues',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(headerValue(calls[0]?.init, 'PRIVATE-TOKEN')).toBe('glpat-secret');
    expect(parseJsonBody(calls[0]?.init)).toEqual({
      title: 'Recorded result',
      description: 'result body',
      labels: 'auto-archive,agent-result',
      confidential: true,
    });
  });

  it('creates issue notes and preserves the internal-note flag', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return createJsonResponse(gitLabNote({ body: 'note body', internal: true }));
    });
    const manager = new GitLabHttpProjectManager({
      baseUrl: 'https://gitlab.example.com/',
      projectId: 42,
      token: 'glpat-secret',
      fetchImpl,
    });

    const note = await manager.createIssueNote({
      issueIid: 7,
      body: 'note body',
      internal: true,
    });

    expect(note).toMatchObject({
      id: 456,
      body: 'note body',
      internal: true,
    });
    expect(calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/42/issues/7/notes',
    );
    expect(parseJsonBody(calls[0]?.init)).toEqual({
      body: 'note body',
      internal: true,
    });
  });

  it('closes issues with a GitLab issue state transition', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return createJsonResponse(gitLabIssue({ state: 'closed' }));
    });
    const manager = new GitLabHttpProjectManager({
      baseUrl: 'https://gitlab.example.com/',
      projectId: 42,
      token: 'glpat-secret',
      fetchImpl,
    });

    const issue = await manager.closeIssue(7);

    expect(issue.state).toBe('closed');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(parseJsonBody(calls[0]?.init)).toEqual({ state_event: 'close' });
  });

  it('redacts the token from HTTP failure messages', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      createJsonResponse(
        { message: 'server echoed glpat-secret in a diagnostic body' },
        { status: 500, statusText: 'Internal Server Error' },
      ),
    );
    const manager = new GitLabHttpProjectManager({
      baseUrl: 'https://gitlab.example.com/',
      projectId: 42,
      token: 'glpat-secret',
      fetchImpl,
    });

    await expect(
      manager.createIssue({ title: 'will fail' }),
    ).rejects.toThrowError('[REDACTED_SECRET]');
    await expect(
      manager.createIssue({ title: 'will fail' }),
    ).rejects.not.toThrowError('glpat-secret');
  });
});

describe('GitLab HTTP instance manager', () => {
  it('loads and creates projects at the GitLab instance level', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return createJsonResponse(gitLabProject({ id: 88 }));
    });
    const manager = new GitLabHttpInstanceManager({
      baseUrl: 'https://gitlab.example.com/',
      token: 'glpat-secret',
      fetchImpl,
    });

    await expect(manager.getProject('research/auto-archive')).resolves.toMatchObject({
      id: 88,
      pathWithNamespace: 'research/auto-archive-task',
    });
    await expect(
      manager.createProject({
        name: 'Task Project',
        path: 'task-project',
        namespaceId: 5,
        description: 'created by Arona',
        visibility: 'private',
        initializeWithReadme: true,
      }),
    ).resolves.toMatchObject({
      id: 88,
    });

    expect(calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/research%2Fauto-archive',
    );
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[1]?.url).toBe('https://gitlab.example.com/api/v4/projects');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(parseJsonBody(calls[1]?.init)).toEqual({
      name: 'Task Project',
      path: 'task-project',
      namespace_id: 5,
      description: 'created by Arona',
      visibility: 'private',
      initialize_with_readme: true,
    });
  });

  it('ensures a project by lookup path before creating it', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return createJsonResponse({ message: '404 Project Not Found' }, { status: 404 });
      }
      return createJsonResponse(gitLabProject({ path: 'task-1' }));
    });
    const manager = new GitLabHttpInstanceManager({
      baseUrl: 'https://gitlab.example.com/',
      token: 'glpat-secret',
      fetchImpl,
    });

    const project = await manager.ensureProject({
      lookupPath: 'research/task-1',
      name: 'Task 1',
      path: 'task-1',
      namespaceId: 5,
    });

    expect(project.path).toBe('task-1');
    expect(calls.map((call) => call.init?.method)).toEqual(['GET', 'POST']);
  });

  it('creates issue records inside an arbitrary managed project', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return createJsonResponse(gitLabIssue({ title: 'assigned project issue' }));
    });
    const manager = new GitLabHttpInstanceManager({
      baseUrl: 'https://gitlab.example.com/',
      token: 'glpat-secret',
      fetchImpl,
    });

    await expect(
      manager.createIssueInProject('research/task-1', {
        title: 'assigned project issue',
      }),
    ).resolves.toMatchObject({
      title: 'assigned project issue',
    });

    expect(calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/research%2Ftask-1/issues',
    );
  });

  it('checks repository files and creates commits inside managed projects', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return createJsonResponse({ message: '404 File Not Found' }, { status: 404 });
      }
      return createJsonResponse({
        id: 'commit-sha-123',
        short_id: 'commit-sha',
        title: 'Publish artifacts for task',
        web_url: 'https://gitlab.example.com/commit/commit-sha-123',
      });
    });
    const manager = new GitLabHttpInstanceManager({
      baseUrl: 'https://gitlab.example.com/',
      token: 'glpat-secret',
      fetchImpl,
    });

    await expect(
      manager.repositoryFileExistsInProject(
        42,
        'artifacts/task-1/ternary_vm.py',
        'main',
      ),
    ).resolves.toBe(false);
    await expect(
      manager.createCommitInProject(42, {
        branch: 'main',
        commitMessage: 'Publish artifacts for task-1',
        actions: [
          {
            action: 'create',
            filePath: 'artifacts/task-1/ternary_vm.py',
            content: 'cHJpbnQoMSk=',
            encoding: 'base64',
          },
        ],
      }),
    ).resolves.toMatchObject({ id: 'commit-sha-123' });

    expect(calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/42/repository/files/artifacts%2Ftask-1%2Fternary_vm.py?ref=main',
    );
    expect(calls[1]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/42/repository/commits',
    );
    expect(parseJsonBody(calls[1]?.init)).toEqual({
      branch: 'main',
      commit_message: 'Publish artifacts for task-1',
      actions: [
        {
          action: 'create',
          file_path: 'artifacts/task-1/ternary_vm.py',
          content: 'cHJpbnQoMSk=',
          encoding: 'base64',
        },
      ],
    });
  });
});

describe('GitLab work-result recorder and Arona management surface', () => {
  it('publishes artifact files into the assigned GitLab project repository', async () => {
    const taskId = 'task-gitlab-artifact-publish';
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'aa-artifacts-'));
    try {
      await mkdir(path.join(artifactRoot, 'examples'), { recursive: true });
      await mkdir(path.join(artifactRoot, '__pycache__'), { recursive: true });
      await writeFile(path.join(artifactRoot, 'spec.md'), '# spec\n');
      await writeFile(path.join(artifactRoot, 'examples', 'add.tasm'), 'HALT\n');
      await writeFile(path.join(artifactRoot, '__pycache__', 'skip.pyc'), 'skip');
      await writeFile(path.join(artifactRoot, '.DS_Store'), 'skip');
      const manager = new FakeGitLabInstanceManager();
      manager.repositoryFileExistsInProject.mockImplementation(
        async (_projectId, filePath) => filePath.endsWith('spec.md'),
      );
      const plan = new Arona(
        new Plana(),
        createSuccessfulDispatcher(taskId),
      ).preparePlan(createTaskRequest(taskId, { artifactLocation: artifactRoot }));
      const evidence: TerminalEvidence = {
        taskId,
        runtimeInstanceId: 'runtime-1',
        reason: 'done',
        provenance: 'test',
        executionContext: {
          planCreatedAt: plan.createdAt,
          runtimeSettings: plan.runtimeSettings,
        },
        resourceEnvelope: plan.resourceEnvelope,
        startedAt: '2026-04-26T00:00:00.000Z',
        endedAt: '2026-04-26T00:00:01.000Z',
        artifactLocation: artifactRoot,
        cause: {
          kind: 'success',
          taskId,
          runtimeInstanceId: 'runtime-1',
          observedAt: '2026-04-26T00:00:01.000Z',
          provenance: 'test',
        },
      };
      const publisher = new GitLabArtifactPublisher(manager, {
        enabled: true,
        projectId: 42,
      });

      await expect(publisher.publish(plan, evidence)).resolves.toMatchObject({
        kind: 'commit-created',
        projectId: 42,
        destinationPrefix: `artifacts/${taskId}`,
        publishedFiles: [
          `artifacts/${taskId}/examples/add.tasm`,
          `artifacts/${taskId}/spec.md`,
        ],
      });

      expect(manager.createCommitInProject).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          branch: 'main',
          commitMessage: `Publish artifacts for ${taskId}`,
          actions: [
            expect.objectContaining({
              action: 'create',
              filePath: `artifacts/${taskId}/examples/add.tasm`,
            }),
            expect.objectContaining({
              action: 'update',
              filePath: `artifacts/${taskId}/spec.md`,
            }),
          ],
        }),
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('records artifact publication metadata in the GitLab result issue', async () => {
    const taskId = 'task-gitlab-artifact-recording';
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'aa-artifacts-'));
    try {
      await writeFile(path.join(artifactRoot, 'ternary_vm.py'), 'print(3)\n');
      const manager = new FakeGitLabInstanceManager();
      const assignmentManager = new GitLabProjectAssignmentService(manager, {
        autoCreateProjects: true,
        namespaceId: 5,
        namespacePath: 'research',
        projectPrefix: 'agent-task',
        projectVisibility: 'private',
        initializeWithReadme: true,
      });
      const recorder = new GitLabWorkResultRecorder(manager, {
        artifactPublisher: new GitLabArtifactPublisher(manager, {
          enabled: true,
        }),
      });
      const result = await new Arona(
        new Plana(),
        createSuccessfulDispatcher(taskId),
        {
          gitLabInstanceManager: manager,
          gitLabProjectAssignmentManager: assignmentManager,
          gitLabWorkResultRecorder: recorder,
        },
      ).requestDispatch(createTaskRequest(taskId, { artifactLocation: artifactRoot }));

      expect(result.kind).toBe('dispatched');
      if (result.kind !== 'dispatched') return;

      await expect(result.gitLabRecording).resolves.toMatchObject({
        kind: 'issue-created',
        artifactPublication: {
          kind: 'commit-created',
          destinationPrefix: `artifacts/${taskId}`,
        },
      });
      expect(manager.createIssueInProject).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          description: expect.stringContaining('## Artifact publication'),
        }),
      );
      expect(manager.createIssueInProject).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          description: expect.stringContaining(
            `artifacts/${taskId}/ternary_vm.py`,
          ),
        }),
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('records completed agent work as a note when a target issue is configured', async () => {
    const taskId = 'task-gitlab-note-recording';
    const manager = new FakeGitLabProjectManager();
    const recorder = new GitLabWorkResultRecorder(manager, {
      issueIid: 77,
      internal: true,
    });
    const result = await new Arona(
      new Plana(),
      createSuccessfulDispatcher(taskId),
      {
        gitLabProjectManager: manager,
        gitLabWorkResultRecorder: recorder,
      },
    ).requestDispatch(
      createTaskRequest(taskId, {
        instruction: 'Record this agent result in GitLab.',
      }),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;

    await expect(result.submission.completion).resolves.toMatchObject({
      taskId,
    });
    await expect(result.gitLabRecording).resolves.toMatchObject({
      kind: 'note-created',
      issueIid: 77,
    });
    expect(manager.createIssueNote).toHaveBeenCalledWith(
      expect.objectContaining({
        issueIid: 77,
        internal: true,
        body: expect.stringContaining('Task ID: `task-gitlab-note-recording`'),
      }),
    );
    expect(manager.createIssueNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('Record this agent result in GitLab.'),
      }),
    );
  });

  it('does not fail task completion when GitLab result recording fails', async () => {
    const taskId = 'task-gitlab-recording-failure';
    const manager = new FakeGitLabProjectManager();
    manager.createIssueNote.mockRejectedValueOnce(new Error('GitLab unavailable'));
    const recorder = new GitLabWorkResultRecorder(manager, {
      issueIid: 77,
    });

    const result = await new Arona(
      new Plana(),
      createSuccessfulDispatcher(taskId),
      {
        gitLabProjectManager: manager,
        gitLabWorkResultRecorder: recorder,
      },
    ).requestDispatch(createTaskRequest(taskId));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;

    await expect(result.submission.completion).resolves.toMatchObject({
      taskId,
    });
    await expect(result.gitLabRecording).resolves.toEqual({
      kind: 'failed',
      reason: 'GitLab unavailable',
    });
  });

  it('assigns a managed GitLab project before dispatch and exposes it to the subagent context', async () => {
    const taskId = 'task-gitlab-project-assignment';
    const manager = new FakeGitLabInstanceManager();
    const assignmentManager = new GitLabProjectAssignmentService(manager, {
      defaultProjectId: 'research/shared-agent-project',
      autoCreateProjects: false,
      projectPrefix: 'agent-task',
      projectVisibility: 'private',
      initializeWithReadme: true,
    });
    let observedAssignment: GitLabProjectAssignment | undefined;
    let observedInstruction = '';
    const driver: RuntimeDriver = {
      run: vi.fn(async (context): Promise<RuntimeDriverResult> => {
        observedAssignment = context.plan.gitLabProjectAssignment;
        observedInstruction = context.plan.instruction;
        return {
          reason: 'agent completed assigned gitlab project test',
          provenance: 'gitlab-project-assignment-test-driver',
          cause: {
            kind: 'success',
            taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: '2026-04-26T00:00:00.000Z',
            provenance: 'gitlab-project-assignment-test',
          },
        };
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
      {
        gitLabInstanceManager: manager,
        gitLabProjectAssignmentManager: assignmentManager,
        gitLabWorkResultRecorder: new GitLabWorkResultRecorder(manager),
      },
    ).requestDispatch(createTaskRequest(taskId));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;
    await expect(result.gitLabRecording).resolves.toMatchObject({
      kind: 'issue-created',
    });

    expect(result.gitLabAssignment).toMatchObject({
      taskId,
      assignmentKind: 'existing-project',
      project: {
        id: 42,
        pathWithNamespace: 'research/auto-archive-task',
      },
    });
    expect(observedAssignment).toBeDefined();
    expect(observedAssignment).toEqual(result.gitLabAssignment);
    expect(observedInstruction).toContain(
      'AUTO_ARCHIVE GITLAB ASSIGNMENT',
    );
    expect(observedInstruction).toContain('- GitLab project ID: 42');
    expect(observedInstruction).toContain(
      '- GitLab API project selector: 42',
    );
    expect(observedInstruction).toContain(
      '- GitLab origin: https://gitlab.example.com',
    );
    expect(observedInstruction).not.toContain('research/auto-archive-task');
    expect(observedInstruction).not.toContain('SSH clone URL');
    expect(observedInstruction).not.toContain('HTTP clone URL');
    expect(manager.getProject).toHaveBeenCalledWith('research/shared-agent-project');
    expect(manager.createIssueInProject).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        title: `Auto Archive task ${taskId}: success`,
      }),
    );
  });

  it('creates or reuses a task project when assignment auto-create is enabled', async () => {
    const taskId = 'task-gitlab-auto-project';
    const manager = new FakeGitLabInstanceManager();
    const assignmentManager = new GitLabProjectAssignmentService(manager, {
      autoCreateProjects: true,
      namespaceId: 5,
      namespacePath: 'research',
      projectPrefix: 'agent-task',
      projectVisibility: 'private',
      initializeWithReadme: true,
    });

    const assignment = await assignmentManager.assignProjectForTask(
      new Arona(new Plana(), createSuccessfulDispatcher(taskId)).preparePlan(
        createTaskRequest(taskId, {
          instruction: 'Use a newly assigned GitLab project.',
        }),
      ),
    );

    expect(assignment.assignmentKind).toBe('created-or-reused-project');
    expect(assignment.instructionBlock).toContain(
      'AUTO_ARCHIVE GITLAB ASSIGNMENT',
    );
    expect(assignment.instructionBlock).toContain('- GitLab project ID: 42');
    expect(assignment.instructionBlock).not.toContain(
      'research/auto-archive-task',
    );
    expect(assignment.instructionBlock).not.toContain('git@gitlab.example.com');
    expect(assignment.instructionBlock).not.toContain(
      'https://gitlab.example.com/research/auto-archive-task',
    );
    expect(manager.ensureProject).toHaveBeenCalledWith(
      expect.objectContaining({
        lookupPath: `research/agent-task-${taskId}`,
        name: `agent-task ${taskId}`,
        path: `agent-task-${taskId}`,
        namespaceId: 5,
        visibility: 'private',
        initializeWithReadme: true,
      }),
    );
  });

  it('allows Arona to create, annotate, and close GitLab issues', async () => {
    const manager = new FakeGitLabProjectManager();
    const arona = new Arona(new Plana(), createSuccessfulDispatcher('task'), {
      gitLabProjectManager: manager,
    });

    await expect(
      arona.createGitLabIssue({
        title: 'Arona managed issue',
        labels: ['auto-archive'],
      }),
    ).resolves.toMatchObject({
      iid: 9,
      title: 'Arona managed issue',
    });
    await expect(
      arona.addGitLabIssueNote({ issueIid: 9, body: 'management note' }),
    ).resolves.toMatchObject({
      body: 'management note',
    });
    await expect(arona.closeGitLabIssue(9)).resolves.toMatchObject({
      state: 'closed',
    });
  });

  it('allows Arona to manage GitLab projects at instance scope', async () => {
    const manager = new FakeGitLabInstanceManager();
    const arona = new Arona(new Plana(), createSuccessfulDispatcher('task'), {
      gitLabInstanceManager: manager,
    });

    await expect(arona.getGitLabProject(42)).resolves.toMatchObject({
      pathWithNamespace: 'research/auto-archive-task',
    });
    await expect(
      arona.createGitLabProject({
        name: 'Arona created project',
        path: 'arona-created-project',
        namespaceId: 5,
      }),
    ).resolves.toMatchObject({
      id: 42,
    });
    await expect(
      arona.ensureGitLabProject({
        lookupPath: 'research/arona-created-project',
        name: 'Arona created project',
        path: 'arona-created-project',
        namespaceId: 5,
      }),
    ).resolves.toMatchObject({
      id: 42,
    });
  });

  it('fails Arona GitLab management calls clearly when no manager is configured', async () => {
    const arona = new Arona(new Plana(), createSuccessfulDispatcher('task'));

    await expect(
      arona.createGitLabIssue({ title: 'unconfigured' }),
    ).rejects.toThrowError('GitLab project manager is not configured for Arona.');
  });
});
