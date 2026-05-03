/**
 * M10 Stage 3 — ACP slash command advertiser.
 *
 * Adapts the Discord COMMAND_REGISTRY (M1, single source of truth)
 * to the ACP `AvailableCommand` shape so the IDE can render slash
 * commands native to its UI without us maintaining two registries.
 *
 * Two pieces:
 *
 *   - `buildAvailableCommands()` — pure mapping from
 *     `COMMAND_REGISTRY` to a list of `AvailableCommand`. Filters out
 *     commands that opt out of the ACP surface via
 *     `surfaceTags: ['discord']` (etc.).
 *   - `notifyAvailableCommands(connection, sessionId, commands?)` —
 *     emits a single `available_commands_update` `sessionUpdate`
 *     notification for the given session. Caller decides when (e.g.,
 *     once at session start, or whenever the registry changes).
 *
 * The actual `commandIntercept` hook fire (M5b) happens at the
 * dispatcher integration point — when a slash command name is parsed
 * out of an ACP prompt and forwarded to the dispatcher. Stage 3 only
 * advertises the surface; Stage 3 also lays the groundwork by
 * wrapping the command lookup function the integration will use.
 */

import type {
  AgentSideConnection,
  AvailableCommand,
} from '@agentclientprotocol/sdk';

import {
  COMMAND_REGISTRY,
  commandIsExposedOn,
  type DiscordCommandDef,
} from '../discord/discord-command-registry.js';

/**
 * Map a single command def to its ACP `AvailableCommand` envelope.
 *
 * Note: ACP's `AvailableCommand.input` is currently a single optional
 * structured input descriptor; our Discord registry permits multiple
 * options. Stage 3 adopts a simple convention: if the command has
 * exactly one required option, surface it as the ACP input. Otherwise
 * we drop the input shape — the IDE is free to prompt the user for
 * arguments via a generic text field. Stage 5 polish may refine this
 * mapping after dogfood.
 */
export function commandDefToAvailable(
  cmd: DiscordCommandDef,
): AvailableCommand {
  const requiredOptions = (cmd.options ?? []).filter((opt) => opt.required);
  const envelope: AvailableCommand = {
    name: cmd.name,
    description: cmd.description,
  };
  if (requiredOptions.length === 1) {
    return {
      ...envelope,
      input: {
        hint: requiredOptions[0].description,
      },
    };
  }
  return envelope;
}

/**
 * Build the `availableCommands` list for the ACP surface.
 *
 * Filters out commands tagged exclusively for non-ACP surfaces and
 * preserves registry order so the IDE renders them deterministically.
 */
export function buildAvailableCommands(): readonly AvailableCommand[] {
  return COMMAND_REGISTRY.filter((cmd) =>
    commandIsExposedOn(cmd, 'acp'),
  ).map(commandDefToAvailable);
}

/**
 * Emit a single `available_commands_update` sessionUpdate. Awaiting
 * the returned promise propagates ACP wire backpressure to callers.
 *
 * Defensive: any thrown error is swallowed — a notification failure
 * must not abort a prompt turn. Callers that need to know about
 * failures should pass through their own logger via the `onError`
 * option.
 */
export async function notifyAvailableCommands(
  connection: Pick<AgentSideConnection, 'sessionUpdate'>,
  sessionId: string,
  options: {
    readonly commands?: readonly AvailableCommand[];
    readonly onError?: (err: unknown) => void;
  } = {},
): Promise<void> {
  const commands = options.commands ?? buildAvailableCommands();
  try {
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [...commands],
      },
    });
  } catch (err) {
    options.onError?.(err);
  }
}
