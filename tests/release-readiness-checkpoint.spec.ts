import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const redirectPath = resolve(
  process.cwd(),
  'specs/CURRENT/release-readiness-checkpoint-2026-05-16.md',
);
const archivePath = resolve(
  process.cwd(),
  'specs/ARCHIVE/release-readiness-checkpoint-2026-05-16.md',
);
const currentScopePath = resolve(
  process.cwd(),
  'specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('release readiness checkpoint archival redirect', () => {
  it('keeps the 2026-05-16 WARN checkpoint as archived history only', () => {
    const redirect = read(redirectPath);
    const archive = read(archivePath);

    expect(redirect).toContain('status: redirect');
    expect(redirect).toContain('authority: redirect-only');
    expect(redirect).toContain(
      'specs/ARCHIVE/release-readiness-checkpoint-2026-05-16.md',
    );
    expect(redirect).toContain(
      'specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md',
    );
    expect(redirect).toContain('contains no\nsecond copy of the archived checkpoint');

    expect(archive).toContain('WARN / not release-complete');
    expect(archive).toContain('Operator-gated live proof gate');
    expect(archive).toContain('approved host verification environment');
  });

  it('pins the current product boundary and readiness evidence classes', () => {
    const current = read(currentScopePath);

    expect(current).toContain('Discord-centered automatic research workflow and\nevidence-governance platform');
    expect(current).toContain('Model automatic learning / RL environments / SFT-DPO dataset generation');
    expect(current).toContain('2026-05-16 release-readiness checkpoint');
    expect(current).toContain('Repo-local static evidence');
    expect(current).toContain('Retained live-proof replay');
    expect(current).toContain('Fresh live runtime proof');
  });
});
