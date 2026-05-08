/**
 * `ClaudeOffloadResult` — in-process record of one Claude offload turn.
 *
 * The Claude gateway returns a free-form envelope with metadata and an
 * advisory text/JSON body. The Codex parent normalizes that envelope
 * into a small, retained record before deciding whether to act on the
 * advisory body. The retained record never carries the raw prompt or
 * raw response by default; only structured metadata and a parsed view
 * of the result sections (when they validate) are retained.
 *
 * Route status vocabulary is intentionally namespaced — the live-proof
 * matrix uses `pass`/`warn`/`fail`. Naive substring grep across reports
 * could otherwise conflate a Claude advisor degradation with a real
 * live-proof gate failure. Use `'offload-route-ok' | 'offload-route-warn'
 * | 'offload-route-fail'` here.
 *
 * Degradation policy:
 *   - Quota / auth / model-not-found / network errors are normalized to
 *     `offload-route-warn` with a stable `errorCategory`.
 *   - Tool-use requests inside Claude's response are flagged as
 *     `offload-route-warn` with `errorCategory: 'tool-use-degraded'`.
 *     The advisor must not request tools per the offload prompt
 *     invariants; this is treated as degraded, not fatal, so the parent
 *     can fall back to Codex-native synthesis.
 *   - Partial responses (missing required sections) are kept as
 *     `offload-route-warn` with `errorCategory: 'partial-result'`; the
 *     parent decides whether to retry.
 *   - Successful, fully-shaped responses are `offload-route-ok`.
 *
 * Forbidden in any retained record:
 *   - rawPrompt, rawResponse, rawInstruction
 *   - any banned key from the bundle contract
 *   - free-form `errorMessage` text from the gateway, unless first
 *     scrubbed by `sanitizeDegradedReason` (length-capped + banned
 *     substrings redacted).
 */

import {
  CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS,
  type ClaudeOffloadPurpose,
} from '../contracts/claude-token-offload.js';
import {
  CLAUDE_OFFLOAD_RESULT_SECTIONS,
  type ClaudeOffloadResultSection,
} from './claude-token-offload.js';

export const CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION = 1 as const;

export type ClaudeOffloadRouteStatus =
  | 'offload-route-ok'
  | 'offload-route-warn'
  | 'offload-route-fail';

export type ClaudeOffloadErrorCategory =
  | 'none'
  | 'quota-exhausted'
  | 'auth-failed'
  | 'model-unavailable'
  | 'timeout'
  | 'network'
  | 'partial-result'
  | 'tool-use-degraded'
  | 'parse-failure'
  | 'unknown';

export interface ClaudeOffloadTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface ClaudeOffloadGatewayEnvelope {
  readonly status: 'ok' | 'error';
  readonly model?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly tokenUsage?: Partial<ClaudeOffloadTokenUsage>;
  readonly errorCategory?: ClaudeOffloadErrorCategory;
  readonly errorMessage?: string;
  readonly toolUseRequested?: boolean;
  readonly responseText?: string;
}

export type ClaudeOffloadSections = Readonly<
  Record<ClaudeOffloadResultSection, readonly string[]>
>;

export interface ClaudeOffloadResult {
  readonly schemaVersion: typeof CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION;
  readonly purpose: ClaudeOffloadPurpose;
  readonly routeStatus: ClaudeOffloadRouteStatus;
  readonly errorCategory: ClaudeOffloadErrorCategory;
  readonly degradedReason?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly tokenUsage?: ClaudeOffloadTokenUsage;
  readonly sections?: ClaudeOffloadSections;
  readonly blockingGapCount: number;
  readonly memoryCandidateCount: number;
}

export interface NormalizeOptions {
  readonly purpose: ClaudeOffloadPurpose;
}

export const CLAUDE_OFFLOAD_DEGRADED_REASON_MAX_CHARS = 240;
export const CLAUDE_OFFLOAD_RESPONSE_TEXT_MAX_BYTES = 64 * 1024;
export const CLAUDE_OFFLOAD_SECTION_MAX_ENTRIES = 64;
export const CLAUDE_OFFLOAD_SECTION_ENTRY_MAX_CHARS = 512;

const BANNED_LOWER = new Set<string>(
  CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS.map((field) => field.toLowerCase()),
);

// Word-boundary scrub so `secretsRedacted` / `tokenUsage` (legitimate
// internal field names) survive intact while bare `secret` / `token`
// occurrences in free-form gateway prose get redacted.
const BANNED_SCRUB_REGEX = new RegExp(
  `\\b(?:${CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS.map((field) =>
    field.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
  ).join('|')})\\b`,
  'gi',
);

/**
 * Strict plain-object check: only accept `{}` literals, deserialized
 * JSON, or `Object.create(null)`. Class instances and arrays are
 * rejected. Used for **input validation**.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Permissive object-shape check used **only** by `containsBannedKey`.
 * The point is defense in depth: if a gateway adapter constructs
 * envelope objects via `Object.create(null)`, in another realm, or as
 * class instances, we still want to recurse and scan their keys for
 * banned names rather than skip them (which the strict check did).
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeTokenUsage(
  usage: Partial<ClaudeOffloadTokenUsage> | undefined,
): ClaudeOffloadTokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = safeNumber(usage.inputTokens) ?? 0;
  const cachedInputTokens = safeNumber(usage.cachedInputTokens) ?? 0;
  const outputTokens = safeNumber(usage.outputTokens) ?? 0;
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) {
    return undefined;
  }
  return Object.freeze({ inputTokens, cachedInputTokens, outputTokens });
}

function containsBannedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsBannedKey);
  }
  if (!isObjectLike(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (BANNED_LOWER.has(key.toLowerCase())) {
      return true;
    }
    if (containsBannedKey(value[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Scrub a free-form gateway message into a retainable `degradedReason`:
 * trim length to `CLAUDE_OFFLOAD_DEGRADED_REASON_MAX_CHARS` and replace
 * any banned-key substring (case-insensitive) with a redaction marker.
 *
 * This guarantees that a careless or malicious gateway adapter cannot
 * leak `errorMessage: "Bearer sk-..."` through the metadata-only ledger.
 * Note: this is *substring* scrubbing on the prose channel only — it
 * does not reach into the bundle's `content` (which the caller owns)
 * and does not pretend to be a general secret detector.
 */
export function sanitizeDegradedReason(
  raw: string | undefined,
  fallback: string,
): string {
  const source =
    typeof raw === 'string' && raw.length > 0 ? raw : fallback;
  const scrubbed = source.replace(BANNED_SCRUB_REGEX, '[redacted-banned-key]');
  if (scrubbed.length <= CLAUDE_OFFLOAD_DEGRADED_REASON_MAX_CHARS) {
    return scrubbed;
  }
  // Reserve room for an explicit truncation marker so an operator
  // reading the ledger knows the message was cut.
  const marker = '…[truncated]';
  return `${scrubbed.slice(0, CLAUDE_OFFLOAD_DEGRADED_REASON_MAX_CHARS - marker.length)}${marker}`;
}

function coerceSectionValue(value: unknown): readonly string[] | null {
  if (typeof value === 'string') {
    if (value.length === 0) {
      return Object.freeze<string[]>([]);
    }
    if (value.length > CLAUDE_OFFLOAD_SECTION_ENTRY_MAX_CHARS) {
      return null;
    }
    return Object.freeze<string[]>([value]);
  }
  if (Array.isArray(value)) {
    if (value.length > CLAUDE_OFFLOAD_SECTION_MAX_ENTRIES) {
      return null;
    }
    if (
      !value.every(
        (entry) =>
          typeof entry === 'string' &&
          entry.length <= CLAUDE_OFFLOAD_SECTION_ENTRY_MAX_CHARS,
      )
    ) {
      return null;
    }
    return Object.freeze<string[]>(Array.from<string>(value));
  }
  return null;
}

interface ParsedSections {
  readonly sections?: ClaudeOffloadSections;
  readonly missingSections: readonly ClaudeOffloadResultSection[];
  readonly parseFailureReason?: string;
}

/**
 * Extract the canonical JSON object from a Claude advisor response.
 *
 * Real-world Claude outputs frequently wrap the requested JSON object in
 * a fenced code block (```json ... ```), surround it with prose, or both.
 * This helper strips the most common wrapping patterns so the parser
 * recovers the bare object before JSON.parse:
 *
 *   1. Trim whitespace.
 *   2. If the string starts with a triple-backtick fence (optionally
 *      tagged `json`), strip the leading fence and trailing fence.
 *   3. Otherwise, if a `{ ... }` region exists, extract the substring
 *      from the first `{` to the last matching `}` (greedy outer
 *      brace). Prose before/after the object is discarded.
 *
 * The return value is then handed to `JSON.parse` and the same
 * banned-key + allowlist + section-shape checks run on the parsed
 * object — fence stripping does not bypass any safety check.
 */
function extractCandidateJson(responseText: string): string {
  const trimmed = responseText.trim();
  // Pattern 1: ```json\n{...}\n``` or ```\n{...}\n```
  const fence = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/u.exec(trimmed);
  if (fence !== null && typeof fence[1] === 'string') {
    return fence[1].trim();
  }
  // Pattern 2: prose before/after a single top-level `{...}` region.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseSections(responseText: string | undefined): ParsedSections {
  if (responseText === undefined || responseText.trim().length === 0) {
    return {
      missingSections: [...CLAUDE_OFFLOAD_RESULT_SECTIONS],
      parseFailureReason: 'empty-response',
    };
  }
  if (
    Buffer.byteLength(responseText, 'utf8') >
    CLAUDE_OFFLOAD_RESPONSE_TEXT_MAX_BYTES
  ) {
    return {
      missingSections: [...CLAUDE_OFFLOAD_RESULT_SECTIONS],
      parseFailureReason: 'response-too-large',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractCandidateJson(responseText));
  } catch {
    return {
      missingSections: [...CLAUDE_OFFLOAD_RESULT_SECTIONS],
      parseFailureReason: 'non-json-response',
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      missingSections: [...CLAUDE_OFFLOAD_RESULT_SECTIONS],
      parseFailureReason: 'response-not-object',
    };
  }

  if (containsBannedKey(parsed)) {
    return {
      missingSections: [...CLAUDE_OFFLOAD_RESULT_SECTIONS],
      parseFailureReason: 'response-contains-banned-key',
    };
  }

  const sections: Record<ClaudeOffloadResultSection, readonly string[]> = {
    status: [],
    findings: [],
    blockingGaps: [],
    memoryCandidates: [],
    residualRisk: [],
  };
  const missing: ClaudeOffloadResultSection[] = [];

  for (const section of CLAUDE_OFFLOAD_RESULT_SECTIONS) {
    if (!(section in parsed)) {
      missing.push(section);
      continue;
    }
    const coerced = coerceSectionValue(parsed[section]);
    if (coerced === null) {
      missing.push(section);
      continue;
    }
    sections[section] = coerced;
  }

  return {
    sections: Object.freeze(sections),
    missingSections: missing,
  };
}

export function normalizeClaudeOffloadResult(
  envelope: ClaudeOffloadGatewayEnvelope,
  options: NormalizeOptions,
): ClaudeOffloadResult {
  const tokenUsage = normalizeTokenUsage(envelope.tokenUsage);
  const model = typeof envelope.model === 'string' ? envelope.model : undefined;
  const latencyMs = safeNumber(envelope.latencyMs);
  const costUsd = safeNumber(envelope.costUsd);

  if (envelope.status === 'error') {
    const errorCategory: ClaudeOffloadErrorCategory =
      envelope.errorCategory ?? 'unknown';
    return Object.freeze({
      schemaVersion: CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
      purpose: options.purpose,
      routeStatus: 'offload-route-warn',
      errorCategory,
      degradedReason: sanitizeDegradedReason(envelope.errorMessage, errorCategory),
      model,
      latencyMs,
      costUsd,
      tokenUsage,
      blockingGapCount: 0,
      memoryCandidateCount: 0,
    });
  }

  if (envelope.toolUseRequested) {
    return Object.freeze({
      schemaVersion: CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
      purpose: options.purpose,
      routeStatus: 'offload-route-warn',
      errorCategory: 'tool-use-degraded',
      degradedReason: sanitizeDegradedReason(
        undefined,
        'claude-requested-tool-use-violates-advisor-contract',
      ),
      model,
      latencyMs,
      costUsd,
      tokenUsage,
      blockingGapCount: 0,
      memoryCandidateCount: 0,
    });
  }

  const parsed = parseSections(envelope.responseText);

  if (parsed.parseFailureReason) {
    return Object.freeze({
      schemaVersion: CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
      purpose: options.purpose,
      routeStatus: 'offload-route-warn',
      errorCategory: 'parse-failure',
      degradedReason: sanitizeDegradedReason(undefined, parsed.parseFailureReason),
      model,
      latencyMs,
      costUsd,
      tokenUsage,
      blockingGapCount: 0,
      memoryCandidateCount: 0,
    });
  }

  if (parsed.missingSections.length > 0) {
    return Object.freeze({
      schemaVersion: CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
      purpose: options.purpose,
      routeStatus: 'offload-route-warn',
      errorCategory: 'partial-result',
      degradedReason: sanitizeDegradedReason(
        undefined,
        `missing-sections:${parsed.missingSections.join(',')}`,
      ),
      model,
      latencyMs,
      costUsd,
      tokenUsage,
      sections: parsed.sections,
      blockingGapCount: parsed.sections?.blockingGaps.length ?? 0,
      memoryCandidateCount: parsed.sections?.memoryCandidates.length ?? 0,
    });
  }

  const sections = parsed.sections;
  if (sections === undefined) {
    // Unreachable: parseSections only returns missingSections.length === 0
    // when sections is populated. The guard keeps type narrowing explicit
    // and avoids a non-null assertion.
    return Object.freeze({
      schemaVersion: CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
      purpose: options.purpose,
      routeStatus: 'offload-route-warn',
      errorCategory: 'parse-failure',
      degradedReason: 'sections-missing-after-parse',
      model,
      latencyMs,
      costUsd,
      tokenUsage,
      blockingGapCount: 0,
      memoryCandidateCount: 0,
    });
  }
  return Object.freeze({
    schemaVersion: CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
    purpose: options.purpose,
    routeStatus: 'offload-route-ok',
    errorCategory: 'none',
    model,
    latencyMs,
    costUsd,
    tokenUsage,
    sections,
    blockingGapCount: sections.blockingGaps.length,
    memoryCandidateCount: sections.memoryCandidates.length,
  });
}
