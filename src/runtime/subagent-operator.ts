import type { TerminalCauseRuntimeVeto } from '../contracts/terminal-cause.js';
import type { SubagentDescriptor } from '../contracts/subagent-roster.js';
import { createVetoPath } from '../contracts/veto.js';
import type { SubagentRoster } from './subagent-roster.js';
import type { SubagentRosterRegistry } from './subagent-roster-registry.js';

export type SubagentOperatorAction = 'list' | 'info' | 'kill' | 'log' | 'send' | 'steer';

export type SubagentOperatorResult =
  | { readonly status: 'ok'; readonly message: string; readonly descriptor?: SubagentDescriptor; readonly descriptors?: readonly SubagentDescriptor[] }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'not-found'; readonly reason: string };

export interface SubagentOperatorSurfaceOptions {
  /**
   * Single-roster mode (legacy). Preserved so existing callers and
   * tests that wire one dispatch-scoped roster keep working unchanged.
   * Mutually exclusive with `rosterRegistry`; supplying both falls
   * back to the registry path so the registry sees every active
   * dispatch's roster.
   */
  readonly roster?: SubagentRoster;
  /**
   * P4 Stage 4-2 — registry-aware mode. When supplied, the operator
   * surface enumerates descriptors across every currently-registered
   * dispatch (instead of a single roster). subagentIds are unique
   * across rosters because each dispatch's roster mints its own
   * sequence-keyed identifiers and the registry never re-keys; the
   * operator's `info`/`kill`/`send`/`steer` actions resolve a target
   * by walking every registered roster's snapshot.
   */
  readonly rosterRegistry?: SubagentRosterRegistry;
  readonly maxLogChars?: number;
  /**
   * Hard cap on how many distinct subagentIds the operator surface keeps
   * log buffers for. When `appendLog` would create a (cap+1)-th key the
   * least-recently-touched key is evicted. Defaults to 200, sized for a
   * Discord deployment where the bot is long-lived but a single human
   * is unlikely to keep more than a few dozen subagents in mind at once.
   * The cap protects the bot process from an unbounded log buffer when
   * subagents come and go over the bot's uptime — without it, the
   * `logs` Map grows once per spawn and never shrinks.
   */
  readonly maxLogSubagents?: number;
}

const SECRETISH = /(?:glpat-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+|[A-Za-z0-9+/]{32,}={0,2})/g;

export function redactOperatorText(value: string): string {
  return value.replace(SECRETISH, '[REDACTED_SECRET]');
}

function summarizeDescriptor(descriptor: SubagentDescriptor): string {
  return `${descriptor.subagentId} ${descriptor.role} ${descriptor.state} parent=${descriptor.parent.taskId}/${descriptor.parent.instanceId}`;
}

function abortCauseFor(descriptor: SubagentDescriptor, reason: string): TerminalCauseRuntimeVeto {
  const now = new Date().toISOString();
  return {
    kind: 'runtime-veto',
    taskId: descriptor.parent.taskId,
    runtimeInstanceId: descriptor.parent.instanceId,
    observedAt: now,
    provenance: 'subagent-operator',
    reason,
    veto: createVetoPath('runtime', reason, 'subagent-operator'),
    vetoSource: 'operator',
    cancellation: {
      requestedAt: now,
      cancelMode: 'preemptive',
      cancelDetail: { originPort: 'plana-runtime-review' },
    },
  };
}

const DEFAULT_MAX_LOG_SUBAGENTS = 200;
const MIN_MAX_LOG_SUBAGENTS = 1;

export class SubagentOperatorSurface {
  private readonly logs = new Map<string, string[]>();
  private readonly maxLogChars: number;
  private readonly maxLogSubagents: number;

  constructor(private readonly options: SubagentOperatorSurfaceOptions) {
    if (options.roster === undefined && options.rosterRegistry === undefined) {
      throw new TypeError(
        'SubagentOperatorSurface requires either `roster` or `rosterRegistry`',
      );
    }
    this.maxLogChars = options.maxLogChars ?? 1_500;
    this.maxLogSubagents = Math.max(
      MIN_MAX_LOG_SUBAGENTS,
      Math.floor(options.maxLogSubagents ?? DEFAULT_MAX_LOG_SUBAGENTS),
    );
  }

  list(): SubagentOperatorResult {
    const descriptors = this.snapshotAllDescriptors();
    if (descriptors.length === 0 && this.options.rosterRegistry !== undefined) {
      // Registry-aware empty state: distinguish "no active dispatches"
      // from the legacy single-roster "no subagents" message so
      // operators see which case they hit. The bot is configured (the
      // operator surface was wired) — there just isn't any work in
      // flight.
      const registrationCount = this.options.rosterRegistry.list().length;
      if (registrationCount === 0) {
        return {
          status: 'ok',
          descriptors,
          message: 'No active subagent dispatches.',
        };
      }
      return {
        status: 'ok',
        descriptors,
        message: `No subagents in ${registrationCount} active dispatch${registrationCount === 1 ? '' : 'es'}.`,
      };
    }
    return {
      status: 'ok',
      descriptors,
      message:
        descriptors.length === 0
          ? 'No subagents are currently tracked.'
          : descriptors.map(summarizeDescriptor).join('\n'),
    };
  }

  info(subagentId: string): SubagentOperatorResult {
    const descriptor = this.find(subagentId);
    if (descriptor === undefined) {
      return { status: 'not-found', reason: `Unknown subagent: ${subagentId}` };
    }
    return {
      status: 'ok',
      descriptor,
      message: summarizeDescriptor(descriptor),
    };
  }

  async kill(subagentId: string, reason = 'operator kill requested'): Promise<SubagentOperatorResult> {
    const descriptor = this.find(subagentId);
    if (descriptor === undefined) {
      return { status: 'not-found', reason: `Unknown subagent: ${subagentId}` };
    }
    if (descriptor.state !== 'active') {
      return { status: 'denied', reason: `Subagent ${subagentId} is not active.` };
    }
    const owningRoster = this.findOwningRoster(subagentId);
    if (owningRoster === undefined) {
      return { status: 'not-found', reason: `Unknown subagent: ${subagentId}` };
    }
    await owningRoster.terminate(subagentId, abortCauseFor(descriptor, reason));
    this.appendLog(subagentId, `killed: ${reason}`);
    return { status: 'ok', descriptor: this.find(subagentId), message: `Subagent ${subagentId} killed.` };
  }

  log(subagentId: string): SubagentOperatorResult {
    if (this.find(subagentId) === undefined) {
      return { status: 'not-found', reason: `Unknown subagent: ${subagentId}` };
    }
    const text = (this.logs.get(subagentId) ?? []).join('\n');
    return {
      status: 'ok',
      message: text.length === 0 ? '(no bounded operator log entries)' : text.slice(-this.maxLogChars),
    };
  }

  send(subagentId: string, message: string): SubagentOperatorResult {
    return this.sendLike('send', subagentId, message);
  }

  steer(subagentId: string, instruction: string): SubagentOperatorResult {
    return this.sendLike('steer', subagentId, instruction);
  }

  announceCompletion(input: {
    readonly subagentId: string;
    readonly role: string;
    readonly status: string;
    readonly summary: string;
    readonly artifactRef?: string;
    readonly resourceSummary?: string;
  }): string {
    return [
      `Subagent ${input.subagentId} completed`,
      `Role: ${input.role}`,
      `Status: ${input.status}`,
      `Summary: ${redactOperatorText(input.summary).slice(0, 300)}`,
      input.artifactRef === undefined ? undefined : `Artifact: ${redactOperatorText(input.artifactRef)}`,
      input.resourceSummary === undefined
        ? undefined
        : `Resources: ${redactOperatorText(input.resourceSummary).slice(0, 160)}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }

  private sendLike(action: 'send' | 'steer', subagentId: string, text: string): SubagentOperatorResult {
    const descriptor = this.find(subagentId);
    if (descriptor === undefined) {
      return { status: 'not-found', reason: `Unknown subagent: ${subagentId}` };
    }
    if (descriptor.state !== 'active') {
      return { status: 'denied', reason: `Subagent ${subagentId} is not active.` };
    }
    this.appendLog(subagentId, `${action}: ${text}`);
    return { status: 'ok', descriptor, message: `${action} accepted for ${subagentId}.` };
  }

  private appendLog(subagentId: string, text: string): void {
    const existing = this.logs.get(subagentId) ?? [];
    existing.push(`${new Date().toISOString()} ${redactOperatorText(text).slice(0, this.maxLogChars)}`);
    // Touch the key (delete-then-set) so Map's insertion order tracks
    // recency: the oldest entry is at the front of the iteration, ready
    // to be evicted when the cap is exceeded. Without this re-insert,
    // a long-running active subagent could be evicted before a stale
    // one that hasn't been logged in days.
    this.logs.delete(subagentId);
    this.logs.set(subagentId, existing.slice(-50));
    while (this.logs.size > this.maxLogSubagents) {
      const oldest = this.logs.keys().next();
      if (oldest.done === true) break;
      this.logs.delete(oldest.value);
    }
  }

  private find(subagentId: string): SubagentDescriptor | undefined {
    return this.snapshotAllDescriptors().find(
      (descriptor) => descriptor.subagentId === subagentId,
    );
  }

  /**
   * P4 Stage 4-2 — registry-aware descriptor walk. In single-roster
   * mode this returns the lone roster's snapshot (legacy behavior);
   * in registry mode it concatenates every registered roster's
   * snapshot. Per-roster `snapshot()` calls are wrapped in try/catch
   * so a broken roster cannot break the operator surface.
   */
  private snapshotAllDescriptors(): readonly SubagentDescriptor[] {
    const registry = this.options.rosterRegistry;
    if (registry !== undefined) {
      const all: SubagentDescriptor[] = [];
      for (const registration of registry.list()) {
        try {
          for (const descriptor of registration.roster.snapshot()) {
            all.push(descriptor);
          }
        } catch {
          // Roster snapshot threw; skip this dispatch silently. The
          // registry's own warn line already fired at register-time
          // diagnostics; the operator surface must never throw to
          // the Discord interaction layer.
        }
      }
      return all;
    }
    return this.options.roster?.snapshot() ?? [];
  }

  /**
   * P4 Stage 4-2 — locate the roster that owns a given subagentId.
   * Used by `kill(...)` to terminate the descriptor on its own
   * roster instead of guessing. In single-roster mode this is the
   * configured roster; in registry mode it is the first registered
   * roster whose snapshot contains the subagentId.
   */
  private findOwningRoster(subagentId: string): SubagentRoster | undefined {
    const registry = this.options.rosterRegistry;
    if (registry !== undefined) {
      for (const registration of registry.list()) {
        try {
          if (
            registration.roster
              .snapshot()
              .some((descriptor) => descriptor.subagentId === subagentId)
          ) {
            return registration.roster;
          }
        } catch {
          // Skip broken roster.
        }
      }
      return undefined;
    }
    return this.options.roster;
  }
}
