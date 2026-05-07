import { describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_TOOL_LOOP_DISABLED,
  AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS,
  AUTO_ARCHIVE_TOOL_LOOP_RECENT_WINDOW_SIZE,
  AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH,
  AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT,
  AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH,
  AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT,
  resolveToolLoopDetectorConfigFromEnv,
} from '../src/core/tool-loop-detector.js';
import { createRuntimeEvent } from '../src/index.js';

function toolEvent(args: string, delta = 'same') {
  return createRuntimeEvent({
    kind: 'tool-invocation',
    instanceId: 'runtime-1',
    toolName: 'shell',
    toolKind: 'shell',
    detail: `shell ${args}`,
    argumentsDigest: args,
    observedDeltaDigest: delta,
  });
}

describe('resolveToolLoopDetectorConfigFromEnv', () => {
  it('returns undefined detector when no env knob is set', () => {
    const config = resolveToolLoopDetectorConfigFromEnv({});
    expect(config.detector).toBeUndefined();
    expect(config.resolvedOptions).toBeUndefined();
  });

  it('returns detector=false when explicitly disabled', () => {
    const config = resolveToolLoopDetectorConfigFromEnv({
      [AUTO_ARCHIVE_TOOL_LOOP_DISABLED]: 'true',
    });
    expect(config.detector).toBe(false);
    expect(config.resolvedOptions).toBeUndefined();
  });

  it('honors a raised veto repeat count', () => {
    const config = resolveToolLoopDetectorConfigFromEnv({
      [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '12',
    });
    expect(config.detector).toBeTruthy();
    expect(config.resolvedOptions).toEqual({ vetoRepeatCount: 12 });
    if (!config.detector) throw new Error('detector should be defined');
    const decisions = Array.from({ length: 12 }, () =>
      config.detector === false ? null : config.detector?.observe(toolEvent('same')),
    );
    // pre-veto: warn fires from count=4 onward (default warn=4), veto only at 12.
    expect(decisions[3]).toMatchObject({ status: 'warn', count: 4 });
    expect(decisions[5]).toMatchObject({ status: 'warn', count: 6 });
    expect(decisions[10]).toMatchObject({ status: 'warn', count: 11 });
    expect(decisions[11]).toMatchObject({ status: 'veto', count: 12 });
  });

  it('rejects warn >= veto repeat count', () => {
    expect(() =>
      resolveToolLoopDetectorConfigFromEnv({
        [AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT]: '6',
        [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '6',
      }),
    ).toThrow(/strictly less than/);
  });

  it('rejects warn >= veto ping-pong length', () => {
    expect(() =>
      resolveToolLoopDetectorConfigFromEnv({
        [AUTO_ARCHIVE_TOOL_LOOP_WARN_PING_PONG_LENGTH]: '12',
        [AUTO_ARCHIVE_TOOL_LOOP_VETO_PING_PONG_LENGTH]: '12',
      }),
    ).toThrow(/strictly less than/);
  });

  it('rejects non-positive integers', () => {
    expect(() =>
      resolveToolLoopDetectorConfigFromEnv({
        [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '0',
      }),
    ).toThrow(/positive integer/);
    expect(() =>
      resolveToolLoopDetectorConfigFromEnv({
        [AUTO_ARCHIVE_TOOL_LOOP_RECENT_WINDOW_SIZE]: 'abc',
      }),
    ).toThrow(/positive integer/);
  });

  it('extends knownPollingTools additively', () => {
    const config = resolveToolLoopDetectorConfigFromEnv({
      [AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS]: 'k8s-pod-status, queue-depth',
    });
    expect(config.resolvedOptions?.knownPollingTools).toEqual(
      expect.arrayContaining([
        'status',
        'poll',
        'wait',
        'list_jobs',
        'k8s-pod-status',
        'queue-depth',
      ]),
    );
  });

  it('rejects an empty extra-polling-tools list', () => {
    expect(() =>
      resolveToolLoopDetectorConfigFromEnv({
        [AUTO_ARCHIVE_TOOL_LOOP_EXTRA_POLLING_TOOLS]: ',  ,',
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects an unrecognised disabled value', () => {
    expect(() =>
      resolveToolLoopDetectorConfigFromEnv({
        [AUTO_ARCHIVE_TOOL_LOOP_DISABLED]: 'maybe',
      }),
    ).toThrow(/must be one of/);
  });
});
