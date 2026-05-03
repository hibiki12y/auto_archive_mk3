/**
 * M10 Stage 1 — ACP `Agent` implementation.
 *
 * Implements only the methods needed for the initial handshake:
 *   - initialize: returns `PROTOCOL_VERSION` + minimal agentCapabilities
 *   - authenticate: no-op success (no auth methods advertised yet)
 *   - newSession: allocates a fresh sessionId, records local state
 *
 * Other `Agent` methods (`prompt`, `cancel`, `setSessionMode`, `loadSession`,
 * `unstable_forkSession`, `resumeSession`, `closeSession`,
 * `setSessionConfigOption`) are deliberately left unimplemented — the SDK
 * `Agent` interface marks them optional, so omitting them returns a
 * `methodNotFound` JSON-RPC error to the client. That is the desired
 * Stage 1 posture: clients see we exist and can hold a session, but any
 * actual work returns a clear "not yet" signal.
 *
 * Subsequent stages add:
 *   - Stage 2: `prompt`, `cancel`
 *   - Stage 3: `requestPermission` callbacks via `acp-permission-bridge`,
 *              available_commands advertisement
 *   - Stage 4: `loadSession`, `unstable_forkSession`, `resumeSession`,
 *              `closeSession`
 *   - Stage 5: structured error envelopes, log label normalization
 */

import {
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';

import type {
  AcpSessionId,
  AcpSessionLifecycleEvent,
  AcpSessionState,
} from '../contracts/acp-session.js';
import type { AcpPromptBridge } from './acp-prompt-bridge.js';
import {
  buildAvailableCommands,
  notifyAvailableCommands,
} from './acp-slash-commands.js';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type {
  AcpSessionStore,
  PersistedAcpSessionRecord,
} from './acp-session-store.js';
import { type AcpLogger, defaultAcpLogger } from './acp-logger.js';

const AGENT_NAME = 'auto-archive-acp';
const AGENT_VERSION = '0.0.0-stage1';

/** Optional sink for Stage 1 lifecycle observability — used by tests. */
export type AcpLifecycleObserver = (event: AcpSessionLifecycleEvent) => void;

export interface AcpServerOptions {
  /**
   * Source of `now` — injectable for tests so lifecycle event timestamps
   * are deterministic. Defaults to `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
  /**
   * Source of session ids — injectable for tests. Defaults to a
   * 32-hex-char id derived from `crypto.getRandomValues`.
   */
  readonly newSessionId?: () => AcpSessionId;
  /**
   * Optional lifecycle sink. Stage 5 will replace this with the
   * project's structured logger; Stage 1 keeps it pluggable for
   * the handshake spec.
   */
  readonly onLifecycle?: AcpLifecycleObserver;
  /**
   * Stage 2 — optional prompt bridge. When unset, `prompt` continues
   * to throw `methodNotFound` (Stage 1 default). Stage 3+ will wire
   * a real `DispatcherBackedPromptDriver` into the bridge.
   */
  readonly promptBridge?: AcpPromptBridge;
  /**
   * Stage 2 — turn-id source for in-flight prompt tracking. NOT a
   * dispatcher TaskId; just a stable string the bridge uses for
   * cancel routing and tests use for assertion. Defaults to a
   * 16-hex turn id from `crypto.getRandomValues`.
   */
  readonly newTurnId?: () => string;
  /**
   * Stage 3 — when `true` (default), the first prompt invocation
   * for a session emits an `available_commands_update` notification
   * built from the Discord `COMMAND_REGISTRY`. Set to `false` to
   * suppress the advertisement (tests that don't care about it, or
   * deployments that want to advertise via a different channel).
   */
  readonly advertiseSlashCommands?: boolean;
  /**
   * Stage 3 — override the advertised command list. When unset,
   * derived from `buildAvailableCommands()`. Tests use this to
   * assert specific shapes without depending on the live registry.
   */
  readonly availableCommands?: readonly AvailableCommand[];
  /**
   * Stage 4 — when set, the server persists each created/forked
   * session via this store and resolves `loadSession`/`resumeSession`
   * by reading from it. When unset, those methods continue to throw
   * `methodNotFound` and `agentCapabilities.loadSession` is reported
   * as `false`.
   */
  readonly sessionStore?: AcpSessionStore;
  /**
   * Stage 4 — fired whenever `unstable_forkSession` allocates a new
   * session. The consumer can wire this to M3
   * `prompt-cache-invariant.rotateSession(...)` so the new sessionId
   * inherits a clean prompt-cache baseline. Errors are swallowed.
   */
  readonly onSessionRotation?: (event: AcpSessionRotationEvent) => void;
  /**
   * Stage 5 — diagnostic logger. Defaults to `defaultAcpLogger`
   * (ndjson lines on stderr). Tests pass a recording logger; ops
   * deployments can plug syslog/OTel/etc.
   */
  readonly logger?: AcpLogger;
}

/**
 * Stage 4 — emitted on `unstable_forkSession`. Mirrors
 * `SessionRotationEvent` from M3 prompt-cache invariant but kept
 * separate so the ACP layer does not import the runtime module
 * directly (callers wire the two together at the bootstrap site).
 */
export interface AcpSessionRotationEvent {
  readonly previousSessionId: AcpSessionId;
  readonly nextSessionId: AcpSessionId;
  readonly reason: 'fork';
  readonly observedAt: string;
}

/**
 * Stage 1 ACP agent. Holds a `Map<sessionId, AcpSessionState>` and
 * exposes it for inspection (read-only) so future stages can wire
 * dispatcher / persistence on top.
 */
export class AcpServer implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly now: () => string;
  private readonly newSessionId: () => AcpSessionId;
  private readonly newTurnId: () => string;
  private readonly onLifecycle?: AcpLifecycleObserver;
  private readonly promptBridge?: AcpPromptBridge;
  private readonly advertiseSlashCommands: boolean;
  private readonly availableCommands?: readonly AvailableCommand[];
  private readonly sessionStore?: AcpSessionStore;
  private readonly onSessionRotation?: (event: AcpSessionRotationEvent) => void;
  private readonly logger: AcpLogger;
  private readonly sessions = new Map<AcpSessionId, AcpSessionState>();

  constructor(connection: AgentSideConnection, options: AcpServerOptions = {}) {
    this.connection = connection;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newSessionId = options.newSessionId ?? defaultSessionId;
    this.newTurnId = options.newTurnId ?? defaultTurnId;
    this.onLifecycle = options.onLifecycle;
    this.promptBridge = options.promptBridge;
    this.advertiseSlashCommands = options.advertiseSlashCommands ?? true;
    this.availableCommands = options.availableCommands;
    this.sessionStore = options.sessionStore;
    this.onSessionRotation = options.onSessionRotation;
    this.logger = options.logger ?? defaultAcpLogger;
  }

  /**
   * Returns a read-only snapshot of the active session table. Used by
   * tests; not part of the ACP wire surface.
   */
  snapshotSessions(): readonly AcpSessionState[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- ACP SDK contract requires Promise<InitializeResponse>; the body is sync.
  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    const persistenceEnabled = this.sessionStore !== undefined;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: AGENT_NAME,
        version: AGENT_VERSION,
      },
      // Stage 4 — flip `loadSession` and advertise
      // `sessionCapabilities.fork`/`resume` only when a store is
      // wired. Without persistence we cannot answer those calls so
      // a false advertisement would be misleading.
      agentCapabilities: {
        loadSession: persistenceEnabled,
        ...(persistenceEnabled
          ? {
              sessionCapabilities: {
                fork: {},
                resume: {},
              },
            }
          : {}),
      },
      // No auth methods advertised — `authenticate` is a no-op success.
      authMethods: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- ACP SDK contract requires Promise<AuthenticateResponse>; the body is a sync no-op.
  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // No methods advertised; clients should not call this. We accept it
    // as a no-op so misbehaving clients don't see a hard failure during
    // initial handshake testing.
    return {};
  }

  /**
   * Stage 2 — when a `promptBridge` is configured, drive a turn through
   * it. Without a bridge (default-uninjected at Stage 2), continue to
   * return `methodNotFound` so a misconfigured deploy fails loudly
   * rather than silently dropping prompts.
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.promptBridge === undefined) {
      throw RequestError.methodNotFound('session/prompt');
    }
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown session id: ${params.sessionId}`,
      );
    }

    // Disallow concurrent prompts on the same session — at the ACP
    // protocol level a session is a single-turn-at-a-time conversation.
    // The protocol expects the client to wait for one prompt to settle
    // before sending another.
    if (session.phase === 'prompting') {
      throw RequestError.invalidRequest(
        { sessionId: params.sessionId },
        `session ${params.sessionId} already has a prompt in flight`,
      );
    }

    const controller = new AbortController();
    const turnId = this.newTurnId();
    session.phase = 'prompting';
    session.currentTaskId = turnId;
    session.pendingCancel = controller;

    // Stage 3 — advertise slash commands once per session, on the
    // first prompt turn. Errors are swallowed by `notifyAvailableCommands`
    // so a wire glitch on the notification cannot abort the turn.
    if (this.advertiseSlashCommands && session.commandsAdvertised !== true) {
      session.commandsAdvertised = true;
      const commands = this.availableCommands ?? buildAvailableCommands();
      await notifyAvailableCommands(this.connection, params.sessionId, {
        commands,
      });
    }

    try {
      return await this.promptBridge.run(
        this.connection,
        {
          sessionId: params.sessionId,
          cwd: session.cwd,
          content: params.prompt,
          additionalDirectories: session.additionalDirectories,
        },
        controller.signal,
      );
    } finally {
      // Always clear per-turn state, even if the bridge threw — a
      // stale `pendingCancel` would route a later cancel to a
      // controller that no longer drives anything.
      session.pendingCancel = undefined;
      session.currentTaskId = undefined;
      session.phase = controller.signal.aborted ? 'idle' : 'idle';
    }
  }

  /**
   * Stage 2 — `cancel` is an ACP notification (no JSON-RPC response).
   * Find the session, abort the in-flight controller. This MUST NOT
   * throw on no-op cases (no session, no current turn) since the SDK
   * has no way to surface notification errors to the caller — the
   * IDE may legitimately send a redundant cancel.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- ACP SDK notification handlers must return Promise<void>; the body is sync.
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      // Unknown session — no-op. Stage 5 will normalize the log label.
      return;
    }
    if (session.pendingCancel === undefined) {
      // No turn in flight — no-op (legitimate redundant cancel).
      return;
    }
    session.phase = 'cancelling';
    try {
      session.pendingCancel.abort();
    } catch {
      // Defensive — `AbortController.abort()` does not throw in any
      // supported runtime, but swallow just in case so a notification
      // never crashes the server.
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = this.newSessionId();
    const createdAt = this.now();
    const state: AcpSessionState = {
      sessionId,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? [],
      createdAt,
      phase: 'idle',
    };
    this.sessions.set(sessionId, state);
    this.onLifecycle?.({
      kind: 'session-created',
      sessionId,
      cwd: params.cwd,
      observedAt: createdAt,
    });
    if (this.sessionStore !== undefined) {
      try {
        await this.sessionStore.write(persistedFromState(state, createdAt));
      } catch (err) {
        this.logger({
          level: 'warn',
          label: 'acp-session-store-write-failed',
          message: (err as Error).message,
          payload: {
            sessionId,
            phase: 'newSession',
          },
        });
      }
    }
    return { sessionId };
  }

  /**
   * Stage 4 — `session/load`. Restores a previously persisted session
   * record into the in-memory map and returns an empty load response.
   * The caller (IDE) is responsible for replaying conversation history
   * from its own transcript; we ship only the lightweight session
   * envelope. Any pending in-flight prompt from a prior process is
   * NOT resumed (that would cross a process boundary into stale
   * dispatcher state) — the session lands in `idle` phase.
   *
   * Without `sessionStore`, this throws `methodNotFound` to keep
   * the wire contract honest with the agentCapabilities.loadSession
   * advertisement.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (this.sessionStore === undefined) {
      throw RequestError.methodNotFound('session/load');
    }
    const persisted = await this.readPersisted(params.sessionId);
    if (persisted === undefined) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown session id: ${params.sessionId}`,
      );
    }
    this.hydrateFromPersisted(persisted, params);
    // Touch the lastTouchedAt timestamp so a subsequent list_sessions
    // reflects the resume.
    await this.touchPersisted(persisted);
    return {};
  }

  /**
   * Stage 4 — `session/resume`. Same restoration semantics as
   * `loadSession` but per ACP spec the agent does NOT replay history
   * via `sessionUpdate`. Both methods land at `idle` phase.
   */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (this.sessionStore === undefined) {
      throw RequestError.methodNotFound('session/resume');
    }
    const persisted = await this.readPersisted(params.sessionId);
    if (persisted === undefined) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown session id: ${params.sessionId}`,
      );
    }
    this.hydrateFromPersisted(persisted, params);
    await this.touchPersisted(persisted);
    return {};
  }

  /**
   * Stage 4 — `session/fork` (UNSTABLE per ACP). Allocates a new
   * sessionId, copies the parent's cwd / additionalDirectories,
   * persists, and fires `onSessionRotation` so callers can wire M3
   * `prompt-cache-invariant.rotateSession(...)`. The parent session
   * is left untouched.
   */
  async unstable_forkSession(
    params: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    if (this.sessionStore === undefined) {
      throw RequestError.methodNotFound('session/fork');
    }
    const parent =
      this.sessions.get(params.sessionId) ??
      (await this.readPersisted(params.sessionId).then((p) =>
        p ? this.hydrateFromPersisted(p, undefined) : undefined,
      ));
    if (parent === undefined) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown session id: ${params.sessionId}`,
      );
    }
    const newId = this.newSessionId();
    const createdAt = this.now();
    const state: AcpSessionState = {
      sessionId: newId,
      cwd: params.cwd ?? parent.cwd,
      additionalDirectories: params.additionalDirectories ?? parent.additionalDirectories,
      createdAt,
      phase: 'idle',
      parentSessionId: parent.sessionId,
    };
    this.sessions.set(newId, state);
    try {
      await this.sessionStore.write(persistedFromState(state, createdAt));
    } catch (err) {
      this.logger({
        level: 'warn',
        label: 'acp-session-store-write-failed',
        message: (err as Error).message,
        payload: {
          sessionId: newId,
          phase: 'fork',
        },
      });
    }
    if (this.onSessionRotation !== undefined) {
      try {
        this.onSessionRotation({
          previousSessionId: parent.sessionId,
          nextSessionId: newId,
          reason: 'fork',
          observedAt: createdAt,
        });
      } catch {
        // Defensive — rotation hook errors must not abort fork.
      }
    }
    return { sessionId: newId };
  }

  private async readPersisted(
    sessionId: AcpSessionId,
  ): Promise<PersistedAcpSessionRecord | undefined> {
    if (this.sessionStore === undefined) return undefined;
    return this.sessionStore.read(sessionId);
  }

  private hydrateFromPersisted(
    persisted: PersistedAcpSessionRecord,
    overrides:
      | { readonly cwd?: string; readonly additionalDirectories?: readonly string[] }
      | undefined,
  ): AcpSessionState {
    const existing = this.sessions.get(persisted.sessionId);
    const state: AcpSessionState = {
      sessionId: persisted.sessionId,
      cwd: overrides?.cwd ?? persisted.cwd,
      additionalDirectories:
        overrides?.additionalDirectories ?? persisted.additionalDirectories,
      createdAt: existing?.createdAt ?? persisted.createdAt,
      phase: 'idle',
      ...(persisted.parentSessionId === undefined
        ? {}
        : { parentSessionId: persisted.parentSessionId }),
    };
    this.sessions.set(persisted.sessionId, state);
    return state;
  }

  private async touchPersisted(persisted: PersistedAcpSessionRecord): Promise<void> {
    if (this.sessionStore === undefined) return;
    try {
      await this.sessionStore.write({
        ...persisted,
        lastTouchedAt: this.now(),
      });
    } catch (err) {
      this.logger({
        level: 'warn',
        label: 'acp-session-store-write-failed',
        message: (err as Error).message,
        payload: {
          sessionId: persisted.sessionId,
          phase: 'touch',
        },
      });
    }
  }

  /**
   * Connection-close hook for the entrypoint. Marks every active session
   * as `closed` and emits one lifecycle event per session for
   * observability. Defensive — never throws.
   */
  notifyConnectionClosed(reason: 'eof' | 'error'): void {
    const observedAt = this.now();
    for (const [sessionId, state] of this.sessions) {
      state.phase = 'closed';
      try {
        this.onLifecycle?.({
          kind: 'session-closed',
          sessionId,
          reason,
          observedAt,
        });
      } catch {
        // never fail close-out on observer errors
      }
    }
  }

  /** @internal — exposed for the entrypoint, not the wire. */
  get connectionRef(): AgentSideConnection {
    return this.connection;
  }
}

function persistedFromState(
  state: AcpSessionState,
  lastTouchedAt: string,
): PersistedAcpSessionRecord {
  return {
    schemaVersion: 1,
    sessionId: state.sessionId,
    cwd: state.cwd,
    additionalDirectories: state.additionalDirectories,
    createdAt: state.createdAt,
    lastTouchedAt,
    ...(state.parentSessionId === undefined
      ? {}
      : { parentSessionId: state.parentSessionId }),
  };
}

function defaultSessionId(): AcpSessionId {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function defaultTurnId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
