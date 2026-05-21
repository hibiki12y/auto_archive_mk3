import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY } from '../src/discord/discord-command-registry.js';

const SPEC_PATH = 'specs/ARCHIVE/discord-control-plane-always-on.md';

function readArchivedSpec(): string {
  return readFileSync(resolve(process.cwd(), SPEC_PATH), 'utf8');
}

function extractRegisteredCommandSet(markdown: string): readonly string[] {
  const match = /현재 등록 command set:\s*([\s\S]*?)\.\n/.exec(markdown);
  if (match === null) {
    throw new Error(
      `${SPEC_PATH} must include a current command-set sentence.`,
    );
  }

  return [...match[1].matchAll(/`\/([a-z][a-z0-9_-]*)`/g)].map(
    (entry) => entry[1],
  );
}

describe('Discord archived control-plane support spec', () => {
  it('keeps its documented command set synchronized with COMMAND_REGISTRY', () => {
    expect(extractRegisteredCommandSet(readArchivedSpec())).toEqual(
      COMMAND_REGISTRY.map((command) => command.name),
    );
  });

  it('documents archive as reversible now that /unarchive is implemented', () => {
    const spec = readArchivedSpec();

    expect(spec).toContain('`/unarchive`');
    expect(spec).toContain('`task.unarchived`');
    expect(spec).not.toMatch(/\bone-way\b/i);
    expect(spec).not.toContain('일방향');
  });

  it('uses the archived bootstrap-time multi-provider boundary', () => {
    const spec = readArchivedSpec();

    expect(spec).toContain('bootstrap-time multi-provider');
    expect(spec).toContain('`AUTO_ARCHIVE_RUNTIME_PROVIDER=codex`');
    expect(spec).toContain('`AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`');
    expect(spec).toContain('../CLARIFICATIONS/multi-provider-scope.md');
    expect(spec).not.toContain('Codex SDK 단일');
  });
});
