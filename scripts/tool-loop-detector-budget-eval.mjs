#!/usr/bin/env node
// Live evaluation: tool-loop detector budget hot-swap.
//
// Drives the in-memory detector with a synthetic stream of repeated
// identical-fingerprint tool invocations under three configurations:
//
//   1. default                                    (veto at count=6)
//   2. AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT=20 (veto at count=20)
//   3. AUTO_ARCHIVE_TOOL_LOOP_DISABLED=1           (never veto)
//
// Verifies:
//   - Default: veto fires at the 6th repetition.
//   - Raised:  veto fires at the 20th repetition (12 of 20 are still warns).
//   - Disabled: detector is `false` so 50 repetitions all pass.
//
// Pure offline run — no SDK calls, just env-driven config and event replay.
// Useful as the proof-of-payment for the new knobs before wiring them into a
// long-budget complex-research dispatch.

import {
  AUTO_ARCHIVE_TOOL_LOOP_DISABLED,
  AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT,
  resolveToolLoopDetectorConfigFromEnv,
} from '../dist/src/core/tool-loop-detector.js';
import { createRuntimeEvent } from '../dist/src/index.js';
import { createToolLoopDetector } from '../dist/src/core/tool-loop-detector.js';

function event() {
  return createRuntimeEvent({
    kind: 'tool-invocation',
    instanceId: 'budget-eval',
    toolName: 'shell',
    toolKind: 'shell',
    detail: 'shell rg --files src',
    argumentsDigest: 'rg-files-src',
    observedDeltaDigest: 'same',
  });
}

function runWith(label, env, totalCalls) {
  let resolved;
  try {
    resolved = resolveToolLoopDetectorConfigFromEnv(env);
  } catch (error) {
    return {
      label,
      threw: error?.message ?? String(error),
    };
  }
  const detector =
    resolved.detector === false
      ? null
      : resolved.detector ?? createToolLoopDetector();

  const histogram = { ok: 0, warn: 0, veto: 0 };
  let firstVetoAt = null;
  let firstWarnAt = null;
  for (let i = 1; i <= totalCalls; i++) {
    if (detector === null) {
      histogram.ok++;
      continue;
    }
    const decision = detector.observe(event());
    histogram[decision.status] = (histogram[decision.status] ?? 0) + 1;
    if (decision.status === 'warn' && firstWarnAt === null) firstWarnAt = i;
    if (decision.status === 'veto' && firstVetoAt === null) firstVetoAt = i;
  }
  return {
    label,
    detectorMode: detector === null ? 'disabled' : 'enabled',
    resolvedOptions: resolved.resolvedOptions,
    totalCalls,
    histogram,
    firstWarnAt,
    firstVetoAt,
  };
}

const results = [];
results.push(runWith('default', {}, 30));
results.push(
  runWith(
    'raised-to-20',
    { [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '20' },
    50,
  ),
);
results.push(
  runWith(
    'disabled',
    { [AUTO_ARCHIVE_TOOL_LOOP_DISABLED]: '1' },
    50,
  ),
);
results.push(
  runWith('rejects-warn>=veto', {
    AUTO_ARCHIVE_TOOL_LOOP_WARN_REPEAT_COUNT: '6',
    AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT: '6',
  }, 0),
);

console.log('--- tool-loop detector budget eval ---');
for (const r of results) console.log(JSON.stringify(r));

const ok =
  results[0].firstVetoAt === 6 &&
  results[1].firstVetoAt === 20 &&
  results[2].firstVetoAt === null &&
  results[2].histogram.ok === 50 &&
  typeof results[3].threw === 'string' &&
  /strictly less than/.test(results[3].threw);

console.log('VERDICT:', ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
