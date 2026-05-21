import {
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

import { LIVE_PROOF_SURFACES } from '../core/live-proof-report-cli.js';

export type DiscordFirstSliceCommandName =
  | 'ask'
  | 'research'
  | 'evidence'
  | 'claim'
  | 'critique'
  | 'proof'
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
  | 'research-plan'
  | 'help'
  | 'quickstart'
  | 'follow';

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
  | 'admin-research-plan'
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
      'Research mission MVP: create/show/approve/pause/resume/complete/pin/archive or dispatch.',
    category: 'task',
    permissionClass: 'task-dispatch',
    options: [
      {
        name: 'action',
        description:
          'Mission action: new, show, approve, status, pause, resume, complete, pin, synthesize, archive',
        required: false,
        choices: [
          { name: 'new', value: 'new' },
          { name: 'show', value: 'show' },
          { name: 'approve', value: 'approve' },
          { name: 'status', value: 'status' },
          { name: 'pause', value: 'pause' },
          { name: 'resume', value: 'resume' },
          { name: 'complete', value: 'complete' },
          { name: 'pin', value: 'pin' },
          { name: 'synthesize', value: 'synthesize' },
          { name: 'archive', value: 'archive' },
        ],
      },
      {
        name: 'instruction',
        description: 'Research instruction or mission goal',
        required: false,
      },
      {
        name: 'title',
        description: 'Optional mission title for action:new',
        required: false,
        maxLength: 160,
      },
      {
        name: 'mission_id',
        description:
          'Mission id for show, approve, status, pause, resume, complete, pin, synthesize, or archive',
        required: false,
        maxLength: 80,
      },
      {
        name: 'plan_id',
        description: 'Existing research-plan id for action:approve',
        required: false,
        maxLength: 80,
      },
    ],
  },
  {
    name: 'evidence',
    description: 'Research state: add or list mission evidence items.',
    category: 'agenda',
    permissionClass: 'research-state-control',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'action',
        description: 'Evidence action: add or list',
        required: true,
        choices: [
          { name: 'add', value: 'add' },
          { name: 'list', value: 'list' },
        ],
      },
      {
        name: 'mission_id',
        description: 'Research mission id',
        required: true,
        maxLength: 80,
      },
      {
        name: 'summary',
        description: 'Evidence summary for action:add',
        required: false,
        maxLength: 1000,
      },
      {
        name: 'source',
        description: 'Evidence source, artifact, URL, or note',
        required: false,
        maxLength: 240,
      },
    ],
  },
  {
    name: 'claim',
    description: 'Research state: add, list, support, or challenge mission claims.',
    category: 'agenda',
    permissionClass: 'research-state-control',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'action',
        description: 'Claim action: add, list, support, or challenge',
        required: true,
        choices: [
          { name: 'add', value: 'add' },
          { name: 'list', value: 'list' },
          { name: 'support', value: 'support' },
          { name: 'challenge', value: 'challenge' },
        ],
      },
      {
        name: 'mission_id',
        description: 'Research mission id',
        required: true,
        maxLength: 80,
      },
      {
        name: 'text',
        description: 'Claim text for action:add',
        required: false,
        maxLength: 1000,
      },
      {
        name: 'claim_id',
        description: 'Claim id for support/challenge',
        required: false,
        maxLength: 80,
      },
      {
        name: 'evidence_id',
        description: 'Evidence id for support/challenge',
        required: false,
        maxLength: 80,
      },
    ],
  },
  {
    name: 'critique',
    description:
      'Research state: critique preflight or metadata-only constraint report.',
    category: 'agenda',
    permissionClass: 'research-state-control',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'mission_id',
        description: 'Research mission id',
        required: true,
        maxLength: 80,
      },
      {
        name: 'lens',
        description: 'Critique lens to prepare',
        required: true,
        choices: [
          { name: 'methodology', value: 'methodology' },
          { name: 'evidence', value: 'evidence' },
          { name: 'counterargument', value: 'counterargument' },
          { name: 'reproducibility', value: 'reproducibility' },
        ],
      },
      {
        name: 'action',
        description: 'Critique action: preflight or record',
        required: false,
        choices: [
          { name: 'preflight', value: 'preflight' },
          { name: 'record', value: 'record' },
        ],
      },
      {
        name: 'claim_id',
        description:
          'Optional claim id for action:record; omitted records mission-level constraints',
        required: false,
        maxLength: 80,
      },
    ],
  },
  {
    name: 'proof',
    description:
      'Admin-only: inspect, start, export, prepare capture, or link proof metadata.',
    category: 'inspection',
    permissionClass: 'admin-readiness-inspection',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'action',
        description: 'Proof action: status, start, export, capture, or link',
        required: false,
        choices: [
          { name: 'status', value: 'status' },
          { name: 'start', value: 'start' },
          { name: 'export', value: 'export' },
          { name: 'capture', value: 'capture' },
          { name: 'link', value: 'link' },
        ],
      },
      {
        name: 'mission_id',
        description: 'Research mission id for mission-local proof status/link context',
        required: false,
        maxLength: 80,
      },
      {
        name: 'surface',
        description: 'Live-proof matrix surface for action:start/export/capture/link',
        required: false,
        choices: LIVE_PROOF_SURFACES.map((surface) => ({
          name: surface,
          value: surface,
        })),
      },
      {
        name: 'proof_id',
        description: 'Operator-owned proof id for action:link',
        required: false,
        maxLength: 120,
      },
      {
        name: 'status',
        description: 'Operator-scored proof status for action:link',
        required: false,
        choices: [
          { name: 'pass', value: 'pass' },
          { name: 'warn', value: 'warn' },
          { name: 'fail', value: 'fail' },
        ],
      },
      {
        name: 'artifact_tokens',
        description: 'Comma-separated redacted artifact tokens for action:link',
        required: false,
        maxLength: 300,
      },
      {
        name: 'summary',
        description: 'Short redacted operator summary for action:link',
        required: false,
        maxLength: 240,
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
    description: 'Admin-only non-mutating: inspect service or mission readiness.',
    category: 'inspection',
    permissionClass: 'admin-readiness-inspection',
    options: [
      {
        name: 'mission_id',
        description: 'Optional research mission id for mission-scoped diagnostics',
        required: false,
        maxLength: 80,
      },
    ],
  },
  {
    name: 'subagents',
    description:
      'Admin only: inspect/steer root-owned subagents or preview research role spawn.',
    category: 'control',
    permissionClass: 'admin-service-control',
    options: [
      {
        name: 'action',
        description: 'Action: list, info, kill, log, send, steer, tree, spawn',
        required: false,
        choices: [
          { name: 'list', value: 'list' },
          { name: 'info', value: 'info' },
          { name: 'kill', value: 'kill' },
          { name: 'log', value: 'log' },
          { name: 'send', value: 'send' },
          { name: 'steer', value: 'steer' },
          { name: 'tree', value: 'tree' },
          { name: 'spawn', value: 'spawn' },
        ],
      },
      {
        name: 'mission_id',
        description: 'Research mission id for action:tree or action:spawn',
        required: false,
        maxLength: 80,
      },
      {
        name: 'role',
        description: 'Research role for action:spawn',
        required: false,
        choices: [
          { name: 'planner', value: 'planner' },
          { name: 'collector', value: 'collector' },
          { name: 'experimenter', value: 'experimenter' },
          { name: 'critic', value: 'critic' },
          { name: 'synthesizer', value: 'synthesizer' },
          { name: 'archivist', value: 'archivist' },
        ],
      },
      {
        name: 'target',
        description: 'Subagent id for target-specific actions',
        required: false,
      },
      {
        name: 'text',
        description: 'Message, steering instruction, kill reason, or spawn task',
        required: false,
        maxLength: 1000,
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
    name: 'research-plan',
    description:
      'Admin: dispatch a decomposed research plan (sequential sub-tasks + synthesis).',
    category: 'admin',
    permissionClass: 'admin-research-plan',
    options: [
      {
        name: 'plan-id',
        description: 'Plan id (filename without .json) under runtime-state/research-plans/.',
        required: true,
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
  {
    name: 'quickstart',
    description:
      'Help: onboarding card with recent tasks + the most useful commands.',
    category: 'help',
    permissionClass: 'help',
  },
  {
    name: 'follow',
    description:
      'Read-only: live tail one task — posts new control-plane events here as they land.',
    category: 'inspection',
    permissionClass: 'read-only-inspection',
    surfaceTags: ['discord'],
    options: [
      {
        name: 'task_id',
        description: 'Task identifier to follow',
        required: true,
      },
    ],
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
