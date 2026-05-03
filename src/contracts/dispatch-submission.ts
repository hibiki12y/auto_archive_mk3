import type { TaskId } from './task-id.js';
import type { TerminalEvidence } from './terminal-evidence.js';

/**
 * Post-admission acceptance surface.
 *
 * `taskId` is narrowed to the WU-M branded `TaskId` type. This is the
 * contained branded surface — the dispatcher is the sole admission boundary
 * that produces a branded `TaskId` (BC-4 single-issuer), either by issuing
 * a fresh UUIDv7 or by validating a caller-supplied UUIDv7.
 *
 * For the WU-M-INT legacy-compat path (caller-supplied non-UUIDv7 fixture
 * strings, see `Dispatcher.submit()` JSDoc), the dispatcher performs an
 * unchecked brand cast — documented at the cast site — so the acceptance
 * surface remains uniformly `TaskId`. That trust boundary will be retired
 * with WU-M-INT-2 (legacy fixture migration) at which point the cast site
 * disappears and only `assertTaskId()` admits caller-supplied IDs.
 */
export interface DispatchAcceptance {
  taskId: TaskId;
  acceptedAt: string;
  boundary: 'dispatcher';
}

export interface DispatchSubmission {
  acceptance: DispatchAcceptance;
  completion: Promise<TerminalEvidence>;
}
