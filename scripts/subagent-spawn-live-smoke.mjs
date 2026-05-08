#!/usr/bin/env node
// P4 Stage 4-4 — Live smoke for `SubagentRoster.spawnAndRun(...)`.
//
// Drives a real Codex SDK runtime through one parent dispatch + one
// child dispatch via the spawn-and-run path:
//
//   1. Construct an `AgentRuntime` against the shipped CodexRuntimeDriver,
//      with a SubagentPolicyEnforcer that allows the 'explorer' role.
//   2. Wrap the driver in a one-shot decorator that, on the parent
//      invocation only, calls `instance.subagentRoster.spawnAndRun(...)`
//      with a child instruction ("reply with one-line greeting like
//      'hello from child'") BEFORE delegating to the real Codex driver
//      for the parent.
//   3. Wait for both parent + child to terminate.
//   4. Assert: parent terminal cause = success, child terminal cause =
//      success, child output contains "hello".
//
// This is a smoke test against the live Codex SDK. If `~/.codex/auth.json`
// is absent, the script exits 0 with a "skipped" message so CI does not
// break on missing auth.
//
// Sample command line:
//
//     node scripts/subagent-spawn-live-smoke.mjs
//
// Expected wall time: ~30 seconds (two Codex dispatches back-to-back,
// plus driver warmup). Operator-only: do NOT include this script in
// `pnpm verify`.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const codexAuthPath = join(homedir(), '.codex', 'auth.json');
if (!existsSync(codexAuthPath)) {
  process.stderr.write(
    `[skipped] ${codexAuthPath} not found; cannot run live Codex smoke. Exiting 0.\n`,
  );
  process.exit(0);
}

const { AgentRuntime } = await import(
  '../dist/src/runtime/agent-runtime.js'
);
const { CodexRuntimeDriver } = await import(
  '../dist/src/runtime/codex-runtime-adapter.js'
);
const { resolveCodexBootstrapResolution } = await import(
  '../dist/src/runtime/codex-bootstrap-settings.js'
);
const { Plana } = await import('../dist/src/core/plana.js');
const { SubagentPolicyEnforcer } = await import(
  '../dist/src/runtime/subagent-policy-enforcer.js'
);
const { createDispatchPlan } = await import('../dist/src/core/task.js');

const codexResolution = resolveCodexBootstrapResolution(process.env);
const realCodexDriver = new CodexRuntimeDriver({
  codexOptions: codexResolution.options,
  codexRuntimeConfig: codexResolution.runtimeConfig,
});

let parentDispatchSeen = false;
let childResult;
let childError;

// Decorator that, on the FIRST observed dispatch (the parent), drives
// one child via spawnAndRun(...) before delegating the parent to the
// real Codex driver. Subsequent dispatches (the child running through
// the same driver) go straight to Codex with no recursion.
const decoratedDriver = {
  async run(context) {
    const isParent = context.instance.subagentRoster !== undefined;
    if (isParent && !parentDispatchSeen) {
      parentDispatchSeen = true;
      const roster = context.instance.subagentRoster;
      try {
        childResult = await roster.spawnAndRun({
          options: { role: 'explorer' },
          instruction:
            "Reply with exactly one short line beginning with the word 'hello' (no quotes, no other text). Do not call any tools.",
        });
        process.stderr.write(
          `[parent-driver] child spawnAndRun resolved with cause.kind=${childResult.result.cause.kind}\n`,
        );
      } catch (error) {
        childError = error;
        process.stderr.write(
          `[parent-driver] child spawnAndRun rejected: ${error?.message ?? error}\n`,
        );
      }
    }
    return realCodexDriver.run(context);
  },
};

const subagentPolicyEnforcer = new SubagentPolicyEnforcer({
  policy: {
    maxDepth: 1,
    maxConcurrent: 2,
    allowedRoles: ['explorer', 'coder', 'writer', 'verifier'],
  },
  logger: (warning) => {
    process.stderr.write(`[subagent-policy] ${JSON.stringify(warning)}\n`);
  },
});

const runtime = new AgentRuntime(decoratedDriver, {
  subagentPolicyEnforcer,
});

const plan = createDispatchPlan({
  taskId: 'task-subagent-spawn-live-smoke',
  instruction:
    "Reply with exactly the literal text 'parent-spawn-ok' (no quotes, no other text). Do not call any tools.",
  resources: {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 120, gpuCards: 0 },
  },
  runtimeSettings: {
    networkProfile: 'provider-only',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    workingDirectory: process.cwd(),
  },
  artifactLocation: 'results/task-artifacts',
});

const cancellationBoundary = {
  cancel(veto) {
    return {
      taskId: plan.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
    };
  },
  latchRuntimeVeto(veto) {
    return {
      kind: 'runtime-veto',
      taskId: plan.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
      veto,
    };
  },
  currentTerminalCause: () => undefined,
};

const startedAt = Date.now();
process.stderr.write(`[smoke] starting parent dispatch...\n`);
const evidence = await runtime.execute(
  plan,
  new Plana(),
  cancellationBoundary,
);
const elapsedMs = Date.now() - startedAt;
process.stderr.write(`[smoke] parent dispatch settled in ${elapsedMs}ms\n`);

const summary = {
  parentTerminalCauseKind: evidence.cause.kind,
  childInvoked: parentDispatchSeen,
  childErrorMessage: childError?.message ?? null,
  childTerminalCauseKind: childResult?.result.cause.kind ?? null,
  childArtifactLocation: childResult?.result.cause?.artifactLocation ?? null,
  childReason: childResult?.result.reason ?? null,
  elapsedMs,
};
console.log(JSON.stringify(summary, null, 2));

const ok =
  summary.parentTerminalCauseKind === 'success' &&
  summary.childInvoked === true &&
  summary.childTerminalCauseKind === 'success' &&
  // Child reason text is the lift of Codex's last assistant message;
  // the instruction asked for a line beginning with 'hello', so a
  // case-insensitive substring is the verifier here.
  /hello/i.test(summary.childReason ?? '');

console.log('\nVERDICT:', ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
