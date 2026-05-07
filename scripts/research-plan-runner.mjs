#!/usr/bin/env node
// Generic research-plan runner CLI.
//
// Loads a research plan from a JSON file, builds the configured RuntimeDriver
// (codex or claude-agent), and dispatches the plan via runResearchPlan(...).
// Streams per-event heartbeats to stderr, prints the per-sub-task summary +
// final aggregated report to stdout, and exits 0/1 based on whether every
// sub-task and synthesis succeeded.
//
// Usage:
//
//   node scripts/research-plan-runner.mjs <plan.json>
//       [--provider codex|claude-agent]   (default: codex)
//       [--max-turns N]                   (claude-agent only; default: 30)
//       [--report-out <file>]             (write the aggregated report here)
//
// Plan JSON shape (see src/core/research-plan-orchestrator.ts):
//
//   {
//     "subTasks": [
//       { "taskId": "...", "instruction": "..." },
//       ...
//     ],
//     "synthesis": {
//       "taskId": "...",
//       "instructionTemplate": "...{{subTaskOutputs}}..."
//     },
//     "runtimeSettings": {
//       "networkProfile": "provider-only",
//       "sandboxMode": "workspace-write",
//       "approvalPolicy": "on-request",
//       "workingDirectory": "."
//     },
//     "resources": {
//       "requested": { "cpuCores": 1, "memoryMiB": 256, "wallTimeSec": 600, "gpuCards": 0 }
//     }
//   }
//
// Auth: Codex via local CLI (~/.codex/auth.json) or AUTO_ARCHIVE_CODEX_API_KEY;
// Claude via local Claude Code binary (AUTO_ARCHIVE_CLAUDE_CLI_PATH) or
// AUTO_ARCHIVE_ANTHROPIC_API_KEY.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import {
  ClaudeAgentRuntimeDriver,
  createDefaultClaudeAgentQueryFactory,
} from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { runResearchPlan } from '../dist/src/core/research-plan-orchestrator.js';

function parseArgs(argv) {
  const args = { provider: 'codex', maxTurns: 30 };
  let planPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') {
      args.provider = argv[++i];
    } else if (a === '--max-turns') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--max-turns must be a positive integer, got ${argv[i]}`);
      }
      args.maxTurns = n;
    } else if (a === '--report-out') {
      args.reportOut = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (planPath === undefined && !a.startsWith('--')) {
      planPath = a;
    } else {
      throw new Error(`unrecognized arg: ${a}`);
    }
  }
  if (args.help || planPath === undefined) {
    console.error(
      'Usage: node scripts/research-plan-runner.mjs <plan.json> ' +
        '[--provider codex|claude-agent] [--max-turns N] [--report-out <file>]',
    );
    process.exit(args.help ? 0 : 2);
  }
  if (args.provider !== 'codex' && args.provider !== 'claude-agent') {
    throw new Error(`--provider must be codex or claude-agent, got ${args.provider}`);
  }
  return { planPath, ...args };
}

function buildDriver(provider, maxTurns) {
  if (provider === 'claude-agent') {
    const claudeCliPath =
      process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';
    return new ClaudeAgentRuntimeDriver({
      queryFactory: createDefaultClaudeAgentQueryFactory(),
      pathToClaudeCodeExecutable: claudeCliPath,
      permissionMode: 'bypassPermissions',
      maxTurns,
    });
  }
  const codexResolution = resolveCodexBootstrapResolution(process.env);
  return new CodexRuntimeDriver({
    codexOptions: codexResolution.options,
    codexRuntimeConfig: codexResolution.runtimeConfig,
  });
}

const { planPath, provider, maxTurns, reportOut } = parseArgs(process.argv.slice(2));
const planAbs = resolve(planPath);
process.stderr.write(`[runner] loading plan ${planAbs}\n`);
const planRaw = readFileSync(planAbs, 'utf8');
const plan = JSON.parse(planRaw);

if (!Array.isArray(plan.subTasks) || plan.subTasks.length === 0) {
  throw new Error('plan.subTasks must be a non-empty array.');
}
if (
  !plan.synthesis ||
  typeof plan.synthesis.taskId !== 'string' ||
  typeof plan.synthesis.instructionTemplate !== 'string'
) {
  throw new Error('plan.synthesis.{taskId,instructionTemplate} required.');
}
if (!plan.runtimeSettings || !plan.resources) {
  throw new Error('plan.runtimeSettings and plan.resources required.');
}

process.stderr.write(
  `[runner] provider=${provider} ${provider === 'claude-agent' ? `maxTurns=${maxTurns} ` : ''}` +
    `subTasks=${plan.subTasks.length}\n`,
);

const driver = buildDriver(provider, maxTurns);
const start = Date.now();
let lastEventLog = start;
const result = await runResearchPlan(driver, plan, {
  onEvent: ({ subTaskId, event }) => {
    const now = Date.now();
    if (
      event.kind === 'turn.started' ||
      event.kind === 'turn.completed' ||
      now - lastEventLog > 5000
    ) {
      process.stderr.write(
        `[${subTaskId}] ${event.kind} @+${((now - start) / 1000).toFixed(1)}s\n`,
      );
      lastEventLog = now;
    }
  },
});
const elapsed = Date.now() - start;

console.log('--- research-plan runner summary ---');
for (const o of result.subTaskOutcomes) {
  console.log(
    JSON.stringify({
      subTaskId: o.subTaskId,
      causeKind: o.causeKind,
      elapsedMs: o.elapsedMs,
      eventCount: o.eventCount,
      toolUseCount: o.toolUseCount,
      finalLength: o.finalText.length,
    }),
  );
}
if (result.synthesisOutcome !== undefined) {
  console.log(
    JSON.stringify({
      subTaskId: result.synthesisOutcome.subTaskId,
      causeKind: result.synthesisOutcome.causeKind,
      elapsedMs: result.synthesisOutcome.elapsedMs,
      eventCount: result.synthesisOutcome.eventCount,
      toolUseCount: result.synthesisOutcome.toolUseCount,
      finalLength: result.synthesisOutcome.finalText.length,
    }),
  );
}
console.log(`totalElapsedMs: ${elapsed}`);
console.log(`stoppedEarly: ${result.stoppedEarly}`);

if (reportOut !== undefined) {
  writeFileSync(reportOut, result.aggregatedReport, 'utf8');
  console.log(`reportWrittenTo: ${resolve(reportOut)}`);
} else {
  console.log('\n--- aggregated report ---');
  console.log(result.aggregatedReport);
}

const allOk =
  !result.stoppedEarly &&
  result.subTaskOutcomes.every((o) => o.causeKind === 'success') &&
  result.synthesisOutcome?.causeKind === 'success';
console.log(`\nVERDICT: ${allOk ? 'OK' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
