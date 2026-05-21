import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// UX-13 — automation-friendly --json output for scripts/research-plan-runner.mjs.
//
// We can't end-to-end exercise the runner inside a unit test (it spins up
// a real RuntimeDriver that would talk to Codex / Claude Agent over the
// network). Instead the test enforces:
//   1. The CLI accepts --json without throwing on unrecognized arg.
//   2. --help output documents the new flag so operators discover it.
//   3. The script source contains the JSONL emission scaffolding that
//      shapes per-sub-task outcomes, the synthesis outcome, and a
//      trailing run-summary record on stdout when jsonMode is on.
//
// The shape contract is also pinned by inspecting the literal record
// keys in the source, which guards against silent renames that would
// break downstream JSONL consumers without flipping any unit test.

const RUNNER_PATH = resolve(__dirname, '..', 'scripts', 'research-plan-runner.mjs');

describe('research-plan-runner --json (UX-13)', () => {
  it('--help advertises the --json flag in usage', () => {
    const result = spawnSync('node', [RUNNER_PATH, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(result.status).toBe(0);
    const usageBlob = `${result.stdout}\n${result.stderr}`;
    expect(usageBlob).toContain('--json');
    expect(usageBlob).toContain('research-plan-runner.mjs');
  });

  it('rejects --json combined with an unrecognized arg without crashing', () => {
    const result = spawnSync(
      'node',
      [RUNNER_PATH, '--json', '--no-such-flag'],
      { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
    );
    // arg parser throws → the runner exits non-zero with the bad-arg
    // message on stderr. Stdout must stay clean even in jsonMode so a
    // pipeline like `runner --json | jq` is not poisoned by partial
    // human-readable text before parser failure.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unrecognized arg');
  });

  it('fails closed for research-plan.v2 live execution attempts', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'research-plan-runner-v2-'));
    try {
      const planPath = join(workspace, 'v2.json');
      writeFileSync(
        planPath,
        JSON.stringify({
          schema: 'research-plan.v2',
          steps: [
            {
              kind: 'task',
              taskId: 'v2-task',
              instruction: 'private instruction must not run',
            },
          ],
          synthesis: {
            taskId: 'v2-synth',
            instructionTemplate: 'private synthesis must not run',
          },
          runtimeSettings: {
            networkProfile: 'provider-only',
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-request',
          },
          resources: {
            requested: {
              cpuCores: 1,
              memoryMiB: 256,
              wallTimeSec: 60,
              gpuCards: 0,
            },
          },
        }),
        'utf8',
      );

      const result = spawnSync('node', [RUNNER_PATH, planPath, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('research-plan.v2 is validate/dry-run only');
      expect(result.stderr).toContain('research:plan:dry-run');
      expect(result.stderr).not.toContain('private instruction must not run');
      expect(result.stderr).not.toContain('private synthesis must not run');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('source contains the per-sub-task outcome JSON record shape', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain("type: 'sub-task-outcome'");
    expect(source).toContain('subTaskId: o.subTaskId');
    expect(source).toContain('causeKind: o.causeKind');
    expect(source).toContain('elapsedMs: o.elapsedMs');
    expect(source).toContain('eventCount: o.eventCount');
    expect(source).toContain('toolUseCount: o.toolUseCount');
    expect(source).toContain('finalLength: o.finalText.length');
  });

  it('source contains the synthesis outcome JSON record shape', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain("type: 'synthesis-outcome'");
    expect(source).toContain('subTaskId: result.synthesisOutcome.subTaskId');
  });

  it('source contains the trailing run-summary record (verdict + skipped)', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain("type: 'run-summary'");
    expect(source).toContain('verdict,');
    expect(source).toContain('totalElapsedMs: elapsed');
    expect(source).toContain('stoppedEarly: result.stoppedEarly');
    expect(source).toContain('skippedSubTaskIds: result.skippedSubTaskIds');
  });

  it('source enforces stdout/stderr discipline (emitJson only writes when jsonMode)', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    // emitHuman writes to stdout only when jsonMode is OFF — keeps the
    // legacy human-readable path bit-stable for callers that didn't
    // opt in.
    expect(source).toContain('function emitHuman(line)');
    expect(source).toContain('if (!jsonMode)');
    // emitJson writes to stdout only when jsonMode is ON — so a non-JSON
    // run never contaminates stdout with a JSONL trailer.
    expect(source).toContain('function emitJson(record)');
    expect(source).toContain('if (jsonMode)');
  });
});
