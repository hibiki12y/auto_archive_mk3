/**
 * M9 — Job output store + `context_from` chaining data plane.
 *
 * Hermes mapping: `cron/scheduler.py:699-707` (`context_from` resolution)
 * and `cron/scheduler.py:115` (`SILENT_MARKER` output suppression).
 *
 * Scope (data plane plus bounded tick planning):
 *
 *   - `SILENT_MARKER` constant + `stripSilentMarker()` to detect and
 *     remove the suppression marker from a job's terminal output.
 *   - `JobOutputStore` — durable mapping from `jobId` to the most recent
 *     `JobOutput` (in-memory ring with bounded retention; JSONL path
 *     persistence as opt-in).
 *   - `resolveContextFrom(...)` — resolves a `contextFrom: string | string[]`
 *     declaration against the store and returns the concatenated context
 *     payload (or `undefined` when none of the referenced jobs has a
 *     non-silent output yet).
 *
 * `trait-scheduler-tick.ts` adds a deterministic one-shot due-run planner
 * over the persistent TraitModule scheduler state, and
 * `trait-scheduler-dispatch-runner.ts` can hand finalized due-job snapshots to
 * a host-owned dispatcher callback, persist conservative `lastTickAt`
 * cursor checkpoints, compose one explicit planner→dispatch→cursor tick, and
 * serialize overlapping ticks inside one Node.js process. It also exposes an
 * optional filesystem lease wrapper for host-owned cross-process exclusion plus
 * a best-effort JSONL evidence ledger for ran/skipped tick summaries. The
 * evidence ledger is replay-tolerant for torn/malformed lines and can apply
 * an optional append-time valid-record retention guard, but is not an
 * fsync-backed store, cross-process append lock, or backup rotation mechanism. A
 * read-only evidence report can emit advisory trend scores plus JSONL replay
 * audit counters for bounded tick batches without claiming live daemon
 * readiness; the package script only reads an existing ledger, applies a
 * bounded chunked byte guard during replay, and prints JSON. The
 * operator-owned daemon loop, fresh environment reload, backup rotation policy, and
 * Discord job-management UX remain intentionally out of scope for this file.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// SILENT_MARKER
// ---------------------------------------------------------------------------

/**
 * Output prefix that suppresses operator-facing delivery while still
 * persisting the job output for downstream `context_from` consumers.
 * Matches the Hermes `SILENT_MARKER` convention so cron scripts authored
 * for either system are interoperable.
 */
export const SILENT_MARKER = '<<<SILENT>>>';

/**
 * Strip the SILENT marker from `content` if present. Returns the
 * stripped content + a flag indicating whether the marker was present.
 *
 * Authors place the marker as the first non-whitespace token. Trailing
 * whitespace after the marker is also consumed (so `\n` separators
 * between marker and body don't leak into the body).
 */
export function stripSilentMarker(content: string): {
  readonly stripped: string;
  readonly silent: boolean;
} {
  const trimmedStart = content.replace(/^\s+/u, '');
  if (trimmedStart.startsWith(SILENT_MARKER)) {
    const after = trimmedStart.slice(SILENT_MARKER.length).replace(/^\s+/u, '');
    return { stripped: after, silent: true };
  }
  return { stripped: content, silent: false };
}

// ---------------------------------------------------------------------------
// JobOutput type
// ---------------------------------------------------------------------------

export interface JobOutput {
  readonly jobId: string;
  readonly runId: string;
  readonly content: string;
  readonly silent: boolean;
  readonly observedAt: string;
}

// ---------------------------------------------------------------------------
// JobOutputStore
// ---------------------------------------------------------------------------

export interface JobOutputStorePort {
  /** Persist a fresh output for the given job. Replaces any prior entry. */
  record(output: JobOutput): void;
  /** Most-recent output for `jobId`, or `undefined` if none recorded. */
  latest(jobId: string): JobOutput | undefined;
  /** History (most-recent first), bounded to the store's retention. */
  history(jobId: string): readonly JobOutput[];
}

export interface InMemoryJobOutputStoreOptions {
  /** Per-job retention bound. Defaults to 8. */
  readonly retentionPerJob?: number;
}

/**
 * Pure in-memory implementation. Bounded by `retentionPerJob` to avoid
 * unbounded growth across long-running deployments.
 */
export class InMemoryJobOutputStore implements JobOutputStorePort {
  private readonly retention: number;
  private readonly entries: Map<string, JobOutput[]> = new Map();

  constructor(options?: InMemoryJobOutputStoreOptions) {
    const r = options?.retentionPerJob ?? 8;
    this.retention = r < 1 ? 1 : Math.floor(r);
  }

  record(output: JobOutput): void {
    let bucket = this.entries.get(output.jobId);
    if (bucket === undefined) {
      bucket = [];
      this.entries.set(output.jobId, bucket);
    }
    bucket.unshift({ ...output });
    if (bucket.length > this.retention) {
      bucket.length = this.retention;
    }
  }

  latest(jobId: string): JobOutput | undefined {
    const bucket = this.entries.get(jobId);
    if (bucket === undefined || bucket.length === 0) return undefined;
    return { ...(bucket[0]) };
  }

  history(jobId: string): readonly JobOutput[] {
    const bucket = this.entries.get(jobId);
    if (bucket === undefined) return [];
    return bucket.map((entry) => ({ ...entry }));
  }
}

/**
 * JSONL-backed store. Writes are append-only; reads scan the file.
 * Use this when the cron data plane needs to survive process restarts
 * (e.g. a soak window across multiple agent runs).
 */
export class JsonlJobOutputStore implements JobOutputStorePort {
  constructor(
    private readonly filePath: string,
    private readonly retentionPerJob: number = 8,
  ) {}

  record(output: JobOutput): void {
    ensureDirFor(this.filePath);
    appendFileSync(
      this.filePath,
      `${JSON.stringify({ ...output })}\n`,
      'utf8',
    );
  }

  latest(jobId: string): JobOutput | undefined {
    const all = this.history(jobId);
    return all.length === 0 ? undefined : all[0];
  }

  history(jobId: string): readonly JobOutput[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const matches: JobOutput[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as { jobId?: unknown }).jobId === jobId
      ) {
        const candidate = parsed as Record<string, unknown>;
        if (
          typeof candidate.runId === 'string' &&
          typeof candidate.content === 'string' &&
          typeof candidate.observedAt === 'string'
        ) {
          matches.unshift({
            jobId,
            runId: candidate.runId,
            content: candidate.content,
            silent: candidate.silent === true,
            observedAt: candidate.observedAt,
          });
          if (matches.length > this.retentionPerJob) {
            matches.length = this.retentionPerJob;
          }
        }
      }
    }
    return matches;
  }
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (dir.length > 0 && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// resolveContextFrom
// ---------------------------------------------------------------------------

export interface ResolveContextFromInput {
  /** A single ref or list of refs (job ids). */
  readonly contextFrom: string | readonly string[];
  /** Output store to consult. */
  readonly store: JobOutputStorePort;
  /**
   * Whether SILENT outputs should still be consumed as context. Defaults
   * to `true` — silent suppresses operator-facing delivery, not
   * downstream chaining.
   */
  readonly includeSilent?: boolean;
}

export interface ResolveContextFromResult {
  /** Merged context payload, `undefined` when nothing was resolvable. */
  readonly context: string | undefined;
  /** Per-ref resolution status (in input order). */
  readonly entries: readonly ResolvedContextEntry[];
}

export interface ResolvedContextEntry {
  readonly jobId: string;
  readonly status: 'resolved' | 'absent' | 'silent-skipped';
  readonly runId?: string;
  readonly observedAt?: string;
}

export function resolveContextFrom(
  input: ResolveContextFromInput,
): ResolveContextFromResult {
  const refs =
    typeof input.contextFrom === 'string'
      ? [input.contextFrom]
      : [...input.contextFrom];
  const includeSilent = input.includeSilent ?? true;

  const entries: ResolvedContextEntry[] = [];
  const blocks: string[] = [];

  for (const jobId of refs) {
    const latest = input.store.latest(jobId);
    if (latest === undefined) {
      entries.push({ jobId, status: 'absent' });
      continue;
    }
    if (latest.silent && !includeSilent) {
      entries.push({
        jobId,
        status: 'silent-skipped',
        runId: latest.runId,
        observedAt: latest.observedAt,
      });
      continue;
    }
    entries.push({
      jobId,
      status: 'resolved',
      runId: latest.runId,
      observedAt: latest.observedAt,
    });
    if (latest.content.length > 0) {
      blocks.push(`[from ${jobId} @ ${latest.observedAt}]\n${latest.content}`);
    }
  }

  const context = blocks.length === 0 ? undefined : blocks.join('\n\n');
  return { context, entries };
}
