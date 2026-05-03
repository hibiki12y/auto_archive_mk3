import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SPEC_PATH = resolve(
  REPO_ROOT,
  'specs/CURRENT/methodology-skill-admission-governance.md',
);

const SPEC_TEXT = readFileSync(SPEC_PATH, 'utf8');

const REQUIRED_SOURCE_URLS = [
  'https://arxiv.org/abs/2201.11903',
  'https://arxiv.org/abs/2203.11171',
  'https://arxiv.org/abs/2305.10601',
  'https://arxiv.org/abs/2308.09687',
  'https://arxiv.org/abs/2210.03629',
  'https://arxiv.org/abs/2212.08073',
  'https://arxiv.org/abs/2305.20050',
  'https://arxiv.org/abs/2209.07858',
] as const;

const REQUIRED_BOUNDARY_SNIPPETS = [
  '참조 전용',
  '런타임 컴포넌트가 아니다',
  '프로바이더가 아니다',
  '인프로세스 컴포넌트가 아니다',
  '실행 또는 프롬프트 주입해서는 안 된다',
] as const;

const REQUIRED_METHOD_SKILL_SNIPPETS = [
  'methodology-skill',
  '증거 전용 런타임 데코레이터',
  '진입/거버넌스',
  '옵트인 컴포지션',
] as const;

const REQUIRED_VALIDATION_SNIPPETS = [
  'Peekaboo/Discord 직접 제어',
  'readiness 분리',
  '증거 점수',
  '지속형 원장',
  '경계가 정해진 배치 계획',
] as const;

function readRepoText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function collectTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('agent methodology origin integration spec', () => {
  it('ships all mapped source URLs', () => {
    for (const url of REQUIRED_SOURCE_URLS) {
      expect(SPEC_TEXT).toContain(url);
    }
  });

  it('states the reference-only and no-runtime boundary', () => {
    for (const snippet of REQUIRED_BOUNDARY_SNIPPETS) {
      expect(SPEC_TEXT).toContain(snippet);
    }
  });

  it('documents the canonical methodology-skill evidence-only runtime posture', () => {
    for (const snippet of REQUIRED_METHOD_SKILL_SNIPPETS) {
      expect(SPEC_TEXT).toContain(snippet);
    }
  });

  it('includes Peekaboo/Discord direct-control as the validation/evidence path', () => {
    for (const snippet of REQUIRED_VALIDATION_SNIPPETS) {
      expect(SPEC_TEXT).toContain(snippet);
    }
  });
});

describe('agent methodology origin integration source boundaries', () => {
  const guardedFiles = [
    'src/contracts/capability-flag.ts',
    'src/contracts/trait-module.ts',
    'src/contracts/methodology-skill.ts',
    'src/core/plana.ts',
    'src/runtime/methodology-skill-runtime-driver.ts',
    'src/contracts/runtime-settings.ts',
  ] as const;

  it('keeps guarded source files free of templerun pathing, mode flags, and templerun trait literals', () => {
    for (const relativePath of guardedFiles) {
      const text = readRepoText(relativePath);
      expect(text).not.toContain('resource/templerun');
      expect(text).not.toContain('instruction-set-mode');
      expect(text).not.toContain("'templerun'");
      expect(text).not.toContain('"templerun"');
    }
  });

  it('recognizes methodology as a canonical TraitModule, not a capability flag', () => {
    expect(readRepoText('src/contracts/capability-flag.ts')).not.toContain(
      "'methodology-skill'",
    );
    expect(readRepoText('src/contracts/methodology-skill.ts')).toContain(
      "'trait.methodology.agent-methodology-origin.v1'",
    );
    expect(readRepoText('src/core/plana.ts')).toContain("'trait-module'");
  });

  it('keeps src TypeScript free of resource/templerun imports or references', () => {
    const srcFiles = collectTypeScriptFiles(resolve(REPO_ROOT, 'src'));
    const offenders = srcFiles.filter((filePath) =>
      readFileSync(filePath, 'utf8').includes('resource/templerun'),
    );
    expect(offenders).toEqual([]);
  });
});
