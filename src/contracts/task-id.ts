/**
 * WU-M Task Identity Invariant — generator + opacity contract.
 *
 * Spec: `specs/wu-m-task-identity-invariant.md`.
 *
 * Governance resolution (OQ-M1, §6 Q1): UUIDv7.
 *
 *   "taskId semantics (DIS-008): permanent for-life-of-system (UUIDv7 or
 *    ULID). Unblocks WU-M. Rationale: audit/observability/resume/log-
 *    correlation 모두 permanent ID 요구."
 *      — IMPLEMENTATION_LOG.md 2026-04-20
 *
 * UUIDv7 is selected over ULID for two reasons that are micro-decisions per
 * the spec OQ-M1 register: (a) the `uuid` npm package is already widely
 * deployed and ships a stable v7 implementation (v9.0+ exports `v7`; the
 * version pinned here ships in `package.json`), (b) the hyphenated 36-char
 * representation is the universally-recognized opaque shape for byte-stable
 * downstream consumption (BC-6).
 *
 * Binding constraints honored here:
 *   BC-2 (a) monotonic time-ordering on millisecond scale  → satisfied by v7.
 *   BC-2 (b) collision-resistant cryptographic-RNG entropy → satisfied by v7.
 *   BC-2 (c) byte-stable representation                    → 36-char hex form.
 *   BC-6     opacity                                       → consumers see a
 *                                                            string only; no
 *                                                            parse helpers
 *                                                            are exported.
 *
 * What this module does NOT do (anti-scope per WU-M):
 *   - NG-M1 wire format selection (no encoding/transport choice).
 *   - NG-M2 generator alternatives beyond UUIDv7 (locked here per OQ-M1).
 *   - NG-M3 correlation/parent/span IDs.
 *   - NG-M6 cross-process propagation channel.
 */

import { v7 as uuidv7 } from 'uuid';

/**
 * Nominal brand for `taskId`. Use `TaskId` in API surfaces that require the
 * value to have come through `generateTaskId` / `assertTaskId`. The brand is
 * a structural property only; per BC-6 the runtime representation remains a
 * plain string and downstream consumers MUST treat it as opaque.
 */
declare const TaskIdBrand: unique symbol;
export type TaskId = string & { readonly [TaskIdBrand]: 'WU-M.TaskId' };

/**
 * UUIDv7 canonical representation: lowercase hex with hyphens, version nibble
 * `7`, variant nibble `8|9|a|b`. Validator only verifies shape (BC-6); it
 * does NOT inspect embedded timestamp, prefix, or any sub-string semantics.
 */
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Issue a new `TaskId`. Single-owner issuance authority is enforced
 * structurally by the dispatcher's admission boundary calling this exactly
 * once per task (BC-4); this function is a pure generator and has no
 * side-effects beyond entropy consumption.
 */
export function generateTaskId(): TaskId {
  return uuidv7() as TaskId;
}

/**
 * Shape guard for the byte-string contract. Per BC-6 this is the *only*
 * structural inspection downstream consumers may perform on a `taskId`.
 */
export function isValidTaskId(value: unknown): value is TaskId {
  return typeof value === 'string' && UUIDV7_PATTERN.test(value);
}

/**
 * Brand-cast helper for callers that have a string from a trusted boundary
 * (e.g., a validated incoming plan, a checkpoint replay). Throws on shape
 * violation. Use sparingly; prefer `generateTaskId`.
 */
export function assertTaskId(value: unknown): TaskId {
  if (!isValidTaskId(value)) {
    throw new TypeError(
      `taskId must be a UUIDv7 string (BC-2 / BC-6); received: ${
        typeof value === 'string' ? `'${value}'` : typeof value
      }`,
    );
  }
  return value;
}
