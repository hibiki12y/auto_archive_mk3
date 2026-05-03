/**
 * WU-V Phase 4a — Cause→Outcome / Cause→AbortInfo mapper helpers.
 *
 * Provides the deterministic projection from `TerminalCause` (the
 * source-of-truth representation per WU-V BC-V1) to a human-facing
 * outcome label literal, plus the sibling synthesis of
 * `TerminalAbortInfo` for the `runtime-veto` kind (which carries the
 * structural side-condition required by the abort-info payload).
 *
 * WU-V Phase 6 (closure): the legacy `TerminalOutcome` type alias has
 * been retired. The literal union remains here as the inline return
 * type of `deriveOutcomeFromCause` — the canonical helper used by the
 * Discord renderer (and anywhere a human-facing label is needed).
 *
 * @see specs/wu-v-terminal-cause-tightening.md §3 Phase 6, §4 mapping
 * @see specs/wu-v-terminal-cause-tightening.md §4.1 abort handling /
 *      OQ-V1 resolution
 */

import type {
  TerminalCause,
  TerminalCauseRuntimeVeto,
} from '../contracts/terminal-cause.js';
import type {
  TerminalAbortCancellation,
  TerminalAbortInfo,
} from '../contracts/terminal-evidence.js';

/**
 * Project a `TerminalCause` onto its corresponding human-facing outcome
 * literal per the binding §4 mapping table. Used by the Discord
 * renderer to preserve UX-stable label strings post-Phase-6.
 *
 * The `default` arm uses a `never`-typed binding so that any future
 * addition to `TerminalCause.kind` becomes a compile-time error here,
 * surfacing the required mapping update in the same commit.
 *
 * @see specs/wu-v-terminal-cause-tightening.md §4 mapping table
 */
export function deriveOutcomeFromCause(
  cause: TerminalCause,
): 'success' | 'failure' | 'timeout' | 'operator-cancel' | 'abort' {
  switch (cause.kind) {
    case 'success':
      return 'success';
    case 'provider-failure':
      return 'failure';
    case 'driver-failure':
      return 'failure';
    case 'timeout':
      return 'timeout';
    case 'external-cancel':
      return 'operator-cancel';
    case 'runtime-veto':
      return 'abort';
    default: {
      const _exhaustive: never = cause;
      throw new Error(
        `unhandled terminal cause kind: ${(_exhaustive as TerminalCause).kind}`,
      );
    }
  }
}

/**
 * Synthesize a `TerminalAbortInfo` from a `runtime-veto` cause, satisfying
 * the structural side-condition that `'abort'` outcomes carry an `abort`
 * payload (`createTerminalEvidence` invariant in `terminal-evidence.ts`).
 *
 * The synthesis derives the `TerminalAbortCancellation` shape from cause
 * base fields (`taskId`, `provenance`, `reason`) plus the cause's
 * `cancellation.requestedAt` when present. The `boundary` literal is fixed
 * to `'dispatcher'` per `TerminalAbortCancellation` shape (the only legal
 * value today). When `cause.cancellation` is absent the synthesized
 * abort-info omits the `cancellation` field entirely.
 *
 * NOTE: The orchestrator brief described the synthesis as
 * `cancellation: cause.cancellation`; that wording does not typecheck
 * because `TerminalCauseRuntimeVeto.cancellation` is a strict subset of
 * `TerminalAbortCancellation`. Synthesizing the missing fields from cause
 * base data preserves intent while satisfying both type contracts. Logged
 * in the change summary as a confidence-flag for verifier review.
 *
 * @see specs/wu-v-terminal-cause-tightening.md §4.1 (OQ-V1 resolution)
 */
export function deriveAbortInfoFromCause(
  cause: TerminalCauseRuntimeVeto,
): TerminalAbortInfo {
  if (cause.cancellation === undefined) {
    return {
      kind: 'veto',
      veto: cause.veto,
    };
  }

  const cancellation: TerminalAbortCancellation = {
    taskId: cause.taskId,
    reason: cause.reason,
    provenance: cause.provenance,
    requestedAt: cause.cancellation.requestedAt,
    boundary: 'dispatcher',
  };

  return {
    kind: 'veto',
    veto: cause.veto,
    cancellation,
  };
}
