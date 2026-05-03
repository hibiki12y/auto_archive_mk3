import {
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

export type DiscordFirstSliceCommandName =
  | 'ask'
  | 'research'
  | 'status'
  | 'cancel'
  | 'tasks'
  | 'agenda'
  | 'history'
  | 'context'
  | 'approve'
  | 'deny'
  | 'doctor'
  | 'subagents'
  | 'focus'
  | 'unfocus'
  | 'auth'
  | 'insights'
  | 'help';

export type DiscordCommandCategory =
  | 'task'
  | 'inspection'
  | 'agenda'
  | 'control'
  | 'admin'
  | 'help';

export interface DiscordCommandOptionChoice {
  readonly name: string;
  readonly value: string;
}

export interface DiscordCommandOptionDef {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly choices?: readonly DiscordCommandOptionChoice[];
}

/**
 * The surfaces on which a command is exposable. When omitted the
 * command is treated as available on EVERY surface (the
 * default-permissive case used for the original Discord-first
 * commands). M10 stage 3 adds the `'acp'` value so individual
 * commands can opt out of the IDE surface where the semantics don't
 * carry over (e.g. Discord-only auth admin) without breaking
 * existing behavior.
 */
export type CommandSurfaceTag = 'discord' | 'acp';

export interface DiscordCommandDef {
  readonly name: DiscordFirstSliceCommandName;
  readonly description: string;
  readonly category: DiscordCommandCategory;
  readonly options?: readonly DiscordCommandOptionDef[];
  /**
   * Optional opt-in/opt-out per surface. When unset the command is
   * exposed on every surface (default-permissive). When set, only the
   * listed surfaces expose it.
   */
  readonly surfaceTags?: readonly CommandSurfaceTag[];
}

export const COMMAND_REGISTRY: readonly DiscordCommandDef[] = [
  {
    name: 'ask',
    description: 'Dispatch a task through the TypeScript core.',
    category: 'task',
    options: [
      {
        name: 'instruction',
        description: 'Instruction to dispatch',
        required: true,
      },
    ],
  },
  {
    name: 'research',
    description:
      'Dispatch a research task through the always-on control plane.',
    category: 'task',
    options: [
      {
        name: 'instruction',
        description: 'Research instruction to dispatch',
        required: true,
      },
    ],
  },
  {
    name: 'status',
    description: 'Inspect coarse task status for a tracked Discord task.',
    category: 'inspection',
    options: [
      {
        name: 'task_id',
        description: 'Task identifier returned by /ask',
        required: true,
      },
    ],
  },
  {
    name: 'cancel',
    description: 'Request cancellation for a tracked Discord task.',
    category: 'control',
    options: [
      {
        name: 'task_id',
        description: 'Task identifier returned by /ask',
        required: true,
      },
      {
        name: 'reason',
        description: 'Optional cancellation reason',
        required: false,
      },
    ],
  },
  {
    name: 'tasks',
    description: 'List visible active and recent Discord tasks.',
    category: 'inspection',
    options: [
      {
        name: 'state',
        description: 'Filter: active, all, accepted, running, terminal',
        required: false,
      },
      {
        name: 'limit',
        description: 'Maximum tasks to display',
        required: false,
      },
    ],
  },
  {
    name: 'agenda',
    description: 'Manage persistent research agenda and cadence.',
    category: 'agenda',
    options: [
      {
        name: 'action',
        description: 'Agenda action',
        required: false,
        choices: [
          { name: 'list', value: 'list' },
          { name: 'add', value: 'add' },
          { name: 'done', value: 'done' },
          { name: 'cadence', value: 'cadence' },
        ],
      },
      {
        name: 'text',
        description: 'Agenda title or cadence text',
        required: false,
      },
      {
        name: 'item_id',
        description: 'Research agenda item id',
        required: false,
      },
      {
        name: 'status',
        description: 'Filter: open, done, all',
        required: false,
      },
      {
        name: 'limit',
        description: 'Maximum agenda items to display',
        required: false,
      },
    ],
  },
  {
    name: 'history',
    description: 'Show bounded control-plane history.',
    category: 'inspection',
    options: [
      {
        name: 'task_id',
        description: 'Optional task identifier',
        required: false,
      },
      {
        name: 'limit',
        description: 'Maximum events to display',
        required: false,
      },
    ],
  },
  {
    name: 'context',
    description: 'Show the context envelope used for a task.',
    category: 'inspection',
    options: [
      {
        name: 'task_id',
        description: 'Task identifier returned by /ask or /research',
        required: true,
      },
    ],
  },
  {
    name: 'approve',
    description: 'Approve a pending Discord-exposed runtime approval.',
    category: 'control',
    options: [
      {
        name: 'approval_id',
        description: 'Approval identifier',
        required: true,
      },
      {
        name: 'note',
        description: 'Optional approval note',
        required: false,
      },
    ],
  },
  {
    name: 'deny',
    description: 'Deny a pending Discord-exposed runtime approval.',
    category: 'control',
    options: [
      {
        name: 'approval_id',
        description: 'Approval identifier',
        required: true,
      },
      {
        name: 'reason',
        description: 'Denial reason',
        required: false,
      },
    ],
  },
  {
    name: 'doctor',
    description: 'Inspect Discord research service readiness.',
    category: 'inspection',
  },
  {
    name: 'subagents',
    description: 'Inspect or steer root-owned depth-1 subagents.',
    category: 'control',
    options: [
      {
        name: 'action',
        description: 'Action: list, info, kill, log, send, steer',
        required: false,
        choices: [
          { name: 'list', value: 'list' },
          { name: 'info', value: 'info' },
          { name: 'kill', value: 'kill' },
          { name: 'log', value: 'log' },
          { name: 'send', value: 'send' },
          { name: 'steer', value: 'steer' },
        ],
      },
      {
        name: 'target',
        description: 'Subagent id for target-specific actions',
        required: false,
      },
      {
        name: 'text',
        description: 'Message, steering instruction, or kill reason',
        required: false,
      },
    ],
  },
  {
    name: 'focus',
    description:
      'Bind this channel/thread to a task for follow-up steering.',
    category: 'control',
    options: [
      {
        name: 'task_id',
        description: 'Task identifier to focus',
        required: true,
      },
    ],
  },
  {
    name: 'unfocus',
    description: 'Release this channel/thread focus binding.',
    category: 'control',
  },
  {
    name: 'auth',
    description: 'Administer the Discord auth database.',
    category: 'admin',
    options: [
      {
        name: 'action',
        description: 'Auth action',
        required: true,
        choices: [
          { name: 'list', value: 'list' },
          { name: 'allow user', value: 'allow_user' },
          { name: 'revoke user', value: 'revoke_user' },
          { name: 'allow channel', value: 'allow_channel' },
          { name: 'revoke channel', value: 'revoke_channel' },
          { name: 'allow guild', value: 'allow_guild' },
          { name: 'revoke guild', value: 'revoke_guild' },
          { name: 'add admin', value: 'add_admin' },
          { name: 'remove admin', value: 'remove_admin' },
        ],
      },
      {
        name: 'subject_id',
        description: 'Discord user, channel, or guild id for mutation actions',
        required: false,
      },
    ],
  },
  {
    name: 'insights',
    description: 'Show operational telemetry snapshot from the control-plane ledger.',
    category: 'inspection',
    options: [
      {
        name: 'period',
        description: 'Time window: 1d, 7d, 30d, or all (default: 7d)',
        required: false,
        choices: [
          { name: '1 day', value: '1d' },
          { name: '7 days', value: '7d' },
          { name: '30 days', value: '30d' },
          { name: 'all time', value: 'all' },
        ],
      },
    ],
  },
  {
    name: 'help',
    description: 'Show how to use the Discord task bot.',
    category: 'help',
  },
];

const COMMAND_LOOKUP: ReadonlyMap<string, DiscordCommandDef> = new Map(
  COMMAND_REGISTRY.map((cmd) => [cmd.name, cmd] as const),
);

const COMMAND_NAMES: readonly DiscordFirstSliceCommandName[] =
  COMMAND_REGISTRY.map((cmd) => cmd.name);

const COMMAND_NAME_SET: ReadonlySet<DiscordFirstSliceCommandName> = new Set(
  COMMAND_NAMES,
);

export function resolveCommand(name: string): DiscordCommandDef | undefined {
  return COMMAND_LOOKUP.get(name);
}

export function getDiscordFirstSliceCommandNames(): readonly DiscordFirstSliceCommandName[] {
  return COMMAND_NAMES;
}

export function isDiscordFirstSliceCommandName(
  value: string,
): value is DiscordFirstSliceCommandName {
  return COMMAND_NAME_SET.has(value as DiscordFirstSliceCommandName);
}

/**
 * Returns true when `cmd` should be exposed on `surface`. Empty
 * `surfaceTags` is interpreted as "every surface" (default-permissive).
 */
export function commandIsExposedOn(
  cmd: DiscordCommandDef,
  surface: CommandSurfaceTag,
): boolean {
  if (cmd.surfaceTags === undefined) {
    return true;
  }
  return cmd.surfaceTags.includes(surface);
}

export function commandsByCategory(): ReadonlyMap<
  DiscordCommandCategory,
  readonly DiscordCommandDef[]
> {
  const grouped = new Map<DiscordCommandCategory, DiscordCommandDef[]>();
  for (const cmd of COMMAND_REGISTRY) {
    const existing = grouped.get(cmd.category);
    if (existing === undefined) {
      grouped.set(cmd.category, [cmd]);
    } else {
      existing.push(cmd);
    }
  }
  return grouped;
}

export function buildDiscordFirstSliceCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return COMMAND_REGISTRY.map((cmd) => {
    const builder = new SlashCommandBuilder()
      .setName(cmd.name)
      .setDescription(cmd.description);
    for (const opt of cmd.options ?? []) {
      builder.addStringOption((option) => {
        option
          .setName(opt.name)
          .setDescription(opt.description)
          .setRequired(opt.required);
        if (opt.choices !== undefined && opt.choices.length > 0) {
          option.addChoices(
            ...opt.choices.map((choice) => ({
              name: choice.name,
              value: choice.value,
            })),
          );
        }
        return option;
      });
    }
    return builder.toJSON();
  });
}
