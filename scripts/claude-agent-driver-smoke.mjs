#!/usr/bin/env node
// Smoke test: live ClaudeAgentRuntimeDriver against the real SDK.
//
// Drives a tiny task end-to-end through our adapter. Verifies:
//   - SDK lazy-load via createDefaultClaudeAgentQueryFactory()
//   - assistant text/tool_use → emit() event mapping
//   - result message → cause.kind classification
//   - provenance label is 'claude-agent-runtime-driver'
//
// Auth: uses the local Claude Code binary (single-user OAuth dev path) per
// specs/CLARIFICATIONS/multi-provider-scope.md. Production posture would
// flip to AUTO_ARCHIVE_ANTHROPIC_API_KEY + --bare instead.

import {
  ClaudeAgentRuntimeDriver,
  createDefaultClaudeAgentQueryFactory,
} from '../dist/src/runtime/claude-agent-runtime-adapter.js';

const cliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

const driver = new ClaudeAgentRuntimeDriver({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: cliPath,
  permissionMode: 'bypassPermissions',
  maxTurns: 2,
});

const events = [];
const context = {
  plan: {
    taskId: 'task-claude-smoke',
    instruction:
      'Reply with just the literal text "claude-smoke-ok" and nothing else. Do not call any tools.',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: undefined,
    resources: { requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 } },
  },
  instance: {
    taskId: 'task-claude-smoke',
    instanceId: 'agent-task-claude-smoke-' + Date.now(),
    createdAt: new Date().toISOString(),
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
  },
  emit: async (event) => {
    events.push(event);
    process.stderr.write(
      `[event] ${event.kind}` +
        (event.kind === 'item.completed'
          ? ` summary="${(event.item?.summary ?? '').slice(0, 80)}"`
          : '') +
        '\n',
    );
  },
  requestApproval: async ({ request }) => {
    process.stderr.write(`[approval] ${request.kind} ${request.toolName ?? ''}\n`);
    return { status: 'rejected', reason: 'smoke test denies tools' };
  },
  isAborted: () => false,
};

const start = Date.now();
let result;
try {
  result = await driver.run(context);
} catch (error) {
  console.error('DRIVER THREW:', error.name, error.message);
  if (error.providerFailureCause)
    console.error('providerFailureCause:', JSON.stringify(error.providerFailureCause, null, 2));
  process.exit(2);
}
const elapsedMs = Date.now() - start;

console.log('--- smoke result ---');
console.log('elapsedMs:', elapsedMs);
console.log('cause.kind:', result.cause.kind);
console.log('provenance:', result.provenance);
console.log('reason (truncated):', String(result.reason).slice(0, 200));
console.log('emit count:', events.length);
console.log(
  'emit kinds:',
  events.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {}),
);
if (result.cause.kind === 'provider-failure') {
  console.log('classification:', result.cause.classification);
  console.log('provider:', result.cause.provider);
}

const ok =
  result.provenance === 'claude-agent-runtime-driver' &&
  (result.cause.kind === 'success' || result.cause.kind === 'provider-failure');
console.log('VERDICT:', ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
