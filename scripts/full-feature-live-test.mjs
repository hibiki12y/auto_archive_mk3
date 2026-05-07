#!/usr/bin/env node
// Full-feature live verification.
//
// Runs every layer of the persona hot-swap + research-plan chain back-to-back
// against the real SDKs, confirming the orchestrator + CLI + Discord handler
// still work after the bootstrap refactor that extracted
// `buildDiscordServiceRuntimeDriver`.
//
// Phases:
//
//   P1. Persona hot-swap chain (Arona + Plana simultaneously)
//       Re-runs the existing simultaneous hot-swap smoke. Confirms that the
//       v1.4 + v1.5 routing surface still works after recent driver refactor.
//
//   P2. CLI runner (quickstart plan, codex)
//       Spawns `node scripts/research-plan-runner.mjs` with the shipped
//       quickstart plan. Confirms the operator-facing CLI surface end-to-end.
//
//   P3. Discord handler integration (real RuntimeDriver, real plan file)
//       Constructs DiscordCommandHandlers with the production-shape driver
//       built by buildDiscordServiceRuntimeDriver, simulates a /research-plan
//       Discord interaction against the existing examples/research-plans/
//       quickstart, and verifies the same aggregated synthesis lands in the
//       captured Discord follow-ups. This is the live verification of the
//       command flow that the unit tests cover with stubs.
//
// Auth: Codex via local CLI (~/.codex/auth.json), Claude via local Claude
// Code binary (AUTO_ARCHIVE_CLAUDE_CLI_PATH). Both required.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import {
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
} from '../dist/src/index.js';
import { buildDiscordServiceRuntimeDriver } from '../dist/src/discord/discord-service-bootstrap.js';

// Minimal ComputeNode stub. /research-plan never touches the dispatcher's
// node — the orchestrator goes around AgentRuntime — but DiscordCommandHandlers
// requires the constructor field, so we provide a fail-fast shim that
// satisfies isComputeNode() without doing any actual work.
const NEVER_USED_NODE = {
  capabilities: { kind: 'never-used-stub' },
  async allocate() {
    throw new Error('compute-node.allocate must not be called by /research-plan');
  },
  async dispatch() {
    throw new Error('compute-node.dispatch must not be called by /research-plan');
  },
  observe() {
    /* no-op */
  },
  async cancel() {
    /* no-op */
  },
};

const repoRoot = resolve(import.meta.dirname, '..');

class FakeDiscordInteraction {
  constructor(commandName, strings, userId = 'live-test-user') {
    this.commandName = commandName;
    this.strings = strings;
    this.userId = userId;
    this.channelId = 'live-test-channel';
    this.deferredReplies = [];
    this.editedReplies = [];
    this.followUpReplies = [];
  }
  getString(name, required) {
    const v = this.strings[name];
    if (v !== undefined) return v;
    if (required) throw new Error(`missing required option: ${name}`);
    return null;
  }
  async deferReply(opts) {
    this.deferredReplies.push(opts);
  }
  async editReply(payload) {
    this.editedReplies.push(payload);
  }
  async followUp(payload) {
    this.followUpReplies.push(payload);
  }
}

function runChild(label, args, extraEnv = {}) {
  return new Promise((resolveCmd, rejectCmd) => {
    const start = Date.now();
    process.stderr.write(`\n=== ${label} ===\n$ ${args.join(' ')}\n`);
    const child = spawn(args[0], args.slice(1), {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      const s = b.toString();
      stdout += s;
      // Mirror to terminal so the operator sees progress.
      process.stderr.write(s);
    });
    child.stderr.on('data', (b) => {
      const s = b.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on('error', rejectCmd);
    child.on('exit', (code) => {
      resolveCmd({
        label,
        exitCode: code,
        elapsedMs: Date.now() - start,
        stdout,
        stderr,
      });
    });
  });
}

const phaseResults = {};

// --- P1: simultaneous Arona+Plana hot-swap --------------------------------
const p1 = await runChild('P1: simultaneous hot-swap smoke', [
  'node',
  'scripts/multi-provider-simultaneous-hot-swap-smoke.mjs',
]);
phaseResults.P1 = {
  exitCode: p1.exitCode,
  elapsedMs: p1.elapsedMs,
  ok: p1.exitCode === 0 && /VERDICT: OK/.test(p1.stdout + p1.stderr),
};

// --- P2: CLI runner (quickstart plan) -------------------------------------
const p2 = await runChild('P2: CLI runner quickstart', [
  'node',
  'scripts/research-plan-runner.mjs',
  'examples/research-plans/quickstart-runtime-driver-survey.json',
  '--provider',
  'codex',
]);
phaseResults.P2 = {
  exitCode: p2.exitCode,
  elapsedMs: p2.elapsedMs,
  ok:
    p2.exitCode === 0 &&
    /VERDICT: OK/.test(p2.stdout + p2.stderr) &&
    /quickstart-comparison-OK/.test(p2.stdout),
};

// --- P3: Discord handler with real driver --------------------------------
process.stderr.write('\n=== P3: Discord handler against live RuntimeDriver ===\n');
const p3Start = Date.now();
const driver = buildDiscordServiceRuntimeDriver(process.env);
const dispatcher = new Dispatcher(NEVER_USED_NODE);
const handlers = new DiscordCommandHandlers({
  arona: new Arona(new Plana(), dispatcher),
  dispatcher,
  taskRegistry: new DiscordTaskRegistry(),
  requestFactory: new DefaultDiscordTaskRequestFactory({
    resources: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    },
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: 'results/task-artifacts',
    taskIdFactory: () => 'p3-fixed',
  }),
  researchPlanRuntimeDriver: driver,
  researchPlanWorkingDirectory: repoRoot,
});

const interaction = new FakeDiscordInteraction('research-plan', {
  'plan-id': 'quickstart-runtime-driver-survey',
});
process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY = resolve(
  repoRoot,
  'examples/research-plans',
);
try {
  await handlers.handleInteraction(interaction);
  // The handler kicks off the orchestrator in the background; await its
  // completion by polling the follow-up count. Quickstart should land 4
  // follow-ups (3 progress + 1 final) within ~3-5 min.
  const deadline = Date.now() + 15 * 60 * 1000; // 15 min ceiling
  while (
    interaction.followUpReplies.length < 4 &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  delete process.env.AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY;
}

const p3ElapsedMs = Date.now() - p3Start;
const acceptedText =
  interaction.editedReplies[0]?.content ?? '';
const followText = interaction.followUpReplies
  .map((p) => p?.content ?? '')
  .join('\n');

// The Discord renderer truncates aggregated reports to a ~1900-char budget
// (Discord message size limit) and appends a "(truncated …)" hint pointing
// the operator at the CLI for the full report. For a quickstart-shaped plan
// the synthesis is ~3.7 KB so truncation is expected. We therefore accept
// EITHER (a) the sentinel makes it under the budget, OR (b) the truncation
// hint is present — both are valid end-to-end success signals.
phaseResults.P3 = {
  elapsedMs: p3ElapsedMs,
  acceptedReplyOk: /Research plan `quickstart-runtime-driver-survey` accepted/.test(
    acceptedText,
  ),
  progressFollowUps: interaction.followUpReplies.length,
  finalContainsSentinel: /quickstart-comparison-OK/.test(followText),
  finalContainsTruncationHint: /truncated \d+ chars/.test(followText),
  finalContainsCompleteHeader: /Research plan `quickstart-runtime-driver-survey` complete/.test(
    followText,
  ),
};
phaseResults.P3.ok =
  phaseResults.P3.acceptedReplyOk &&
  (phaseResults.P3.finalContainsSentinel ||
    phaseResults.P3.finalContainsTruncationHint) &&
  phaseResults.P3.finalContainsCompleteHeader &&
  phaseResults.P3.progressFollowUps >= 4;

console.log('\n--- full-feature live test summary ---');
for (const [k, v] of Object.entries(phaseResults)) {
  console.log(`${k}: ${JSON.stringify(v)}`);
}
const allOk = Object.values(phaseResults).every((p) => p.ok);
console.log('\nVERDICT:', allOk ? 'OK' : 'FAIL');
process.exit(allOk ? 0 : 1);
