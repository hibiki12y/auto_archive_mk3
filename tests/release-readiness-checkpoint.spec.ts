import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const checkpointPath = resolve(
  process.cwd(),
  'specs/CURRENT/release-readiness-checkpoint-2026-05-16.md',
);

function readCheckpoint(): string {
  return readFileSync(checkpointPath, 'utf8');
}

describe('release readiness checkpoint', () => {
  it('keeps release completion gated on operator-owned live proof', () => {
    const doc = readCheckpoint();

    expect(doc).toContain('status: current');
    expect(doc).toContain('authority: implementation-risk-ledger');
    expect(doc).toContain('WARN / not release-complete');
    expect(doc).toContain('Operator-gated live proof gate');
    expect(doc).toContain('pnpm live:proof:report -- --proof <manifest> --pretty');
    expect(doc).toContain('live-proof-matrix.md');
    expect(doc).toContain('approved host verification environment');
  });

  it('pins the current SLURM/Apptainer release hygiene slice', () => {
    const doc = readCheckpoint();

    expect(doc).toContain('dist/src/runtime/agent-instance-entry.js');
    expect(doc).toContain('multi-provider runtime posture');
    expect(doc).toMatch(
      /must not emit the\s+unsupported `exec --read-only` token/u,
    );
    expect(doc).toContain('test -f dist/src/runtime/agent-instance-entry.js');
    expect(doc).toContain('`--writable-tmpfs`');
  });
});
