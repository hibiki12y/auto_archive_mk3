import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const docPath = resolve(
  process.cwd(),
  'specs/CURRENT/full-matrix-release-blockers-2026-05-16.md',
);

function readDoc(): string {
  return readFileSync(docPath, 'utf8');
}

function parseBlockingRows(doc: string): Map<string, string[]> {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith('| Surface |'));
  expect(start).toBeGreaterThanOrEqual(0);

  const rows = new Map<string, string[]>();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('| ')) {
      break;
    }

    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.length > 0)).toBe(true);
    rows.set(cells[0], cells);
  }

  return rows;
}

describe('full-matrix release blockers ledger', () => {
  it('keeps full-matrix release blocked until live proof is collected', () => {
    const doc = readDoc();

    expect(doc).toContain('authority: implementation-risk-ledger');
    expect(doc).toContain('Full-matrix release is **blocked**');
    expect(doc).toContain('does not satisfy the\ncorrelated command/reply proof row by itself');
    expect(doc).toContain('Any placeholder/template evidence');
    expect(doc).toContain('operatorApproved:true');
    expect(doc).toContain('status:"pass"');
    expect(doc).toContain('raw secret/content field');
  });

  it('covers every operator-gated live-proof surface with an unblock scorer', () => {
    const doc = readDoc();
    const rows = parseBlockingRows(doc);
    const expectedUnblockEvidence = new Map([
      ['Discord service', 'node scripts/check-task-message-shape.mjs'],
      ['GitLab recording', 'pnpm gitlab:admin-bootstrap'],
      ['Codex runtime provider', 'pnpm runtime:provider:evidence:report'],
      ['Claude Agent runtime provider', 'pnpm runtime:provider:evidence:report'],
      ['Agent harness registry', 'pnpm agent:harness:registry:report'],
      ['Plana runtime advisor', 'pnpm plana:advisor:events:report'],
      ['Autonomous research evidence', 'pnpm autonomous:research:evidence:report'],
      ['Durable task archive UX', 'pnpm task:archive:evidence:report'],
      ['Subagent operator surface', 'pnpm subagent:operator:evidence:report'],
      ['Focus/session binding UX', 'pnpm session:binding:evidence:report'],
      ['Task health observer', 'pnpm task:health:evidence:report'],
      ['Trait scheduler tick evidence', 'pnpm trait:scheduler:evidence:report'],
      ['Control-plane OTLP logs', 'pnpm live:proof:report'],
      ['SLURM/Apptainer compute', 'apptainer exec'],
      ['Peekaboo macOS/Discord GUI path', 'pnpm peekaboo:evidence:report'],
      ['Persona model rewrite', 'pnpm persona:telemetry:report'],
    ]);

    expect([...rows.keys()]).toEqual([...expectedUnblockEvidence.keys()]);

    for (const [surface, expectedEvidence] of expectedUnblockEvidence) {
      const row = rows.get(surface);
      expect(row, surface).toBeDefined();
      const [, currentEvidence, missingArtifact, unblockCommand] = row!;
      expect(currentEvidence).not.toMatch(/operator-approved full-matrix pass/i);
      expect(missingArtifact).toMatch(
        /artifact|evidence|record|transcript|receipt|review|report|interaction|jsonl|telemetry/i,
      );
      expect(unblockCommand).toContain(expectedEvidence);
    }

    expect(doc).toContain('pnpm live:proof:report -- --proof runtime-state/live-proof.json --pretty');
    expect(doc).toContain('pnpm runtime:provider:evidence:report');
    expect(doc).toContain('pnpm persona:telemetry:report');
  });
});
