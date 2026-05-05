import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isCapabilityFlag,
  type CapabilityFlag,
} from '../contracts/capability-flag.js';
import {
  TRAIT_MODULE_SCHEMA_VERSION,
  isTraitModuleId,
  type TraitCronSchedule,
  type TraitModuleId,
  type TraitModuleManifest,
  type TraitRuntimeSpec,
  type TraitScheduleDelivery,
} from '../contracts/trait-module.js';
import type {
  TraitRuntimeDriverDecorator,
  TraitRuntimeEntrypointContext,
  TraitRuntimeHookEntrypoint,
  TraitRuntimeHookResult,
  TraitRuntimeModuleImporter,
} from '../contracts/trait-runtime-hook.js';

export const TRAIT_MODULE_LOADER_VERSION = '2026-04-30' as const;
export const TRAIT_SCHEDULER_STATE_SCHEMA_VERSION = 1 as const;

/**
 * M5a — Tier-1 lifecycle hook names that AgentRuntime recognises.
 *
 * This is an ALLOWLIST for hooks a trait module may export; it is
 * deliberately separate from RESERVED_KERNEL_AUTHORITY_MANIFEST_KEYS
 * (which is a denylist for manifest *claims*). Order is stable and
 * matches the invocation order inside execute().
 */
export const TRAIT_RUNTIME_HOOK_ALLOWLIST = Object.freeze([
  // M5a — Tier-1 lifecycle hooks
  'beforeDispatch',
  'afterDispatch',
  'onTerminalEvidence',
  // M5b — Tier-2 mid-cycle hooks
  'subagentSpawn',
  'subagentTerminal',
  'skillAdmit',
  'skillBumpUse',
  'commandIntercept',
  // M5c — Tier-3 observe-only hooks
  'providerSelectObserve',
  'promptCacheBreakpointObserve',
  'ledgerAppendObserve',
  'insightsSnapshotObserve',
  'doctorProbeObserve',
  'cronTickObserve',
  'acpSessionObserve',
] as const);

const RESERVED_KERNEL_AUTHORITY_MANIFEST_KEYS = Object.freeze([
  'extensionPoints',
  'kernelReplacement',
  'kernelModuleKind',
  'dispatcherOverride',
  'planaReplacement',
  'runtimeProvider',
  'runtimeProviderSwitch',
  'providerSwitch',
  'computeAllocator',
  'terminalCauseRewrite',
  'authOverride',
  'unboundedDaemon',
] as const);

export type TraitModuleLoaderErrorCode =
  | 'traits-root-not-directory'
  | 'manifest-json-invalid'
  | 'manifest-shape-invalid'
  | 'instruction-missing'
  | 'duplicate-id-version'
  | 'path-outside-workspace'
  | 'runtime-trust-boundary-rejected'
  | 'runtime-export-invalid'
  | 'runtime-capability-rejected'
  | 'runtime-import-failed'
  | 'runtime-timeout'
  | 'runtime-hook-threw';

export class TraitModuleLoaderError extends Error {
  readonly code: TraitModuleLoaderErrorCode;
  readonly manifestPath?: string;

  constructor(
    code: TraitModuleLoaderErrorCode,
    message: string,
    options: { readonly manifestPath?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TraitModuleLoaderError';
    this.code = code;
    this.manifestPath = options.manifestPath;
  }
}

export interface TraitModuleRegistryEntry {
  readonly manifest: TraitModuleManifest;
  readonly manifestPath: string;
  readonly rootPath: string;
  readonly instructionPath: string;
  readonly registryKey: string;
}

export interface TraitModuleRegistry {
  readonly entries: readonly TraitModuleRegistryEntry[];
  readonly byRegistryKey: ReadonlyMap<string, TraitModuleRegistryEntry>;
  readonly byId: ReadonlyMap<TraitModuleId, readonly TraitModuleRegistryEntry[]>;
}

export interface DiscoverTraitModuleManifestsOptions {
  /** Repository/workspace root used to bound trait paths. */
  readonly workspaceRoot: string;
  /** Relative or absolute traits root. Defaults to `${workspaceRoot}/traits`. */
  readonly traitsRoot?: string;
}

export function traitModuleRegistryKey(manifest: TraitModuleManifest): string {
  return `${manifest.id}@${manifest.version}`;
}

export function traitModuleFamilyId(id: TraitModuleId): string {
  return id.replace(/\.v[1-9][0-9]*$/u, '');
}

export function traitModuleMajorVersion(id: TraitModuleId): number {
  const match = id.match(/\.v([1-9][0-9]*)$/u);
  if (match === null) {
    throw new Error(`Invalid TraitModuleId: ${id}`);
  }
  return Number.parseInt(match[1], 10);
}

export function isTraitModuleMajorSuccessor(
  previousId: TraitModuleId,
  nextId: TraitModuleId,
): boolean {
  return (
    traitModuleFamilyId(previousId) === traitModuleFamilyId(nextId) &&
    traitModuleMajorVersion(nextId) > traitModuleMajorVersion(previousId)
  );
}

export function discoverTraitModuleManifests(
  options: DiscoverTraitModuleManifestsOptions,
): TraitModuleRegistry {
  const workspaceRoot = resolve(options.workspaceRoot);
  const traitsRoot = resolveBoundedPath(
    workspaceRoot,
    options.traitsRoot ?? 'traits',
    'traits-root-not-directory',
  );

  if (!existsSync(traitsRoot)) {
    return createTraitModuleRegistry([]);
  }
  if (!statSync(traitsRoot).isDirectory()) {
    throw new TraitModuleLoaderError(
      'traits-root-not-directory',
      `Trait modules root is not a directory: ${traitsRoot}`,
    );
  }

  const manifestPaths = findTraitManifestPaths(traitsRoot);
  const entries = manifestPaths
    .map((manifestPath) =>
      loadTraitModuleManifestFromPath({ workspaceRoot, manifestPath }),
    )
    .sort((a, b) => a.registryKey.localeCompare(b.registryKey));
  return createTraitModuleRegistry(entries);
}

export function loadTraitModuleManifestFromPath(input: {
  readonly workspaceRoot: string;
  readonly manifestPath: string;
}): TraitModuleRegistryEntry {
  const workspaceRoot = resolve(input.workspaceRoot);
  const manifestPath = resolveBoundedPath(
    workspaceRoot,
    input.manifestPath,
    'path-outside-workspace',
  );

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new TraitModuleLoaderError(
      'manifest-json-invalid',
      `Trait module manifest is not valid JSON: ${manifestPath}`,
      { manifestPath, cause: error },
    );
  }

  const manifest = parseTraitModuleManifest(raw, manifestPath);
  const rootPath = resolveBoundedPath(
    workspaceRoot,
    manifest.layout.root,
    'path-outside-workspace',
  );
  const instructionPath = resolveBoundedPath(
    rootPath,
    manifest.instructions.entrypoint,
    'path-outside-workspace',
  );
  const declaredManifestPath = resolveBoundedPath(
    rootPath,
    manifest.layout.manifest,
    'path-outside-workspace',
  );

  if (declaredManifestPath !== manifestPath) {
    throw new TraitModuleLoaderError(
      'manifest-shape-invalid',
      `Trait module manifest layout.manifest does not point to the loaded trait.json: ${manifestPath}`,
      { manifestPath },
    );
  }
  if (!existsSync(instructionPath) || !statSync(instructionPath).isFile()) {
    throw new TraitModuleLoaderError(
      'instruction-missing',
      `Trait module instruction entrypoint is missing: ${instructionPath}`,
      { manifestPath },
    );
  }

  return {
    manifest,
    manifestPath,
    rootPath,
    instructionPath,
    registryKey: traitModuleRegistryKey(manifest),
  };
}

export function parseTraitModuleManifest(
  value: unknown,
  manifestPath = '<memory>',
): TraitModuleManifest {
  const record = requireRecord(value, 'manifest', manifestPath);
  rejectReservedKernelAuthorityKeys(record, manifestPath);
  if (record['schemaVersion'] !== TRAIT_MODULE_SCHEMA_VERSION) {
    throwInvalidManifest(manifestPath, 'schemaVersion must be 1.');
  }
  const id = requireString(record, 'id', manifestPath);
  if (!isTraitModuleId(id)) {
    throwInvalidManifest(manifestPath, `id must match trait.<namespace>.vN: ${id}`);
  }
  const name = requireNonEmptyString(record, 'name', manifestPath);
  const version = requireSemver(record, 'version', manifestPath);
  const trustBoundary = requireOneOf(
    record,
    'trustBoundary',
    ['repository-owned', 'workspace-local', 'external'] as const,
    manifestPath,
  );

  const layout = requireRecord(record['layout'], 'layout', manifestPath);
  rejectReservedKernelAuthorityKeys(layout, manifestPath);
  const layoutRoot = requireRelativePath(layout, 'root', manifestPath);
  const layoutManifest = requireRelativePath(layout, 'manifest', manifestPath);
  const layoutInstruction = requireRelativePath(layout, 'instruction', manifestPath);
  const runtimeDir = optionalRelativePath(layout, 'runtimeDir', manifestPath);
  const schedulesDir = optionalRelativePath(layout, 'schedulesDir', manifestPath);

  const instructions = requireRecord(record['instructions'], 'instructions', manifestPath);
  rejectReservedKernelAuthorityKeys(instructions, manifestPath);
  const instructionEntrypoint = requireRelativePath(
    instructions,
    'entrypoint',
    manifestPath,
  );
  const instructionFormat = requireOneOf(
    instructions,
    'format',
    ['markdown'] as const,
    manifestPath,
  );
  const instructionSummary = requireNonEmptyString(
    instructions,
    'summary',
    manifestPath,
  );
  if (layoutInstruction !== instructionEntrypoint) {
    throwInvalidManifest(
      manifestPath,
      'layout.instruction must match instructions.entrypoint.',
    );
  }

  const schedule = parseTraitScheduleSpec(record['schedule'], manifestPath);
  const runtime = parseTraitRuntimeSpec(record['runtime'], manifestPath);
  const admission = requireRecord(record['admission'], 'admission', manifestPath);
  rejectReservedKernelAuthorityKeys(admission, manifestPath);
  const defaultRequested = requireBoolean(admission, 'defaultRequested', manifestPath);
  const requiredCapabilityFlags = requireCapabilityFlagArray(
    admission,
    'requiredCapabilityFlags',
    manifestPath,
  );
  const forbiddenCapabilityFlags = requireCapabilityFlagArray(
    admission,
    'forbiddenCapabilityFlags',
    manifestPath,
  );
  const provenance = requireNonEmptyString(admission, 'provenance', manifestPath);
  const sourceMapIds = requireStringArray(record, 'sourceMapIds', manifestPath);

  return {
    schemaVersion: TRAIT_MODULE_SCHEMA_VERSION,
    id,
    name,
    version,
    trustBoundary,
    layout: {
      root: layoutRoot,
      manifest: layoutManifest,
      instruction: layoutInstruction,
      ...(runtimeDir === undefined ? {} : { runtimeDir }),
      ...(schedulesDir === undefined ? {} : { schedulesDir }),
    },
    instructions: {
      entrypoint: instructionEntrypoint,
      format: instructionFormat,
      summary: instructionSummary,
    },
    schedule,
    runtime,
    admission: {
      defaultRequested,
      requiredCapabilityFlags,
      forbiddenCapabilityFlags,
      provenance,
    },
    sourceMapIds,
  };
}

export type TraitModuleAmbientForbiddenStrictMode = 'reject' | 'log' | 'ignore';

export interface TraitModuleCapabilityBoundaryInput {
  readonly manifest: TraitModuleManifest;
  /** Capabilities requested by the module/runtime hook itself. */
  readonly moduleRequestedCapabilityFlags?: readonly CapabilityFlag[];
  /** Ambient capabilities already granted to the host allocation. */
  readonly hostGrantedCapabilityFlags?: readonly CapabilityFlag[];
  /**
   * How to treat ambient host capabilities that overlap the manifest's
   * forbidden list. Default `'ignore'` preserves the historical permissive
   * posture: ambient overlap is reported in the result but does not affect
   * `status`. `'log'` additionally writes a structured `console.warn` so
   * operators can observe the leak. `'reject'` flips `status` to `'rejected'`.
   */
  readonly ambientForbiddenStrictMode?: TraitModuleAmbientForbiddenStrictMode;
}

export interface TraitModuleCapabilityBoundaryResult {
  readonly status: 'approved' | 'rejected';
  readonly missingRequiredCapabilityFlags: readonly CapabilityFlag[];
  readonly forbiddenSelfRequestedCapabilityFlags: readonly CapabilityFlag[];
  readonly ambientForbiddenCapabilityFlagsIgnored: readonly CapabilityFlag[];
}

export function evaluateTraitModuleCapabilityBoundary(
  input: TraitModuleCapabilityBoundaryInput,
): TraitModuleCapabilityBoundaryResult {
  const moduleRequested = new Set(input.moduleRequestedCapabilityFlags ?? []);
  const hostGranted = new Set(input.hostGrantedCapabilityFlags ?? []);
  const forbidden = new Set(input.manifest.admission.forbiddenCapabilityFlags);
  const required = input.manifest.admission.requiredCapabilityFlags;
  const strictMode: TraitModuleAmbientForbiddenStrictMode =
    input.ambientForbiddenStrictMode ?? 'ignore';

  const missingRequiredCapabilityFlags = required.filter(
    (flag) => !moduleRequested.has(flag) && !hostGranted.has(flag),
  );
  const forbiddenSelfRequestedCapabilityFlags = [...moduleRequested].filter((flag) =>
    forbidden.has(flag),
  );
  const ambientForbiddenCapabilityFlagsIgnored = [...hostGranted].filter((flag) =>
    forbidden.has(flag),
  );

  if (
    ambientForbiddenCapabilityFlagsIgnored.length > 0 &&
    strictMode === 'log'
  ) {
    try {
      console.warn(
        `trait-module-ambient-forbidden-flags-ignored ${JSON.stringify({
          event: 'trait-module-ambient-forbidden-flags-ignored',
          moduleId: input.manifest.id,
          moduleVersion: input.manifest.version,
          flags: ambientForbiddenCapabilityFlagsIgnored,
        })}`,
      );
    } catch {
      // best-effort log; never fail the admission boundary because of a
      // serialization or logger error.
    }
  }

  const ambientRejection =
    strictMode === 'reject' &&
    ambientForbiddenCapabilityFlagsIgnored.length > 0;

  return {
    status:
      missingRequiredCapabilityFlags.length === 0 &&
      forbiddenSelfRequestedCapabilityFlags.length === 0 &&
      !ambientRejection
        ? 'approved'
        : 'rejected',
    missingRequiredCapabilityFlags,
    forbiddenSelfRequestedCapabilityFlags,
    ambientForbiddenCapabilityFlagsIgnored,
  };
}

export interface TraitScheduleDeliveryContext {
  readonly moduleId: TraitModuleId;
  readonly scheduleId: string;
  readonly currentSessionId?: string;
  readonly mainSessionId?: string;
}

export type TraitScheduleDeliveryTarget =
  | { readonly kind: 'main-session'; readonly sessionId: string }
  | { readonly kind: 'current-session'; readonly sessionId: string }
  | { readonly kind: 'isolated-session'; readonly sessionKey: string };

export interface TraitSchedulerJobRecord {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_STATE_SCHEMA_VERSION;
  readonly jobId: string;
  readonly moduleId: TraitModuleId;
  readonly moduleVersion: string;
  readonly scheduleId: string;
  readonly cron: string;
  readonly timezone: string;
  readonly delivery: TraitScheduleDelivery;
  readonly deliveryTarget: TraitScheduleDeliveryTarget;
  readonly summary: string;
  readonly state: 'scheduled';
  readonly maxRetries: number;
  readonly retentionDays: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TraitSchedulerState {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly jobs: readonly TraitSchedulerJobRecord[];
}

export interface BuildTraitSchedulerDryRunOptions {
  readonly manifests: readonly TraitModuleManifest[];
  readonly now?: string;
  readonly currentSessionId?: string;
  readonly mainSessionId?: string;
  readonly defaultTimezone?: string;
  readonly maxRetries?: number;
  readonly retentionDays?: number;
}

export function buildTraitSchedulerDryRun(
  options: BuildTraitSchedulerDryRunOptions,
): TraitSchedulerState {
  const now = options.now ?? new Date().toISOString();
  const jobs: TraitSchedulerJobRecord[] = [];
  for (const manifest of options.manifests) {
    if (manifest.schedule.mode === 'none') {
      continue;
    }
    for (const schedule of manifest.schedule.schedules) {
      jobs.push({
        schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
        jobId: `${manifest.id}:${manifest.version}:${schedule.id}`,
        moduleId: manifest.id,
        moduleVersion: manifest.version,
        scheduleId: schedule.id,
        cron: schedule.cron,
        timezone: schedule.timezone ?? options.defaultTimezone ?? 'UTC',
        delivery: schedule.delivery,
        deliveryTarget: resolveTraitScheduleDeliveryTarget(schedule.delivery, {
          moduleId: manifest.id,
          scheduleId: schedule.id,
          currentSessionId: options.currentSessionId,
          mainSessionId: options.mainSessionId,
        }),
        summary: schedule.summary,
        state: 'scheduled',
        maxRetries: options.maxRetries ?? 3,
        retentionDays: options.retentionDays ?? 30,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return {
    schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
    updatedAt: now,
    jobs,
  };
}

export function resolveTraitScheduleDeliveryTarget(
  delivery: TraitScheduleDelivery,
  context: TraitScheduleDeliveryContext,
): TraitScheduleDeliveryTarget {
  switch (delivery) {
    case 'main-session': {
      if (context.mainSessionId === undefined || context.mainSessionId.length === 0) {
        throw new Error('main-session delivery requires mainSessionId.');
      }
      return { kind: 'main-session', sessionId: context.mainSessionId };
    }
    case 'current-session': {
      if (
        context.currentSessionId === undefined ||
        context.currentSessionId.length === 0
      ) {
        throw new Error('current-session delivery requires currentSessionId.');
      }
      return { kind: 'current-session', sessionId: context.currentSessionId };
    }
    case 'isolated-session':
      return {
        kind: 'isolated-session',
        sessionKey: `trait-schedule:${context.moduleId}:${context.scheduleId}`,
      };
    default: {
      const exhausted: never = delivery;
      return exhausted;
    }
  }
}

export class JsonFileTraitSchedulerStore {
  constructor(private readonly filePath: string) {}

  load(): TraitSchedulerState {
    if (!existsSync(this.filePath)) {
      return {
        schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
        updatedAt: new Date(0).toISOString(),
        jobs: [],
      };
    }
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    return parseTraitSchedulerState(parsed, this.filePath);
  }

  save(state: TraitSchedulerState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
  }
}

/**
 * Validates a deserialized TraitSchedulerState against its declared shape.
 *
 * Persistence files are an external boundary even when the writer is
 * trusted: a partial write, a tampered file, or a schema-skew rollout can
 * present an object whose runtime shape disagrees with the static type.
 * Casting `JSON.parse(...)` straight to `TraitSchedulerState` defeats the
 * type system at exactly the place where validation should be most
 * defensive — all downstream readers assume each `jobs[i]` field is
 * present and well-typed.
 *
 * Throws with a path-tagged message on the first violation. The set of
 * required fields mirrors {@link TraitSchedulerJobRecord} 1:1.
 */
function parseTraitSchedulerState(
  value: unknown,
  filePath: string,
): TraitSchedulerState {
  const record = requireSchedulerRecord(value, 'scheduler state', filePath);
  if (record['schemaVersion'] !== TRAIT_SCHEDULER_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Trait scheduler state schemaVersion must be 1 at ${filePath}.`,
    );
  }
  const updatedAt = record['updatedAt'];
  if (typeof updatedAt !== 'string') {
    throw new Error(
      `Trait scheduler state updatedAt must be a string at ${filePath}.`,
    );
  }
  const rawJobs = record['jobs'];
  if (!Array.isArray(rawJobs)) {
    throw new Error(
      `Trait scheduler state jobs must be an array at ${filePath}.`,
    );
  }
  const jobs: TraitSchedulerJobRecord[] = rawJobs.map((entry, index) =>
    parseTraitSchedulerJobRecord(entry, filePath, index),
  );
  return {
    schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
    updatedAt,
    jobs,
  };
}

function parseTraitSchedulerJobRecord(
  value: unknown,
  filePath: string,
  index: number,
): TraitSchedulerJobRecord {
  const ctx = `${filePath} jobs[${String(index)}]`;
  const record = requireSchedulerRecord(value, 'job record', ctx);
  if (record['schemaVersion'] !== TRAIT_SCHEDULER_STATE_SCHEMA_VERSION) {
    throw new Error(`${ctx}: schemaVersion must be 1.`);
  }
  if (record['state'] !== 'scheduled') {
    throw new Error(`${ctx}: state must be 'scheduled'.`);
  }
  const moduleId = requireSchedulerString(record, 'moduleId', ctx);
  if (!isTraitModuleId(moduleId)) {
    throw new Error(`${ctx}: moduleId is not a valid TraitModuleId.`);
  }
  const delivery = requireSchedulerString(record, 'delivery', ctx);
  if (!TRAIT_SCHEDULE_DELIVERY_VALUES.includes(delivery)) {
    throw new Error(
      `${ctx}: delivery must be one of ${TRAIT_SCHEDULE_DELIVERY_VALUES.join(', ')}.`,
    );
  }
  const deliveryTarget = parseTraitScheduleDeliveryTarget(
    record['deliveryTarget'],
    ctx,
  );
  return {
    schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
    jobId: requireSchedulerString(record, 'jobId', ctx),
    moduleId,
    moduleVersion: requireSchedulerString(record, 'moduleVersion', ctx),
    scheduleId: requireSchedulerString(record, 'scheduleId', ctx),
    cron: requireSchedulerString(record, 'cron', ctx),
    timezone: requireSchedulerString(record, 'timezone', ctx),
    delivery: delivery as TraitScheduleDelivery,
    deliveryTarget,
    summary: requireSchedulerString(record, 'summary', ctx),
    state: 'scheduled',
    maxRetries: requireSchedulerInteger(record, 'maxRetries', ctx),
    retentionDays: requireSchedulerInteger(record, 'retentionDays', ctx),
    createdAt: requireSchedulerString(record, 'createdAt', ctx),
    updatedAt: requireSchedulerString(record, 'updatedAt', ctx),
  };
}

function parseTraitScheduleDeliveryTarget(
  value: unknown,
  ctx: string,
): TraitScheduleDeliveryTarget {
  const record = requireSchedulerRecord(value, 'deliveryTarget', ctx);
  const kind = record['kind'];
  if (kind === 'main-session' || kind === 'current-session') {
    return {
      kind,
      sessionId: requireSchedulerString(record, 'sessionId', `${ctx} deliveryTarget`),
    };
  }
  if (kind === 'isolated-session') {
    return {
      kind,
      sessionKey: requireSchedulerString(record, 'sessionKey', `${ctx} deliveryTarget`),
    };
  }
  throw new Error(
    `${ctx}: deliveryTarget.kind must be one of main-session, current-session, isolated-session.`,
  );
}

const TRAIT_SCHEDULE_DELIVERY_VALUES: readonly string[] = [
  'main-session',
  'isolated-session',
  'current-session',
];

function requireSchedulerRecord(
  value: unknown,
  fieldName: string,
  ctx: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${ctx}: ${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireSchedulerString(
  record: Record<string, unknown>,
  key: string,
  ctx: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${ctx}: ${key} must be a string.`);
  }
  return value;
}

function requireSchedulerInteger(
  record: Record<string, unknown>,
  key: string,
  ctx: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${ctx}: ${key} must be a non-negative integer.`);
  }
  return value;
}

export interface InvokeTraitRuntimeHookOptions {
  readonly workspaceRoot: string;
  readonly importModule?: TraitRuntimeModuleImporter;
  readonly timeoutMs?: number;
  readonly allowWorkspaceLocal?: boolean;
  readonly allowExternal?: boolean;
  readonly moduleRequestedCapabilityFlags?: readonly CapabilityFlag[];
  readonly hostGrantedCapabilityFlags?: readonly CapabilityFlag[];
  readonly ambientForbiddenStrictMode?: TraitModuleAmbientForbiddenStrictMode;
}

export interface TraitRuntimeHookInvocation {
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly manifestId: TraitModuleId;
  readonly manifestVersion: string;
  readonly hook: TraitRuntimeSpec['hook'];
  readonly summary: string;
  readonly errorCode?: TraitModuleLoaderErrorCode;
  readonly errorMessage?: string;
  readonly result?: TraitRuntimeHookResult;
}

export interface TraitRuntimeDriverDecoratorLoadOptions {
  readonly workspaceRoot: string;
  readonly importModule?: TraitRuntimeModuleImporter;
  readonly timeoutMs?: number;
  readonly allowWorkspaceLocal?: boolean;
  readonly allowExternal?: boolean;
  readonly moduleRequestedCapabilityFlags?: readonly CapabilityFlag[];
  readonly hostGrantedCapabilityFlags?: readonly CapabilityFlag[];
  readonly ambientForbiddenStrictMode?: TraitModuleAmbientForbiddenStrictMode;
}

export interface TraitRuntimeDriverDecoratorLoad {
  readonly status: 'loaded' | 'skipped' | 'failed';
  readonly manifestId: TraitModuleId;
  readonly manifestVersion: string;
  readonly hook: TraitRuntimeSpec['hook'];
  readonly summary: string;
  readonly errorCode?: TraitModuleLoaderErrorCode;
  readonly errorMessage?: string;
  readonly decorator?: TraitRuntimeDriverDecorator;
}

export async function invokeTraitRuntimeHook(
  manifest: TraitModuleManifest,
  context: Omit<TraitRuntimeEntrypointContext, 'moduleId' | 'moduleVersion'>,
  options: InvokeTraitRuntimeHookOptions,
): Promise<TraitRuntimeHookInvocation> {
  if (manifest.runtime.hook === 'none') {
    return {
      status: 'skipped',
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      hook: 'none',
      summary: 'TraitModule runtime hook is disabled.',
    };
  }

  const boundary = evaluateTraitModuleCapabilityBoundary({
    manifest,
    moduleRequestedCapabilityFlags: options.moduleRequestedCapabilityFlags,
    hostGrantedCapabilityFlags: options.hostGrantedCapabilityFlags,
    ambientForbiddenStrictMode: options.ambientForbiddenStrictMode,
  });
  if (boundary.status === 'rejected') {
    return {
      status: 'failed',
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      hook: manifest.runtime.hook,
      summary: 'TraitModule runtime hook capability boundary rejected execution.',
      errorCode: 'runtime-capability-rejected',
      errorMessage: JSON.stringify({
        missingRequiredCapabilityFlags: boundary.missingRequiredCapabilityFlags,
        forbiddenSelfRequestedCapabilityFlags:
          boundary.forbiddenSelfRequestedCapabilityFlags,
      }),
    };
  }
  if (manifest.runtime.hook !== 'module-entrypoint') {
    return runtimeFailure(
      manifest,
      'runtime-export-invalid',
      `TraitModule runtime hook ${manifest.runtime.hook} is not a module-entrypoint.`,
    );
  }

  if (
    manifest.trustBoundary === 'workspace-local' &&
    options.allowWorkspaceLocal !== true
  ) {
    return runtimeFailure(
      manifest,
      'runtime-trust-boundary-rejected',
      'workspace-local TraitModule runtime hooks require allowWorkspaceLocal=true.',
    );
  }
  if (manifest.trustBoundary === 'external' && options.allowExternal !== true) {
    return runtimeFailure(
      manifest,
      'runtime-trust-boundary-rejected',
      'external TraitModule runtime hooks require allowExternal=true.',
    );
  }

  const workspaceRoot = resolve(options.workspaceRoot);
  let moduleSpecifier: string;
  try {
    moduleSpecifier = resolveRuntimeModuleSpecifier(
      workspaceRoot,
      manifest.runtime.modulePath,
      options.importModule !== undefined,
    );
  } catch (error) {
    return runtimeFailure(
      manifest,
      'path-outside-workspace',
      error instanceof Error ? error.message : String(error),
    );
  }

  let moduleExports: Readonly<Record<string, unknown>>;
  try {
    const importer: TraitRuntimeModuleImporter =
      options.importModule ??
      ((specifier) =>
        import(specifier) as Promise<Readonly<Record<string, unknown>>>);
    moduleExports = await withTimeout(
      importer(moduleSpecifier),
      options.timeoutMs ?? 5_000,
    );
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'trait-runtime-timeout';
    return runtimeFailure(
      manifest,
      isTimeout ? 'runtime-timeout' : 'runtime-import-failed',
      isTimeout
        ? `TraitModule runtime hook import timed out after ${options.timeoutMs ?? 5_000}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  const entrypoint = moduleExports[manifest.runtime.exportName];
  if (typeof entrypoint !== 'function') {
    return runtimeFailure(
      manifest,
      'runtime-export-invalid',
      `TraitModule runtime export ${manifest.runtime.exportName} is not a function.`,
    );
  }

  try {
    const result = await withTimeout(
      Promise.resolve(
        (entrypoint as TraitRuntimeHookEntrypoint)({
          moduleId: manifest.id,
          moduleVersion: manifest.version,
          ...context,
        }),
      ),
      options.timeoutMs ?? 5_000,
    );
    if (!isTraitRuntimeHookResult(result)) {
      return runtimeFailure(
        manifest,
        'runtime-export-invalid',
        'TraitModule runtime hook returned an invalid result shape.',
      );
    }
    return {
      status: result.status,
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      hook: manifest.runtime.hook,
      summary: result.summary,
      result,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'trait-runtime-timeout';
    return runtimeFailure(
      manifest,
      isTimeout ? 'runtime-timeout' : 'runtime-hook-threw',
      isTimeout
        ? `TraitModule runtime hook timed out after ${options.timeoutMs ?? 5_000}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

export async function loadTraitRuntimeDriverDecorator(
  manifest: TraitModuleManifest,
  options: TraitRuntimeDriverDecoratorLoadOptions,
): Promise<TraitRuntimeDriverDecoratorLoad> {
  if (manifest.runtime.hook === 'none') {
    return {
      status: 'skipped',
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      hook: 'none',
      summary: 'TraitModule runtime hook is disabled.',
    };
  }
  if (manifest.runtime.hook !== 'evidence-decorator') {
    return runtimeDecoratorFailure(
      manifest,
      'runtime-export-invalid',
      `TraitModule runtime hook ${manifest.runtime.hook} is not an evidence-decorator.`,
    );
  }

  const boundary = evaluateTraitModuleCapabilityBoundary({
    manifest,
    moduleRequestedCapabilityFlags: options.moduleRequestedCapabilityFlags,
    hostGrantedCapabilityFlags: options.hostGrantedCapabilityFlags,
    ambientForbiddenStrictMode: options.ambientForbiddenStrictMode,
  });
  if (boundary.status === 'rejected') {
    return runtimeDecoratorFailure(
      manifest,
      'runtime-capability-rejected',
      JSON.stringify({
        missingRequiredCapabilityFlags: boundary.missingRequiredCapabilityFlags,
        forbiddenSelfRequestedCapabilityFlags:
          boundary.forbiddenSelfRequestedCapabilityFlags,
        ambientForbiddenCapabilityFlagsIgnored:
          boundary.ambientForbiddenCapabilityFlagsIgnored,
      }),
    );
  }

  if (
    manifest.trustBoundary === 'workspace-local' &&
    options.allowWorkspaceLocal !== true
  ) {
    return runtimeDecoratorFailure(
      manifest,
      'runtime-trust-boundary-rejected',
      'workspace-local TraitModule runtime decorators require allowWorkspaceLocal=true.',
    );
  }
  if (manifest.trustBoundary === 'external' && options.allowExternal !== true) {
    return runtimeDecoratorFailure(
      manifest,
      'runtime-trust-boundary-rejected',
      'external TraitModule runtime decorators require allowExternal=true.',
    );
  }

  const workspaceRoot = resolve(options.workspaceRoot);
  let moduleSpecifier: string;
  try {
    moduleSpecifier = resolveRuntimeModuleSpecifier(
      workspaceRoot,
      manifest.runtime.modulePath,
      options.importModule !== undefined,
    );
  } catch (error) {
    return runtimeDecoratorFailure(
      manifest,
      'path-outside-workspace',
      error instanceof Error ? error.message : String(error),
    );
  }

  let moduleExports: Readonly<Record<string, unknown>>;
  try {
    const importer: TraitRuntimeModuleImporter =
      options.importModule ??
      ((specifier) =>
        import(specifier) as Promise<Readonly<Record<string, unknown>>>);
    moduleExports = await withTimeout(
      importer(moduleSpecifier),
      options.timeoutMs ?? 5_000,
    );
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'trait-runtime-timeout';
    return runtimeDecoratorFailure(
      manifest,
      isTimeout ? 'runtime-timeout' : 'runtime-import-failed',
      isTimeout
        ? `TraitModule runtime decorator import timed out after ${options.timeoutMs ?? 5_000}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  const entrypoint = moduleExports[manifest.runtime.exportName];
  if (typeof entrypoint !== 'function') {
    return runtimeDecoratorFailure(
      manifest,
      'runtime-export-invalid',
      `TraitModule runtime decorator export ${manifest.runtime.exportName} is not a function.`,
    );
  }

  return {
    status: 'loaded',
    manifestId: manifest.id,
    manifestVersion: manifest.version,
    hook: manifest.runtime.hook,
    summary: `TraitModule runtime decorator ${manifest.runtime.exportName} loaded.`,
    decorator: entrypoint as TraitRuntimeDriverDecorator,
  };
}


function resolveRuntimeModuleSpecifier(
  workspaceRoot: string,
  modulePath: string,
  preserveSourceSpecifier: boolean,
): string {
  const sourcePath = resolveBoundedPath(
    workspaceRoot,
    modulePath,
    'path-outside-workspace',
  );
  if (!preserveSourceSpecifier && modulePath.endsWith('.ts')) {
    const jsSibling = `${sourcePath.slice(0, -3)}.js`;
    if (existsSync(jsSibling)) {
      return pathToFileURL(jsSibling).href;
    }
    const distModulePath = `dist/${modulePath.slice(0, -3)}.js`;
    const distJs = resolveBoundedPath(
      workspaceRoot,
      distModulePath,
      'path-outside-workspace',
    );
    if (existsSync(distJs)) {
      return pathToFileURL(distJs).href;
    }
  }
  return pathToFileURL(sourcePath).href;
}

function createTraitModuleRegistry(
  entries: readonly TraitModuleRegistryEntry[],
): TraitModuleRegistry {
  const byRegistryKey = new Map<string, TraitModuleRegistryEntry>();
  const byIdMutable = new Map<TraitModuleId, TraitModuleRegistryEntry[]>();
  for (const entry of entries) {
    if (byRegistryKey.has(entry.registryKey)) {
      throw new TraitModuleLoaderError(
        'duplicate-id-version',
        `Duplicate TraitModule manifest id/version: ${entry.registryKey}`,
        { manifestPath: entry.manifestPath },
      );
    }
    byRegistryKey.set(entry.registryKey, entry);
    const existing = byIdMutable.get(entry.manifest.id) ?? [];
    existing.push(entry);
    byIdMutable.set(entry.manifest.id, existing);
  }
  const byId = new Map<TraitModuleId, readonly TraitModuleRegistryEntry[]>();
  for (const [id, values] of byIdMutable) {
    byId.set(id, Object.freeze([...values]));
  }
  return {
    entries: Object.freeze([...entries]),
    byRegistryKey,
    byId,
  };
}

function findTraitManifestPaths(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && basename(path) === 'trait.json') {
        out.push(path);
      }
    }
  };
  visit(root);
  return out.sort();
}

function resolveBoundedPath(
  base: string,
  target: string,
  code: TraitModuleLoaderErrorCode,
): string {
  if (target.trim().length === 0) {
    throw new TraitModuleLoaderError(code, 'Path must be non-empty.');
  }
  const resolvedBase = resolve(base);
  const resolved = isAbsolute(target) ? resolve(target) : resolve(resolvedBase, target);
  const rel = relative(resolvedBase, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolved;
  }
  throw new TraitModuleLoaderError(
    code,
    `Path escapes the allowed root: ${target}`,
  );
}

function requireRecord(
  value: unknown,
  fieldName: string,
  manifestPath: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throwInvalidManifest(manifestPath, `${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throwInvalidManifest(manifestPath, `${key} must be a string.`);
  }
  return value;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): string {
  const value = requireString(record, key, manifestPath).trim();
  if (value.length === 0) {
    throwInvalidManifest(manifestPath, `${key} must be non-empty.`);
  }
  return value;
}

function requireSemver(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): string {
  const value = requireNonEmptyString(record, key, manifestPath);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throwInvalidManifest(manifestPath, `${key} must be a semver string.`);
  }
  return value;
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throwInvalidManifest(manifestPath, `${key} must be a boolean.`);
  }
  return value;
}

function requireOneOf<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
  manifestPath: string,
): T[number] {
  const value = requireString(record, key, manifestPath);
  if (!(values as readonly string[]).includes(value)) {
    throwInvalidManifest(manifestPath, `${key} must be one of: ${values.join(', ')}.`);
  }
  return value;
}

function requireRelativePath(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): string {
  const value = requireNonEmptyString(record, key, manifestPath);
  if (isAbsolute(value) || value.split(/[\\/]+/u).includes('..')) {
    throwInvalidManifest(manifestPath, `${key} must be a bounded relative path.`);
  }
  return value.split(/[\\/]+/u).join(sep);
}

function optionalRelativePath(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): string | undefined {
  if (record[key] === undefined) {
    return undefined;
  }
  return requireRelativePath(record, key, manifestPath);
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throwInvalidManifest(manifestPath, `${key} must be a string array.`);
  }
  // Narrow `value` to `string[]` after Array.isArray + element-type guard.
  const stringValues = value as readonly string[];
  return Object.freeze([...stringValues]);
}

function requireCapabilityFlagArray(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
): readonly CapabilityFlag[] {
  const values = requireStringArray(record, key, manifestPath);
  for (const value of values) {
    if (!isCapabilityFlag(value)) {
      throwInvalidManifest(manifestPath, `${key} contains unknown CapabilityFlag: ${value}`);
    }
  }
  return values as readonly CapabilityFlag[];
}

function parseTraitScheduleSpec(
  value: unknown,
  manifestPath: string,
): TraitModuleManifest['schedule'] {
  const record = requireRecord(value, 'schedule', manifestPath);
  rejectReservedKernelAuthorityKeys(record, manifestPath);
  const mode = requireOneOf(record, 'mode', ['none', 'cron'] as const, manifestPath);
  if (mode === 'none') {
    return { mode: 'none' };
  }

  const schedulesRaw = record['schedules'];
  if (!Array.isArray(schedulesRaw) || schedulesRaw.length === 0) {
    throwInvalidManifest(manifestPath, 'cron schedule requires non-empty schedules.');
  }
  const seenIds = new Set<string>();
  const schedules: TraitCronSchedule[] = schedulesRaw.map((entry, index) => {
    const schedule = requireRecord(entry, `schedule[${index}]`, manifestPath);
    rejectReservedKernelAuthorityKeys(schedule, manifestPath);
    const id = requireNonEmptyString(schedule, 'id', manifestPath);
    if (seenIds.has(id)) {
      throwInvalidManifest(manifestPath, `duplicate schedule id: ${id}`);
    }
    seenIds.add(id);
    const cron = requireNonEmptyString(schedule, 'cron', manifestPath);
    assertSimpleFiveFieldCron(cron, manifestPath);
    const timezone =
      schedule['timezone'] === undefined
        ? undefined
        : requireNonEmptyString(schedule, 'timezone', manifestPath);
    const delivery = requireOneOf(
      schedule,
      'delivery',
      ['main-session', 'isolated-session', 'current-session'] as const,
      manifestPath,
    );
    const summary = requireNonEmptyString(schedule, 'summary', manifestPath);
    return {
      id,
      cron,
      ...(timezone === undefined ? {} : { timezone }),
      delivery,
      summary,
    };
  });
  return { mode: 'cron', schedules };
}

function parseTraitRuntimeSpec(
  value: unknown,
  manifestPath: string,
): TraitRuntimeSpec {
  const record = requireRecord(value, 'runtime', manifestPath);
  rejectReservedKernelAuthorityKeys(record, manifestPath);
  const hook = requireOneOf(
    record,
    'hook',
    ['none', 'evidence-decorator', 'module-entrypoint'] as const,
    manifestPath,
  );
  if (hook === 'none') {
    return { hook: 'none' };
  }
  return {
    hook,
    modulePath: requireRelativePath(record, 'modulePath', manifestPath),
    exportName: requireNonEmptyString(record, 'exportName', manifestPath),
    enforcement: requireOneOf(
      record,
      'enforcement',
      ['advisory', 'required'] as const,
      manifestPath,
    ),
    summary: requireNonEmptyString(record, 'summary', manifestPath),
  };
}

function rejectReservedKernelAuthorityKeys(
  record: Record<string, unknown>,
  manifestPath: string,
): void {
  for (const key of RESERVED_KERNEL_AUTHORITY_MANIFEST_KEYS) {
    if (Object.hasOwn(record, key)) {
      throwInvalidManifest(
        manifestPath,
        `${key} is reserved for kernel-owned authority and is not part of the TraitModule manifest schema.`,
      );
    }
  }
}

interface CronFieldBounds {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const CRON_FIELD_BOUNDS: readonly CronFieldBounds[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
];

function assertSimpleFiveFieldCron(cron: string, manifestPath: string): void {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) {
    throwInvalidManifest(manifestPath, `cron must have five fields: ${cron}`);
  }
  for (let i = 0; i < parts.length; i += 1) {
    assertCronField(parts[i], CRON_FIELD_BOUNDS[i], manifestPath);
  }
}

function assertCronField(
  part: string,
  bounds: CronFieldBounds,
  manifestPath: string,
): void {
  const reject = (reason: string): never => {
    throwInvalidManifest(
      manifestPath,
      `cron ${bounds.name} field '${part}' ${reason} (allowed: ${bounds.min}-${bounds.max}).`,
    );
  };
  if (part === '*') {
    return;
  }
  if (part.startsWith('*/')) {
    const stepRaw = part.slice(2);
    if (!/^\d+$/u.test(stepRaw)) {
      reject('has a malformed step expression');
    }
    const step = Number.parseInt(stepRaw, 10);
    if (!Number.isFinite(step) || step <= 0) {
      reject('has step <= 0');
    }
    if (step > bounds.max) {
      reject('has step exceeding the field range');
    }
    return;
  }
  if (part.includes(',')) {
    const items = part.split(',');
    if (items.length === 0 || items.some((item) => item.length === 0)) {
      reject('has an empty list element');
    }
    for (const item of items) {
      assertCronField(item, bounds, manifestPath);
    }
    return;
  }
  if (part.includes('-')) {
    const rangeParts = part.split('-');
    if (rangeParts.length !== 2 || rangeParts.some((p) => p.length === 0)) {
      reject('is not a well-formed range');
    }
    const lo = Number.parseInt(rangeParts[0], 10);
    const hi = Number.parseInt(rangeParts[1], 10);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      reject('has non-numeric range bounds');
    }
    if (lo < bounds.min || hi > bounds.max) {
      reject('range is outside the allowed bounds');
    }
    if (lo > hi) {
      reject('has a reversed range (lo > hi)');
    }
    return;
  }
  if (!/^\d+$/u.test(part)) {
    reject('is not a recognized cron expression');
  }
  const literal = Number.parseInt(part, 10);
  if (!Number.isFinite(literal)) {
    reject('is not numeric');
  }
  if (literal < bounds.min || literal > bounds.max) {
    reject('is out of range');
  }
}

function isTraitRuntimeHookResult(value: unknown): value is TraitRuntimeHookResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record['status'] === 'ok' ||
      record['status'] === 'skipped' ||
      record['status'] === 'failed') &&
    typeof record['summary'] === 'string'
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Trait runtime timeoutMs must be a positive finite number.');
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('trait-runtime-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function runtimeFailure(
  manifest: TraitModuleManifest,
  code: TraitModuleLoaderErrorCode,
  message: string,
): TraitRuntimeHookInvocation {
  return {
    status: 'failed',
    manifestId: manifest.id,
    manifestVersion: manifest.version,
    hook: manifest.runtime.hook,
    summary: message,
    errorCode: code,
    errorMessage: message,
  };
}

function runtimeDecoratorFailure(
  manifest: TraitModuleManifest,
  code: TraitModuleLoaderErrorCode,
  message: string,
): TraitRuntimeDriverDecoratorLoad {
  return {
    status: 'failed',
    manifestId: manifest.id,
    manifestVersion: manifest.version,
    hook: manifest.runtime.hook,
    summary: message,
    errorCode: code,
    errorMessage: message,
  };
}

function throwInvalidManifest(manifestPath: string, message: string): never {
  throw new TraitModuleLoaderError(
    'manifest-shape-invalid',
    `Trait module manifest invalid at ${manifestPath}: ${message}`,
    { manifestPath },
  );
}
