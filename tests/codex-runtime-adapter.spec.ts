import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { CodexOptions } from '@openai/codex-sdk';

import { BoundaryValidationError } from '../src/contracts/boundary-validators.js';
import { createDispatchPlan } from '../src/core/task.js';
import type {
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';
import { PROVIDER_FAILURE_CLASSIFICATIONS } from '../src/contracts/terminal-cause.js';
import {
  CodexRuntimeDriver,
  classifyCodexProviderFailureMessage,
  type CodexRuntimeDriverOptions,
} from '../src/runtime/codex-runtime-adapter.js';
import {
  CODEX_MODEL_FALLBACK_ENV,
  CODEX_MODEL_ENV,
  CODEX_REASONING_EFFORT_ENV,
  CODEX_SETTINGS_FILE_PATH_ENV,
  CodexBootstrapSettingsLoadError,
  CodexCliAuthLoadError,
} from '../src/runtime/codex-bootstrap-settings.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

const ORIGINAL_CODEX_API_KEY = process.env['AUTO_ARCHIVE_CODEX_API_KEY'];
const ORIGINAL_CODEX_CLI_PATH = process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];
const ORIGINAL_CODEX_SETTINGS_FILE =
  process.env[CODEX_SETTINGS_FILE_PATH_ENV];
const ORIGINAL_CODEX_MODEL = process.env[CODEX_MODEL_ENV];
const ORIGINAL_CODEX_MODEL_FALLBACK =
  process.env[CODEX_MODEL_FALLBACK_ENV];
const ORIGINAL_CODEX_REASONING_EFFORT =
  process.env[CODEX_REASONING_EFFORT_ENV];
const ORIGINAL_HOME = process.env['HOME'];
const CODEX_SETTINGS_FIXTURE_DIR = new URL(
  './fixtures/codex-bootstrap-settings/',
  import.meta.url,
);
const VALID_CODEX_SETTINGS_FILE = fileURLToPath(
  new URL('valid.json', CODEX_SETTINGS_FIXTURE_DIR),
);
const INVALID_SCHEMA_CODEX_SETTINGS_FILE = fileURLToPath(
  new URL('invalid-schema.json', CODEX_SETTINGS_FIXTURE_DIR),
);
const MALFORMED_CODEX_SETTINGS_FILE = fileURLToPath(
  new URL('malformed.json', CODEX_SETTINGS_FIXTURE_DIR),
);
const CODEX_CLI_AUTH_FIXTURE_DIR = new URL(
  './fixtures/codex-cli-auth/',
  import.meta.url,
);
const VALID_CHATGPT_HOME = fileURLToPath(
  new URL('valid-chatgpt-home/', CODEX_CLI_AUTH_FIXTURE_DIR),
);
const VALID_APIKEY_HOME = fileURLToPath(
  new URL('valid-apikey-home/', CODEX_CLI_AUTH_FIXTURE_DIR),
);
const INVALID_CHATGPT_HOME = fileURLToPath(
  new URL('invalid-chatgpt-home/', CODEX_CLI_AUTH_FIXTURE_DIR),
);
const MALFORMED_CLI_AUTH_HOME = fileURLToPath(
  new URL('malformed-home/', CODEX_CLI_AUTH_FIXTURE_DIR),
);
const MISSING_CLI_AUTH_HOME = fileURLToPath(
  new URL('missing-home/', CODEX_CLI_AUTH_FIXTURE_DIR),
);

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function createRuntimeContext(
  overrides: Partial<RuntimeExecutionContext> = {},
): RuntimeExecutionContext {
  const plan = overrides.plan ?? createDispatchPlan(createTaskRequest('task-codex-driver'));
  return {
    plan,
    instance:
      overrides.instance ?? {
        taskId: plan.taskId,
        instanceId: 'agent-task-codex-driver',
        createdAt: '2026-04-20T00:00:00.000Z',
        runtimeSettings: plan.runtimeSettings,
      },
    emit: overrides.emit ?? (async () => {}),
    requestApproval:
      overrides.requestApproval ?? (async () => ({ status: 'approved' })),
    isAborted: overrides.isAborted ?? (() => false),
  };
}

describe('codex runtime driver streamed-event integration', () => {
  beforeEach(() => {
    delete process.env[CODEX_MODEL_ENV];
    delete process.env[CODEX_MODEL_FALLBACK_ENV];
    delete process.env[CODEX_REASONING_EFFORT_ENV];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (ORIGINAL_CODEX_API_KEY === undefined) {
      delete process.env['AUTO_ARCHIVE_CODEX_API_KEY'];
    } else {
      process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = ORIGINAL_CODEX_API_KEY;
    }
    if (ORIGINAL_CODEX_CLI_PATH === undefined) {
      delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];
    } else {
      process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'] = ORIGINAL_CODEX_CLI_PATH;
    }
    if (ORIGINAL_CODEX_SETTINGS_FILE === undefined) {
      delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    } else {
      process.env[CODEX_SETTINGS_FILE_PATH_ENV] = ORIGINAL_CODEX_SETTINGS_FILE;
    }
    if (ORIGINAL_CODEX_MODEL === undefined) {
      delete process.env[CODEX_MODEL_ENV];
    } else {
      process.env[CODEX_MODEL_ENV] = ORIGINAL_CODEX_MODEL;
    }
    if (ORIGINAL_CODEX_MODEL_FALLBACK === undefined) {
      delete process.env[CODEX_MODEL_FALLBACK_ENV];
    } else {
      process.env[CODEX_MODEL_FALLBACK_ENV] = ORIGINAL_CODEX_MODEL_FALLBACK;
    }
    if (ORIGINAL_CODEX_REASONING_EFFORT === undefined) {
      delete process.env[CODEX_REASONING_EFFORT_ENV];
    } else {
      process.env[CODEX_REASONING_EFFORT_ENV] =
        ORIGINAL_CODEX_REASONING_EFFORT;
    }
    if (ORIGINAL_HOME === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = ORIGINAL_HOME;
    }
  });

  it('loads default Codex options from env when codexOptions are omitted', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-api-key';
    process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'] = '/opt/codex/bin/codex';

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-env-options',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      apiKey: 'env-api-key',
      codexPathOverride: '/opt/codex/bin/codex',
    });
  });

  it('passes env-backed Codex model overrides through SDK thread options', async () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    delete process.env['AUTO_ARCHIVE_CODEX_API_KEY'];
    delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];
    process.env[CODEX_MODEL_ENV] = 'gpt-5.4';
    process.env[CODEX_REASONING_EFFORT_ENV] = 'high';

    let capturedOptions: unknown;
    let capturedThreadOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: (threadOptions: unknown) => {
          capturedThreadOptions = threadOptions;
          return {
            id: 'thread-env-model-options',
            async runStreamed() {
              return { events: (async function* () {})() };
            },
          };
        },
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    const driver = new CodexRuntimeDriver({ sdkFactory });
    await driver.run(createRuntimeContext());

    expect(capturedOptions).toEqual({});
    expect(capturedThreadOptions).toMatchObject({
      model: 'gpt-5.4',
      modelReasoningEffort: 'high',
    });
  });

  it('keeps env-backed Codex model overrides when local CLI auth is preferred', async () => {
    process.env['HOME'] = VALID_CHATGPT_HOME;
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-api-key';
    process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'] = '/opt/env-codex';
    process.env[CODEX_MODEL_ENV] = 'gpt-5.4';
    process.env[CODEX_REASONING_EFFORT_ENV] = 'medium';
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];

    let capturedOptions: unknown;
    let capturedThreadOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: (threadOptions: unknown) => {
          capturedThreadOptions = threadOptions;
          return {
            id: 'thread-cli-auth-model-options',
            async runStreamed() {
              return { events: (async function* () {})() };
            },
          };
        },
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    const driver = new CodexRuntimeDriver({ sdkFactory });
    await driver.run(createRuntimeContext());

    expect(capturedOptions).toEqual({
      codexPathOverride: '/opt/env-codex',
    });
    expect(capturedThreadOptions).toMatchObject({
      model: 'gpt-5.4',
      modelReasoningEffort: 'medium',
    });
  });

  it('fails startup closed when env-backed Codex reasoning effort is unsupported', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env[CODEX_REASONING_EFFORT_ENV] = 'maximum';
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-invalid-env-reasoning-effort',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoundaryValidationError);
    expect((caught as Error).message).toContain(
      `${CODEX_REASONING_EFFORT_ENV} must be one of: minimal, low, medium, high, xhigh.`,
    );
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('fails startup closed when env-backed Codex model contains whitespace', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env[CODEX_MODEL_ENV] = 'gpt 5.5';
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-invalid-env-model',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoundaryValidationError);
    expect((caught as Error).message).toContain(
      `${CODEX_MODEL_ENV} must be a single Codex model id without whitespace`,
    );
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('fails startup closed when the fallback Codex model duplicates the primary override', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env[CODEX_MODEL_ENV] = 'gpt-5.4';
    process.env[CODEX_MODEL_FALLBACK_ENV] = 'gpt-5.4';
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-duplicate-model-fallback',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoundaryValidationError);
    expect((caught as Error).message).toContain(
      `${CODEX_MODEL_FALLBACK_ENV} must differ from ${CODEX_MODEL_ENV}.`,
    );
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('does not attempt a settings-file load when no settings file is configured', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-only-api-key';
    delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-no-settings-file',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      apiKey: 'env-only-api-key',
    });
  });

  it('treats an empty settings-file env value as unset', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env[CODEX_SETTINGS_FILE_PATH_ENV] = '   ';
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-empty-settings-api-key';
    delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-empty-settings-file-env',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      apiKey: 'env-empty-settings-api-key',
    });
  });

  it('omits unset env-backed defaults from Codex options', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];
    delete process.env['AUTO_ARCHIVE_CODEX_API_KEY'];
    delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-empty-env-options',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({});
  });

  it('loads Codex bootstrap options from the sanctioned settings file', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    delete process.env['AUTO_ARCHIVE_CODEX_API_KEY'];
    delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];
    process.env[CODEX_SETTINGS_FILE_PATH_ENV] = VALID_CODEX_SETTINGS_FILE;

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-file-options',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      apiKey: 'file-api-key',
      codexPathOverride: '/opt/file-codex',
    });
  });

  it('keeps env values authoritative over overlapping settings-file keys', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-api-key';
    process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'] = '/opt/env-codex';
    process.env[CODEX_SETTINGS_FILE_PATH_ENV] = VALID_CODEX_SETTINGS_FILE;

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-env-wins',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      apiKey: 'env-api-key',
      codexPathOverride: '/opt/env-codex',
    });
  });

  it('prefers valid ChatGPT-backed Codex CLI auth over env API-key bootstrap', () => {
    process.env['HOME'] = VALID_CHATGPT_HOME;
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-api-key';
    process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'] = '/opt/env-codex';
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-cli-auth-chatgpt',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      codexPathOverride: '/opt/env-codex',
    });
  });

  it('prefers valid API-key-backed Codex CLI auth over sanctioned settings-file apiKey bootstrap', () => {
    process.env['HOME'] = VALID_APIKEY_HOME;
    delete process.env['AUTO_ARCHIVE_CODEX_API_KEY'];
    delete process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'];
    process.env[CODEX_SETTINGS_FILE_PATH_ENV] = VALID_CODEX_SETTINGS_FILE;

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-cli-auth-apikey',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      codexPathOverride: '/opt/file-codex',
    });
  });

  it('falls back to API-key bootstrap when Codex CLI auth is absent', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-fallback-api-key';
    process.env['AUTO_ARCHIVE_CODEX_CLI_PATH'] = '/opt/env-codex';
    delete process.env[CODEX_SETTINGS_FILE_PATH_ENV];

    let capturedOptions: unknown;
    const sdkFactory = ((options?: CodexOptions) => {
      capturedOptions = options;
      return {
        startThread: () => ({
          id: 'thread-cli-auth-absent',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      };
    }) as unknown as CodexRuntimeDriverOptions['sdkFactory'];

    new CodexRuntimeDriver({ sdkFactory });

    expect(capturedOptions).toEqual({
      apiKey: 'env-fallback-api-key',
      codexPathOverride: '/opt/env-codex',
    });
  });

  it('fails startup closed when detected Codex CLI auth is malformed JSON', () => {
    process.env['HOME'] = MALFORMED_CLI_AUTH_HOME;
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-api-key';
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-malformed-cli-auth',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(CodexBootstrapSettingsLoadError);
    expect(caught).toBeInstanceOf(CodexCliAuthLoadError);
    expect((caught as Error).message).toContain(
      'auth file must contain valid JSON.',
    );
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('fails startup closed when detected Codex CLI auth has an invalid shape', () => {
    process.env['HOME'] = INVALID_CHATGPT_HOME;
    process.env['AUTO_ARCHIVE_CODEX_API_KEY'] = 'env-api-key';
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-invalid-cli-auth',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexCliAuthLoadError);
    expect((caught as Error).message).toContain(
      'auth.json.tokens.access_token must be a non-empty string.',
    );
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('fails startup closed when the settings file is malformed JSON', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env[CODEX_SETTINGS_FILE_PATH_ENV] = MALFORMED_CODEX_SETTINGS_FILE;
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-malformed-settings',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexBootstrapSettingsLoadError);
    expect((caught as Error).message).toContain(
      '[B-SET] settings file must contain valid JSON.',
    );
    expect((caught as CodexBootstrapSettingsLoadError).cause).toBeInstanceOf(
      BoundaryValidationError,
    );
    expect(
      (
        (caught as CodexBootstrapSettingsLoadError)
          .cause as BoundaryValidationError
      ).boundary,
    ).toBe('B-SET');
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('fails startup closed when the settings file violates the sanctioned schema', () => {
    process.env['HOME'] = MISSING_CLI_AUTH_HOME;
    process.env[CODEX_SETTINGS_FILE_PATH_ENV] =
      INVALID_SCHEMA_CODEX_SETTINGS_FILE;
    const sdkFactory = vi.fn(
      (() => ({
        startThread: () => ({
          id: 'thread-invalid-settings',
          async runStreamed() {
            return { events: (async function* () {})() };
          },
        }),
      })),
    );

    let caught: unknown;
    try {
      new CodexRuntimeDriver({ sdkFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexBootstrapSettingsLoadError);
    expect((caught as Error).message).toContain('[B-SET] apiKey must be a string.');
    expect((caught as CodexBootstrapSettingsLoadError).cause).toBeInstanceOf(
      BoundaryValidationError,
    );
    expect(
      (
        (caught as CodexBootstrapSettingsLoadError)
          .cause as BoundaryValidationError
      ).boundary,
    ).toBe('B-SET');
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it('maps streamed thread items into runtime events and uses the latest agent message', async () => {
    const emittedEvents: Parameters<RuntimeExecutionContext['emit']>[0][] = [];
    let startThreadOptions: object | undefined;
    let runInput: string | undefined;
    let runSignal: AbortSignal | undefined;

    const sdkFactory = (() => ({
        startThread: (options: object | undefined) => {
          startThreadOptions = options;
          return {
            id: 'thread-1',
            async runStreamed(
              input: string,
              runOptions: { signal?: AbortSignal } | undefined,
            ) {
              runInput = input;
              runSignal = runOptions?.signal;
              return {
                events: (async function* () {
                  yield {
                    type: 'item.started',
                    item: {
                      type: 'command_execution',
                      status: 'in_progress',
                      command: 'pnpm test',
                      exit_code: 0,
                    },
                  };
                  yield {
                    type: 'item.updated',
                    item: {
                      type: 'mcp_tool_call',
                      status: 'completed',
                      server: 'workspace',
                      tool: 'read_file',
                    },
                  };
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'web_search',
                      query: 'discord slash command registration',
                    },
                  };
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'web_search_call',
                      status: 'completed',
                    },
                  };
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'reasoning',
                      text: 'checked command registration path',
                    },
                  };
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'file_change',
                      status: 'applied',
                      changes: [{ kind: 'added', path: 'tests/codex-runtime-adapter.spec.ts' }],
                    },
                  };
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'todo_list',
                      items: [
                        { content: 'add tests', completed: true },
                        { content: 'run checks', completed: false },
                      ],
                    },
                  };
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'error',
                      message: 'transient warning',
                    },
                  };
                  yield {
                    type: 'item.updated',
                    item: {
                      type: 'agent_message',
                      text: '  final streamed answer  ',
                    },
                  };
                })(),
              };
            },
          };
        },
      })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      sdkFactory,
    });

    const result = await driver.run(
      createRuntimeContext({
        emit: async (event) => {
          emittedEvents.push(event);
        },
      }),
    );

    expect(startThreadOptions).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: true,
      webSearchMode: 'live',
      skipGitRepoCheck: true,
      workingDirectory: 'results/task-artifacts',
    });
    expect(runInput).toBe('Execute contract-first runtime skeleton');
    expect(runSignal).toBeInstanceOf(AbortSignal);
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            type: 'web_search',
            summary: 'discord slash command registration',
          }),
        }),
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            type: 'web_search',
            originalType: 'web_search_call',
            status: 'completed',
            summary: 'completed',
          }),
        }),
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            type: 'reasoning',
            summary: 'checked command registration path',
          }),
        }),
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            type: 'file_change',
          }),
        }),
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            type: 'todo_list',
          }),
        }),
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            type: 'error',
          }),
        }),
      ]),
    );
    expect(result).toMatchObject({
      reason: 'final streamed answer',
      provenance: 'codex-runtime-driver',
      artifactLocation: 'results/task-artifacts',
    });
    // WU-V Phase 5: outcome retired from RuntimeDriverResult; cause.kind
    // is the canonical terminal-state field (success ⇒ outcome 'success'
    // at the agent-runtime boundary via deriveOutcomeFromCause).
    expect(result.cause.kind).toBe('success');
  });

  it('falls back to the default success reason when no meaningful agent message arrives', async () => {
    const sdkFactory = (() => ({
        startThread: () => ({
          id: 'thread-blank-message',
          async runStreamed() {
            return {
              events: (async function* () {
                yield {
                  type: 'item.completed',
                  item: {
                    type: 'agent_message',
                    text: '   ',
                  },
                };
              })(),
            };
          },
        }),
      })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      sdkFactory,
    });

    const blankResult = await driver.run(createRuntimeContext());
    expect(blankResult).toMatchObject({
      reason: 'codex runtime completed',
      provenance: 'codex-runtime-driver',
    });
    // WU-V Phase 5: cause.kind replaces the retired outcome literal.
    expect(blankResult.cause.kind).toBe('success');
  });

  it('fail-closes a zero-token completed turn with no observable item activity', async () => {
    const sdkFactory = (() => ({
        startThread: () => ({
          id: 'thread-empty-zero-token-turn',
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: 'turn.started' };
                yield {
                  type: 'turn.completed',
                  usage: {
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                  },
                };
              })(),
            };
          },
        }),
      })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      sdkFactory,
    });

    const observed = await driver.run(createRuntimeContext()).catch((error: unknown) => error);

    expect(observed).toMatchObject({
      name: 'CodexProviderFailureError',
    });
    const cause = (observed as { providerFailureCause?: unknown })
      .providerFailureCause;
    expect(cause).toMatchObject({
      kind: 'provider-failure',
      provider: 'codex',
      provenance: 'codex-runtime-driver',
      classification: 'permanent-protocol',
      retryable: false,
      message: expect.stringContaining('without observable assistant output'),
    });
  });

  it('propagates AbortError after emit when runtime cancellation becomes visible', async () => {
    let runSignal: AbortSignal | undefined;
    let returnCalled = false;
    let delivered = false;
    let aborted = false;

    const sdkFactory = (() => ({
        startThread: () => ({
          id: 'thread-veto',
          async runStreamed(
            _input: string,
            options: { signal?: AbortSignal } | undefined,
          ) {
            runSignal = options?.signal;
            const events = {
              [Symbol.asyncIterator]() {
                return this;
              },
              async next() {
                if (delivered) {
                  return { done: true, value: undefined };
                }
                delivered = true;
                return {
                  done: false,
                  value: {
                    type: 'item.completed',
                    item: {
                      id: 'cmd-veto',
                      type: 'command_execution',
                      status: 'in_progress',
                      command: 'rm -rf results',
                    },
                  },
                };
              },
              async return() {
                returnCalled = true;
                throw createAbortError('stream aborted after veto');
              },
            };

            return {
              events,
            };
          },
        }),
      })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      sdkFactory,
    });

    const observed = await driver.run(
      createRuntimeContext({
        emit: async () => {
          aborted = true;
        },
        isAborted: () => aborted,
      }),
    ).catch((error: unknown) => error);

    expect(returnCalled).toBe(true);
    expect(runSignal?.aborted).toBe(true);
    expect(observed).toMatchObject({
      name: 'AbortError',
    });
  });

  it('propagates AbortError when external cancellation becomes visible during streaming', async () => {
    vi.useFakeTimers();

    let runSignal: AbortSignal | undefined;
    let aborted = false;

    const sdkFactory = (() => ({
        startThread: () => ({
          id: 'thread-external-abort',
          async runStreamed(
            _input: string,
            options: { signal?: AbortSignal } | undefined,
          ) {
            runSignal = options?.signal;
            const events = {
              [Symbol.asyncIterator]() {
                return this;
              },
              next() {
                return new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                  const rejectAbort = () => reject(createAbortError('stream aborted'));
                  if (runSignal?.aborted) {
                    rejectAbort();
                    return;
                  }
                  runSignal?.addEventListener('abort', rejectAbort, { once: true });
                });
              },
              async return() {
                return { done: true, value: undefined };
              },
            };

            return {
              events,
            };
          },
        }),
      })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      abortPollIntervalMs: 1,
      sdkFactory,
    });

    const execution = driver.run(
      createRuntimeContext({
        isAborted: () => aborted,
      }),
    );
    const observedRejection = execution.catch((error: unknown) => error);

    aborted = true;
    await vi.advanceTimersByTimeAsync(5);

    await expect(observedRejection).resolves.toMatchObject({
      name: 'AbortError',
      message: 'stream aborted',
    });
    expect(runSignal?.aborted).toBe(true);
  });

  it('returns a failure result without starting a turn when already aborted', async () => {
    const startThread = vi.fn();
    const sdkFactory = (() => ({
      startThread,
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      sdkFactory,
    });

    const abortedResult = await driver.run(
      createRuntimeContext({
        isAborted: () => true,
      }),
    );
    expect(abortedResult).toMatchObject({
      reason: 'codex runtime aborted before turn start',
      provenance: 'codex-runtime-driver',
      artifactLocation: 'results/task-artifacts',
    });
    // WU-V Phase 5: pre-turn abort emits provider-failure cause (§6.12 F9
    // fallback); outcome derivation lives at the agent-runtime boundary.
    expect(abortedResult.cause.kind).toBe('provider-failure');
    expect(startThread).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: 'turn.failed events',
      event: {
        type: 'turn.failed',
        error: { message: 'streamed turn failed' },
      },
      expectedMessage: 'streamed turn failed',
    },
    {
      caseName: 'error events',
      event: {
        type: 'error',
        message: 'stream transport failed',
      },
      expectedMessage: 'stream transport failed',
    },
  ])('rethrows failures from $caseName', async ({ event, expectedMessage }) => {
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-failure',
        async runStreamed() {
          return {
            events: (async function* () {
              yield event;
            })(),
          };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      sdkFactory,
    });

    const observed = await driver.run(createRuntimeContext()).catch((e: unknown) => e);
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain(expectedMessage);
    expect((observed as Error).name).toBe('CodexProviderFailureError');
    const cause = (observed as { providerFailureCause?: unknown }).providerFailureCause;
    expect(cause).toMatchObject({
      kind: 'provider-failure',
      provider: 'codex',
      provenance: 'codex-runtime-driver',
    });
    const c = cause as {
      classification: string;
      retryable: boolean;
      message: string;
    };
    expect(typeof c.classification).toBe('string');
    expect(typeof c.retryable).toBe('boolean');
    // The cause's `message` field is the RAW provider message (no prefix).
    expect(c.message).toBe(expectedMessage);
  });

  it('retries once with the configured fallback model when the primary model is rejected', async () => {
    const emittedEvents: Parameters<RuntimeExecutionContext['emit']>[0][] = [];
    const observedThreadOptions: unknown[] = [];
    const sdkFactory = (() => ({
      startThread: (threadOptions: unknown) => {
        observedThreadOptions.push(threadOptions);
        return {
          id:
            (threadOptions as { model?: string }).model === 'gpt-5.4'
              ? 'thread-fallback-model'
              : 'thread-primary-model',
          async runStreamed() {
            return {
              events: (async function* () {
                if ((threadOptions as { model?: string }).model === 'gpt-5.4') {
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'agent_message',
                      text: 'fallback model success',
                    },
                  };
                  return;
                }
                yield {
                  type: 'turn.failed',
                  error: {
                    message: 'invalid model: gpt-5.5 is not accessible',
                  },
                };
              })(),
            };
          },
        };
      },
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      codexOptions: {},
      codexRuntimeConfig: {
        model: 'gpt-5.5',
        modelFallback: 'gpt-5.4',
        modelReasoningEffort: 'high',
      },
      sdkFactory,
    });

    const result = await driver.run(
      createRuntimeContext({
        emit: async (event) => {
          emittedEvents.push(event);
        },
      }),
    );

    expect(observedThreadOptions).toHaveLength(2);
    expect(observedThreadOptions[0]).toMatchObject({
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
    });
    expect(observedThreadOptions[1]).toMatchObject({
      model: 'gpt-5.4',
      modelReasoningEffort: 'high',
    });
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'item.failed',
          failure: expect.objectContaining({
            code: 'codex-model-fallback',
            message: 'invalid model: gpt-5.5 is not accessible',
          }),
          item: expect.objectContaining({
            type: 'error',
            summary: expect.stringContaining('retrying fallback model gpt-5.4'),
          }),
        }),
      ]),
    );
    expect(result.reason).toBe('fallback model success');
    expect(result.cause.kind).toBe('success');
  });

  it('retries the fallback model when the inherited global default model is rejected', async () => {
    const observedThreadOptions: unknown[] = [];
    const sdkFactory = (() => ({
      startThread: (threadOptions: unknown) => {
        observedThreadOptions.push(threadOptions);
        return {
          id:
            (threadOptions as { model?: string }).model === 'gpt-5.4'
              ? 'thread-global-fallback-model'
              : 'thread-global-default-model',
          async runStreamed() {
            return {
              events: (async function* () {
                if ((threadOptions as { model?: string }).model === 'gpt-5.4') {
                  yield {
                    type: 'item.completed',
                    item: {
                      type: 'agent_message',
                      text: 'global fallback model success',
                    },
                  };
                  return;
                }
                yield {
                  type: 'turn.failed',
                  error: {
                    message: 'model gpt-5.5 is not available for this account',
                  },
                };
              })(),
            };
          },
        };
      },
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      codexOptions: {},
      codexRuntimeConfig: {
        modelFallback: 'gpt-5.4',
      },
      sdkFactory,
    });

    const result = await driver.run(createRuntimeContext());

    expect(observedThreadOptions).toHaveLength(2);
    expect((observedThreadOptions[0] as { model?: string }).model).toBeUndefined();
    expect(observedThreadOptions[1]).toMatchObject({
      model: 'gpt-5.4',
    });
    expect(result.reason).toBe('global fallback model success');
    expect(result.cause.kind).toBe('success');
  });

  it('does not use the fallback model for non-model permanent config failures', async () => {
    const observedThreadOptions: unknown[] = [];
    const sdkFactory = (() => ({
      startThread: (threadOptions: unknown) => {
        observedThreadOptions.push(threadOptions);
        return {
          id: 'thread-non-model-config-failure',
          async runStreamed() {
            return {
              events: (async function* () {
                yield {
                  type: 'turn.failed',
                  error: {
                    message: 'invalid parameter temperature',
                  },
                };
              })(),
            };
          },
        };
      },
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      codexOptions: {},
      codexRuntimeConfig: {
        model: 'gpt-5.5',
        modelFallback: 'gpt-5.4',
      },
      sdkFactory,
    });

    const observed = await driver
      .run(createRuntimeContext())
      .catch((error: unknown) => error);

    expect(observed).toMatchObject({
      name: 'CodexProviderFailureError',
    });
    expect(observedThreadOptions).toHaveLength(1);
    expect(observedThreadOptions[0]).toMatchObject({
      model: 'gpt-5.5',
    });
  });

  it('classifies Codex Exec model-access exits as provider permanent-config failures', async () => {
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-cli-exit-model-access',
        async runStreamed() {
          return {
            // eslint-disable-next-line require-yield -- intentional throwing-only generator simulating SDK exit
            events: (async function* () {
              throw new Error(
                'Codex Exec exited with code 1: model "not-a-real-codex-model" does not exist or you do not have access to it',
              );
            })(),
          };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      codexOptions: {},
      sdkFactory,
    });

    const observed = await driver
      .run(createRuntimeContext())
      .catch((error: unknown) => error);

    expect(observed).toMatchObject({
      name: 'CodexProviderFailureError',
    });
    expect((observed as { driverFailureCause?: unknown }).driverFailureCause).toBeUndefined();
    expect((observed as { providerFailureCause?: unknown }).providerFailureCause).toMatchObject({
      kind: 'provider-failure',
      provider: 'codex',
      provenance: 'codex-runtime-driver',
      classification: 'permanent-config',
      retryable: false,
      message: expect.stringContaining('not-a-real-codex-model'),
    });
  });

  it.each([
    {
      caseName: 'missing streamedTurn.events async iterable',
      buildStreamedTurn: () => ({ events: null }),
    },
    {
      caseName: 'turn.failed without a string error.message',
      buildStreamedTurn: () => ({
        events: (async function* () {
          yield {
            type: 'turn.failed',
            error: { message: 123 },
          };
        })(),
      }),
    },
    {
      caseName: 'turn.completed with malformed usage payload',
      buildStreamedTurn: () => ({
        events: (async function* () {
          yield {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 'bad',
              output_tokens: 2,
            },
          };
        })(),
      }),
    },
    {
      caseName: 'known command_execution item missing command',
      buildStreamedTurn: () => ({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              status: 'completed',
            },
          };
        })(),
      }),
    },
  ])(
    'classifies malformed Codex ingress ($caseName) as provider-failure/permanent-protocol',
    async ({ buildStreamedTurn }) => {
      const sdkFactory = (() => ({
        startThread: () => ({
          id: 'thread-malformed-ingress',
          async runStreamed() {
            return buildStreamedTurn() as never;
          },
        }),
      })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
      const driver = new CodexRuntimeDriver({ sdkFactory });

      const observed = await driver
        .run(createRuntimeContext())
        .catch((error: unknown) => error);

      expect(observed).toMatchObject({
        name: 'CodexProviderFailureError',
      });
      expect((observed as { driverFailureCause?: unknown }).driverFailureCause).toBeUndefined();
      const cause = (observed as { providerFailureCause?: unknown })
        .providerFailureCause;
      expect(cause).toMatchObject({
        kind: 'provider-failure',
        provider: 'codex',
        provenance: 'codex-runtime-driver',
        classification: 'permanent-protocol',
        retryable: false,
      });
      expect((cause as { message: string }).message).toContain(
        'invalid Codex response shape:',
      );
      expect((cause as { message: string }).message).toContain('[B-CDX]');
    },
  );

  it('keeps unknown future event additions on the success path', async () => {
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-future-event',
        async runStreamed() {
          return {
            events: (async function* () {
              yield {
                type: 'future.event',
                payload: { addedLater: true },
              };
              yield {
                type: 'item.completed',
                item: {
                  type: 'agent_message',
                  text: 'future-compatible success',
                },
              };
            })(),
          };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const result = await driver.run(createRuntimeContext());

    expect(result.reason).toBe('future-compatible success');
    expect(result.cause.kind).toBe('success');
  });

  it('normalizes unknown future item additions instead of fail-closing the turn', async () => {
    const emittedEvents: Parameters<RuntimeExecutionContext['emit']>[0][] = [];
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-future-item',
        async runStreamed() {
          return {
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: {
                  id: 'item_future_1',
                  type: 'patch_apply',
                  status: 'completed',
                  summary: 'applied one patch',
                },
              };
              yield {
                type: 'item.completed',
                item: {
                  type: 'agent_message',
                  text: 'future-item-compatible success',
                },
              };
            })(),
          };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const result = await driver.run(
      createRuntimeContext({
        emit: async (event) => {
          emittedEvents.push(event);
        },
      }),
    );

    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'item.completed',
          item: expect.objectContaining({
            id: 'item_future_1',
            type: 'unknown',
            originalType: 'patch_apply',
            status: 'completed',
            summary: expect.stringContaining('patch_apply'),
          }),
        }),
      ]),
    );
    expect(result.reason).toBe('future-item-compatible success');
    expect(result.cause.kind).toBe('success');
  });
});

describe('classifyCodexProviderFailureMessage', () => {
  it('classifies rate-limit signals (429 / "rate limit" / "too many requests")', () => {
    for (const msg of [
      '429 Too Many Requests',
      'Rate limit reached for gpt-x',
      'rate-limit exceeded',
      'TOO MANY REQUESTS',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'rate-limit',
        retryable: true,
      });
    }
  });

  it('classifies quota-exhausted signals (quota / billing / 402)', () => {
    for (const msg of [
      'You exceeded your current quota',
      'insufficient_quota',
      'billing required',
      '402 Payment Required',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'error')).toEqual({
        classification: 'quota-exhausted',
        retryable: false,
      });
    }
  });

  it('F3 transient-network: classifies socket/DNS/TCP signals', () => {
    for (const msg of [
      'Connection timed out',
      'request timeout',
      'network unreachable',
      'ECONNRESET on socket',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'DNS lookup failed',
      [
        'Reconnecting... 2/5',
        '(stream disconnected before completion:',
        'failed to lookup address information: Try again)',
      ].join(' '),
      'temporary failure in name resolution',
      'getaddrinfo EAI_AGAIN api.openai.com',
      'TLS handshake error',
      'socket hang up',
      'connection reset by peer',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'transient-network',
        retryable: true,
      });
    }
  });

  it('F4 transient-server: classifies 5xx / gateway / upstream signals', () => {
    for (const msg of [
      'service unavailable',
      '503 Service Unavailable',
      '502 Bad Gateway',
      '504 Gateway Timeout',
      '500 Internal Server Error',
      'upstream server error',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'transient-server',
        retryable: true,
      });
    }
  });

  it('F5 transient-tool: classifies sandbox / tool-call timeout signals', () => {
    for (const msg of [
      'sandbox container died',
      'container crashed during tool call',
      'tool_call_timeout reached',
      'tool-call timed out waiting for response',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'transient-tool',
        retryable: true,
      });
    }
  });

  it('F6 permanent-auth: classifies 401/403/invalid-key/revoked signals', () => {
    for (const msg of [
      '401 Unauthorized',
      '403 Forbidden',
      'invalid API key provided',
      'invalid_api_key',
      'token revoked',
      'authentication failed',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'error')).toEqual({
        classification: 'permanent-auth',
        retryable: false,
      });
    }
  });

  it('F7 permanent-config: classifies invalid-model / malformed / 400 signals', () => {
    for (const msg of [
      '400 Bad Request',
      'invalid model: gpt-?',
      'The model "not-a-real-codex-model" does not exist or you do not have access to it',
      'model gpt-5.5 is not available for this account',
      'model not enabled',
      'unknown model identifier',
      'unknown_model identifier',
      'unsupported model',
      'unsupported_model error',
      'malformed parameters',
      'invalid request body',
      'invalid parameter temperature',
      'unsupported feature requested',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'permanent-config',
        retryable: false,
      });
    }
  });

  it('F8 permanent-protocol: classifies schema / protocol / SDK-contract signals', () => {
    for (const msg of [
      'unexpected event shape received',
      'schema mismatch in response',
      'protocol error: unknown frame',
      'unsupported sdk version',
      'invalid response shape',
    ]) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'permanent-protocol',
        retryable: false,
      });
    }
  });

  it('F9 unknown: defaults unmapped messages to unknown / non-retryable', () => {
    for (const msg of ['hallucinated tool call', 'wat', '']) {
      expect(classifyCodexProviderFailureMessage(msg, 'turn.failed')).toEqual({
        classification: 'unknown',
        retryable: false,
      });
    }
  });

  it('order: rate-limit wins over quota when both substrings present', () => {
    // "429 quota issue" — rate-limit rule fires first.
    expect(
      classifyCodexProviderFailureMessage('429 quota issue', 'turn.failed'),
    ).toEqual({ classification: 'rate-limit', retryable: true });
  });

  it('order: quota wins over transient when both substrings present', () => {
    expect(
      classifyCodexProviderFailureMessage(
        'billing exhausted; please retry after timeout',
        'turn.failed',
      ),
    ).toEqual({ classification: 'quota-exhausted', retryable: false });
  });
});

// ---------------------------------------------------------------------------
// WU-V Phase 1 — RuntimeDriverResult.cause dual-emit
// See: specs/wu-v-terminal-cause-tightening.md §3 Phase 1, §5 AC-V1.1..V1.5
// ---------------------------------------------------------------------------

describe('WU-V Phase 1 — RuntimeDriverResult.cause dual-emit', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC-V4.1: declares REQUIRED `cause` field on RuntimeDriverResult (typecheck sentinel)', () => {
    // WU-V Phase 4b: cause is now required. The structural sentinel below
    // confirms the union shape; assigning `undefined` (as in Phase 1) is
    // intentionally NOT valid — see tests/wu-v-phase-4b.spec.ts for the
    // negative compile-time assertion via @ts-expect-error.
    const _success: RuntimeDriverResult['cause'] = {
      kind: 'success',
      taskId: 't',
      runtimeInstanceId: 'r',
      observedAt: '2026-04-21T00:00:00.000Z',
      provenance: 'codex-runtime-driver',
    };
    void _success;
    expect(true).toBe(true);
  });

  it('AC-V1.2 / AC-V1.4: success path dual-emits matching cause and outcome', async () => {
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-success',
        async runStreamed() {
          return {
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', text: 'all done' },
              };
            })(),
          };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const result = await driver.run(createRuntimeContext());

    expect(result.cause).toBeDefined();
    expect(result.cause?.kind).toBe('success');
    // WU-V Phase 5: outcome retired from RuntimeDriverResult; cause.kind
    // is the canonical terminal-state field.
    // Provenance + reason coherence with the existing success-construction site
    expect(result.cause?.provenance).toBe('codex-runtime-driver');
    expect(result.reason).toBe('all done');
    // Identity fields populated from execution context
    if (result.cause?.kind === 'success') {
      expect(result.cause.taskId).toBe('task-codex-driver');
      expect(result.cause.runtimeInstanceId).toBe('agent-task-codex-driver');
      expect(typeof result.cause.observedAt).toBe('string');
      expect(result.cause.observedAt.length).toBeGreaterThan(0);
    }
  });

  it('AC-V1.3 / AC-V1.4: failure path (already-aborted) dual-emits provider-failure cause with §6.12 classification', async () => {
    const driver = new CodexRuntimeDriver({
      sdkFactory: (() => ({ startThread: vi.fn() })) as unknown as CodexRuntimeDriverOptions['sdkFactory'],
    });

    const result = await driver.run(
      createRuntimeContext({ isAborted: () => true }),
    );

    expect(result.cause).toBeDefined();
    expect(result.cause?.kind).toBe('provider-failure');
    // WU-V Phase 5: outcome retired from RuntimeDriverResult; cause.kind
    // is the canonical terminal-state field.
    if (result.cause?.kind === 'provider-failure') {
      expect(PROVIDER_FAILURE_CLASSIFICATIONS).toContain(result.cause.classification);
      expect(result.cause.provider).toBe('codex');
      expect(typeof result.cause.retryable).toBe('boolean');
      expect(result.cause.message).toBe('codex runtime aborted before turn start');
      expect(result.cause.provenance).toBe('codex-runtime-driver');
    }
  });

  it('Phase 4a (OQ-V1): abort is observed cooperatively via context.isAborted()', async () => {
    let delivered = false;
    let aborted = false;
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-veto-cause',
        async runStreamed() {
          const events = {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              if (delivered) {
                return { done: true, value: undefined };
              }
              delivered = true;
              return {
                done: false,
                value: {
                  type: 'item.completed',
                  item: {
                    id: 'cmd-phase-4a',
                    type: 'command_execution',
                    status: 'in_progress',
                    command: 'noop',
                  },
                },
              };
            },
            async return() {
              throw createAbortError('aborted after veto');
            },
          };
          return { events };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const observed = await driver.run(
      createRuntimeContext({
        emit: async () => {
          aborted = true;
        },
        isAborted: () => aborted,
      }),
    ).catch((error: unknown) => error);

    expect(observed).toMatchObject({
      name: 'AbortError',
    });
    expect(aborted).toBe(true);
  });
});
