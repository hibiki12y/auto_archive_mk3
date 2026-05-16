import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  DISCORD_ESCALATION_REASON_MAX_LENGTH,
  buildDiscordFirstSliceCommands,
  commandsByCategory,
  commandsByPermissionClass,
  getDiscordFirstSliceCommandNames,
  isDiscordFirstSliceCommandName,
  resolveCommand,
  type DiscordCommandPermissionClass,
  type DiscordFirstSliceCommandName,
} from '../src/discord/discord-command-registry.js';

const EXPECTED_COMMAND_NAMES: readonly DiscordFirstSliceCommandName[] = [
  'ask',
  'research',
  'evidence',
  'claim',
  'critique',
  'proof',
  'status',
  'cancel',
  'rerun',
  'archive',
  'unarchive',
  'tasks',
  'traits',
  'agenda',
  'history',
  'context',
  'escalate',
  'feed',
  'approve',
  'deny',
  'doctor',
  'subagents',
  'focus',
  'unfocus',
  'auth',
  'config',
  'help',
  'quickstart',
  'follow',
  'insights',
  'research-plan',
];

const EXPECTED_PERMISSION_CLASSES: ReadonlyMap<
  DiscordFirstSliceCommandName,
  DiscordCommandPermissionClass
> = new Map([
  ['ask', 'task-dispatch'],
  ['research', 'task-dispatch'],
  ['evidence', 'research-state-control'],
  ['claim', 'research-state-control'],
  ['critique', 'research-state-control'],
  ['proof', 'admin-readiness-inspection'],
  ['status', 'read-only-inspection'],
  ['cancel', 'owner-admin-task-mutation'],
  ['rerun', 'owner-admin-task-mutation'],
  ['archive', 'owner-admin-task-mutation'],
  ['unarchive', 'owner-admin-task-mutation'],
  ['tasks', 'read-only-inspection'],
  ['traits', 'read-only-discovery'],
  ['agenda', 'research-state-control'],
  ['history', 'read-only-inspection'],
  ['context', 'read-only-inspection'],
  ['escalate', 'operator-escalation-control'],
  ['feed', 'read-only-inspection'],
  ['approve', 'admin-approval-control'],
  ['deny', 'admin-approval-control'],
  ['doctor', 'admin-readiness-inspection'],
  ['subagents', 'admin-service-control'],
  ['focus', 'owner-focus-control'],
  ['unfocus', 'owner-focus-control'],
  ['auth', 'admin-service-control'],
  ['config', 'admin-persona-config'],
  ['help', 'help'],
  ['quickstart', 'help'],
  ['follow', 'read-only-inspection'],
  ['insights', 'read-only-inspection'],
  ['research-plan', 'admin-research-plan'],
]);

const EXPECTED_PERMISSION_CLASS_NAMES = [
  'task-dispatch',
  'owner-admin-task-mutation',
  'read-only-inspection',
  'read-only-discovery',
  'research-state-control',
  'admin-approval-control',
  'admin-service-control',
  'admin-readiness-inspection',
  'admin-persona-config',
  'admin-research-plan',
  'owner-focus-control',
  'operator-escalation-control',
  'help',
] as const satisfies readonly DiscordCommandPermissionClass[];

type ExpectedPermissionClassName =
  (typeof EXPECTED_PERMISSION_CLASS_NAMES)[number];

describe('discord command registry', () => {
  it('exposes every first-slice command exactly once', () => {
    const names = COMMAND_REGISTRY.map((cmd) => cmd.name);
    expect(names).toEqual(expect.arrayContaining([...EXPECTED_COMMAND_NAMES]));
    expect(names).toHaveLength(EXPECTED_COMMAND_NAMES.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('publishes the command-name list via getDiscordFirstSliceCommandNames()', () => {
    expect(getDiscordFirstSliceCommandNames()).toEqual(
      expect.arrayContaining([...EXPECTED_COMMAND_NAMES]),
    );
  });

  it('resolves canonical names through resolveCommand()', () => {
    for (const name of EXPECTED_COMMAND_NAMES) {
      const def = resolveCommand(name);
      expect(def).toBeDefined();
      expect(def?.name).toBe(name);
    }
  });

  it('returns undefined for unknown command names', () => {
    expect(resolveCommand('not-a-command')).toBeUndefined();
  });

  it('isDiscordFirstSliceCommandName narrows known names and rejects others', () => {
    for (const name of EXPECTED_COMMAND_NAMES) {
      expect(isDiscordFirstSliceCommandName(name)).toBe(true);
    }
    expect(isDiscordFirstSliceCommandName('not-a-command')).toBe(false);
    expect(isDiscordFirstSliceCommandName('')).toBe(false);
  });

  it('groups commands by category without losing any entries', () => {
    const grouped = commandsByCategory();
    const flattened = [...grouped.values()].flat();
    expect(flattened).toHaveLength(EXPECTED_COMMAND_NAMES.length);
    expect(grouped.has('task')).toBe(true);
    expect(grouped.has('inspection')).toBe(true);
    expect(grouped.has('control')).toBe(true);
    expect(grouped.has('admin')).toBe(true);
    expect(grouped.has('help')).toBe(true);
    expect(grouped.has('agenda')).toBe(true);
  });

  it('classifies every command with structured permission metadata', () => {
    for (const name of EXPECTED_COMMAND_NAMES) {
      expect(resolveCommand(name)?.permissionClass).toBe(
        EXPECTED_PERMISSION_CLASSES.get(name),
      );
    }

    const grouped = commandsByPermissionClass();
    expect(grouped.get('task-dispatch')?.map((cmd) => cmd.name)).toEqual([
      'ask',
      'research',
    ]);
    expect(
      grouped.get('owner-admin-task-mutation')?.map((cmd) => cmd.name),
    ).toEqual(['cancel', 'rerun', 'archive', 'unarchive']);
    expect(grouped.get('read-only-discovery')?.map((cmd) => cmd.name)).toEqual([
      'traits',
    ]);
    expect(grouped.get('admin-service-control')?.map((cmd) => cmd.name)).toEqual([
      'subagents',
      'auth',
    ]);
    expect(
      grouped.get('operator-escalation-control')?.map((cmd) => cmd.name),
    ).toEqual(['escalate']);
  });

  it('keeps the expected permission class list type-complete with the union', () => {
    expectTypeOf<
      Exclude<DiscordCommandPermissionClass, ExpectedPermissionClassName>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Exclude<ExpectedPermissionClassName, DiscordCommandPermissionClass>
    >().toEqualTypeOf<never>();
  });

  it('partitions the registry exhaustively by permissionClass', () => {
    const grouped = commandsByPermissionClass();
    expect([...grouped.keys()].sort()).toEqual(
      [...EXPECTED_PERMISSION_CLASS_NAMES].sort(),
    );
    for (const permissionClass of EXPECTED_PERMISSION_CLASS_NAMES) {
      expect(grouped.get(permissionClass)?.length, permissionClass).toBeGreaterThan(
        0,
      );
    }

    const flattened = [...grouped.values()].flat().map((cmd) => cmd.name);
    expect(flattened.sort()).toEqual([...EXPECTED_COMMAND_NAMES].sort());
    expect(new Set(flattened).size).toBe(COMMAND_REGISTRY.length);
  });

  it('keeps user-facing description labels aligned with permission metadata', () => {
    for (const name of ['cancel', 'rerun', 'archive', 'unarchive'] as const) {
      expect(resolveCommand(name)?.description).toContain('Owner/admin only');
    }

    for (const name of ['status', 'tasks', 'history', 'context', 'feed', 'insights'] as const) {
      expect(resolveCommand(name)?.description).toContain('Read-only:');
    }

    expect(resolveCommand('traits')?.description).toContain('Read-only:');
    for (const name of ['agenda', 'evidence', 'claim', 'critique'] as const) {
      expect(resolveCommand(name)?.description).toContain('Research state:');
    }
    for (const name of ['approve', 'deny', 'subagents', 'auth'] as const) {
      expect(resolveCommand(name)?.description).toContain('Admin');
    }
    expect(resolveCommand('doctor')?.description).toContain(
      'Admin-only non-mutating',
    );
    expect(resolveCommand('proof')?.description).toContain('Admin-only:');
    for (const name of ['focus', 'unfocus'] as const) {
      expect(resolveCommand(name)?.description).toContain('Owner only:');
    }
    expect(resolveCommand('escalate')?.description).toContain('Discord-only:');
    expect(resolveCommand('help')?.description).toContain('Help:');
  });

  it('keeps slash command descriptions within the Discord API length limit', () => {
    for (const command of COMMAND_REGISTRY) {
      expect(command.description.length, command.name).toBeLessThanOrEqual(100);
    }
  });

  describe('buildDiscordFirstSliceCommands()', () => {
    const commands = buildDiscordFirstSliceCommands();
    const byName = new Map(commands.map((cmd) => [cmd.name, cmd] as const));

    it('emits one Discord command JSON body per registry entry', () => {
      expect(commands).toHaveLength(EXPECTED_COMMAND_NAMES.length);
      for (const name of EXPECTED_COMMAND_NAMES) {
        expect(byName.has(name)).toBe(true);
      }
    });

    it('preserves required vs optional flags from the registry', () => {
      const ask = byName.get('ask');
      expect(ask).toBeDefined();
      expect(ask?.options).toEqual([
        expect.objectContaining({
          name: 'instruction',
          description: 'Instruction to dispatch',
          required: true,
        }),
      ]);

      const research = byName.get('research');
      expect(research?.options).toEqual([
        expect.objectContaining({
          name: 'action',
          required: false,
        }),
        expect.objectContaining({
          name: 'instruction',
          required: false,
        }),
        expect.objectContaining({
          name: 'title',
          required: false,
          max_length: 160,
        }),
        expect.objectContaining({
          name: 'mission_id',
          required: false,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'plan_id',
          required: false,
          max_length: 80,
        }),
      ]);

      const evidence = byName.get('evidence');
      expect(evidence?.options).toEqual([
        expect.objectContaining({
          name: 'action',
          required: true,
        }),
        expect.objectContaining({
          name: 'mission_id',
          required: true,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'summary',
          required: false,
          max_length: 1000,
        }),
        expect.objectContaining({
          name: 'source',
          required: false,
          max_length: 240,
        }),
      ]);

      const claim = byName.get('claim');
      expect(claim?.options).toEqual([
        expect.objectContaining({
          name: 'action',
          required: true,
        }),
        expect.objectContaining({
          name: 'mission_id',
          required: true,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'text',
          required: false,
          max_length: 1000,
        }),
        expect.objectContaining({
          name: 'claim_id',
          required: false,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'evidence_id',
          required: false,
          max_length: 80,
        }),
      ]);

      const critique = byName.get('critique');
      expect(critique?.options).toEqual([
        expect.objectContaining({
          name: 'mission_id',
          required: true,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'lens',
          required: true,
        }),
      ]);

      const proof = byName.get('proof');
      expect(proof?.options).toEqual([
        expect.objectContaining({
          name: 'action',
          required: false,
        }),
        expect.objectContaining({
          name: 'mission_id',
          required: false,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'surface',
          required: false,
        }),
        expect.objectContaining({
          name: 'proof_id',
          required: false,
          max_length: 120,
        }),
        expect.objectContaining({
          name: 'status',
          required: false,
        }),
        expect.objectContaining({
          name: 'artifact_tokens',
          required: false,
          max_length: 300,
        }),
        expect.objectContaining({
          name: 'summary',
          required: false,
          max_length: 240,
        }),
      ]);

      const cancel = byName.get('cancel');
      expect(cancel?.options).toEqual([
        expect.objectContaining({
          name: 'task_id',
          required: true,
        }),
        expect.objectContaining({
          name: 'reason',
          required: false,
        }),
      ]);

      const rerun = byName.get('rerun');
      expect(rerun?.options).toEqual([
        expect.objectContaining({
          name: 'task_id',
          required: true,
        }),
        expect.objectContaining({
          name: 'note',
          required: false,
        }),
      ]);

      const archive = byName.get('archive');
      expect(archive?.options).toEqual([
        expect.objectContaining({
          name: 'task_id',
          required: true,
        }),
        expect.objectContaining({
          name: 'reason',
          required: false,
        }),
      ]);

      const unarchive = byName.get('unarchive');
      expect(unarchive?.options).toEqual([
        expect.objectContaining({
          name: 'task_id',
          required: true,
        }),
        expect.objectContaining({
          name: 'reason',
          required: false,
        }),
      ]);

      const escalate = byName.get('escalate');
      expect(escalate?.options).toEqual([
        expect.objectContaining({
          name: 'task_id',
          required: false,
        }),
        expect.objectContaining({
          name: 'reason',
          required: false,
          max_length: DISCORD_ESCALATION_REASON_MAX_LENGTH,
        }),
      ]);

      const feed = byName.get('feed');
      expect(feed?.options).toEqual([
        expect.objectContaining({
          name: 'since',
          required: false,
        }),
        expect.objectContaining({
          name: 'kind',
          required: false,
        }),
      ]);

      const subagents = byName.get('subagents');
      expect(subagents?.options).toEqual([
        expect.objectContaining({
          name: 'action',
          required: false,
        }),
        expect.objectContaining({
          name: 'mission_id',
          required: false,
          max_length: 80,
        }),
        expect.objectContaining({
          name: 'role',
          required: false,
        }),
        expect.objectContaining({
          name: 'target',
          required: false,
        }),
        expect.objectContaining({
          name: 'text',
          required: false,
          max_length: 1000,
        }),
      ]);
    });

    it('emits choice metadata for choice-bearing options', () => {
      const auth = byName.get('auth');
      const action = (auth?.options ?? []).find(
        (option) => (option as { name: string }).name === 'action',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(action).toBeDefined();
      expect(action?.choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'list', value: 'list' }),
          expect.objectContaining({ name: 'allow user', value: 'allow_user' }),
          expect.objectContaining({ name: 'add admin', value: 'add_admin' }),
        ]),
      );
      const history = byName.get('history');
      const view = (history?.options ?? []).find(
        (option) => (option as { name: string }).name === 'view',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(view).toBeDefined();
      expect(view?.choices).toEqual([
        expect.objectContaining({ name: 'events', value: 'events' }),
        expect.objectContaining({ name: 'talk', value: 'talk' }),
      ]);
      const feed = byName.get('feed');
      const kind = (feed?.options ?? []).find(
        (option) => (option as { name: string }).name === 'kind',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(kind).toBeDefined();
      expect(kind?.choices).toEqual([
        expect.objectContaining({ name: 'all', value: 'all' }),
        expect.objectContaining({ name: 'task', value: 'task' }),
        expect.objectContaining({ name: 'escalation', value: 'escalation' }),
        expect.objectContaining({ name: 'approval', value: 'approval' }),
      ]);
      const research = byName.get('research');
      const researchAction = (research?.options ?? []).find(
        (option) => (option as { name: string }).name === 'action',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(researchAction).toBeDefined();
      expect(researchAction?.choices).toEqual([
        expect.objectContaining({ name: 'new', value: 'new' }),
        expect.objectContaining({ name: 'show', value: 'show' }),
        expect.objectContaining({ name: 'approve', value: 'approve' }),
        expect.objectContaining({ name: 'status', value: 'status' }),
        expect.objectContaining({ name: 'pause', value: 'pause' }),
        expect.objectContaining({ name: 'resume', value: 'resume' }),
        expect.objectContaining({ name: 'complete', value: 'complete' }),
        expect.objectContaining({ name: 'pin', value: 'pin' }),
        expect.objectContaining({ name: 'synthesize', value: 'synthesize' }),
        expect.objectContaining({ name: 'archive', value: 'archive' }),
      ]);
      const evidence = byName.get('evidence');
      const evidenceAction = (evidence?.options ?? []).find(
        (option) => (option as { name: string }).name === 'action',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(evidenceAction?.choices).toEqual([
        expect.objectContaining({ name: 'add', value: 'add' }),
        expect.objectContaining({ name: 'list', value: 'list' }),
      ]);
      const claim = byName.get('claim');
      const claimAction = (claim?.options ?? []).find(
        (option) => (option as { name: string }).name === 'action',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(claimAction?.choices).toEqual([
        expect.objectContaining({ name: 'add', value: 'add' }),
        expect.objectContaining({ name: 'list', value: 'list' }),
        expect.objectContaining({ name: 'support', value: 'support' }),
        expect.objectContaining({ name: 'challenge', value: 'challenge' }),
      ]);
      const critique = byName.get('critique');
      const critiqueLens = (critique?.options ?? []).find(
        (option) => (option as { name: string }).name === 'lens',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(critiqueLens?.choices).toEqual([
        expect.objectContaining({ name: 'methodology', value: 'methodology' }),
        expect.objectContaining({ name: 'evidence', value: 'evidence' }),
        expect.objectContaining({
          name: 'counterargument',
          value: 'counterargument',
        }),
        expect.objectContaining({
          name: 'reproducibility',
          value: 'reproducibility',
        }),
      ]);
      const proof = byName.get('proof');
      const proofAction = (proof?.options ?? []).find(
        (option) => (option as { name: string }).name === 'action',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(proofAction?.choices).toEqual([
        expect.objectContaining({ name: 'status', value: 'status' }),
        expect.objectContaining({ name: 'start', value: 'start' }),
        expect.objectContaining({ name: 'export', value: 'export' }),
        expect.objectContaining({ name: 'capture', value: 'capture' }),
        expect.objectContaining({ name: 'link', value: 'link' }),
      ]);
      const proofSurface = (proof?.options ?? []).find(
        (option) => (option as { name: string }).name === 'surface',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(proofSurface?.choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'discord-service', value: 'discord-service' }),
          expect.objectContaining({
            name: 'durable-task-archive-ux',
            value: 'durable-task-archive-ux',
          }),
        ]),
      );

      const subagents = byName.get('subagents');
      const subagentsAction = (subagents?.options ?? []).find(
        (option) => (option as { name: string }).name === 'action',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(subagentsAction?.choices).toEqual([
        expect.objectContaining({ name: 'list', value: 'list' }),
        expect.objectContaining({ name: 'info', value: 'info' }),
        expect.objectContaining({ name: 'kill', value: 'kill' }),
        expect.objectContaining({ name: 'log', value: 'log' }),
        expect.objectContaining({ name: 'send', value: 'send' }),
        expect.objectContaining({ name: 'steer', value: 'steer' }),
        expect.objectContaining({ name: 'tree', value: 'tree' }),
        expect.objectContaining({ name: 'spawn', value: 'spawn' }),
      ]);
      const subagentsRole = (subagents?.options ?? []).find(
        (option) => (option as { name: string }).name === 'role',
      ) as { choices?: ReadonlyArray<{ name: string; value: string }> } | undefined;
      expect(subagentsRole?.choices).toEqual([
        expect.objectContaining({ name: 'planner', value: 'planner' }),
        expect.objectContaining({ name: 'collector', value: 'collector' }),
        expect.objectContaining({ name: 'experimenter', value: 'experimenter' }),
        expect.objectContaining({ name: 'critic', value: 'critic' }),
        expect.objectContaining({ name: 'synthesizer', value: 'synthesizer' }),
        expect.objectContaining({ name: 'archivist', value: 'archivist' }),
      ]);

      const doctor = byName.get('doctor');
      expect(doctor?.options).toEqual([
        expect.objectContaining({
          name: 'mission_id',
          required: false,
          max_length: 80,
        }),
      ]);
    });

    it('builds option-less commands when the registry omits options', () => {
      const help = byName.get('help');
      expect(help).toBeDefined();
      expect(help?.options ?? []).toHaveLength(0);

      const traits = byName.get('traits');
      expect(traits).toBeDefined();
      expect(traits).toEqual(
        expect.objectContaining({
          description: 'Read-only: list repository TraitModule plugin manifests.',
        }),
      );
      expect(
        ((traits as { readonly options?: readonly unknown[] } | undefined)
          ?.options ?? []),
      ).toHaveLength(0);
    });
  });
});
