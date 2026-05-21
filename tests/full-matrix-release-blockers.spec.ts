import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const redirectPath = resolve(
  process.cwd(),
  'specs/CURRENT/full-matrix-release-blockers-2026-05-16.md',
);
const archivePath = resolve(
  process.cwd(),
  'specs/ARCHIVE/full-matrix-release-blockers-2026-05-16.md',
);
const currentScopePath = resolve(
  process.cwd(),
  'specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('full-matrix release blockers archival redirect', () => {
  it('keeps the 2026-05-16 blocker ledger as archived history only', () => {
    const redirect = read(redirectPath);
    const archive = read(archivePath);

    expect(redirect).toContain('status: redirect');
    expect(redirect).toContain('authority: redirect-only');
    expect(redirect).toContain(
      'specs/ARCHIVE/full-matrix-release-blockers-2026-05-16.md',
    );
    expect(redirect).toContain(
      'specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md',
    );
    expect(redirect).toContain('contains no\nsecond copy of the archived blocker table');

    expect(archive).toContain('authority: implementation-risk-ledger');
    expect(archive).toContain('Full-matrix release is **blocked**');
    expect(archive).toContain('Any placeholder/template evidence');
  });

  it('points current readiness to the 2026-05-21 scope/readiness SSoT', () => {
    const current = read(currentScopePath);

    expect(current).toContain('status: current');
    expect(current).toContain('Auto Archive is **not** currently a model automatic-learning framework');
    expect(current).toContain('report status | `complete`');
    expect(current).toContain('active complete PASS records | 15');
    expect(current).toContain('Historical blocker closure map');
    const expectedRows = [
      ['Discord service', 'discord-service', 'active PASS'],
      ['GitLab recording', 'gitlab-recording', 'active PASS'],
      ['Codex runtime provider', 'codex-runtime-provider', 'active PASS'],
      ['Claude Agent runtime provider', 'claude-agent-runtime-provider', 'active PASS'],
      ['Agent harness registry', 'agent-harness-registry', 'active PASS'],
      ['Plana runtime advisor', 'plana-runtime-advisor', 'active PASS'],
      ['Autonomous research evidence', 'autonomous-research-evidence', 'active PASS'],
      ['Durable task archive UX', 'durable-task-archive-ux', 'active PASS'],
      ['Subagent operator surface', 'subagent-operator-surface', 'active PASS'],
      ['Focus/session binding UX', 'focus-session-binding-ux', 'active PASS'],
      ['Task health observer', 'task-health-observer', 'active PASS'],
      ['Trait scheduler tick evidence', 'trait-scheduler-tick-evidence', 'active PASS'],
      ['Control-plane OTLP logs', 'control-plane-otel-logs', 'active PASS'],
      ['SLURM/Apptainer compute', 'slurm-apptainer-compute', 'active PASS'],
      ['Peekaboo macOS/Discord GUI path', 'peekaboo-discord-gui', 'active PASS'],
      ['Persona model rewrite', 'persona-model-rewrite', 'mothballed retained PASS'],
    ] as const;

    for (const [archivedRow, retainedSurface, posture] of expectedRows) {
      expect(current).toContain(
        `| ${archivedRow} | \`${retainedSurface}\` | ${posture}`,
      );
    }

    expect(current).toContain('mothballed retained row | `persona-model-rewrite`');
    expect(current).toContain('Retained live-proof replay');
  });
});
