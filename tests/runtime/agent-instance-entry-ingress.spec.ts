import { describe, expect, it } from 'vitest';

import { assertDispatchPlanShape } from '../../src/runtime/agent-instance-entry-ingress.js';

function validPlan(): Record<string, unknown> {
  return {
    taskId: 'task-1',
    instruction: 'do the thing',
    createdAt: '2026-04-30T00:00:00.000Z',
    runtimeSettings: { workingDirectory: '/tmp/x' },
    resourceEnvelope: { requested: {}, effective: {} },
  };
}

describe('agent-instance-entry ingress validator', () => {
  it('accepts a minimally well-formed DispatchPlan and returns it as the typed shape', () => {
    const plan = validPlan();
    expect(assertDispatchPlanShape(plan)).toBe(plan);
  });

  it('accepts an optional artifactLocation that is a meaningful string', () => {
    const plan = { ...validPlan(), artifactLocation: 'results/task-1' };
    expect(() => assertDispatchPlanShape(plan)).not.toThrow();
  });

  it('rejects a non-object value', () => {
    expect(() => assertDispatchPlanShape(null)).toThrow(/must be a JSON object/);
    expect(() => assertDispatchPlanShape('plan')).toThrow(/must be a JSON object/);
    expect(() => assertDispatchPlanShape([{ taskId: 'task-1' }])).toThrow(
      /must be a JSON object/,
    );
  });

  it('rejects a missing taskId', () => {
    const plan = validPlan();
    delete plan.taskId;
    expect(() => assertDispatchPlanShape(plan)).toThrow(
      /taskId must be a meaningful string/,
    );
  });

  it('rejects an empty-string instruction', () => {
    expect(() =>
      assertDispatchPlanShape({ ...validPlan(), instruction: '   ' }),
    ).toThrow(/instruction must be a meaningful string/);
  });

  it('rejects a non-string createdAt', () => {
    expect(() =>
      assertDispatchPlanShape({ ...validPlan(), createdAt: 0 }),
    ).toThrow(/createdAt must be a meaningful string/);
  });

  it('rejects a runtimeSettings that is not an object', () => {
    expect(() =>
      assertDispatchPlanShape({ ...validPlan(), runtimeSettings: 'workingDir' }),
    ).toThrow(/runtimeSettings must be an object/);
  });

  it('rejects a resourceEnvelope that is an array (object-but-not-record)', () => {
    expect(() =>
      assertDispatchPlanShape({ ...validPlan(), resourceEnvelope: [] }),
    ).toThrow(/resourceEnvelope must be an object/);
  });

  it('rejects an artifactLocation that is provided but blank', () => {
    expect(() =>
      assertDispatchPlanShape({ ...validPlan(), artifactLocation: '   ' }),
    ).toThrow(/artifactLocation must be a meaningful string when provided/);
  });
});
