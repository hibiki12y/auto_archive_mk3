import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const BOUNDARY_DOC = readFileSync(
  resolve(process.cwd(), 'specs/CONTRACTS/microkernel-module-boundary.md'),
  'utf8',
);
const README = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

describe('microkernel module boundary contract', () => {
  it('defines the module taxonomy that keeps TraitModule as an extension subset', () => {
    expect(BOUNDARY_DOC).toContain('kernel-core');
    expect(BOUNDARY_DOC).toContain('port-contract');
    expect(BOUNDARY_DOC).toContain('infrastructure-adapter');
    expect(BOUNDARY_DOC).toContain('trait-module');
    expect(BOUNDARY_DOC).toMatch(/not all\s+microkernel modules are TraitModules/);
  });

  it('pins kernel-owned surfaces outside TraitModule conversion', () => {
    for (const protectedSurface of [
      'Arona',
      'Plana',
      'Dispatcher',
      'AgentRuntime',
      'ComputeNode',
      'RuntimeDriver',
      'TerminalEvidence',
      'CapabilityFlag',
    ]) {
      expect(BOUNDARY_DOC).toContain(protectedSurface);
    }
    expect(BOUNDARY_DOC).toContain('TraitModules MUST NOT');
    expect(BOUNDARY_DOC).toContain('switch runtime providers');
    expect(BOUNDARY_DOC).toContain('rewrite `TerminalCause`');
  });

  it('keeps README aligned that TraitModules are not provider switches or kernel replacements', () => {
    expect(README).toContain('A TraitModule is a project-owned submodule/plugin manifest');
    expect(README).toContain('not a provider switch');
    expect(README).toContain('Microkernel boundary');
    expect(README).toContain('specs/CONTRACTS/microkernel-module-boundary.md');
  });
});
