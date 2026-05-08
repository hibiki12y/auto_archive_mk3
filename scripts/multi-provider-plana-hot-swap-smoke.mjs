#!/usr/bin/env node
// Smoke test: live MultiProviderPlanaAdvisor — operator-driven Plana provider
// hot-swap (spec v1.5.0).
//
// Wires the real PlanaClaudeRuntimeAdvisor and the real PlanaCodexRuntimeAdvisor
// behind a single MultiProviderPlanaAdvisor. Then issues three back-to-back
// review() calls with the operator's `plana.provider` override flipping
// between providers between each call:
//
//   1. no override                 → routes to defaultProvider (claude-agent)
//   2. override = 'codex'          → routes to PlanaCodexRuntimeAdvisor
//   3. override = 'claude-agent'   → routes to PlanaClaudeRuntimeAdvisor
//
// Verifies:
//   - Each review() lands on the expected sub-advisor (verdict.provenance for
//     vetoes, or onAdvise hook payload for approves).
//   - Each review() returns a real SDK-backed verdict (approve or veto with
//     a parseable JSON body).
//   - The wrapper consults the override fresh on every call (the same wrapper
//     instance is reused).
//   - onProviderSelected fires once per call with correct attribution.
//
// Auth: Codex via local CLI (~/.codex/auth.json), Claude via local Claude
// Code binary.

import {
  PlanaClaudeRuntimeAdvisor,
  PLANA_CLAUDE_ADVISOR_PROVENANCE,
} from '../dist/src/core/plana-claude-runtime-advisor.js';
import {
  PlanaCodexRuntimeAdvisor,
  PLANA_CODEX_ADVISOR_PROVENANCE,
} from '../dist/src/core/plana-codex-runtime-advisor.js';
import { MultiProviderPlanaAdvisor } from '../dist/src/core/multi-provider-plana-advisor.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import { createDefaultClaudeAgentQueryFactory } from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { createDispatchPlan } from '../dist/src/core/task.js';

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

const codexResolution = resolveCodexBootstrapResolution(process.env);

const codexAdviseLog = [];
const codexAdvisor = new PlanaCodexRuntimeAdvisor({
  codexOptions: codexResolution.options,
  maxAdvisorCallsPerInstance: 5,
  onAdvise: (info) => {
    codexAdviseLog.push({
      provenance: PLANA_CODEX_ADVISOR_PROVENANCE,
      verdict: info.verdict.status,
      sample: info.responseText.slice(0, 80),
    });
    process.stderr.write(
      `[codex-advise] verdict=${info.verdict.status} sample=${JSON.stringify(info.responseText.slice(0, 80))}\n`,
    );
  },
});

const claudeAdviseLog = [];
const claudeAdvisor = new PlanaClaudeRuntimeAdvisor({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: claudeCliPath,
  maxAdvisorCallsPerInstance: 5,
  onAdvise: (info) => {
    claudeAdviseLog.push({
      provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
      verdict: info.verdict.status,
      sample: info.responseText.slice(0, 80),
    });
    process.stderr.write(
      `[claude-advise] verdict=${info.verdict.status} sample=${JSON.stringify(info.responseText.slice(0, 80))}\n`,
    );
  },
});

let activeOverride;
const auditLog = [];

const wrapper = new MultiProviderPlanaAdvisor({
  codexAdvisor,
  claudeAdvisor,
  defaultProvider: 'claude-agent',
  settingsProvider: {
    readSettings: () =>
      activeOverride === undefined ? {} : { provider: activeOverride },
  },
  onProviderSelected: (sel) => {
    auditLog.push({ ...sel });
    process.stderr.write(
      `[selected] provider=${sel.provider} source=${sel.source}\n`,
    );
  },
});

function buildAdvisorInput(label, instanceLabel) {
  const plan = createDispatchPlan({
    taskId: `task-plana-swap-${label}`,
    instruction:
      'Smoke test plan — agent ran a benign agent_message describing tests it intends to run.',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: 'results/task-artifacts',
    resources: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    },
  });
  // Synthesize one item.completed event of type agent_message — this is in the
  // ADVISED_KINDS / ADVISED_ITEM_TYPES sets and triggers a real consultation.
  return {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: `agent-${plan.taskId}-${instanceLabel}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      runtimeSettings: plan.runtimeSettings,
    },
    event: {
      kind: 'item.completed',
      timestamp: new Date().toISOString(),
      instanceId: `agent-${plan.taskId}-${instanceLabel}`,
      item: {
        type: 'agent_message',
        summary:
          'I will read the test runner script and report which suite I plan to execute. No tools called yet.',
      },
    },
  };
}

async function consult(label, expectedProvenance) {
  const input = buildAdvisorInput(label, label);
  const start = Date.now();
  let verdict;
  try {
    verdict = await wrapper.review(input);
  } catch (error) {
    console.error(`ADVISOR THREW (${label}):`, error?.name, error?.message);
    return { label, ok: false };
  }
  const elapsedMs = Date.now() - start;

  const subProvenance =
    expectedProvenance === PLANA_CLAUDE_ADVISOR_PROVENANCE
      ? 'claude'
      : 'codex';
  const subLog = subProvenance === 'claude' ? claudeAdviseLog : codexAdviseLog;
  const subBefore = subLog.length;
  const matchedSub = subLog.length > subBefore - 1; // one entry should now exist for this call
  process.stderr.write(
    `[review ${label}] elapsedMs=${elapsedMs} verdict=${verdict.status}` +
      (verdict.status === 'veto'
        ? ` provenance=${verdict.provenance}`
        : '') +
      `\n`,
  );
  return {
    label,
    ok: verdict.status === 'approve' || verdict.status === 'veto',
    elapsedMs,
    verdictStatus: verdict.status,
    verdictProvenance:
      verdict.status === 'veto' ? verdict.provenance : 'n/a-approve',
    matchedSub,
  };
}

const results = [];

// Snapshot the per-sub-advisor onAdvise log lengths before each consult so we
// can assert the right sub-advisor handled the call.
let claudeBefore = claudeAdviseLog.length;
let codexBefore = codexAdviseLog.length;

activeOverride = undefined;
results.push(await consult('default-claude', PLANA_CLAUDE_ADVISOR_PROVENANCE));
const claudeDelta1 = claudeAdviseLog.length - claudeBefore;
const codexDelta1 = codexAdviseLog.length - codexBefore;
claudeBefore = claudeAdviseLog.length;
codexBefore = codexAdviseLog.length;

activeOverride = 'codex';
results.push(await consult('override-codex', PLANA_CODEX_ADVISOR_PROVENANCE));
const claudeDelta2 = claudeAdviseLog.length - claudeBefore;
const codexDelta2 = codexAdviseLog.length - codexBefore;
claudeBefore = claudeAdviseLog.length;
codexBefore = codexAdviseLog.length;

activeOverride = 'claude-agent';
results.push(
  await consult('override-claude-agent', PLANA_CLAUDE_ADVISOR_PROVENANCE),
);
const claudeDelta3 = claudeAdviseLog.length - claudeBefore;
const codexDelta3 = codexAdviseLog.length - codexBefore;

console.log('\n--- multi-provider Plana hot-swap smoke summary ---');
for (const r of results) {
  console.log(JSON.stringify(r));
}
console.log('\nper-sub-advisor onAdvise deltas (claude/codex):');
console.log(`  call1 (default→claude):       claude=${claudeDelta1}, codex=${codexDelta1}`);
console.log(`  call2 (override→codex):       claude=${claudeDelta2}, codex=${codexDelta2}`);
console.log(`  call3 (override→claude):      claude=${claudeDelta3}, codex=${codexDelta3}`);

console.log('\nrouter audit log:');
console.log(JSON.stringify(auditLog, null, 2));

const allOk = results.every((r) => r.ok);
const auditMatches =
  auditLog.length === 3 &&
  auditLog[0].provider === 'claude-agent' &&
  auditLog[0].source === 'default' &&
  auditLog[1].provider === 'codex' &&
  auditLog[1].source === 'override' &&
  auditLog[2].provider === 'claude-agent' &&
  auditLog[2].source === 'override';
const subAdvisorRouting =
  claudeDelta1 === 1 &&
  codexDelta1 === 0 &&
  claudeDelta2 === 0 &&
  codexDelta2 === 1 &&
  claudeDelta3 === 1 &&
  codexDelta3 === 0;

const verdict = allOk && auditMatches && subAdvisorRouting ? 'OK' : 'FAIL';
console.log('VERDICT:', verdict);
process.exit(verdict === 'OK' ? 0 : 1);
