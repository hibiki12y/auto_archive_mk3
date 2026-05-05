import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY } from '../src/discord/discord-command-registry.js';

function readReadme(): string {
  return readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
}

function extractCurrentSliceCommandSurface(readme: string): readonly string[] {
  const match =
    /registry-backed command surface \((?<commands>[^)]*)\)/.exec(readme);
  if (match?.groups?.['commands'] === undefined) {
    throw new Error(
      'README Current implemented slices must document the registry-backed command surface.',
    );
  }

  return [...match.groups['commands'].matchAll(/`\/([a-z][a-z0-9_-]*)`/g)].map(
    (entry) => entry[1],
  );
}

describe('README current implemented slices', () => {
  it('keeps the top-level Discord command surface aligned with COMMAND_REGISTRY', () => {
    expect(extractCurrentSliceCommandSurface(readReadme())).toEqual(
      COMMAND_REGISTRY.map((command) => command.name),
    );
  });
});
