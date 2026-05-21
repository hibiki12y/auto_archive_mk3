import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CURRENT_DIR = 'specs/CURRENT';
const LIVE_CURRENT_FILES = new Set([
  'agent-repo-comparison-improvement-plan-2026-05-17.md',
  'research-platform-readiness-and-scope-2026-05-21.md',
]);

interface Frontmatter {
  readonly fields: Record<string, string>;
  readonly sourcePaths: readonly string[];
}

function frontmatter(path: string): Frontmatter {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (match === null) {
    throw new Error(`${path} must have YAML frontmatter`);
  }

  const fields: Record<string, string> = {};
  const sourcePaths: string[] = [];
  let inSourcePaths = false;
  for (const line of match[1].split('\n')) {
    if (line === 'source_paths:') {
      inSourcePaths = true;
      continue;
    }
    const sourcePath = /^\s*-\s+(?<path>.+)$/.exec(line);
    if (inSourcePaths && sourcePath?.groups !== undefined) {
      sourcePaths.push(sourcePath.groups.path.trim());
      continue;
    }
    if (!line.startsWith('  ')) {
      inSourcePaths = false;
    }

    const field = /^(?<key>[a-zA-Z_]+):\s*(?<value>.*)$/.exec(line);
    if (field?.groups !== undefined) {
      fields[field.groups.key] = field.groups.value.replace(/^['"]|['"]$/g, '');
    }
  }
  return { fields, sourcePaths };
}

function isLocalPath(path: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

describe('specs/CURRENT authoritative inventory', () => {
  it('keeps only the Hermes comparison plan and readiness SSoT as live-current', () => {
    const files = readdirSync(CURRENT_DIR).filter((file) => !file.startsWith('.'));
    const markdownFiles = files.filter((file) => file.endsWith('.md'));
    const nonMarkdownFiles = files.filter((file) => !file.endsWith('.md'));

    expect(nonMarkdownFiles).toEqual([]);
    expect(markdownFiles).toEqual(expect.arrayContaining([...LIVE_CURRENT_FILES]));

    const liveFiles: string[] = [];
    for (const file of markdownFiles) {
      const { fields, sourcePaths } = frontmatter(join(CURRENT_DIR, file));
      if (LIVE_CURRENT_FILES.has(file)) {
        liveFiles.push(file);
        expect(fields.status).toBe('current');
        expect(['implementation-plan', 'implementation-risk-ledger']).toContain(
          fields.authority,
        );
        continue;
      }

      expect(fields.status, `${file} should be a redirect-only compatibility stub`).toBe(
        'redirect',
      );
      expect(fields.authority, `${file} should not be current authority`).toBe(
        'redirect-only',
      );
      expect(sourcePaths[0], `${file} should point at its archived/supporting target`).toMatch(
        /^specs\/(ARCHIVE|METADATA)\//,
      );
    }

    expect(liveFiles.sort()).toEqual([...LIVE_CURRENT_FILES].sort());
  });

  it('keeps redirect source_paths from dangling', () => {
    const markdownFiles = readdirSync(CURRENT_DIR).filter((file) => file.endsWith('.md'));

    for (const file of markdownFiles) {
      const { sourcePaths } = frontmatter(join(CURRENT_DIR, file));
      for (const sourcePath of sourcePaths) {
        if (isLocalPath(sourcePath)) {
          expect(existsSync(sourcePath), `${file} source path must exist: ${sourcePath}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('keeps model automatic-learning and RL framed as deferred, not current work', () => {
    const comparisonPlan = readFileSync(
      join(CURRENT_DIR, 'agent-repo-comparison-improvement-plan-2026-05-17.md'),
      'utf8',
    );
    const readinessScope = readFileSync(
      join(CURRENT_DIR, 'research-platform-readiness-and-scope-2026-05-21.md'),
      'utf8',
    );

    expect(comparisonPlan).toContain(
      '모델 자동 학습, RL/SFT-DPO, trajectory compression, batch-runner 학습 데이터화, provider zoo는 현시점 개량 목표가 아니다',
    );
    expect(comparisonPlan).toContain('reviewable workflow artifact');
    expect(readinessScope).toContain('model automatic-learning framework');
    expect(readinessScope).toContain('Deferred / out of scope');
    expect(readinessScope).toContain('reviewable workflow artifacts');
  });
});
