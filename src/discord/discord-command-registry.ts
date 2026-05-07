import {
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

export type DiscordFirstSliceCommandName =
  | 'ask'
  | 'research'
  | 'status'
  | 'cancel'
  | 'rerun'
  | 'archive'
  | 'unarchive'
  | 'tasks'
  | 'traits'
  | 'agenda'
  | 'history'
  | 'context'
  | 'escalate'
  | 'feed'
  | 'approve'
  | 'deny'
  | 'doctor'
  | 'subagents'
  | 'focus'
  | 'unfocus'
  | 'auth'
  | 'config'
  | 'insights'
  | 'help';

export type DiscordCommandCategory =
  | 'task'
  | 'inspection'
  | 'agenda'
  | 'control'
  | 'admin'
  | 'help';

export type DiscordCommandPermissionClass =
  | 'task-dispatch'
  | 'owner-admin-task-mutation'
  | 'read-only-inspection'
  | 'read-only-discovery'
  | 'research-state-control'
  | 'admin-approval-control'
  | 'admin-service-control'
  | 'admin-readiness-inspection'
  | 'admin-persona-config'
  | 'owner-focus-control'
  | 'operator-escalation-control'
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
  readonly maxLength?: number;
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
  readonly permissionClass: DiscordCommandPermissionClass;
  readonly options?: readonly DiscordCommandOptionDef[];
  /**
   * Optional opt-in/opt-out per surface. When unset the command is
   * exposed on every surface (default-permissive). When set, only the
   * listed surfaces expose it.
   */
  readonly surfaceTags?: readonly CommandSurfaceTag[];
}

export const DISCORD_ESCALATION_REASON_MAX_LENGTH = 1000;

export const COMMAND_REGISTRY: readonly DiscordCommandDef[] = [
  {
    name: 'ask',
    description: 'Task dispatch: run a task through the TypeScript core.',
    category: 'task',
    permissionClass: 'task-dispatch',
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
      'Task dispatch: run a research task through the always-on control plane.',
    category: 'task',
    permissionClass: 'task-dispatch',
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
    description: 'Read-only: inspect coarse task status for a tracked Discord task.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
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
    description: 'Owner/admin only: request cancellation for a tracked Discord task.',
    category: 'control',
    permissionClass: 'owner-admin-task-mutation',
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
    name: 'rerun',
    description: 'Owner/admin only: start a fresh task from terminal evidence.',
    category: 'task',
    permissionClass: 'owner-admin-task-mutation',
    options: [
      {
        name: 'task_id',
        description: 'Terminal task identifier to rerun',
        required: true,
      },
      {
        name: 'note',
        description: 'Optional rerun note appended to the original instruction',
        required: false,
      },
    ],
  },
  {
    name: 'tasks',
    description: 'Read-only: list visible active/recent Discord tasks.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
    options: [
      {
        name: 'state',
        description: 'Filter: active, all, accepted, running, terminal, archived',
        required: false,
        choices: [
          { name: 'active', value: 'active' },
          { name: 'all', value: 'all' },
          { name: 'accepted', value: 'accepted' },
          { name: 'running', value: 'running' },
          { name: 'terminal', value: 'terminal' },
          { name: 'archived', value: 'archived' },
        ],
      },
      {
        name: 'limit',
        description: 'Maximum tasks to display',
        required: false,
      },
    ],
  },
  {
    name: 'traits',
    description: 'Read-only: list repository TraitModule plugin manifests.',
    category: 'inspection',
    permissionClass: 'read-only-discovery',
  },
  {
    name: 'archive',
    description: 'Owner/admin only: hide a terminal task from default task lists.',
    category: 'control',
    permissionClass: 'owner-admin-task-mutation',
    options: [
      {
        name: 'task_id',
        description: 'Task identifier returned by /ask or /research',
        required: true,
      },
      {
        name: 'reason',
        description: 'Optional archive reason',
        required: false,
      },
    ],
  },
  {
    name: 'unarchive',
    description: 'Owner/admin only: restore an archived task to default task lists.',
    category: 'control',
    permissionClass: 'owner-admin-task-mutation',
    options: [
      {
        name: 'task_id',
        description: 'Archived task identifier returned by /ask or /research',
        required: true,
      },
      {
        name: 'reason',
        description: 'Optional restore reason',
        required: false,
      },
    ],
  },
  {
    name: 'agenda',
    description: 'Research state: manage persistent agenda and cadence.',
    category: 'agenda',
    permissionClass: 'research-state-control',
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
    description: 'Read-only: show bounded control-plane history.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
    options: [
      {
        name: 'view',
        description: 'History view: events or talk transcript',
        required: false,
        choices: [
          { name: 'events', value: 'events' },
          { name: 'talk', value: 'talk' },
        ],
      },
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
    description: 'Read-only: show the context envelope used for a task.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
    options: [
      {
        name: 'task_id',
        description: 'Task identifier returned by /ask or /research',
        required: true,
      },
    ],
  },
  {
    name: 'escalate',
    description: 'Discord-only: request operator escalation for a task or channel.',
    category: 'control',
    permissionClass: 'operator-escalation-control',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'task_id',
        description: 'Optional task identifier to escalate',
        required: false,
      },
      {
        name: 'reason',
        description: 'Optional escalation reason for the operator',
        required: false,
        maxLength: DISCORD_ESCALATION_REASON_MAX_LENGTH,
      },
    ],
  },
  {
    name: 'feed',
    description: 'Read-only: Discord-only bounded live feed from the control ledger.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'since',
        description: 'Duration to look back, for example 5m or 2h (minimum 1m)',
        required: false,
      },
      {
        name: 'kind',
        description: 'Event kind filter',
        required: false,
        choices: [
          { name: 'all', value: 'all' },
          { name: 'task', value: 'task' },
          { name: 'escalation', value: 'escalation' },
          { name: 'approval', value: 'approval' },
        ],
      },
    ],
  },
  {
    name: 'approve',
    description: 'Admin only: approve a pending runtime approval.',
    category: 'control',
    permissionClass: 'admin-approval-control',
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
    description: 'Admin only: deny a pending runtime approval.',
    category: 'control',
    permissionClass: 'admin-approval-control',
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
    description: 'Admin-only non-mutating: inspect service readiness.',
    category: 'inspection',
    permissionClass: 'admin-readiness-inspection',
  },
  {
    name: 'subagents',
    description: 'Admin only: inspect or steer root-owned subagents.',
    category: 'control',
    permissionClass: 'admin-service-control',
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
      'Owner only: bind this channel/thread to an active task.',
    category: 'control',
    permissionClass: 'owner-focus-control',
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
    description: 'Owner only: release this channel/thread focus binding.',
    category: 'control',
    permissionClass: 'owner-focus-control',
  },
  {
    name: 'auth',
    description: 'Admin only: administer the Discord auth database.',
    category: 'admin',
    permissionClass: 'admin-service-control',
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
    description: 'Read-only: show telemetry snapshot from the control-plane ledger.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
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
    name: 'config',
    description:
      'Admin only: view or override Arona/Plana persona settings (model, effort, etc.).',
    category: 'admin',
    permissionClass: 'admin-persona-config',
    options: [
      {
        name: 'action',
        description: 'Config action',
        required: true,
        choices: [
          { name: 'view', value: 'view' },
          { name: 'set', value: 'set' },
          { name: 'reset', value: 'reset' },
        ],
      },
      {
        name: 'persona',
        description: 'Persona scope: arona or plana (required for set / reset)',
        required: false,
        choices: [
          { name: 'arona', value: 'arona' },
          { name: 'plana', value: 'plana' },
        ],
      },
      {
        name: 'key',
        description: 'Setting key (required for set): provider, model, effort, max_turns',
        required: false,
        choices: [
          { name: 'provider', value: 'provider' },
          { name: 'model', value: 'model' },
          { name: 'effort', value: 'effort' },
          { name: 'max_turns', value: 'max_turns' },
        ],
      },
      {
        name: 'value',
        description: 'Setting value (required for set)',
        required: false,
        maxLength: 80,
      },
    ],
  },
  {
    name: 'help',
    description: 'Help: show how to use the Discord task bot.',
    category: 'help',
    permissionClass: 'help',
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

export function commandsByPermissionClass(): ReadonlyMap<
  DiscordCommandPermissionClass,
  readonly DiscordCommandDef[]
> {
  const grouped = new Map<DiscordCommandPermissionClass, DiscordCommandDef[]>();
  for (const cmd of COMMAND_REGISTRY) {
    const existing = grouped.get(cmd.permissionClass);
    if (existing === undefined) {
      grouped.set(cmd.permissionClass, [cmd]);
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
        if (opt.maxLength !== undefined) {
          option.setMaxLength(opt.maxLength);
        }
        return option;
      });
    }
    return builder.toJSON();
  });
}
