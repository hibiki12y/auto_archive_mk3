/**
 * WU-R Boundary Validators — contract module.
 *
 * Spec: `specs/wu-r-validator-process-boundaries.md` (see §2 boundary set,
 * §3 depth policy, §6.8 Session 115 RESOLVED — hand-rolled type-guard binding,
 * zero runtime dependency, B-CKP-only ADR-gated escape hatch per AC-R10).
 *
 * This module ONLY provides the four named entry-points plus a small set of
 * re-usable primitive guards. Per §6.8 + rubber-duck option (b), per-boundary
 * payload schemas are the call-site's responsibility: each entry-point accepts
 * a `BoundaryAssert<T>` callback that narrows the unknown input. On any
 * rejection this module re-wraps the failure as a `BoundaryValidationError`
 * (a `TypeError` subclass) tagged with the boundary name; WU-H mapping from
 * TypeError to `TerminalCause` is owned by the calling adapter, not by this
 * module.
 *
 * Intentional non-features (v1):
 *   - No generic `{deep:true}` flag — depth is the caller's responsibility
 *     inside the `assert` callback (spec §3 is honored at the call site).
 *   - No embedded schemas for any boundary.
 *   - No global schema-version registry; `validateCheckpointLoad` simply
 *     forwards `version` so the caller's assert can branch locally.
 */

export type BoundaryName = 'B-IPC' | 'B-CDX' | 'B-SET' | 'B-CKP';

/**
 * Callback shape a call-site brings to each entry-point. Must throw a
 * `TypeError` on invalid input; anything else is normalized by this module
 * into a `BoundaryValidationError` with a "validator threw non-TypeError"
 * prefix so upstream adapters still see a canonical rejection shape.
 */
export type BoundaryAssert<T> = (raw: unknown) => asserts raw is T;

/**
 * Canonical rejection shape for all four WU-R boundaries. Subclass of
 * `TypeError` so existing `instanceof TypeError` checks continue to work;
 * adds the originating `boundary` tag and preserves the underlying thrown
 * value via `cause` (native ES2022 `Error.cause` semantics, mirrored on a
 * readonly field for stable typing).
 */
export class BoundaryValidationError extends TypeError {
  public readonly boundary: BoundaryName;
  public override readonly cause?: unknown;

  constructor(boundary: BoundaryName, message: string, cause?: unknown) {
    super(`[${boundary}] ${message}`);
    this.name = 'BoundaryValidationError';
    this.boundary = boundary;
    if (cause !== undefined) {
      this.cause = cause;
    }
    // Restore prototype chain (TS target ES2022 makes this a no-op in most
    // runtimes, but keep it defensive for subclass instanceof under transpilation).
    Object.setPrototypeOf(this, BoundaryValidationError.prototype);
  }
}

// --- Shared helper primitives ------------------------------------------------

/**
 * Formats a structured path (e.g. `['root','field',0,'nested']`) into a
 * human-readable dotted/bracket string for validator error messages.
 * Empty input yields `"<root>"`.
 */
export function formatPath(segments: ReadonlyArray<string | number>): string {
  if (segments.length === 0) return '<root>';
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (out === '') {
      out = seg;
    } else {
      out += `.${seg}`;
    }
  }
  return out;
}

/**
 * Asserts `value` is a plain record object. Throws a `BoundaryValidationError`
 * on failure. Arrays and `null` are rejected.
 */
export function requireObject(
  value: unknown,
  boundary: BoundaryName,
  path: ReadonlyArray<string | number>,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoundaryValidationError(
      boundary,
      `${formatPath(path)} must be an object.`,
    );
  }
}

/** Asserts `value` is a string. */
export function requireString(
  value: unknown,
  boundary: BoundaryName,
  path: ReadonlyArray<string | number>,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new BoundaryValidationError(
      boundary,
      `${formatPath(path)} must be a string.`,
    );
  }
}

/** Asserts `value` is an array. */
export function requireArray(
  value: unknown,
  boundary: BoundaryName,
  path: ReadonlyArray<string | number>,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new BoundaryValidationError(
      boundary,
      `${formatPath(path)} must be an array.`,
    );
  }
}

// --- Internal normalization --------------------------------------------------

function runAssert<T>(
  boundary: BoundaryName,
  raw: unknown,
  assert: BoundaryAssert<T>,
): T {
  try {
    assert(raw);
  } catch (err) {
    if (err instanceof BoundaryValidationError) {
      // Already in canonical form — pass through as-is so caller sees the
      // originating boundary tag without double-wrapping.
      throw err;
    }
    if (err instanceof TypeError) {
      throw new BoundaryValidationError(boundary, err.message, err);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new BoundaryValidationError(
      boundary,
      `validator threw non-TypeError: ${msg}`,
      err,
    );
  }
  return raw;
}

// --- Public entry-points (one per WU-R boundary) -----------------------------

/**
 * B-IPC — Cross-process IPC ingress (Discord gateway frames, HTTP bodies,
 * out-of-band callbacks). See spec §2.1.
 */
export function validateIpcIngress<T>(
  raw: unknown,
  assert: BoundaryAssert<T>,
): T {
  return runAssert('B-IPC', raw, assert);
}

/**
 * B-CDX — Codex SDK response ingress (`@openai/codex-sdk` turn events /
 * completions / failures). See spec §2.2. Implementation file is
 * `src/runtime/codex-runtime-adapter.ts`; earlier drafts referenced
 * `codex-runtime-driver.ts` (pre-rename).
 */
export function validateCodexResponse<T>(
  raw: unknown,
  assert: BoundaryAssert<T>,
): T {
  return runAssert('B-CDX', raw, assert);
}

/**
 * B-SET — Settings-file load (operator-authored configuration). See spec
 * §2.3. Rejection at this boundary is fatal-at-startup at the call-site's
 * discretion; this module only normalizes the shape.
 */
export function validateSettingsLoad<T>(
  raw: unknown,
  assert: BoundaryAssert<T>,
): T {
  return runAssert('B-SET', raw, assert);
}

/**
 * B-CKP — Checkpoint deserialization. See spec §2.4. Accepts an explicit
 * `version` so schema-mismatch is a first-class rejection class instead of
 * a runtime KeyError. The `version` is forwarded to the caller's `assert`
 * via closure (call-sites should pattern-match on it inside `assert`); this
 * module validates only that `version` is a non-empty string.
 */
export function validateCheckpointLoad<T>(
  raw: unknown,
  assert: BoundaryAssert<T>,
  version: string,
): T {
  if (typeof version !== 'string' || version.length === 0) {
    throw new BoundaryValidationError(
      'B-CKP',
      'checkpoint version must be a non-empty string.',
    );
  }
  return runAssert('B-CKP', raw, assert);
}
