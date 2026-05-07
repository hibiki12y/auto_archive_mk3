import { createHash } from 'node:crypto';

import type {
  ItemCompletedEvent,
  RuntimeEvent,
  ToolInvocationEvent,
} from '../contracts/runtime-event.js';

export type ToolLoopDecision =
  | { readonly status: 'ok' }
  | {
      readonly status: 'warn';
      readonly reason: string;
      readonly fingerprint: string;
      readonly count: number;
    }
  | {
      readonly status: 'veto';
      readonly reason: string;
      readonly fingerprint: string;
      readonly count: number;
    };

export interface ToolLoopObservationSnapshot {
  readonly fingerprint: string;
  readonly toolKind: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly count: number;
  readonly lastObservedAt: string;
  readonly lastObservedDeltaDigest?: string;
}

export interface ToolLoopDetectorSnapshot {
  readonly observations: readonly ToolLoopObservationSnapshot[];
  readonly recentFingerprints: readonly string[];
  readonly warnings: readonly Omit<Extract<ToolLoopDecision, { status: 'warn' }>, never>[];
  readonly vetoes: readonly Omit<Extract<ToolLoopDecision, { status: 'veto' }>, never>[];
}

export interface ToolLoopDetector {
  observe(event: RuntimeEvent): ToolLoopDecision;
  snapshot(): ToolLoopDetectorSnapshot;
}

export interface ToolLoopDetectorOptions {
  readonly warnRepeatCount?: number;
  readonly vetoRepeatCount?: number;
  readonly warnPingPongLength?: number;
  readonly vetoPingPongLength?: number;
  readonly knownPollingTools?: readonly string[];
  readonly recentWindowSize?: number;
}

interface ToolObservation {
  readonly fingerprint: string;
  readonly toolKind: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly observedDeltaDigest?: string;
  readonly isKnownPollingTool: boolean;
}

interface MutableObservationState {
  readonly fingerprint: string;
  readonly toolKind: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  count: number;
  lastObservedAt: string;
  lastObservedDeltaDigest?: string;
  warnedAtCounts: Set<number>;
}

const DEFAULT_WARN_REPEAT_COUNT = 4;
const DEFAULT_VETO_REPEAT_COUNT = 6;
const DEFAULT_WARN_PING_PONG_LENGTH = 6;
const DEFAULT_VETO_PING_PONG_LENGTH = 10;
const DEFAULT_RECENT_WINDOW_SIZE = 20;
const DEFAULT_POLLING_TOOLS = Object.freeze([
  'status',
  'poll',
  'wait',
  'list_jobs',
  'slurm-status',
  'docker-ps',
  'gitlab-job-status',
]);

const OK: ToolLoopDecision = Object.freeze({ status: 'ok' });

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toolObservationFromToolInvocation(
  event: ToolInvocationEvent,
  knownPollingTools: ReadonlySet<string>,
): ToolObservation {
  const raw = event as ToolInvocationEvent & Record<string, unknown>;
  const toolKind = optionalString(raw['toolKind']) ?? 'tool';
  const toolName = event.toolName;
  const argumentsDigest =
    optionalString(raw['argumentsDigest']) ??
    optionalString(raw['stableArgumentsDigest']) ??
    digestText(event.detail);
  const observedDeltaDigest =
    optionalString(raw['observedDeltaDigest']) ??
    optionalString(raw['resultDigest']) ??
    (event.observedSummary === undefined
      ? undefined
      : digest(event.observedSummary));
  const isKnownPollingTool =
    optionalBoolean(raw['knownPollingTool']) ??
    (knownPollingTools.has(toolName) ||
      knownPollingTools.has(`${toolKind}:${toolName}`));
  const fingerprint = digest({ toolKind, toolName, argumentsDigest });
  return {
    fingerprint,
    toolKind,
    toolName,
    argumentsDigest,
    observedDeltaDigest,
    isKnownPollingTool,
  };
}

function toolObservationFromItemCompleted(
  event: ItemCompletedEvent,
  knownPollingTools: ReadonlySet<string>,
): ToolObservation | undefined {
  const item = event.item;
  if (
    item.type !== 'command_execution' &&
    item.type !== 'mcp_tool_call' &&
    item.type !== 'web_search'
  ) {
    return undefined;
  }
  const toolKind = item.type;
  const summaryParts = item.summary.split('|').map((part) => part.trim());
  const toolName =
    item.type === 'mcp_tool_call'
      ? summaryParts.slice(1).filter(Boolean).join('/') || item.type
      : item.type;
  const argumentsDigest = digestText(item.summary);
  const observedDeltaDigest = item.status === undefined ? undefined : digestText(item.status);
  const isKnownPollingTool =
    knownPollingTools.has(toolName) || knownPollingTools.has(`${toolKind}:${toolName}`);
  return {
    fingerprint: digest({ toolKind, toolName, argumentsDigest }),
    toolKind,
    toolName,
    argumentsDigest,
    observedDeltaDigest,
    isKnownPollingTool,
  };
}

function extractToolObservation(
  event: RuntimeEvent,
  knownPollingTools: ReadonlySet<string>,
): ToolObservation | undefined {
  if (event.kind === 'tool-invocation') {
    return toolObservationFromToolInvocation(event, knownPollingTools);
  }
  if (event.kind === 'item.completed') {
    return toolObservationFromItemCompleted(event, knownPollingTools);
  }
  return undefined;
}

function isStrictAlternating(window: readonly string[], length: number): boolean {
  if (window.length < length) {
    return false;
  }
  const slice = window.slice(window.length - length);
  const first = slice[0];
  const second = slice[1];
  if (first === undefined || second === undefined || first === second) {
    return false;
  }
  return slice.every((fingerprint, index) =>
    index % 2 === 0 ? fingerprint === first : fingerprint === second,
  );
}

export function createToolLoopDetector(
  options: ToolLoopDetectorOptions = {},
): ToolLoopDetector {
  const warnRepeatCount = options.warnRepeatCount ?? DEFAULT_WARN_REPEAT_COUNT;
  const vetoRepeatCount = options.vetoRepeatCount ?? DEFAULT_VETO_REPEAT_COUNT;
  const warnPingPongLength = options.warnPingPongLength ?? DEFAULT_WARN_PING_PONG_LENGTH;
  const vetoPingPongLength = options.vetoPingPongLength ?? DEFAULT_VETO_PING_PONG_LENGTH;
  const recentWindowSize = options.recentWindowSize ?? DEFAULT_RECENT_WINDOW_SIZE;
  const knownPollingTools = new Set(
    (options.knownPollingTools ?? DEFAULT_POLLING_TOOLS).map((tool) => tool.trim()).filter(Boolean),
  );
  const observations = new Map<string, MutableObservationState>();
  const recentFingerprints: string[] = [];
  const warnings: Extract<ToolLoopDecision, { status: 'warn' }>[] = [];
  const vetoes: Extract<ToolLoopDecision, { status: 'veto' }>[] = [];
  const warnedPingPongLengths = new Set<number>();
  const vetoedPingPongLengths = new Set<number>();

  const rememberRecent = (fingerprint: string): void => {
    recentFingerprints.push(fingerprint);
    while (recentFingerprints.length > recentWindowSize) {
      recentFingerprints.shift();
    }
  };

  const pingPongDecision = (): ToolLoopDecision => {
    if (isStrictAlternating(recentFingerprints, vetoPingPongLength)) {
      if (!vetoedPingPongLengths.has(vetoPingPongLength)) {
        vetoedPingPongLengths.add(vetoPingPongLength);
      }
      const fingerprint = recentFingerprints.slice(-2).join('<->');
      const decision = {
        status: 'veto' as const,
        reason: `tool ping-pong loop detected after ${vetoPingPongLength} alternating tool events`,
        fingerprint,
        count: vetoPingPongLength,
      };
      vetoes.push(decision);
      return decision;
    }
    if (
      isStrictAlternating(recentFingerprints, warnPingPongLength) &&
      !warnedPingPongLengths.has(warnPingPongLength)
    ) {
      warnedPingPongLengths.add(warnPingPongLength);
      const fingerprint = recentFingerprints.slice(-2).join('<->');
      const decision = {
        status: 'warn' as const,
        reason: `tool ping-pong loop suspected after ${warnPingPongLength} alternating tool events`,
        fingerprint,
        count: warnPingPongLength,
      };
      warnings.push(decision);
      return decision;
    }
    return OK;
  };

  return {
    observe(event: RuntimeEvent): ToolLoopDecision {
      const observation = extractToolObservation(event, knownPollingTools);
      if (observation === undefined) {
        return OK;
      }

      const existing = observations.get(observation.fingerprint);
      if (
        existing !== undefined &&
        observation.isKnownPollingTool &&
        existing.lastObservedDeltaDigest !== undefined &&
        observation.observedDeltaDigest !== undefined &&
        existing.lastObservedDeltaDigest !== observation.observedDeltaDigest
      ) {
        existing.count = 1;
        existing.lastObservedAt = event.timestamp;
        existing.lastObservedDeltaDigest = observation.observedDeltaDigest;
        return OK;
      }

      const state = existing ?? {
        fingerprint: observation.fingerprint,
        toolKind: observation.toolKind,
        toolName: observation.toolName,
        argumentsDigest: observation.argumentsDigest,
        count: 0,
        lastObservedAt: event.timestamp,
        warnedAtCounts: new Set<number>(),
        ...(observation.observedDeltaDigest === undefined
          ? {}
          : { lastObservedDeltaDigest: observation.observedDeltaDigest }),
      };
      state.count += 1;
      state.lastObservedAt = event.timestamp;
      if (observation.observedDeltaDigest !== undefined) {
        state.lastObservedDeltaDigest = observation.observedDeltaDigest;
      }
      observations.set(observation.fingerprint, state);
      rememberRecent(observation.fingerprint);

      if (state.count >= vetoRepeatCount) {
        const decision = {
          status: 'veto' as const,
          reason: `tool invocation loop detected for ${observation.toolKind}:${observation.toolName} after ${state.count} repeated calls`,
          fingerprint: observation.fingerprint,
          count: state.count,
        };
        vetoes.push(decision);
        return decision;
      }

      const pingPong = pingPongDecision();
      if (pingPong.status !== 'ok') {
        return pingPong;
      }

      if (state.count >= warnRepeatCount && !state.warnedAtCounts.has(state.count)) {
        state.warnedAtCounts.add(state.count);
        const decision = {
          status: 'warn' as const,
          reason: `tool invocation loop suspected for ${observation.toolKind}:${observation.toolName} after ${state.count} repeated calls`,
          fingerprint: observation.fingerprint,
          count: state.count,
        };
        warnings.push(decision);
        return decision;
      }

      return OK;
    },
    snapshot(): ToolLoopDetectorSnapshot {
      return {
        observations: [...observations.values()].map((entry) => ({
          fingerprint: entry.fingerprint,
          toolKind: entry.toolKind,
          toolName: entry.toolName,
          argumentsDigest: entry.argumentsDigest,
          count: entry.count,
          lastObservedAt: entry.lastObservedAt,
          ...(entry.lastObservedDeltaDigest === undefined
            ? {}
            : { lastObservedDeltaDigest: entry.lastObservedDeltaDigest }),
        })),
        recentFingerprints: [...recentFingerprints],
        warnings: warnings.map((warning) => ({ ...warning })),
        vetoes: vetoes.map((veto) => ({ ...veto })),
      };
    },
  };
}

export const AUTO_ARCHIVE_TOOL_LOOP_DISABLED = 'AUTO_ARCHIVE_TOOL_LOOP_DISABLED';
export const AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT =
  'AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT';
export const AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT =
  'AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT';
export const AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH =
  'AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH';
export const AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH =
  'AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH';
export const AUTO_ARCHIVE_TOOL_LOOP_RECENT_WINDOW_SIZE =
  'AUTO_ARCHIVE_TOOL_LOOP_RECENT_WINDOW_SIZE';
export const AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS =
  'AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS';

export interface ResolvedToolLoopDetectorConfig {
  /** `false` means the detector is disabled. `undefined` means default. */
  readonly detector: ToolLoopDetector | false | undefined;
  /** Resolved options snapshot for /doctor + tests. `undefined` when default. */
  readonly resolvedOptions: ToolLoopDetectorOptions | undefined;
}

/**
 * Read the operator-tunable detector knobs from env. Returns `{ detector: undefined }`
 * when no knob is set so the caller falls back to the standard
 * `createToolLoopDetector()` defaults. Returns `{ detector: false }` when the
 * detector is explicitly disabled (operator opt-out for legitimate long-poll
 * workloads). Otherwise returns a configured detector + the resolved option
 * snapshot for surfacing in /doctor.
 *
 * env knobs (all optional):
 *   AUTO_ARCHIVE_TOOL_LOOP_DISABLED                 — "1"/"true" disables entirely
 *   AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT        — int, default 6
 *   AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT        — int, default 4
 *   AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH    — int, default 10
 *   AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH    — int, default 6
 *   AUTO_ARCHIVE_TOOL_LOOP_RECENT_WINDOW_SIZE       — int, default 20
 *   AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS      — comma-separated tool
 *                                                     names, additive to defaults
 *
 * Invalid values throw. The bootstrap surfaces this as a fatal startup error
 * so an operator typo never silently degrades to the default ceiling.
 */
export function resolveToolLoopDetectorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedToolLoopDetectorConfig {
  const disabled = readBooleanEnv(env, AUTO_ARCHIVE_TOOL_LOOP_DISABLED);
  if (disabled === true) {
    return { detector: false, resolvedOptions: undefined };
  }
  const vetoRepeatCount = readPositiveIntEnv(
    env,
    AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT,
  );
  const warnRepeatCount = readPositiveIntEnv(
    env,
    AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT,
  );
  const vetoPingPongLength = readPositiveIntEnv(
    env,
    AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH,
  );
  const warnPingPongLength = readPositiveIntEnv(
    env,
    AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH,
  );
  const recentWindowSize = readPositiveIntEnv(
    env,
    AUTO_ARCHIVE_TOOL_LOOP_RECENT_WINDOW_SIZE,
  );
  const extraPollingTools = readPollingToolListEnv(
    env,
    AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS,
  );

  const anySet =
    vetoRepeatCount !== undefined ||
    warnRepeatCount !== undefined ||
    vetoPingPongLength !== undefined ||
    warnPingPongLength !== undefined ||
    recentWindowSize !== undefined ||
    extraPollingTools !== undefined;
  if (!anySet) {
    return { detector: undefined, resolvedOptions: undefined };
  }

  // warn must be < veto (parity with `createToolLoopDetector`'s implicit
  // expectations: warn fires earlier than veto on the same fingerprint).
  const effectiveWarnRepeat = warnRepeatCount ?? DEFAULT_WARN_REPEAT_COUNT;
  const effectiveVetoRepeat = vetoRepeatCount ?? DEFAULT_VETO_REPEAT_COUNT;
  if (effectiveWarnRepeat >= effectiveVetoRepeat) {
    throw new Error(
      `${AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT} (${effectiveWarnRepeat}) ` +
        `must be strictly less than ${AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT} ` +
        `(${effectiveVetoRepeat}).`,
    );
  }
  const effectiveWarnPingPong =
    warnPingPongLength ?? DEFAULT_WARN_PING_PONG_LENGTH;
  const effectiveVetoPingPong =
    vetoPingPongLength ?? DEFAULT_VETO_PING_PONG_LENGTH;
  if (effectiveWarnPingPong >= effectiveVetoPingPong) {
    throw new Error(
      `${AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH} ` +
        `(${effectiveWarnPingPong}) must be strictly less than ` +
        `${AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH} ` +
        `(${effectiveVetoPingPong}).`,
    );
  }

  const knownPollingTools =
    extraPollingTools === undefined
      ? undefined
      : Array.from(new Set([...DEFAULT_POLLING_TOOLS, ...extraPollingTools]));

  const resolvedOptions: ToolLoopDetectorOptions = {
    ...(vetoRepeatCount === undefined ? {} : { vetoRepeatCount }),
    ...(warnRepeatCount === undefined ? {} : { warnRepeatCount }),
    ...(vetoPingPongLength === undefined ? {} : { vetoPingPongLength }),
    ...(warnPingPongLength === undefined ? {} : { warnPingPongLength }),
    ...(recentWindowSize === undefined ? {} : { recentWindowSize }),
    ...(knownPollingTools === undefined ? {} : { knownPollingTools }),
  };
  return {
    detector: createToolLoopDetector(resolvedOptions),
    resolvedOptions,
  };
}

function readBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const lowered = raw.toLowerCase();
  if (lowered === '1' || lowered === 'true' || lowered === 'yes') return true;
  if (lowered === '0' || lowered === 'false' || lowered === 'no') return false;
  throw new Error(
    `${name} must be one of "1"/"0"/"true"/"false"/"yes"/"no" (got ${JSON.stringify(raw)}).`,
  );
}

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer (got ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}

function readPollingToolListEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): readonly string[] | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const tools = raw
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  if (tools.length === 0) {
    throw new Error(
      `${name} must contain at least one non-empty tool name (got ${JSON.stringify(raw)}).`,
    );
  }
  return tools;
}
