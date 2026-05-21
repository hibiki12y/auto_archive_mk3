/**
 * `ClaudeOffloadBundle` — narrow read-only consultation contract for the
 * Claude token offload route described in
 * `specs/ARCHIVE/claude-token-offload-implementation-plan-2026-05-05.md`.
 *
 * The Codex parent assembles a bundle of *path/anchor references* and
 * structural acceptance checks, then sends it to Claude for synthesis,
 * critique, live-proof triage, or memory-compaction draft. Claude is an
 * advisor only: it never gains write authority and never satisfies a live
 * proof gate by itself (`decisionRole: 'advisory-only'`).
 *
 * Invariants enforced structurally by `createClaudeOffloadBundle`:
 *   - schemaVersion is fixed at 1 (versioning is opt-in upgrade only).
 *   - purpose is one of the allowed offload purposes.
 *   - sourceRefs are non-empty path/anchor strings; raw content (env
 *     values, secrets, raw transcripts) is rejected by structural shape
 *     checks because each ref must match a path/anchor pattern.
 *   - acceptanceChecks are short structural assertions. They are stored
 *     verbatim but checked for length and banned-key contamination.
 *   - redactionBoundary booleans are all `true` — i.e. the bundle is
 *     declared free of secrets/raw prompts/responses/instructions.
 *   - The constructor rejects bundles that contain banned field names at
 *     the top level (`rawPrompt`, `rawResponse`, `rawInstruction`,
 *     `token`, `apiKey`, `credential`, `secret`).
 *   - A positive allowlist of retained fields is enforced before the
 *     banned-key check, so the invariant is structural rather than only
 *     a negative denylist.
 */

export const CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION = 1 as const;

export const CLAUDE_OFFLOAD_PURPOSES = Object.freeze([
  'checkpoint-synthesis',
  'live-proof-triage',
  'implementation-plan-critique',
  'memory-compaction-draft',
] as const);

export type ClaudeOffloadPurpose = (typeof CLAUDE_OFFLOAD_PURPOSES)[number];

export const CLAUDE_OFFLOAD_BUNDLE_ALLOWED_FIELDS = Object.freeze([
  'schemaVersion',
  'purpose',
  'sourceRefs',
  'acceptanceChecks',
  'redactionBoundary',
  'content',
] as const);

export const CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS = Object.freeze([
  'rawPrompt',
  'rawResponse',
  'rawInstruction',
  'token',
  'apiKey',
  'credential',
  'secret',
] as const);

export const CLAUDE_OFFLOAD_REDACTION_BOUNDARY = Object.freeze({
  excludesSecrets: true,
  excludesRawPrompts: true,
  excludesRawResponses: true,
  excludesRawInstructions: true,
} as const);

export type ClaudeOffloadRedactionBoundary =
  typeof CLAUDE_OFFLOAD_REDACTION_BOUNDARY;

export interface ClaudeOffloadBundle {
  readonly schemaVersion: typeof CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION;
  readonly purpose: ClaudeOffloadPurpose;
  readonly sourceRefs: readonly string[];
  readonly acceptanceChecks: readonly string[];
  readonly redactionBoundary: ClaudeOffloadRedactionBoundary;
  readonly content: string;
}

export interface ClaudeOffloadBundleInput {
  readonly purpose: ClaudeOffloadPurpose;
  readonly sourceRefs: readonly string[];
  readonly acceptanceChecks: readonly string[];
  readonly content: string;
}

const SAFE_REF_PATTERN = /^[A-Za-z0-9._/:#@-]{1,256}$/u;
const MAX_SOURCE_REFS = 64;
const MAX_ACCEPTANCE_CHECKS = 32;
const MAX_ACCEPTANCE_CHECK_LENGTH = 240;
const MAX_CONTENT_LENGTH = 32 * 1024;

export class ClaudeOffloadBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeOffloadBundleError';
  }
}

/**
 * Strict plain-object check used for input validation. Accepts `{}`
 * literals, JSON-deserialized objects, and `Object.create(null)`. Class
 * instances and arrays are rejected.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Permissive object-shape check used **only** by `rejectBannedKeysDeep`.
 * The banned-key scan must walk into every object-shaped value, even if
 * its prototype is unfamiliar (cross-realm, class instance, etc.).
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BANNED_FIELD_LOWER = new Set<string>(
  CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS.map((field) => field.toLowerCase()),
);

function rejectBannedKeysDeep(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectBannedKeysDeep(entry, `${path}[${index}]`);
    });
    return;
  }
  if (!isObjectLike(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const lowered = key.toLowerCase();
    if (BANNED_FIELD_LOWER.has(lowered)) {
      throw new ClaudeOffloadBundleError(
        `bundle field "${path}.${key}" matches banned key "${key}"`,
      );
    }
    rejectBannedKeysDeep(value[key], `${path}.${key}`);
  }
}

function isOffloadPurpose(value: unknown): value is ClaudeOffloadPurpose {
  return (
    typeof value === 'string' &&
    (CLAUDE_OFFLOAD_PURPOSES as readonly string[]).includes(value)
  );
}

export function createClaudeOffloadBundle(
  input: ClaudeOffloadBundleInput,
): ClaudeOffloadBundle {
  if (!isPlainObject(input)) {
    throw new ClaudeOffloadBundleError('bundle input must be a plain object');
  }

  const allowedInput = new Set<string>([
    'purpose',
    'sourceRefs',
    'acceptanceChecks',
    'content',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedInput.has(key)) {
      throw new ClaudeOffloadBundleError(
        `bundle input field "${key}" is not in the positive allowlist`,
      );
    }
  }

  rejectBannedKeysDeep(input, 'input');

  if (!isOffloadPurpose(input.purpose)) {
    throw new ClaudeOffloadBundleError(
      `bundle purpose must be one of ${CLAUDE_OFFLOAD_PURPOSES.join(', ')}`,
    );
  }

  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
    throw new ClaudeOffloadBundleError(
      'bundle sourceRefs must be a non-empty array of path/anchor strings',
    );
  }
  if (input.sourceRefs.length > MAX_SOURCE_REFS) {
    throw new ClaudeOffloadBundleError(
      `bundle sourceRefs exceeds maximum of ${MAX_SOURCE_REFS} entries`,
    );
  }
  for (const ref of input.sourceRefs) {
    if (typeof ref !== 'string' || !SAFE_REF_PATTERN.test(ref)) {
      throw new ClaudeOffloadBundleError(
        `bundle sourceRef "${String(ref)}" is not a safe path/anchor reference`,
      );
    }
  }

  if (!Array.isArray(input.acceptanceChecks)) {
    throw new ClaudeOffloadBundleError(
      'bundle acceptanceChecks must be an array',
    );
  }
  if (input.acceptanceChecks.length > MAX_ACCEPTANCE_CHECKS) {
    throw new ClaudeOffloadBundleError(
      `bundle acceptanceChecks exceeds maximum of ${MAX_ACCEPTANCE_CHECKS} entries`,
    );
  }
  for (const check of input.acceptanceChecks) {
    if (typeof check !== 'string' || check.length === 0) {
      throw new ClaudeOffloadBundleError(
        'bundle acceptanceChecks entries must be non-empty strings',
      );
    }
    if (check.length > MAX_ACCEPTANCE_CHECK_LENGTH) {
      throw new ClaudeOffloadBundleError(
        `bundle acceptanceCheck exceeds ${MAX_ACCEPTANCE_CHECK_LENGTH} chars`,
      );
    }
  }

  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new ClaudeOffloadBundleError(
      'bundle content must be a non-empty string',
    );
  }
  if (input.content.length > MAX_CONTENT_LENGTH) {
    throw new ClaudeOffloadBundleError(
      `bundle content exceeds ${MAX_CONTENT_LENGTH} chars`,
    );
  }

  const sourceRefsCopy: string[] = Array.from<string>(input.sourceRefs);
  const acceptanceChecksCopy: string[] = Array.from<string>(
    input.acceptanceChecks,
  );
  const sourceRefs: readonly string[] = Object.freeze(sourceRefsCopy);
  const acceptanceChecks: readonly string[] = Object.freeze(acceptanceChecksCopy);
  const bundle: ClaudeOffloadBundle = Object.freeze({
    schemaVersion: CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION,
    purpose: input.purpose,
    sourceRefs,
    acceptanceChecks,
    redactionBoundary: CLAUDE_OFFLOAD_REDACTION_BOUNDARY,
    content: input.content,
  });

  return bundle;
}

export function isClaudeOffloadBundle(
  value: unknown,
): value is ClaudeOffloadBundle {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.schemaVersion !== CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION) {
    return false;
  }
  if (!isOffloadPurpose(value.purpose)) {
    return false;
  }
  if (
    !Array.isArray(value.sourceRefs) ||
    value.sourceRefs.length === 0 ||
    !value.sourceRefs.every(
      (ref) => typeof ref === 'string' && SAFE_REF_PATTERN.test(ref),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.acceptanceChecks) ||
    !value.acceptanceChecks.every(
      (check) => typeof check === 'string' && check.length > 0,
    )
  ) {
    return false;
  }
  const boundary = value.redactionBoundary;
  if (!isPlainObject(boundary)) {
    return false;
  }
  // Require *exactly* the four canonical boundary keys, all `=== true`.
  // This rejects forged bundles that piggyback extra keys on the
  // boundary, even if the four canonical booleans are present.
  const boundaryKeys = Object.keys(boundary).sort();
  const expectedKeys = [
    'excludesRawInstructions',
    'excludesRawPrompts',
    'excludesRawResponses',
    'excludesSecrets',
  ];
  if (
    boundaryKeys.length !== expectedKeys.length ||
    boundaryKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  if (
    boundary.excludesSecrets !== true ||
    boundary.excludesRawPrompts !== true ||
    boundary.excludesRawResponses !== true ||
    boundary.excludesRawInstructions !== true
  ) {
    return false;
  }
  if (typeof value.content !== 'string' || value.content.length === 0) {
    return false;
  }
  return true;
}
