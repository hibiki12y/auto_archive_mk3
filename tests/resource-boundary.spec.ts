import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        out.push(path);
      }
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return out;
}

describe('resource submodule runtime boundary', () => {
  it('keeps resource/templestay out of runtime source and scripts', () => {
    const files = [
      ...listFiles('src'),
      ...listFiles('scripts').filter((file) => !file.includes(`${join('scripts', 'dev')}`)),
      'package.json',
    ];

    const offenders = files.filter((file) =>
      readFileSync(file, 'utf8').includes('resource/templestay'),
    );

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });

  it('documents templestay as a reference/plugin resource, not a runtime dependency', () => {
    const doc = readFileSync(
      'specs/CLARIFICATIONS/templestay-reference-boundary.md',
      'utf8',
    );

    expect(doc).toContain('reference/plugin resource posture');
    expect(doc).toContain('not part of Auto Archive\'s runtime stack');
    expect(doc).toContain('not runtime dependency');
  });
});
