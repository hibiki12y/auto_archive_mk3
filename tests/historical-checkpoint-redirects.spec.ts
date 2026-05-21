import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const redirectCases = [
  {
    label: 'midpoint checkpoint',
    current: 'specs/CURRENT/midpoint-checkpoint-2026-05-05.md',
    archive: 'specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md',
    archivedNeedle: 'Midpoint Checkpoint — 2026-05-05',
    redirectNeedle: 'Redirect — Midpoint Checkpoint, 2026-05-05',
  },
  {
    label: 'open-harness parity completion audit',
    current: 'specs/CURRENT/open-harness-parity-completion-audit-2026-05-05.md',
    archive: 'specs/ARCHIVE/open-harness-parity-completion-audit-2026-05-05.md',
    archivedNeedle: 'Open Harness Parity Completion Audit — 2026-05-05',
    redirectNeedle: 'Redirect — Open Harness Parity Completion Audit, 2026-05-05',
  },
  {
    label: 'remaining issues close-out ledger',
    current: 'specs/CURRENT/remaining-issues-2026-04-30.md',
    archive: 'specs/ARCHIVE/remaining-issues-2026-04-30.md',
    archivedNeedle: '2026-04-30 Remaining Issues Ledger — Resolved Follow-up',
    redirectNeedle: 'Redirect — Remaining Issues Ledger, 2026-04-30',
  },
] as const;

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('historical checkpoint redirects', () => {
  for (const item of redirectCases) {
    it(`keeps ${item.label} as archive history with a redirect-only CURRENT stub`, () => {
      const redirect = read(item.current);
      const archive = read(item.archive);

      expect(redirect).toContain('status: redirect');
      expect(redirect).toContain('authority: redirect-only');
      expect(redirect).toContain(item.archive);
      expect(redirect).toContain(
        'specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md',
      );
      expect(redirect).toContain(item.redirectNeedle);
      expect(archive).toContain(item.archivedNeedle);
    });
  }
});
