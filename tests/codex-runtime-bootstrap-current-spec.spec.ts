import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveRuntimeProvider,
  RUNTIME_PROVIDER_ENV,
} from '../src/runtime/runtime-driver-factory.js';

const SPEC_PATH = 'specs/ARCHIVE/codex-sdk-runtime-bootstrap.md';

function readArchivedSpec(): string {
  return readFileSync(resolve(process.cwd(), SPEC_PATH), 'utf8');
}

describe('Codex runtime bootstrap archived support spec', () => {
  it('documents Codex as the default branch of the archived multi-provider seam', () => {
    const spec = readArchivedSpec();

    expect(resolveRuntimeProvider({})).toBe('codex');
    expect(
      resolveRuntimeProvider({ [RUNTIME_PROVIDER_ENV]: 'claude-agent' }),
    ).toBe('claude-agent');
    expect(spec).toContain('bootstrap-time multi-provider');
    expect(spec).toContain(`\`${RUNTIME_PROVIDER_ENV}=codex\``);
    expect(spec).toContain(`\`${RUNTIME_PROVIDER_ENV}=claude-agent\``);
    expect(spec).toContain('../CLARIFICATIONS/multi-provider-scope.md');
    expect(spec).not.toContain('런타임 프로바이더 범위는 **Codex SDK 단일**');
  });

  it('keeps Codex auth/settings inputs scoped to the Codex provider branch', () => {
    const spec = readArchivedSpec();

    expect(spec).toContain('Codex provider branch');
    expect(spec).toContain('Codex branch 안에서의 인증·settings 선택');
    expect(spec).toContain('Codex 인증·settings 입력을 provider routing 신호로 취급');
    expect(spec).not.toContain('다중 프로바이더 부트스트랩 라우팅');
  });
});
