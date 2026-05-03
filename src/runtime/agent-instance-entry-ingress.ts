/**
 * Container-side ingress validator for the host→container DispatchPlan
 * envelope used by `agent-instance-entry.ts`.
 *
 * The host always serializes a fully-formed `DispatchPlan`, but once the
 * JSON crosses the apptainer process boundary it is just bytes — a
 * truncated stdin, a schema-skewed host, or a tampered intermediary could
 * surface here as an object whose shape disagrees with the static type.
 * Casting `JSON.parse(...)` straight to `DispatchPlan` defeated exactly
 * the assertion the boundary needed; downstream reads such as
 * `plan.runtimeSettings.workingDirectory` would otherwise fail with
 * confusing "cannot read property of undefined" deep inside
 * `AgentRuntime`.
 *
 * This module owns the ingress contract only; the entry script itself
 * lives in `agent-instance-entry.ts` and remains a side-effecting CLI
 * (top-level `void main()`), so the validator was lifted out to keep it
 * importable from tests without triggering the entry-script's main loop.
 */

import type { DispatchPlan } from '../core/task.js';

/**
 * Validates the top-level fields the container actually reads
 * (`taskId`, `instruction`, `runtimeSettings`, `resourceEnvelope`,
 * `createdAt`, optional `artifactLocation`). Deep field validation of
 * the resource and runtime-settings sub-trees stays the responsibility
 * of the host's `createDispatchPlan` boundary; the container only checks
 * that the sub-trees are non-null objects.
 */
export function assertDispatchPlanShape(value: unknown): DispatchPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('agent-instance-entry: DispatchPlan must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  requireMeaningfulString(record, 'taskId');
  requireMeaningfulString(record, 'instruction');
  requireMeaningfulString(record, 'createdAt');
  requireRecord(record, 'runtimeSettings');
  requireRecord(record, 'resourceEnvelope');
  if (
    record['artifactLocation'] !== undefined &&
    (typeof record['artifactLocation'] !== 'string' ||
      record['artifactLocation'].trim().length === 0)
  ) {
    throw new Error(
      'agent-instance-entry: DispatchPlan.artifactLocation must be a meaningful string when provided.',
    );
  }
  return value as DispatchPlan;
}

function requireMeaningfulString(
  record: Record<string, unknown>,
  field: string,
): void {
  const v = record[field];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(
      `agent-instance-entry: DispatchPlan.${field} must be a meaningful string.`,
    );
  }
}

function requireRecord(
  record: Record<string, unknown>,
  field: string,
): void {
  const v = record[field];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(
      `agent-instance-entry: DispatchPlan.${field} must be an object.`,
    );
  }
}
