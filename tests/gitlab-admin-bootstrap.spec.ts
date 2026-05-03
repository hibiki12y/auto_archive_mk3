import { describe, expect, it, vi } from 'vitest';

import {
  GitLabHttpAdminBootstrapClient,
  GitLabProjectManagerError,
  redactGitLabAdminBootstrapResult,
  renderGitLabRuntimeEnv,
  resolveGitLabAdminBootstrapConfig,
  runGitLabAdminBootstrap,
  type GitLabAdminBootstrapClient,
  type GitLabBootstrapGroupReference,
  type GitLabGroupAccessTokenReference,
  type GitLabPersonalAccessTokenReference,
} from '../src/index.js';

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
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

function gitLabGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 5,
    name: 'Auto Archive',
    path: 'auto-archive',
    full_path: 'auto-archive',
    web_url: 'https://gitlab.example.com/groups/auto-archive',
    visibility: 'private',
    ...overrides,
  };
}

function groupAccessToken(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 77,
    name: 'auto-archive-runtime',
    token: 'glgt-runtime-secret',
    scopes: ['api', 'write_repository'],
    access_level: 50,
    expires_at: '2026-12-31',
    ...overrides,
  };
}

class FakeAdminBootstrapClient implements GitLabAdminBootstrapClient {
  readonly group: GitLabBootstrapGroupReference = {
    id: 5,
    name: 'Auto Archive',
    path: 'auto-archive',
    fullPath: 'auto-archive',
    webUrl: 'https://gitlab.example.com/groups/auto-archive',
    visibility: 'private',
  };

  readonly runtimeToken: GitLabGroupAccessTokenReference = {
    id: 77,
    name: 'auto-archive-runtime',
    token: 'glgt-runtime-secret',
    scopes: ['api'],
    accessLevel: 50,
    expiresAt: '2026-12-31',
  };

  readonly currentToken: GitLabPersonalAccessTokenReference = {
    id: 999,
    name: 'admin-bootstrap',
  };

  readonly ensureGroup = vi.fn(
    async (): Promise<GitLabBootstrapGroupReference> => this.group,
  );

  readonly createGroupAccessToken = vi.fn(
    async (): Promise<GitLabGroupAccessTokenReference> => this.runtimeToken,
  );

  readonly validateRuntimeToken = vi.fn(async (): Promise<void> => {});

  readonly getCurrentPersonalAccessToken = vi.fn(
    async (): Promise<GitLabPersonalAccessTokenReference> => this.currentToken,
  );

  readonly revokePersonalAccessToken = vi.fn(async (): Promise<void> => {});
}

describe('GitLab admin bootstrap config', () => {
  it('stays disabled until explicitly enabled', () => {
    expect(resolveGitLabAdminBootstrapConfig({})).toBeUndefined();
  });

  it('resolves admin bootstrap env with indirect admin token and runtime defaults', () => {
    const config = resolveGitLabAdminBootstrapConfig({
      AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED: 'true',
      AUTO_ARCHIVE_GITLAB_URL: 'https://gitlab.example.com',
      AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV: 'BOOTSTRAP_ADMIN_TOKEN',
      BOOTSTRAP_ADMIN_TOKEN: 'glpat-admin-secret',
      AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_NAME: 'Auto Archive',
      AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH: 'auto-archive',
      AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_SCOPES: 'api,write_repository,api',
      AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_EXPIRES_AT: '2026-12-31',
    });

    expect(config).toEqual({
      baseUrl: 'https://gitlab.example.com/',
      adminToken: 'glpat-admin-secret',
      discardAdminToken: true,
      groupName: 'Auto Archive',
      groupPath: 'auto-archive',
      groupVisibility: 'private',
      runtimeTokenName: 'auto-archive-runtime',
      runtimeTokenScopes: ['api', 'write_repository'],
      runtimeAccessLevel: 50,
      runtimeTokenExpiresAt: '2026-12-31',
      runtimeTokenEnvName: 'GITLAB_TOKEN',
      assignmentProjectPrefix: 'auto-archive-task',
      assignmentProjectVisibility: 'private',
      assignmentInitializeWithReadme: true,
    });
  });

  it('fails closed when required admin bootstrap env is missing or malformed', () => {
    expect(() =>
      resolveGitLabAdminBootstrapConfig({
        AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED: 'true',
      }),
    ).toThrowError(GitLabProjectManagerError);

    expect(() =>
      resolveGitLabAdminBootstrapConfig({
        AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED: 'true',
        AUTO_ARCHIVE_GITLAB_URL: 'https://gitlab.example.com',
        AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN: 'glpat-admin-secret',
        AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH: 'auto-archive',
        AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY: 'shared',
      }),
    ).toThrowError(
      new GitLabProjectManagerError(
        'AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY must be one of: private, internal, public; received "shared".',
      ),
    );
  });
});

describe('GitLab HTTP admin bootstrap client', () => {
  it('creates the group when lookup misses, creates runtime token, and revokes admin PAT', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      switch (calls.length) {
        case 1:
          return createJsonResponse({ message: '404 Group Not Found' }, { status: 404 });
        case 2:
          return createJsonResponse(gitLabGroup());
        case 3:
          return createJsonResponse(groupAccessToken());
        case 4:
          return createJsonResponse(gitLabGroup());
        case 5:
          return createJsonResponse({ id: 999, name: 'admin-bootstrap' });
        case 6:
          return new Response(null, { status: 204 });
        default:
          throw new Error('unexpected fetch call');
      }
    });
    const client = new GitLabHttpAdminBootstrapClient({
      baseUrl: 'https://gitlab.example.com/',
      adminToken: 'glpat-admin-secret',
      fetchImpl,
    });

    const result = await runGitLabAdminBootstrap(
      {
        baseUrl: 'https://gitlab.example.com/',
        adminToken: 'glpat-admin-secret',
        discardAdminToken: true,
        groupName: 'Auto Archive',
        groupPath: 'auto-archive',
        groupVisibility: 'private',
        runtimeTokenName: 'auto-archive-runtime',
        runtimeTokenScopes: ['api', 'write_repository'],
        runtimeAccessLevel: 50,
        runtimeTokenExpiresAt: '2026-12-31',
        runtimeTokenEnvName: 'GITLAB_TOKEN',
        assignmentProjectPrefix: 'auto-archive-task',
        assignmentProjectVisibility: 'private',
        assignmentInitializeWithReadme: true,
      },
      client,
    );

    expect(result.adminTokenDiscarded).toBe(true);
    expect(result.runtimeEnv).toContain('GITLAB_TOKEN=glgt-runtime-secret');
    expect(calls.map((call) => call.init?.method)).toEqual([
      'GET',
      'POST',
      'POST',
      'GET',
      'GET',
      'DELETE',
    ]);
    expect(calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/groups/auto-archive',
    );
    expect(parseJsonBody(calls[1]?.init)).toEqual({
      name: 'Auto Archive',
      path: 'auto-archive',
      visibility: 'private',
    });
    expect(calls[2]?.url).toBe(
      'https://gitlab.example.com/api/v4/groups/5/access_tokens',
    );
    expect(parseJsonBody(calls[2]?.init)).toEqual({
      name: 'auto-archive-runtime',
      scopes: ['api', 'write_repository'],
      access_level: 50,
      expires_at: '2026-12-31',
    });
    expect(calls[4]?.url).toBe(
      'https://gitlab.example.com/api/v4/personal_access_tokens/self',
    );
    expect(calls[5]?.url).toBe(
      'https://gitlab.example.com/api/v4/personal_access_tokens/999',
    );
    expect(headerValue(calls[3]?.init, 'PRIVATE-TOKEN')).toBe('glgt-runtime-secret');
    expect(headerValue(calls[5]?.init, 'PRIVATE-TOKEN')).toBe('glpat-admin-secret');
  });

  it('reuses an existing group and redacts admin token from HTTP errors', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      createJsonResponse({
        message: 'server echoed glpat-admin-secret in a diagnostic body',
      }, { status: 500, statusText: 'Internal Server Error' }),
    );
    const client = new GitLabHttpAdminBootstrapClient({
      baseUrl: 'https://gitlab.example.com/',
      adminToken: 'glpat-admin-secret',
      fetchImpl,
    });

    await expect(
      client.ensureGroup({
        name: 'Auto Archive',
        path: 'auto-archive',
        visibility: 'private',
      }),
    ).rejects.toThrowError('[REDACTED_SECRET]');
    await expect(
      client.ensureGroup({
        name: 'Auto Archive',
        path: 'auto-archive',
        visibility: 'private',
      }),
    ).rejects.not.toThrowError('glpat-admin-secret');
  });
});

describe('GitLab admin bootstrap runner', () => {
  it('persists runtime env before revoking the admin PAT', async () => {
    const client = new FakeAdminBootstrapClient();
    const events: string[] = [];
    client.getCurrentPersonalAccessToken.mockImplementation(async () => {
      events.push('get-current-token');
      return client.currentToken;
    });
    client.validateRuntimeToken.mockImplementation(async () => {
      events.push('validate-runtime-token');
    });
    client.revokePersonalAccessToken.mockImplementation(async () => {
      events.push('revoke-admin-token');
    });

    const result = await runGitLabAdminBootstrap(
      {
        baseUrl: 'https://gitlab.example.com/',
        adminToken: 'glpat-admin-secret',
        discardAdminToken: true,
        groupName: 'Auto Archive',
        groupPath: 'auto-archive',
        groupVisibility: 'private',
        runtimeTokenName: 'auto-archive-runtime',
        runtimeTokenScopes: ['api'],
        runtimeAccessLevel: 50,
        runtimeTokenEnvName: 'GITLAB_TOKEN',
        assignmentProjectPrefix: 'auto-archive-task',
        assignmentProjectVisibility: 'private',
        assignmentInitializeWithReadme: true,
      },
      client,
      {
        onRuntimeEnvReady: (bootstrapResult) => {
          events.push('persist-runtime-env');
          expect(bootstrapResult.adminTokenDiscarded).toBe(false);
          expect(bootstrapResult.runtimeEnv).toContain('GITLAB_TOKEN=glgt-runtime-secret');
        },
      },
    );

    expect(result.adminTokenDiscarded).toBe(true);
    expect(events).toEqual([
      'persist-runtime-env',
      'validate-runtime-token',
      'get-current-token',
      'revoke-admin-token',
    ]);
  });

  it('does not revoke the admin PAT when runtime env persistence fails', async () => {
    const client = new FakeAdminBootstrapClient();

    await expect(
      runGitLabAdminBootstrap(
        {
          baseUrl: 'https://gitlab.example.com/',
          adminToken: 'glpat-admin-secret',
          discardAdminToken: true,
          groupName: 'Auto Archive',
          groupPath: 'auto-archive',
          groupVisibility: 'private',
          runtimeTokenName: 'auto-archive-runtime',
          runtimeTokenScopes: ['api'],
          runtimeAccessLevel: 50,
          runtimeTokenEnvName: 'GITLAB_TOKEN',
          assignmentProjectPrefix: 'auto-archive-task',
          assignmentProjectVisibility: 'private',
          assignmentInitializeWithReadme: true,
        },
        client,
        {
          onRuntimeEnvReady: () => {
            throw new Error('runtime env write failed');
          },
        },
      ),
    ).rejects.toThrowError('runtime env write failed');
    expect(client.getCurrentPersonalAccessToken).not.toHaveBeenCalled();
    expect(client.validateRuntimeToken).not.toHaveBeenCalled();
    expect(client.revokePersonalAccessToken).not.toHaveBeenCalled();
  });

  it('does not revoke the admin PAT when runtime token validation fails', async () => {
    const client = new FakeAdminBootstrapClient();
    client.validateRuntimeToken.mockRejectedValue(new Error('runtime token rejected'));

    await expect(
      runGitLabAdminBootstrap(
        {
          baseUrl: 'https://gitlab.example.com/',
          adminToken: 'glpat-admin-secret',
          discardAdminToken: true,
          groupName: 'Auto Archive',
          groupPath: 'auto-archive',
          groupVisibility: 'private',
          runtimeTokenName: 'auto-archive-runtime',
          runtimeTokenScopes: ['api'],
          runtimeAccessLevel: 50,
          runtimeTokenEnvName: 'GITLAB_TOKEN',
          assignmentProjectPrefix: 'auto-archive-task',
          assignmentProjectVisibility: 'private',
          assignmentInitializeWithReadme: true,
        },
        client,
      ),
    ).rejects.toThrowError('runtime token rejected');
    expect(client.getCurrentPersonalAccessToken).not.toHaveBeenCalled();
    expect(client.revokePersonalAccessToken).not.toHaveBeenCalled();
  });

  it('can skip admin token discard when explicitly configured', async () => {
    const client = new FakeAdminBootstrapClient();
    const result = await runGitLabAdminBootstrap(
      {
        baseUrl: 'https://gitlab.example.com/',
        adminToken: 'glpat-admin-secret',
        discardAdminToken: false,
        groupName: 'Auto Archive',
        groupPath: 'auto-archive',
        groupVisibility: 'private',
        runtimeTokenName: 'auto-archive-runtime',
        runtimeTokenScopes: ['api'],
        runtimeAccessLevel: 50,
        runtimeTokenEnvName: 'GITLAB_TOKEN',
        assignmentProjectPrefix: 'auto-archive-task',
        assignmentProjectVisibility: 'private',
        assignmentInitializeWithReadme: true,
      },
      client,
    );

    expect(result.adminTokenDiscarded).toBe(false);
    expect(client.validateRuntimeToken).not.toHaveBeenCalled();
    expect(client.getCurrentPersonalAccessToken).not.toHaveBeenCalled();
    expect(client.revokePersonalAccessToken).not.toHaveBeenCalled();
  });

  it('renders and redacts the generated runtime env block', async () => {
    const client = new FakeAdminBootstrapClient();
    const config = {
      baseUrl: 'https://gitlab.example.com/',
      adminToken: 'glpat-admin-secret',
      discardAdminToken: true,
      groupName: 'Auto Archive',
      groupPath: 'auto-archive',
      groupVisibility: 'private' as const,
      runtimeTokenName: 'auto-archive-runtime',
      runtimeTokenScopes: ['api'],
      runtimeAccessLevel: 50,
      runtimeTokenEnvName: 'GITLAB_TOKEN',
      assignmentProjectPrefix: 'auto-archive-task',
      assignmentProjectVisibility: 'private' as const,
      assignmentInitializeWithReadme: true,
    };

    const result = await runGitLabAdminBootstrap(config, client);
    const envBlock = renderGitLabRuntimeEnv(config, result);
    const redacted = redactGitLabAdminBootstrapResult(result);

    expect(envBlock).toContain('AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID=5');
    expect(envBlock).toContain('GITLAB_TOKEN=glgt-runtime-secret');
    expect(redacted.runtimeToken.token).toBe('[REDACTED_SECRET]');
    expect(redacted.runtimeEnv).not.toContain('glgt-runtime-secret');
  });
});
