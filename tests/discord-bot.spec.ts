import { withSynthesizedCause } from './helpers/wu-v-cause.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  Events,
  MessageFlags,
  REST,
  Routes,
  type Client as DiscordClient,
} from 'discord.js';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  adaptChatInputInteraction,
  adaptNaturalLanguageMessage,
  buildDiscordFirstSliceCommands,
  classifyNaturalLanguageControlIntent,
  extractNaturalLanguageAskInstruction,
  extractNaturalLanguagePrefixInstruction,
  extractSlashTextControlInstruction,
  registerDiscordFirstSliceCommands,
  startDiscordFirstSliceBot,
  type RuntimeDriverResult,
} from '../src/index.js';
import { flushDiscordAsyncWork } from './helpers/discord.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

const defaultRequestFactoryOptions = {
  resources: {
    requested: {
      cpuCores: 4,
      memoryMiB: 8192,
      wallTimeSec: 900,
      gpuCards: 0,
    },
  },
  runtimeSettings: {
    networkProfile: 'provider-only' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    workingDirectory: 'results/task-artifacts',
  },
  artifactLocation: 'results/task-artifacts',
  taskIdFactory: () => 'bot-test-id',
};

class FakeDiscordClient {
  private readonly listeners = new Map<string, Array<(value: unknown) => unknown>>();

  readonly user = { id: 'bot-user-1' };
  readonly login = vi.fn(async () => 'logged-in');
  readonly destroy = vi.fn();
  readonly isReady = vi.fn(() => false);

  on(event: string, listener: (value: unknown) => unknown): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  once(event: string, listener: (value: unknown) => unknown): this {
    const onceListener = async (value: unknown): Promise<void> => {
      this.off(event, onceListener);
      await listener(value);
    };
    return this.on(event, onceListener);
  }

  off(event: string, listener: (value: unknown) => unknown): this {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      existing.filter((candidate) => candidate !== listener),
    );
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  async emit(event: string, value: unknown): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener(value);
    }
  }
}

function createBotDependencies(
  onRun?: (instruction: string) => void,
) {
  const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime({
      async run(context): Promise<RuntimeDriverResult> {
        onRun?.(context.plan.instruction);
        void context.emit({
          kind: 'agent-step',
          step: 'complete',
          detail: 'bot-flow',
        });
        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'discord bot handled the task',
          provenance: 'discord-bot-test-driver',
          artifactLocation: 'results/discord-bot',
        });
      },
    })),);

  return {
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
  };
}

describe('discord bot bootstrap and command registration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the first-slice slash command JSON shape', () => {
    const commands = buildDiscordFirstSliceCommands();
    const commandByName = new Map(
      commands.map((command) => [command.name, command]),
    );

    expect(commandByName.get('ask')).toEqual(
      expect.objectContaining({
        name: 'ask',
        description: 'Task dispatch: run a task through the TypeScript core.',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'instruction',
            description: 'Instruction to dispatch',
            required: true,
          }),
        ]),
      }),
    );
    expect(commandByName.get('status')).toEqual(
      expect.objectContaining({
        name: 'status',
        description: 'Read-only: inspect coarse task status for a tracked Discord task.',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'task_id',
            description: 'Task identifier returned by /ask',
            required: true,
          }),
        ]),
      }),
    );
    expect(commandByName.get('cancel')).toEqual(
      expect.objectContaining({
        name: 'cancel',
        description: 'Owner/admin only: request cancellation for a tracked Discord task.',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'task_id',
            required: true,
          }),
          expect.objectContaining({
            name: 'reason',
            description: 'Optional cancellation reason',
            required: false,
          }),
        ]),
      }),
    );
    expect(commandByName.get('rerun')).toEqual(
      expect.objectContaining({
        name: 'rerun',
        description: 'Owner/admin only: start a fresh task from terminal evidence.',
      }),
    );
    expect(commandByName.get('archive')).toEqual(
      expect.objectContaining({
        name: 'archive',
        description: 'Owner/admin only: hide a terminal task from default task lists.',
      }),
    );
    expect(commandByName.get('unarchive')).toEqual(
      expect.objectContaining({
        name: 'unarchive',
        description: 'Owner/admin only: restore an archived task to default task lists.',
      }),
    );
    expect(commandByName.get('help')).toEqual(
      expect.objectContaining({
        name: 'help',
        description: 'Help: show how to use the Discord task bot.',
      }),
    );
    expect(commandByName.get('research')).toEqual(
      expect.objectContaining({
        name: 'research',
        description: expect.stringContaining('Research mission MVP:'),
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'action',
            required: false,
          }),
          expect.objectContaining({
            name: 'instruction',
            required: false,
          }),
        ]),
      }),
    );
    expect(commandByName.get('critique')).toEqual(
      expect.objectContaining({
        name: 'critique',
        description:
          'Research state: critique preflight or metadata-only constraint report.',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'mission_id',
            required: true,
          }),
          expect.objectContaining({
            name: 'lens',
            required: true,
          }),
          expect.objectContaining({
            name: 'action',
            required: false,
          }),
          expect.objectContaining({
            name: 'claim_id',
            required: false,
          }),
        ]),
      }),
    );
    expect(commandByName.get('tasks')).toEqual(
      expect.objectContaining({
        name: 'tasks',
      }),
    );
    expect(commandByName.get('traits')).toEqual(
      expect.objectContaining({
        name: 'traits',
        description: 'Read-only: list repository TraitModule plugin manifests.',
      }),
    );
    expect(commandByName.get('agenda')).toEqual(
      expect.objectContaining({
        name: 'agenda',
      }),
    );
    expect(commandByName.get('history')).toEqual(
      expect.objectContaining({
        name: 'history',
      }),
    );
    expect(commandByName.get('context')).toEqual(
      expect.objectContaining({
        name: 'context',
      }),
    );
    expect(commandByName.get('escalate')).toEqual(
      expect.objectContaining({
        name: 'escalate',
        description:
          'Discord-only: request operator escalation for a task or channel.',
      }),
    );
    expect(commandByName.get('feed')).toEqual(
      expect.objectContaining({
        name: 'feed',
        description:
          'Read-only: Discord-only bounded live feed from the control ledger.',
      }),
    );
    expect(commandByName.get('approve')).toEqual(
      expect.objectContaining({
        name: 'approve',
      }),
    );
    expect(commandByName.get('deny')).toEqual(
      expect.objectContaining({
        name: 'deny',
      }),
    );
    expect(commandByName.get('doctor')).toEqual(
      expect.objectContaining({
        name: 'doctor',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'mission_id',
            required: false,
          }),
        ]),
      }),
    );
    expect(commandByName.get('proof')).toEqual(
      expect.objectContaining({
        name: 'proof',
        description:
          'Admin-only: inspect, start, export, prepare capture, or link proof metadata.',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'action',
            required: false,
          }),
          expect.objectContaining({
            name: 'surface',
            required: false,
          }),
          expect.objectContaining({
            name: 'proof_id',
            required: false,
          }),
          expect.objectContaining({
            name: 'status',
            required: false,
          }),
        ]),
      }),
    );
    expect(commandByName.get('auth')).toEqual(
      expect.objectContaining({
        name: 'auth',
      }),
    );
  });

  it('registers commands on the guild route or global route as configured', async () => {
    const putSpy = vi.spyOn(REST.prototype, 'put').mockResolvedValue([] as never);

    await registerDiscordFirstSliceCommands({
      token: 'discord-token',
      applicationId: 'app-id',
      guildId: 'guild-id',
    });
    await registerDiscordFirstSliceCommands({
      token: 'discord-token',
      applicationId: 'app-id',
    });

    expect(putSpy).toHaveBeenNthCalledWith(
      1,
      Routes.applicationGuildCommands('app-id', 'guild-id'),
      {
        body: buildDiscordFirstSliceCommands(),
      },
    );
    expect(putSpy).toHaveBeenNthCalledWith(
      2,
      Routes.applicationCommands('app-id'),
      {
        body: buildDiscordFirstSliceCommands(),
      },
    );
  });

  it('starts with an injected client and wires supported chat-input commands', async () => {
    const { arona, dispatcher } = createBotDependencies();
    const client = new FakeDiscordClient();
    const nonChatInteraction = {
      isChatInputCommand: () => false,
    };
    const unsupportedInteraction = {
      commandName: 'ping',
      isChatInputCommand: () => true,
      deferReply: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn(),
    };
    const askInteraction = {
      commandName: 'ask',
      user: { id: 'discord-user-1' },
      channelId: 'discord-channel-1',
      options: {
        getString(name: string, required?: boolean): string | null {
          if (name === 'instruction') {
            return 'dispatch from interaction create';
          }
          if (required) {
            throw new Error(`Missing required option: ${name}`);
          }
          return null;
        },
      },
      deferredReplies: [] as Array<{ ephemeral?: boolean; flags?: number } | undefined>,
      editedReplies: [] as Array<{ content?: string }>,
      followUpReplies: [] as Array<{ content?: string }>,
      isChatInputCommand: () => true,
      async deferReply(options?: { ephemeral?: boolean; flags?: number }) {
        this.deferredReplies.push(options);
      },
      async editReply(payload: { content?: string }) {
        this.editedReplies.push(payload);
      },
      async followUp(payload: { content?: string }) {
        this.followUpReplies.push(payload);
      },
    };

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
    });

    expect(bot.client).toBe(client);
    expect(client.login).toHaveBeenCalledWith('discord-token');

    await client.emit(Events.InteractionCreate, nonChatInteraction);
    await client.emit(Events.InteractionCreate, unsupportedInteraction);
    await client.emit(Events.InteractionCreate, askInteraction);
    await flushDiscordAsyncWork();

    expect(unsupportedInteraction.deferReply).not.toHaveBeenCalled();
    expect(askInteraction.deferredReplies).toEqual([undefined]);
    // UX-23 (cycle 8): lifecycle progression flows through editReply
    // (single in-place message) instead of followUp; tests assert
    // content across editedReplies and expect zero followUps.
    const editedContent = askInteraction.editedReplies.map(
      (payload) => payload.content,
    );
    expect(
      editedContent.some((content) =>
        content?.includes('Accepted task `discord-task-bot-test-id`'),
      ),
    ).toBe(true);
    expect(
      editedContent.some((content) =>
        content?.includes('finished with `success`'),
      ),
    ).toBe(true);
    expect(askInteraction.followUpReplies).toHaveLength(0);

    await bot.stop();

    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when adapting an unsupported chat-input command directly', () => {
    expect(() =>
      adaptChatInputInteraction({
        commandName: 'ping',
        user: { id: 'discord-user-1' },
        channelId: 'discord-channel-1',
        options: {
          getString: vi.fn(),
        },
        deferReply: vi.fn(),
        editReply: vi.fn(),
        followUp: vi.fn(),
      } as never),
    ).toThrow('Unsupported Discord command: ping');
  });

  it('logs and contains handler failures without crashing the Discord client loop', async () => {
    const { arona, dispatcher } = createBotDependencies();
    const client = new FakeDiscordClient();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const statusInteraction = {
      commandName: 'status',
      user: { id: 'discord-user-1' },
      channelId: 'discord-channel-1',
      options: {
        getString(name: string): string | null {
          return name === 'task_id' ? 'discord-task-missing' : null;
        },
      },
      isChatInputCommand: () => true,
      async deferReply() {
        throw new Error('Unknown interaction');
      },
      editReply: vi.fn(),
      followUp: vi.fn(),
    };

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
    });

    await expect(
      client.emit(Events.InteractionCreate, statusInteraction),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'discord-interaction-handler-error',
      expect.stringContaining('"commandName":"status"'),
    );

    await bot.stop();
  });

  it('extracts natural-language ask instructions from bot mentions and configured prefixes', () => {
    expect(
      extractNaturalLanguageAskInstruction(
        '<@bot-user-1> create a ternary VM',
        'bot-user-1',
      ),
    ).toBe('create a ternary VM');
    expect(
      extractNaturalLanguageAskInstruction(
        '<@!bot-user-1>: create a ternary VM',
        'bot-user-1',
      ),
    ).toBe('create a ternary VM');
    expect(
      extractNaturalLanguageAskInstruction(
        '아로나 create a ternary VM',
        'bot-user-1',
        { prefixes: ['아로나'], triggerMode: 'mention-or-prefix' },
      ),
    ).toBe('create a ternary VM');
    expect(
      extractNaturalLanguageAskInstruction(
        '아로나 create a ternary VM',
        'bot-user-1',
        { prefixes: ['아로나'] },
      ),
    ).toBeUndefined();
    expect(
      extractNaturalLanguageAskInstruction(
        '<@bot-user-1>야, please create a ternary VM',
        'bot-user-1',
      ),
    ).toBe('create a ternary VM');
    expect(
      extractNaturalLanguageAskInstruction(
        '아로나야, 부탁해. 삼진수 VM 설계해줘',
        'bot-user-1',
        { prefixes: ['아로나'], triggerMode: 'mention-or-prefix' },
      ),
    ).toBe('삼진수 VM 설계해줘');
    expect(
      extractNaturalLanguageAskInstruction(
        'hey arona, pls create a ternary VM',
        'bot-user-1',
        { prefixes: ['arona'], triggerMode: 'mention-or-prefix' },
      ),
    ).toBe('create a ternary VM');
    expect(
      extractNaturalLanguageAskInstruction(
        '플라나에게 좀 삼진수 인터프리터 평가를 진행해줘',
        'bot-user-1',
        { prefixes: ['플라나'], triggerMode: 'mention-or-prefix' },
      ),
    ).toBe('삼진수 인터프리터 평가를 진행해줘');
    expect(
      extractNaturalLanguageAskInstruction(
        '아로나이트 create a ternary VM',
        'bot-user-1',
        { prefixes: ['아로나'], triggerMode: 'mention-or-prefix' },
      ),
    ).toBeUndefined();
    expect(
      extractNaturalLanguageAskInstruction('create a ternary VM', 'bot-user-1'),
    ).toBeUndefined();
    expect(
      extractNaturalLanguageAskInstruction(
        'please create a file <@bot-user-1>',
        'bot-user-1',
        { allowNonLeadingMentions: true },
      ),
    ).toBe('create a file');
    expect(
      extractNaturalLanguageAskInstruction(
        'please <@bot-user-1> create a file',
        'bot-user-1',
        { allowNonLeadingMentions: true },
      ),
    ).toBe('create a file');
    expect(
      extractNaturalLanguageAskInstruction(
        'code sample only\n```\n<@bot-user-1> do not run\n```',
        'bot-user-1',
        { allowNonLeadingMentions: true },
      ),
    ).toBeUndefined();
  });

  it('classifies natural-language control intents before task dispatch', () => {
    expect(
      classifyNaturalLanguageControlIntent(
        'USER30_C21: discord-task-abc123 상태만 알려줘',
      ),
    ).toEqual({
      commandName: 'status',
      taskId: 'discord-task-abc123',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'cancel discord-task-abc123 because the user changed plans',
      ),
    ).toEqual({
      commandName: 'cancel',
      taskId: 'discord-task-abc123',
      reason: 'cancel requested from natural-language Discord message',
    });
    expect(
      classifyNaturalLanguageControlIntent('help. 사용법을 알려줘'),
    ).toEqual({
      commandName: 'help',
    });
    expect(classifyNaturalLanguageControlIntent('auth list')).toEqual({
      commandName: 'auth',
      action: 'list',
    });
    expect(
      classifyNaturalLanguageControlIntent('auth allow_user 999999999999999999'),
    ).toEqual({
      commandName: 'auth',
      action: 'allow_user',
      subjectId: '999999999999999999',
    });
    expect(
      classifyNaturalLanguageControlIntent('999999999999999999 사용자 권한 허용'),
    ).toEqual({
      commandName: 'auth',
      action: 'allow_user',
      subjectId: '999999999999999999',
    });
    expect(
      classifyNaturalLanguageControlIntent('allow user 999999999999999999'),
    ).toEqual({
      commandName: 'auth',
      action: 'allow_user',
      subjectId: '999999999999999999',
    });
    expect(
      classifyNaturalLanguageControlIntent('999999999999999999 사용자를 허가'),
    ).toEqual({
      commandName: 'auth',
      action: 'allow_user',
      subjectId: '999999999999999999',
    });
    expect(
      classifyNaturalLanguageControlIntent('999999999999999999 관리자 권한 허용'),
    ).toEqual({
      commandName: 'auth',
      action: 'add_admin',
      subjectId: '999999999999999999',
    });
    expect(
      classifyNaturalLanguageControlIntent('LIVEADMIN_APPROVE_20260426 approve'),
    ).toEqual({
      commandName: 'approve',
      approvalId: 'LIVEADMIN_APPROVE_20260426',
      note: 'approved from natural-language Discord message',
    });
    expect(
      classifyNaturalLanguageControlIntent('LIVEADMIN_DENY_20260426 거부'),
    ).toEqual({
      commandName: 'deny',
      approvalId: 'LIVEADMIN_DENY_20260426',
      reason: 'denied from natural-language Discord message',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'please approve LIVEADMIN_APPROVE_20260426',
      ),
    ).toEqual({
      commandName: 'approve',
      approvalId: 'LIVEADMIN_APPROVE_20260426',
      note: 'approved from natural-language Discord message',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'please deny the request LIVEADMIN_DENY_20260426',
      ),
    ).toEqual({
      commandName: 'deny',
      approvalId: 'LIVEADMIN_DENY_20260426',
      reason: 'denied from natural-language Discord message',
    });
    expect(
      classifyNaturalLanguageControlIntent('create discord-task-abc123 notes'),
    ).toBeUndefined();
    expect(
      classifyNaturalLanguageControlIntent('진행 중인 연구 목록 최근 5개 보여줘'),
    ).toEqual({
      commandName: 'tasks',
      state: 'active',
      limit: '5',
    });
    expect(classifyNaturalLanguageControlIntent('스킬 목록 보여줘')).toEqual({
      commandName: 'traits',
    });
    expect(classifyNaturalLanguageControlIntent('show available trait modules')).toEqual({
      commandName: 'traits',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'discord-task-abc123 컨텍스트와 프롬프트 보여줘',
      ),
    ).toEqual({
      commandName: 'context',
      taskId: 'discord-task-abc123',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'discord-task-abc123 히스토리 최근 3개',
      ),
    ).toEqual({
      commandName: 'history',
      taskId: 'discord-task-abc123',
      limit: '3',
    });
    expect(
      classifyNaturalLanguageControlIntent('히스토리 최근 5개 보여줘'),
    ).toEqual({
      commandName: 'history',
      limit: '5',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'discord-task-abc123 대화록 히스토리 최근 4개 보여줘',
      ),
    ).toEqual({
      commandName: 'history',
      taskId: 'discord-task-abc123',
      limit: '4',
      historyView: 'talk',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'discord-task-abc123 운영자 검토 요청: 결과가 이상함',
      ),
    ).toEqual({
      commandName: 'escalate',
      taskId: 'discord-task-abc123',
      reason: '운영자 검토 요청: 결과가 이상함',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'discord-task-abc123 needs operator review',
      ),
    ).toEqual({
      commandName: 'escalate',
      taskId: 'discord-task-abc123',
      reason: 'needs operator review',
    });
    expect(
      classifyNaturalLanguageControlIntent('who is the operator of this server?'),
    ).toBeUndefined();
    expect(
      classifyNaturalLanguageControlIntent('담당자에게 문의해 주세요'),
    ).toBeUndefined();
    expect(
      classifyNaturalLanguageControlIntent('please review this PR'),
    ).toBeUndefined();
    expect(classifyNaturalLanguageControlIntent('feed 5m escalation')).toEqual({
      commandName: 'feed',
      since: '5m',
      feedKind: 'escalation',
    });
    expect(classifyNaturalLanguageControlIntent('서비스 상태 점검해줘')).toEqual({
      commandName: 'doctor',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'doctor mission_id:R-20260510-doctor',
      ),
    ).toEqual({
      commandName: 'doctor',
      missionId: 'R-20260510-doctor',
    });
    expect(classifyNaturalLanguageControlIntent('proof status')).toEqual({
      commandName: 'proof',
      action: 'status',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'proof start mission_id:R-20260510-proof surface:discord-service',
      ),
    ).toEqual({
      commandName: 'proof',
      action: 'start',
      missionId: 'R-20260510-proof',
      surface: 'discord-service',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'proof export surface:discord-service',
      ),
    ).toEqual({
      commandName: 'proof',
      action: 'export',
      surface: 'discord-service',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'proof capture mission_id:R-20260510-proof surface:durable-task-archive-ux',
      ),
    ).toEqual({
      commandName: 'proof',
      action: 'capture',
      missionId: 'R-20260510-proof',
      surface: 'durable-task-archive-ux',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'proof link mission_id:R-20260510-proof surface:discord-service proof_id:discord-live-1 status:pass artifacts:gateway-ready,command-registration summary:"operator checked redacted manifest"',
      ),
    ).toEqual({
      commandName: 'proof',
      action: 'link',
      missionId: 'R-20260510-proof',
      surface: 'discord-service',
      proofId: 'discord-live-1',
      proofStatus: 'pass',
      artifactTokens: 'gateway-ready,command-registration',
      summary: 'operator checked redacted manifest',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'subagents tree mission_id:R-20260510-tree',
      ),
    ).toEqual({
      commandName: 'subagents',
      action: 'tree',
        missionId: 'R-20260510-tree',
      });
    expect(
      classifyNaturalLanguageControlIntent(
        'subagents spawn role:collector mission_id:R-20260510-spawn task:"OpenClaw subagent UX 근거 정리"',
      ),
    ).toEqual({
      commandName: 'subagents',
      action: 'spawn',
      missionId: 'R-20260510-spawn',
      role: 'collector',
      text: 'OpenClaw subagent UX 근거 정리',
    });
    expect(
      classifyNaturalLanguageControlIntent('OpenClaw 비교 조사 진행해줘'),
    ).toEqual({
      commandName: 'research',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        '연구 어젠다에 OpenClaw 장기 세션 비교 추가해줘',
      ),
    ).toEqual({
      commandName: 'agenda',
      action: 'add',
      text: 'OpenClaw 장기 세션 비교',
    });
    expect(
      classifyNaturalLanguageControlIntent(
        'research-agenda-abc123 완료 처리해줘',
      ),
    ).toEqual({
      commandName: 'agenda',
      action: 'done',
      itemId: 'research-agenda-abc123',
    });
    expect(
      classifyNaturalLanguageControlIntent('연구 주기는 매일 오후 점검으로 설정'),
    ).toEqual({
      commandName: 'agenda',
      action: 'cadence',
      text: '매일 오후 점검',
    });
  });

  it('extracts slash-text control fallbacks without treating malformed slash text as commands', () => {
    expect(extractSlashTextControlInstruction('/status discord-task-abc123')).toBe(
      'status discord-task-abc123',
    );
    expect(
      extractSlashTextControlInstruction(' /cancel   discord-task-abc123  '),
    ).toBe('cancel discord-task-abc123');
    expect(
      extractSlashTextControlInstruction(' /rerun   discord-task-abc123 lower lr  '),
    ).toBe('rerun discord-task-abc123 lower lr');
    expect(
      extractSlashTextControlInstruction(' /archive   discord-task-abc123 old run  '),
    ).toBe('archive discord-task-abc123 old run');
    expect(
      extractSlashTextControlInstruction(' /unarchive   discord-task-abc123 restore  '),
    ).toBe('unarchive discord-task-abc123 restore');
    expect(extractSlashTextControlInstruction('/help')).toBe('help');
    expect(extractSlashTextControlInstruction('/tasks active')).toBe(
      'tasks active',
    );
    expect(extractSlashTextControlInstruction('/traits')).toBe('traits');
    expect(extractSlashTextControlInstruction('/history discord-task-abc123')).toBe(
      'history discord-task-abc123',
    );
    expect(
      extractSlashTextControlInstruction('/escalate discord-task-abc123 check run'),
    ).toBe('escalate discord-task-abc123 check run');
    expect(extractSlashTextControlInstruction('/feed 5m escalation')).toBe(
      'feed 5m escalation',
    );
    expect(extractSlashTextControlInstruction('/auth allow_user 999')).toBe(
      'auth allow_user 999',
    );
    expect(extractSlashTextControlInstruction('/approve approval-123')).toBe(
      'approve approval-123',
    );
    expect(extractSlashTextControlInstruction('/agenda add follow-up')).toBe(
      'agenda add follow-up',
    );
    expect(extractSlashTextControlInstruction('/doctor')).toBe('doctor');
    expect(
      extractSlashTextControlInstruction('/doctor mission_id:R-20260510-doctor'),
    ).toBe('doctor mission_id:R-20260510-doctor');
    expect(extractSlashTextControlInstruction('/proof status')).toBe(
      'proof status',
    );
    expect(
      extractSlashTextControlInstruction(
        '/proof start mission_id:R-20260510-proof surface:discord-service',
      ),
    ).toBe('proof start mission_id:R-20260510-proof surface:discord-service');
    expect(
      extractSlashTextControlInstruction('/proof export surface:discord-service'),
    ).toBe('proof export surface:discord-service');
    expect(
      extractSlashTextControlInstruction(
        '/proof capture mission_id:R-20260510-proof surface:durable-task-archive-ux',
      ),
    ).toBe('proof capture mission_id:R-20260510-proof surface:durable-task-archive-ux');
    expect(
      extractSlashTextControlInstruction('/statusdiscord-task-abc123'),
    ).toBeUndefined();
    expect(extractSlashTextControlInstruction('/ask create file')).toBeUndefined();
  });

  it('adapts natural-language bot mentions into ask dispatches', async () => {
    const replies: Array<{ content?: string }> = [];
    const adapted = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> dispatch from natural language',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply(payload: { content?: string }) {
          replies.push(payload);
        },
      } as never,
      'bot-user-1',
    );

    expect(adapted?.commandName).toBe('ask');
    expect(adapted?.getString('instruction', true)).toBe(
      'dispatch from natural language',
    );

    await adapted?.editReply({ content: 'accepted' });

    expect(replies).toEqual([{ content: 'accepted' }]);
  });

  it('adapts natural-language status, cancel, and help requests without creating ask instructions', () => {
    const status = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> USER30_C21: discord-task-abc123 상태만 알려줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const cancel = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> cancel discord-task-abc123',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const archive = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> archive discord-task-abc123 stale result',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const rerun = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> rerun discord-task-abc123 lower learning rate',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const unarchive = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> restore discord-task-abc123 back to board',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const help = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> help. 사용법 알려줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );

    expect(status?.commandName).toBe('status');
    expect(status?.getString('task_id', true)).toBe('discord-task-abc123');
    expect(cancel?.commandName).toBe('cancel');
    expect(cancel?.getString('task_id', true)).toBe('discord-task-abc123');
    expect(cancel?.getString('reason')).toBe(
      'cancel requested from natural-language Discord message',
    );
    expect(archive?.commandName).toBe('archive');
    expect(archive?.getString('task_id', true)).toBe('discord-task-abc123');
    expect(archive?.getString('reason')).toBe('stale result');
    expect(rerun?.commandName).toBe('rerun');
    expect(rerun?.getString('task_id', true)).toBe('discord-task-abc123');
    expect(rerun?.getString('note')).toBe('lower learning rate');
    expect(unarchive?.commandName).toBe('unarchive');
    expect(unarchive?.getString('task_id', true)).toBe('discord-task-abc123');
    expect(unarchive?.getString('reason')).toBe('back to board');
    expect(help?.commandName).toBe('help');
  });

  it('adapts natural-language research and research-control requests', () => {
    const research = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> OpenClaw 비교 조사 진행해줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const tasks = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> 진행 중인 연구 목록 최근 5개 보여줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const archivedTasks = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> 아카이브된 연구 목록 최근 4개 보여줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const history = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> discord-task-abc123 히스토리 최근 3개',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const channelHistory = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> 히스토리 최근 5개 보여줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const talkHistory = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> /history --talk 4',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const escalation = adaptNaturalLanguageMessage(
      {
        content:
          '<@bot-user-1> /escalate discord-task-abc123 needs operator review',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const feed = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> /feed 5m escalation',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const context = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> discord-task-abc123 컨텍스트 보여줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const doctor = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> /doctor mission_id:R-20260510-doctor',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const auth = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> auth allow_user 999999999999999999',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const approve = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> LIVEADMIN_APPROVE_20260426 approve',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const deny = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> LIVEADMIN_DENY_20260426 deny',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );

    expect(research?.commandName).toBe('research');
    expect(research?.getString('instruction', true)).toContain(
      'command=research source=natural-language',
    );
    expect(tasks?.commandName).toBe('tasks');
    expect(tasks?.getString('state')).toBe('active');
    expect(tasks?.getString('limit')).toBe('5');
    expect(archivedTasks?.commandName).toBe('tasks');
    expect(archivedTasks?.getString('state')).toBe('archived');
    expect(archivedTasks?.getString('limit')).toBe('4');
    expect(history?.commandName).toBe('history');
    expect(history?.getString('task_id')).toBe('discord-task-abc123');
    expect(history?.getString('limit')).toBe('3');
    expect(channelHistory?.commandName).toBe('history');
    expect(channelHistory?.getString('task_id')).toBeNull();
    expect(channelHistory?.getString('limit')).toBe('5');
    expect(talkHistory?.commandName).toBe('history');
    expect(talkHistory?.getString('view')).toBe('talk');
    expect(talkHistory?.getString('limit')).toBe('4');
    expect(escalation?.commandName).toBe('escalate');
    expect(escalation?.getString('task_id')).toBe('discord-task-abc123');
    expect(escalation?.getString('reason')).toBe('needs operator review');
    expect(feed?.commandName).toBe('feed');
    expect(feed?.getString('since')).toBe('5m');
    expect(feed?.getString('kind')).toBe('escalation');
    expect(context?.commandName).toBe('context');
    expect(context?.getString('task_id')).toBe('discord-task-abc123');
    expect(doctor?.commandName).toBe('doctor');
    expect(doctor?.getString('mission_id')).toBe('R-20260510-doctor');
    expect(auth?.commandName).toBe('auth');
    expect(auth?.getString('action', true)).toBe('allow_user');
    expect(auth?.getString('subject_id')).toBe('999999999999999999');
    expect(approve?.commandName).toBe('approve');
    expect(approve?.getString('approval_id', true)).toBe(
      'LIVEADMIN_APPROVE_20260426',
    );
    expect(approve?.getString('note')).toBe(
      'approved from natural-language Discord message',
    );
    expect(deny?.commandName).toBe('deny');
    expect(deny?.getString('approval_id', true)).toBe(
      'LIVEADMIN_DENY_20260426',
    );
    expect(deny?.getString('reason')).toBe(
      'denied from natural-language Discord message',
    );
  });

  it('keeps research prompts containing readiness/diagnostic wording on the research route', () => {
    const readinessResearch = adaptNaturalLanguageMessage(
      {
        content:
          '<@bot-user-1> [research-live-T] GPU/high-end 연구활동 readiness 문제를 분석하고 개선안을 평가해줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );

    expect(readinessResearch?.commandName).toBe('research');
    expect(readinessResearch?.getString('instruction', true)).toContain(
      'GPU/high-end 연구활동 readiness 문제',
    );
  });

  it('adapts natural-language research agenda and cadence requests', () => {
    const add = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> 연구 어젠다에 OpenClaw 장기 세션 비교 추가해줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const done = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> research-agenda-abc123 완료 처리해줘',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const cadence = adaptNaturalLanguageMessage(
      {
        content: '<@bot-user-1> 연구 주기는 매일 오후 점검으로 설정',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );

    expect(add?.commandName).toBe('agenda');
    expect(add?.getString('action')).toBe('add');
    expect(add?.getString('text')).toBe('OpenClaw 장기 세션 비교');
    expect(done?.commandName).toBe('agenda');
    expect(done?.getString('action')).toBe('done');
    expect(done?.getString('item_id')).toBe('research-agenda-abc123');
    expect(cadence?.commandName).toBe('agenda');
    expect(cadence?.getString('action')).toBe('cadence');
    expect(cadence?.getString('text')).toBe('매일 오후 점검');
  });

  it('adapts slash-text status and cancel fallbacks without requiring a mention', () => {
    const status = adaptNaturalLanguageMessage(
      {
        content: '/status discord-task-abc123',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    const cancel = adaptNaturalLanguageMessage(
      {
        content: '/cancel discord-task-abc123',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );

    expect(status?.commandName).toBe('status');
    expect(status?.getString('task_id', true)).toBe('discord-task-abc123');
    expect(cancel?.commandName).toBe('cancel');
    expect(cancel?.getString('task_id', true)).toBe('discord-task-abc123');
    const proofExport = adaptNaturalLanguageMessage(
      {
        content: '/proof export surface:discord-service',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    expect(proofExport?.commandName).toBe('proof');
    expect(proofExport?.getString('action')).toBe('export');
    expect(proofExport?.getString('surface')).toBe('discord-service');
    const proofStart = adaptNaturalLanguageMessage(
      {
        content:
          '/proof start mission_id:R-20260510-proof surface:discord-service',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    expect(proofStart?.commandName).toBe('proof');
    expect(proofStart?.getString('action')).toBe('start');
    expect(proofStart?.getString('mission_id')).toBe('R-20260510-proof');
    expect(proofStart?.getString('surface')).toBe('discord-service');
    const proofCapture = adaptNaturalLanguageMessage(
      {
        content:
          '/proof capture mission_id:R-20260510-proof surface:durable-task-archive-ux',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    expect(proofCapture?.commandName).toBe('proof');
    expect(proofCapture?.getString('action')).toBe('capture');
    expect(proofCapture?.getString('mission_id')).toBe('R-20260510-proof');
    expect(proofCapture?.getString('surface')).toBe('durable-task-archive-ux');
    const proofLink = adaptNaturalLanguageMessage(
      {
        content:
          '/proof link mission_id:R-20260510-proof surface:discord-service proof_id:discord-live-1 status:pass artifacts:gateway-ready,command-registration',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    expect(proofLink?.commandName).toBe('proof');
    expect(proofLink?.getString('action')).toBe('link');
    expect(proofLink?.getString('mission_id')).toBe('R-20260510-proof');
    expect(proofLink?.getString('surface')).toBe('discord-service');
    expect(proofLink?.getString('proof_id')).toBe('discord-live-1');
    expect(proofLink?.getString('status')).toBe('pass');
    expect(proofLink?.getString('artifact_tokens')).toBe(
      'gateway-ready,command-registration',
    );
    const subagentsTree = adaptNaturalLanguageMessage(
      {
        content: '/subagents tree mission_id:R-20260510-tree',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    expect(subagentsTree?.commandName).toBe('subagents');
    expect(subagentsTree?.getString('action')).toBe('tree');
    expect(subagentsTree?.getString('mission_id')).toBe('R-20260510-tree');
    const subagentsSpawn = adaptNaturalLanguageMessage(
      {
        content:
          '/subagents spawn role:collector mission_id:R-20260510-spawn task:"OpenClaw subagent UX 근거 정리"',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
    );
    expect(subagentsSpawn?.commandName).toBe('subagents');
    expect(subagentsSpawn?.getString('action')).toBe('spawn');
    expect(subagentsSpawn?.getString('mission_id')).toBe('R-20260510-spawn');
    expect(subagentsSpawn?.getString('role')).toBe('collector');
    expect(subagentsSpawn?.getString('text')).toBe(
      'OpenClaw subagent UX 근거 정리',
    );
    expect(
      adaptNaturalLanguageMessage(
        {
          content: '/ask create a task',
          author: { id: 'discord-user-1', bot: false },
          channelId: 'discord-channel-1',
          async reply() {
            // no-op test double
          },
        } as never,
        'bot-user-1',
      ),
    ).toBeUndefined();
  });

  it('adapts natural-language vocative prefixes into ask dispatches', () => {
    const adapted = adaptNaturalLanguageMessage(
      {
        content: '아로나야, 부탁합니다. dispatch from natural prefix',
        author: { id: 'discord-user-1', bot: false },
        channelId: 'discord-channel-1',
        async reply() {
          // no-op test double
        },
      } as never,
      'bot-user-1',
      {
        prefixes: ['아로나'],
        triggerMode: 'mention-or-prefix',
      },
    );

    expect(adapted?.commandName).toBe('ask');
    expect(adapted?.getString('instruction', true)).toBe(
      'dispatch from natural prefix',
    );
  });

  it('detects prefix-only messages separately for mention-only UX notices', () => {
    expect(
      extractNaturalLanguagePrefixInstruction(
        '아로나야, 지금 작업해줘',
        'bot-user-1',
        ['아로나'],
      ),
    ).toBe('지금 작업해줘');
    expect(
      extractNaturalLanguagePrefixInstruction(
        '<@bot-user-1> 지금 작업해줘',
        'bot-user-1',
        ['아로나'],
      ),
    ).toBeUndefined();
  });

  it('records every seen message as context while only mention-addressed messages trigger tasks', async () => {
    let capturedInstruction = '';
    const { arona, dispatcher } = createBotDependencies((instruction) => {
      capturedInstruction = instruction;
    });
    const client = new FakeDiscordClient();
    const createMessage = (
      id: string,
      content: string,
      author: { id: string; bot?: boolean },
    ) => ({
      id,
      content,
      createdTimestamp: 1_779_000_000_000 + Number(id),
      author,
      channelId: 'discord-channel-1',
      replies: [] as Array<{ content?: string }>,
      async reply(payload: { content?: string }) {
        this.replies.push(payload);
      },
    });
    const unaddressedUserMessage = createMessage(
      '1',
      'context from another user',
      { id: 'discord-user-2', bot: false },
    );
    const prefixOnlyMessage = createMessage(
      '2',
      '아로나야, prefix-only should remain context only',
      { id: 'discord-user-1', bot: false },
    );
    const botContextMessage = createMessage(
      '3',
      'prior bot status context',
      { id: 'some-bot', bot: true },
    );
    const fetchedContextMessage = createMessage(
      '0',
      'fetched pre-start context message',
      { id: 'discord-user-3', bot: false },
    );
    const mentionMessage = createMessage(
      '4',
      '<@bot-user-1> execute the current task',
      { id: 'discord-user-1', bot: false },
    );
    const fetchSpy = vi.fn(async () =>
      new Map([
        [mentionMessage.id, mentionMessage],
        [fetchedContextMessage.id, fetchedContextMessage],
      ]),
    );
    (mentionMessage as { channel?: unknown }).channel = {
      messages: {
        fetch: fetchSpy,
      },
    };

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
      enableNaturalLanguageMessages: true,
      enableMessageContextHistory: true,
      enableMessageContextHistoryBackfill: true,
      messageContextHistoryLimit: 10,
      messageContextHistoryBackfillLimit: 10,
      naturalLanguagePrefixes: ['아로나'],
      naturalLanguageTriggerMode: 'mention',
    });

    await client.emit(Events.MessageCreate, unaddressedUserMessage);
    await client.emit(Events.MessageCreate, prefixOnlyMessage);
    await client.emit(Events.MessageCreate, botContextMessage);
    await flushDiscordAsyncWork();

    expect(prefixOnlyMessage.replies).toEqual([]);

    await client.emit(Events.MessageCreate, mentionMessage);
    await flushDiscordAsyncWork();

    expect(fetchSpy).toHaveBeenCalledWith({ limit: 10 });
    expect(capturedInstruction).toContain('[Discord context history]');
    expect(capturedInstruction).toContain('fetched pre-start context message');
    expect(capturedInstruction).toContain('context from another user');
    expect(capturedInstruction).toContain(
      'prefix-only should remain context only',
    );
    expect(capturedInstruction).toContain('prior bot status context');
    expect(capturedInstruction).toContain('execute the current task');
    expect(capturedInstruction).toContain('[Current task instruction]');

    await bot.stop();
  });

  it('wires natural-language mention messages into the ask flow when enabled', async () => {
    const { arona, dispatcher } = createBotDependencies();
    const client = new FakeDiscordClient();
    const message = {
      content: '<@bot-user-1> dispatch from message create',
      author: { id: 'discord-user-1', bot: false },
      channelId: 'discord-channel-1',
      replies: [] as Array<{ content?: string }>,
      async reply(payload: { content?: string }) {
        this.replies.push(payload);
      },
    };

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
      enableNaturalLanguageMessages: true,
    });

    await client.emit(Events.MessageCreate, message);
    await flushDiscordAsyncWork();

    expect(message.replies[0]?.content).toContain(
      'Accepted task `discord-task-bot-test-id`',
    );
    expect(
      message.replies.some((payload) =>
        payload.content?.includes('finished with `success`'),
      ),
    ).toBe(true);

    await bot.stop();
  });

  it('routes natural-language status/help controls directly instead of dispatching new tasks', async () => {
    let runCount = 0;
    const { arona, dispatcher } = createBotDependencies(() => {
      runCount += 1;
    });
    const client = new FakeDiscordClient();
    const createMessage = (content: string) => ({
      content,
      author: { id: 'discord-user-1', bot: false },
      channelId: 'discord-channel-1',
      replies: [] as Array<{ content?: string }>,
      async reply(payload: { content?: string }) {
        this.replies.push(payload);
      },
    });
    const askMessage = createMessage('<@bot-user-1> create initial artifact');
    const statusMessage = createMessage(
      '<@bot-user-1> discord-task-bot-test-id 상태만 알려줘',
    );
    const helpMessage = createMessage('<@bot-user-1> help 사용법 알려줘');

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
      enableNaturalLanguageMessages: true,
    });

    await client.emit(Events.MessageCreate, askMessage);
    await flushDiscordAsyncWork();
    await client.emit(Events.MessageCreate, statusMessage);
    await client.emit(Events.MessageCreate, helpMessage);
    await flushDiscordAsyncWork();

    expect(runCount).toBe(1);
    expect(statusMessage.replies.at(-1)?.content).toContain(
      'discord-task-bot-test-id',
    );
    expect(statusMessage.replies.at(-1)?.content).toMatch(/finished|status|running/i);
    // UX-7: /help reorganized into multiple sections; the message is now
    // long enough to be split across multiple chunks, so we join all
    // chunks before asserting against the Quickstart wording instead of
    // checking only the last chunk.
    const helpText = helpMessage.replies
      .map((r) => r.content)
      .join('\n');
    expect(helpText).toContain('Mention the bot');

    await bot.stop();
  });

  it('can notify users when prefix-only messages are context-only in mention mode', async () => {
    let runCount = 0;
    const { arona, dispatcher } = createBotDependencies(() => {
      runCount += 1;
    });
    const client = new FakeDiscordClient();
    const prefixOnlyMessage = {
      content: '아로나야, 지금 바로 실행해줘',
      author: { id: 'discord-user-1', bot: false },
      channelId: 'discord-channel-1',
      replies: [] as Array<{ content?: string }>,
      async reply(payload: { content?: string }) {
        this.replies.push(payload);
      },
    };

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
      enableNaturalLanguageMessages: true,
      naturalLanguagePrefixes: ['아로나'],
      naturalLanguageTriggerMode: 'mention',
      enableNaturalLanguagePrefixNotice: true,
    });

    await client.emit(Events.MessageCreate, prefixOnlyMessage);
    await flushDiscordAsyncWork();

    expect(runCount).toBe(0);
    expect(prefixOnlyMessage.replies).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('봇 멘션으로 시작'),
      }),
    ]);

    await bot.stop();
  });

  it('maps ephemeral semantic defer replies to Discord flags without deprecated option keys', async () => {
    const deferReply = vi.fn();
    const interaction = adaptChatInputInteraction({
      commandName: 'status',
      user: { id: 'discord-user-1' },
      channelId: 'discord-channel-1',
      options: {
        getString: vi.fn(),
      },
      deferReply,
      editReply: vi.fn(),
      followUp: vi.fn(),
    } as never);

    await interaction.deferReply({ ephemeral: true });
    await interaction.deferReply();

    expect(deferReply).toHaveBeenNthCalledWith(1, {
      flags: MessageFlags.Ephemeral,
    });
    expect(deferReply).toHaveBeenNthCalledWith(2, undefined);
  });

  it('creates a default client and registers commands on startup by default', async () => {
    const { arona, dispatcher } = createBotDependencies();
    const putSpy = vi.spyOn(REST.prototype, 'put').mockResolvedValue([] as never);
    const loginSpy = vi
      .spyOn(Client.prototype, 'login')
      .mockResolvedValue('logged-in');
    const destroySpy = vi
      .spyOn(Client.prototype, 'destroy')
      .mockImplementation(async () => undefined);

    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      guildId: 'guild-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
    });

    expect(bot.client).toBeInstanceOf(Client);
    expect(putSpy).toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-id', 'guild-id'),
      {
        body: buildDiscordFirstSliceCommands(),
      },
    );
    expect(loginSpy).toHaveBeenCalledWith('discord-token');
    expect(loginSpy.mock.invocationCallOrder[0]).toBeLessThan(
      putSpy.mock.invocationCallOrder[0],
    );

    await bot.stop();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('can wait for Discord gateway readiness before registering commands', async () => {
    const { arona, dispatcher } = createBotDependencies();
    const client = new FakeDiscordClient();
    const putSpy = vi.spyOn(REST.prototype, 'put').mockResolvedValue([] as never);
    const lifecycleLogger = vi.fn();

    const startPromise = startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      guildId: 'guild-id',
      arona,
      dispatcher,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      waitForReadyOnStart: true,
      lifecycleLogger,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (client.listenerCount(Events.ClientReady) > 0) {
        break;
      }
      await flushDiscordAsyncWork();
    }

    expect(client.login).toHaveBeenCalledWith('discord-token');
    expect(client.listenerCount(Events.ClientReady)).toBeGreaterThan(0);
    expect(putSpy).not.toHaveBeenCalled();

    await client.emit(Events.ClientReady, client);
    const bot = await startPromise;

    expect(putSpy).toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-id', 'guild-id'),
      {
        body: buildDiscordFirstSliceCommands(),
      },
    );
    expect(lifecycleLogger).toHaveBeenCalledWith('client-ready', {
      userId: 'bot-user-1',
    });
    expect(lifecycleLogger).toHaveBeenCalledWith(
      'client-ready-wait-complete',
      {},
    );

    await bot.stop();
  });
});
