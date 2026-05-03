/**
 * Prompt-cache invariant + session-id rotation hook.
 *
 * Implements the M3 Hermes-derived invariant: once a system prompt is
 * "frozen" for a task, no further mutation is allowed for that task's
 * lifetime; mutating callers must rotate the session.
 *
 * Design principles (from CODE_STANDARDS.md §16 item #2 and
 * docs/references/hermes-agent/05-prompt-caching-strategy.md):
 *
 *   - Default mode is `warn` — logs violations but never throws, so the
 *     first PR can land in production with zero behavior change.
 *   - `enforce` mode is opt-in via `PROMPT_CACHE_INVARIANT=enforce` env
 *     or explicit `options.mode`.
 *   - `off` mode is a complete no-op (returns empty arrays, all methods
 *     are no-ops) for providers that handle caching internally.
 *   - Pure in-process tracker — no globals, no shared state across
 *     instances. Each `createPromptCacheInvariant()` call owns its own
 *     Maps and violation log.
 *
 * Session-rotation hook (`rotateSession`) fires on compaction so providers
 * can chain `parent_session_id` lineage consistent with how Hermes rotates
 * on `context_compressor.py:38-60` and `run_agent.py:9054-9110`.
 */

export type PromptCacheInvariantMode = 'enforce' | 'warn' | 'off';

export type PromptCacheInvariantViolationKind =
  | 'system-prompt-mutation'
  | 'mid-conversation-toolset-change'
  | 'session-rotation-after-freeze-without-event';

export interface PromptCacheInvariantViolation {
  readonly kind: PromptCacheInvariantViolationKind;
  readonly taskId: string;
  readonly conversationTurn: number;
  readonly observedAt: string;
  readonly detail: string;
}

export interface SessionRotationEvent {
  readonly taskId: string;
  readonly previousSessionId: string;
  readonly nextSessionId: string;
  readonly parentSessionId?: string;
  readonly reason: 'compaction' | 'manual' | 'session-end';
  readonly observedAt: string;
}

export interface PromptCacheInvariantPort {
  readonly mode: PromptCacheInvariantMode;
  /**
   * Record the system prompt observed for a given task at a given turn.
   * If the task was already frozen and the prompt differs from the frozen
   * snapshot, a violation is recorded (and thrown in `enforce` mode).
   */
  observeSystemPrompt(taskId: string, turn: number, prompt: string): void;
  /**
   * Freeze the system prompt for a task. After this call, any
   * `observeSystemPrompt` that supplies a different string is a violation.
   */
  freezeSystemPrompt(taskId: string): void;
  /**
   * Notify the invariant tracker that the session has rotated. The tracker
   * records the lineage event. If the previous session was frozen but no
   * rotation event was issued before a system-prompt change, the tracker
   * would have already flagged the mutation; this call is the *correct*
   * way to advance the frozen-prompt baseline to a new session.
   */
  rotateSession(event: SessionRotationEvent): void;
  /**
   * Return all violations recorded by this instance. The array is a
   * snapshot copy — mutation of the returned array does not affect the
   * tracker.
   */
  getViolations(): readonly PromptCacheInvariantViolation[];
  /**
   * Resolve once every in-flight `promptCacheBreakpointObserve` hook
   * chain spawned by `freezeSystemPrompt` has settled (audit 2026-05-03
   * / F1 parity, mirroring `drainPendingProviderSelectHooks`). Each
   * chain is `.catch()`-contained, so this never rejects. Intended for
   * shutdown handlers and tests asserting no hook chain leaked past
   * a deterministic point.
   */
  drainPendingObserveHooks(): Promise<void>;
}

export interface PromptCacheInvariantHookBinding {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly promptCacheBreakpointObserve: import('../contracts/trait-runtime-hook.js').TraitPromptCacheBreakpointObserveHook;
}

export interface PromptCacheInvariantOptions {
  readonly mode?: PromptCacheInvariantMode;
  readonly clock?: () => string;
  readonly logger?: (message: string, payload: unknown) => void;
  /** M5c — fires whenever `freezeSystemPrompt` is called. */
  readonly observeHooks?: ReadonlyArray<PromptCacheInvariantHookBinding>;
}

// The environment variable name used for opt-in mode selection.
export const PROMPT_CACHE_INVARIANT_ENV = 'PROMPT_CACHE_INVARIANT';

function resolveMode(explicit: PromptCacheInvariantMode | undefined): PromptCacheInvariantMode {
  if (explicit !== undefined) {
    return explicit;
  }
  const envValue = process.env[PROMPT_CACHE_INVARIANT_ENV];
  if (envValue === 'enforce' || envValue === 'warn' || envValue === 'off') {
    return envValue;
  }
  return 'warn';
}

function defaultClock(): string {
  return new Date().toISOString();
}

 
function defaultLogger(message: string, payload: unknown): void {
   
  console.warn(message, payload);
}

/** Per-task state tracked by the in-process invariant. */
interface TaskState {
  /** The frozen snapshot of the system prompt, undefined until frozen. */
  frozenPrompt: string | undefined;
  /** Whether `freezeSystemPrompt` has been called. */
  frozen: boolean;
  /** The prompt observed at the most recent `observeSystemPrompt` call. */
  lastObservedPrompt: string | undefined;
  /** The turn at which the prompt was last observed. */
  lastObservedTurn: number;
}

/**
 * Create a prompt-cache invariant tracker.
 *
 * Mode resolution order:
 *   1. explicit `options.mode`
 *   2. `PROMPT_CACHE_INVARIANT` env ∈ `{enforce, warn, off}`
 *   3. default `warn`
 */
export function createPromptCacheInvariant(
  options?: PromptCacheInvariantOptions,
): PromptCacheInvariantPort {
  const mode = resolveMode(options?.mode);

  // No-op fast path for `off` mode.
  if (mode === 'off') {
    return {
      mode: 'off',
      observeSystemPrompt: () => undefined,
      freezeSystemPrompt: () => undefined,
      rotateSession: () => undefined,
      getViolations: () => [],
      drainPendingObserveHooks: async () => undefined,
    };
  }

  const clock = options?.clock ?? defaultClock;
  const logger = options?.logger ?? defaultLogger;
  const observeHooks = options?.observeHooks ?? [];

  // Per-task state — no shared state across instances.
  const taskStates = new Map<string, TaskState>();
  const violations: PromptCacheInvariantViolation[] = [];
  // In-flight `promptCacheBreakpointObserve` hook chains. Each chain is
  // already `.catch()`-contained so it never rejects; the set tracks
  // completion, not failure (audit 2026-05-03 / F1 parity).
  const pendingObserveHooks = new Set<Promise<void>>();
  // Session lineage log: taskId → list of rotation events.
  const rotationLog = new Map<string, SessionRotationEvent[]>();

  function getOrCreateTaskState(taskId: string): TaskState {
    let state = taskStates.get(taskId);
    if (state === undefined) {
      state = {
        frozenPrompt: undefined,
        frozen: false,
        lastObservedPrompt: undefined,
        lastObservedTurn: 0,
      };
      taskStates.set(taskId, state);
    }
    return state;
  }

  function recordViolation(violation: PromptCacheInvariantViolation): void {
    violations.push(violation);
    const logPayload = {
      event: 'prompt-cache-invariant-violation',
      kind: violation.kind,
      taskId: violation.taskId,
      conversationTurn: violation.conversationTurn,
      observedAt: violation.observedAt,
      detail: violation.detail,
    };
    logger(
      `prompt-cache-invariant ${JSON.stringify(logPayload)}`,
      logPayload,
    );
    if (mode === 'enforce') {
      throw new Error(
        `PromptCacheInvariant [${violation.kind}] taskId=${violation.taskId} turn=${violation.conversationTurn}: ${violation.detail}`,
      );
    }
  }

  function observeSystemPrompt(taskId: string, turn: number, prompt: string): void {
    const state = getOrCreateTaskState(taskId);
    state.lastObservedPrompt = prompt;
    state.lastObservedTurn = turn;

    if (!state.frozen) {
      // Not yet frozen — record the observation but do nothing else.
      return;
    }

    // Frozen: check for mutation.
    if (state.frozenPrompt !== prompt) {
      recordViolation({
        kind: 'system-prompt-mutation',
        taskId,
        conversationTurn: turn,
        observedAt: clock(),
        detail: `System prompt mutated after freeze. frozen=${JSON.stringify(
          state.frozenPrompt?.slice(0, 80) ?? '',
        )} observed=${JSON.stringify(prompt.slice(0, 80))}`,
      });
    }
  }

  function freezeSystemPrompt(taskId: string): void {
    const state = getOrCreateTaskState(taskId);
    if (state.frozen) {
      // Idempotent — re-freezing is a no-op.
      return;
    }
    state.frozen = true;
    state.frozenPrompt = state.lastObservedPrompt;

    // M5c — fire promptCacheBreakpointObserve hooks (fire-and-forget,
    // error-contained). Each binding sees the same observedAt timestamp.
    // Audit 2026-05-03 / F1 parity: track each chain so
    // `drainPendingObserveHooks` can await all of them.
    if (observeHooks.length > 0) {
      const observedAt = clock();
      const promptHash = hashPrompt(state.frozenPrompt ?? '');
      for (const binding of observeHooks) {
        const chain: Promise<void> = Promise.resolve()
          .then(() =>
            binding.promptCacheBreakpointObserve(
              {
                moduleId: binding.moduleId as never,
                moduleVersion: binding.moduleVersion,
                observedAt,
              },
              {
                taskId,
                promptHash,
                turn: state.lastObservedTurn,
              },
            ),
          )
          .catch((error: unknown) => {
            logger('trait-runtime-hook-threw', {
              hook: 'promptCacheBreakpointObserve',
              moduleId: binding.moduleId,
              taskId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            pendingObserveHooks.delete(chain);
          });
        pendingObserveHooks.add(chain);
      }
    }
  }

  async function drainPendingObserveHooks(): Promise<void> {
    if (pendingObserveHooks.size === 0) return;
    await Promise.allSettled(Array.from(pendingObserveHooks));
  }

  function hashPrompt(prompt: string): string {
    // Tiny non-crypto digest (FNV-1a) — enough for hook payload identity.
    let h = 0x811c9dc5;
    for (let i = 0; i < prompt.length; i++) {
      h ^= prompt.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return `fnv1a:${h.toString(16)}`;
  }

  function rotateSession(event: SessionRotationEvent): void {
    const { taskId } = event;
    // Record the lineage event.
    const log = rotationLog.get(taskId);
    if (log === undefined) {
      rotationLog.set(taskId, [event]);
    } else {
      log.push(event);
    }

    // On a session rotation, unfreeze the task so the next
    // `freezeSystemPrompt` call captures the new (post-compaction) prompt.
    const state = taskStates.get(taskId);
    if (state !== undefined && state.frozen) {
      state.frozen = false;
      state.frozenPrompt = undefined;
      // Reset the last observed prompt so the next freeze picks up fresh
      // post-compaction content.
      state.lastObservedPrompt = undefined;
      state.lastObservedTurn = 0;
    }
  }

  function getViolations(): readonly PromptCacheInvariantViolation[] {
    // Return a shallow copy so callers can't mutate the internal log.
    return [...violations];
  }

  return {
    mode,
    observeSystemPrompt,
    freezeSystemPrompt,
    rotateSession,
    getViolations,
    drainPendingObserveHooks,
  };
}
