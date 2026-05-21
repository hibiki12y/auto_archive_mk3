import type {
  ControlPlaneEvent,
  ControlPlaneLedgerPort,
} from '../control/control-plane-ledger.js';
import type { DiscordMessagePayload } from './discord-result-renderer.js';

/**
 * UX-15 (cycle 7): a single-task live tail of the control-plane
 * ledger, surfaced to Discord operators through `/follow task_id:<id>`.
 *
 * The controller is transport-agnostic: the bot wires a real
 * `setInterval` scheduler + a per-channel `followUp` delivery port,
 * and tests pass a fake clock + scheduler so they can step `tick(...)`
 * directly without real timers.
 *
 * Lifecycle:
 *   1. `start({taskId, userId, deliver, sinceTimestamp})` registers a
 *      subscription. Per-user cap and per-task de-duplication are
 *      enforced.
 *   2. The scheduler invokes `tick(taskId)` every `pollIntervalMs`.
 *   3. `tick(...)` calls `ledger.loadSince(...)`, filters by taskId,
 *      and posts a one-line per-event summary via the deliver port.
 *   4. On a `task.terminal` event the subscription unsubscribes
 *      itself and posts a final humanized line via `humanizeFinalLine`.
 *   5. If `idleTimeoutMs` elapses without any new event, the
 *      subscription unsubscribes itself and posts an idle-stop line.
 *
 * Resource invariants:
 *   - Every subscription holds at most one scheduler handle. `stop(...)`
 *     calls `handle.clear()` then deletes the map entry.
 *   - `subscriptions` is keyed by taskId, so the same taskId cannot be
 *     followed twice in parallel by the same controller (the slot is
 *     idempotent — `start(...)` returns `'already-following'` on a
 *     duplicate). One Discord operator can still have several follows
 *     for distinct task ids, capped at `perUserCap`.
 *   - `deliver(...)` errors are swallowed and counted; the subscription
 *     stays alive so a transient Discord 5xx does not silently drop
 *     the live tail.
 */

export interface DiscordFollowDeliverPort {
  followUp(payload: DiscordMessagePayload): Promise<unknown>;
}

export interface DiscordFollowSchedulerHandle {
  clear(): void;
}

export interface DiscordFollowSchedulerPort {
  setInterval(
    callback: () => void | Promise<void>,
    ms: number,
  ): DiscordFollowSchedulerHandle;
  now(): number;
}

export interface DiscordFollowControllerOptions {
  readonly ledger: ControlPlaneLedgerPort;
  /**
   * Defaults to real `setInterval` + `Date.now()`. Tests inject a fake
   * scheduler that records the callback so they can step it manually.
   */
  readonly scheduler?: DiscordFollowSchedulerPort;
  /**
   * Default 5 000 ms. Tests usually pass 1 to keep the wired interval
   * trivially small; the fake scheduler does not actually fire it.
   */
  readonly pollIntervalMs?: number;
  /**
   * Default 30 * 60 * 1000 ms. After this many ms with no new events
   * the subscription posts an idle-stop and unregisters.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Default 3. The same userId cannot have more than this many active
   * follows at once.
   */
  readonly perUserCap?: number;
  /**
   * Default 50. `loadSince(...)` is called with this limit so a flurry
   * of events does not dump 1 000 lines into Discord.
   */
  readonly perTickEventLimit?: number;
}

export interface DiscordFollowStartInput {
  readonly taskId: string;
  readonly userId: string;
  readonly deliver: DiscordFollowDeliverPort;
  /**
   * ISO-8601 timestamp. Events strictly older than this are skipped;
   * defaults to `scheduler.now()` so the follow only sees events that
   * land after the operator subscribes (no replay of the entire ledger).
   */
  readonly sinceTimestamp?: string;
}

export type DiscordFollowStartResult =
  | { readonly status: 'started' }
  | { readonly status: 'already-following' }
  | { readonly status: 'cap-reached'; readonly cap: number };

export interface DiscordFollowSubscriptionSnapshot {
  readonly taskId: string;
  readonly userId: string;
  readonly startedAtMs: number;
  readonly lastEventTimestamp: string;
  readonly lastDeliveredAtMs: number;
  readonly deliveredEventCount: number;
  readonly deliverErrorCount: number;
}

interface FollowSubscription {
  readonly taskId: string;
  readonly userId: string;
  readonly deliver: DiscordFollowDeliverPort;
  readonly handle: DiscordFollowSchedulerHandle;
  readonly startedAtMs: number;
  lastEventTimestamp: string;
  lastDeliveredAtMs: number;
  deliveredEventCount: number;
  deliverErrorCount: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_PER_USER_CAP = 3;
const DEFAULT_PER_TICK_EVENT_LIMIT = 50;

const REAL_SCHEDULER: DiscordFollowSchedulerPort = {
  setInterval: (callback, ms) => {
    const id = setInterval(() => {
      void callback();
    }, ms);
    return {
      clear: () => {
        clearInterval(id);
      },
    };
  },
  now: () => Date.now(),
};

export class DiscordFollowController {
  private readonly subscriptions = new Map<string, FollowSubscription>();
  private readonly ledger: ControlPlaneLedgerPort;
  private readonly scheduler: DiscordFollowSchedulerPort;
  private readonly pollIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private readonly perUserCap: number;
  private readonly perTickEventLimit: number;

  constructor(options: DiscordFollowControllerOptions) {
    this.ledger = options.ledger;
    this.scheduler = options.scheduler ?? REAL_SCHEDULER;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.perUserCap = options.perUserCap ?? DEFAULT_PER_USER_CAP;
    this.perTickEventLimit =
      options.perTickEventLimit ?? DEFAULT_PER_TICK_EVENT_LIMIT;
  }

  start(input: DiscordFollowStartInput): DiscordFollowStartResult {
    if (this.subscriptions.has(input.taskId)) {
      return { status: 'already-following' };
    }
    const userOpenCount = [...this.subscriptions.values()].filter(
      (sub) => sub.userId === input.userId,
    ).length;
    if (userOpenCount >= this.perUserCap) {
      return { status: 'cap-reached', cap: this.perUserCap };
    }
    const nowMs = this.scheduler.now();
    const sinceTimestamp =
      input.sinceTimestamp ?? new Date(nowMs).toISOString();
    const handle = this.scheduler.setInterval(() => {
      void this.tick(input.taskId);
    }, this.pollIntervalMs);
    this.subscriptions.set(input.taskId, {
      taskId: input.taskId,
      userId: input.userId,
      deliver: input.deliver,
      handle,
      startedAtMs: nowMs,
      lastEventTimestamp: sinceTimestamp,
      lastDeliveredAtMs: nowMs,
      deliveredEventCount: 0,
      deliverErrorCount: 0,
    });
    return { status: 'started' };
  }

  stop(taskId: string): boolean {
    const sub = this.subscriptions.get(taskId);
    if (sub === undefined) {
      return false;
    }
    sub.handle.clear();
    this.subscriptions.delete(taskId);
    return true;
  }

  list(): readonly DiscordFollowSubscriptionSnapshot[] {
    return [...this.subscriptions.values()].map((sub) => ({
      taskId: sub.taskId,
      userId: sub.userId,
      startedAtMs: sub.startedAtMs,
      lastEventTimestamp: sub.lastEventTimestamp,
      lastDeliveredAtMs: sub.lastDeliveredAtMs,
      deliveredEventCount: sub.deliveredEventCount,
      deliverErrorCount: sub.deliverErrorCount,
    }));
  }

  /**
   * Step the live tail for one taskId. Public so tests can drive the
   * controller deterministically (without real timers). Production code
   * relies on the scheduler firing this on a fixed interval.
   */
  async tick(taskId: string): Promise<void> {
    const sub = this.subscriptions.get(taskId);
    if (sub === undefined) {
      return;
    }
    const events = this.ledger
      .loadSince(sub.lastEventTimestamp, this.perTickEventLimit)
      .filter((event) => event.taskId === taskId);
    if (events.length === 0) {
      const idleForMs = this.scheduler.now() - sub.lastDeliveredAtMs;
      if (idleForMs >= this.idleTimeoutMs) {
        await this.deliverSafely(
          sub,
          renderFollowIdleTimeout({
            taskId,
            idleForMs,
          }),
        );
        this.stop(taskId);
      }
      return;
    }
    const summary = renderFollowEventBatch({
      taskId,
      events,
    });
    await this.deliverSafely(sub, summary);
    // `loadSince(...)` is inclusive (>= sinceMs), so advance by one
    // millisecond past the last delivered event to avoid re-delivering
    // it on the next tick. Same-millisecond ties are rare in practice
    // (control-plane appends are not high-frequency); we accept the
    // edge case of dropping a sibling event minted in the exact same
    // millisecond rather than re-posting the entire trailing event.
    const lastEvent = events[events.length - 1];
    if (lastEvent !== undefined) {
      const lastTimestampMs = Date.parse(lastEvent.timestamp);
      sub.lastEventTimestamp = Number.isFinite(lastTimestampMs)
        ? new Date(lastTimestampMs + 1).toISOString()
        : lastEvent.timestamp;
    }
    sub.lastDeliveredAtMs = this.scheduler.now();
    sub.deliveredEventCount += events.length;
    const terminalEvent = events.find((event) => event.type === 'task.terminal');
    if (terminalEvent !== undefined) {
      await this.deliverSafely(
        sub,
        renderFollowTerminal({
          taskId,
          terminalEvent,
        }),
      );
      this.stop(taskId);
    }
  }

  private async deliverSafely(
    sub: FollowSubscription,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    try {
      await sub.deliver.followUp(payload);
    } catch {
      sub.deliverErrorCount += 1;
    }
  }
}

/**
 * UX-15 — one-line summary of a batch of new ledger events for a task.
 * Each event becomes one line: `<elapsed> · <type> · <event-payload>`.
 * The renderer is tolerant of unknown payload shapes (it stringifies
 * a short prefix), so unknown future event types still surface to the
 * operator.
 */
export function renderFollowEventBatch(input: {
  readonly taskId: string;
  readonly events: readonly ControlPlaneEvent[];
}): DiscordMessagePayload {
  const lines: string[] = [
    `📡 \`${input.taskId}\` · ${input.events.length} new event${input.events.length === 1 ? '' : 's'}`,
  ];
  for (const event of input.events) {
    lines.push(`• ${event.timestamp} · ${event.type}${summarizeEventPayload(event)}`);
  }
  return {
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
  };
}

export function renderFollowTerminal(input: {
  readonly taskId: string;
  readonly terminalEvent: ControlPlaneEvent;
}): DiscordMessagePayload {
  const causeKind = extractTerminalCauseKind(input.terminalEvent.payload);
  const tag = causeKind === 'success' ? '✅' : '⛔';
  return {
    content: [
      `${tag} \`${input.taskId}\` reached terminal state · cause: ${causeKind}`,
      '💡 Live tail closed. Use `/status task_id:<id>` for the full terminal evidence or `/follow task_id:<id>` to re-open.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

export function renderFollowIdleTimeout(input: {
  readonly taskId: string;
  readonly idleForMs: number;
}): DiscordMessagePayload {
  const idleMin = Math.round(input.idleForMs / 60_000);
  return {
    content: [
      `⏸️ \`${input.taskId}\` follow stopped: no new events in ~${idleMin} min.`,
      '💡 Use `/status task_id:<id>` for the latest snapshot or `/follow task_id:<id>` to re-open.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

/**
 * UX-15 — initial editReply for `/follow task_id:<id>` when the
 * subscription is registered. Acknowledges the request and tells the
 * operator how to inspect the live tail's resource limits.
 */
export function renderFollowStarted(input: {
  readonly taskId: string;
  readonly pollIntervalMs: number;
  readonly idleTimeoutMs: number;
}): DiscordMessagePayload {
  const pollSec = Math.round(input.pollIntervalMs / 1_000);
  const idleMin = Math.round(input.idleTimeoutMs / 60_000);
  return {
    content: [
      `📡 Following \`${input.taskId}\`. New control-plane events will land here as they arrive.`,
      `Poll: ~${pollSec}s · Auto-stop: terminal event OR ${idleMin} min idle.`,
      '💡 Live tail closes itself; rerun `/follow task_id:<id>` to re-open.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

export function renderFollowAlreadyFollowing(taskId: string): DiscordMessagePayload {
  return {
    content: [
      `\`${taskId}\` is already being followed in another channel or by another /follow invocation.`,
      '💡 Wait for the existing follow to close (terminal or idle) before opening a new one.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

export function renderFollowCapReached(cap: number): DiscordMessagePayload {
  return {
    content: [
      `You already have ${cap} active /follow subscriptions; the per-user cap is ${cap}.`,
      '💡 Wait for one to close (terminal or idle) before opening another.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

export function renderFollowUnavailable(): DiscordMessagePayload {
  return {
    content: [
      '`/follow` is not configured for this service instance.',
      '💡 The control-plane ledger and follow controller are not wired in this deployment.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

function extractTerminalCauseKind(payload: Record<string, unknown>): string {
  const cause = payload['cause'];
  if (typeof cause === 'object' && cause !== null) {
    const kind = (cause as Record<string, unknown>)['kind'];
    if (typeof kind === 'string') {
      return kind;
    }
  }
  const causeKind = payload['causeKind'];
  return typeof causeKind === 'string' ? causeKind : 'unknown';
}

function summarizeEventPayload(event: ControlPlaneEvent): string {
  const payload = event.payload;
  if (event.type === 'task.lifecycle_observed') {
    const phase = payload['phase'];
    return typeof phase === 'string' ? ` · phase=${phase}` : '';
  }
  if (event.type === 'task.terminal') {
    const cause = payload['cause'];
    if (typeof cause === 'object' && cause !== null) {
      const kind = (cause as Record<string, unknown>)['kind'];
      return typeof kind === 'string' ? ` · cause=${kind}` : '';
    }
    const causeKind = payload['causeKind'];
    return typeof causeKind === 'string' ? ` · cause=${causeKind}` : '';
  }
  if (event.type === 'task.health_stalled') {
    const stalledFor = payload['stalledForMs'];
    return typeof stalledFor === 'number' ? ` · stalledForMs=${stalledFor}` : '';
  }
  return '';
}
