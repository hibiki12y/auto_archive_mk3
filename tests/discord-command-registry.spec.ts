import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  buildDiscordFirstSliceCommands,
  commandsByCategory,
  getDiscordFirstSliceCommandNames,
  isDiscordFirstSliceCommandName,
  resolveCommand,
  type DiscordFirstSliceCommandName,
} from '../src/discord/discord-command-registry.js';

const EXPECTED_COMMAND_NAMES: readonly DiscordFirstSliceCommandName[] = [
  'ask',
  'research',
  'status',
  'cancel',
  'tasks',
  'agenda',
  'history',
  'context',
  'approve',
  'deny',
  'doctor',
  'subagents',
  'focus',
  'unfocus',
  'auth',
  'help',
  'insights',
];

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
    });

    it('builds option-less commands when the registry omits options', () => {
      const doctor = byName.get('doctor');
      expect(doctor).toBeDefined();
      expect(doctor?.options ?? []).toHaveLength(0);

      const help = byName.get('help');
      expect(help).toBeDefined();
      expect(help?.options ?? []).toHaveLength(0);
    });
  });
});
