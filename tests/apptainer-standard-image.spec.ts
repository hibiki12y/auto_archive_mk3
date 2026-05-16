import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { packageManager?: string };

describe('standard Apptainer agent-instance image definition', () => {
  it('publishes the multi-provider runtime label', () => {
    const def = readFileSync(
      resolve(repoRoot, 'containers/agent-instance.def'),
      'utf8',
    );

    expect(def).toContain('org.auto-archive.runtime multi-provider');
    expect(def).toContain(
      'org.auto-archive.entry /opt/auto-archive/dist/src/runtime/agent-instance-entry.js',
    );
  });

  it('sets PNPM_HOME in both build and runtime environments for global provider packages', () => {
    const def = readFileSync(
      resolve(repoRoot, 'containers/agent-instance.def'),
      'utf8',
    );
    const post = readFileSync(
      resolve(repoRoot, 'containers/agent-instance-post.sh'),
      'utf8',
    );

    expect(def).toContain('export PNPM_HOME="/opt/pnpm"');
    expect(def).toContain(
      'export PATH="${PNPM_HOME}:/opt/auto-archive/node_modules/.bin:${PATH}"',
    );
    expect(post).toContain('export PNPM_HOME=/opt/pnpm');
    expect(packageJson.packageManager).toBe('pnpm@10.5.2');
    expect(post).toContain(
      `corepack prepare ${packageJson.packageManager} --activate`,
    );
    expect(post).toContain('mkdir -p "${PNPM_HOME}"');
    expect(post).toContain('pnpm config set global-bin-dir "${PNPM_HOME}"');
    expect(post).toContain(
      'pnpm install --global @openai/codex @anthropic-ai/claude-agent-sdk',
    );
  });

  it('replays the standard PNPM_HOME/PATH contract in the image %test', () => {
    const def = readFileSync(
      resolve(repoRoot, 'containers/agent-instance.def'),
      'utf8',
    );

    expect(def).toMatch(
      /%test[\s\S]*export PNPM_HOME="\/opt\/pnpm"[\s\S]*command -v codex/u,
    );
    expect(def).toMatch(
      /%test[\s\S]*test -f \/opt\/auto-archive\/dist\/src\/runtime\/agent-instance-entry\.js/u,
    );
    expect(def).toMatch(
      /%test[\s\S]*node --check \/opt\/auto-archive\/dist\/src\/runtime\/agent-instance-entry\.js/u,
    );
    expect(def).toMatch(
      /%test[\s\S]*await import\('@openai\/codex-sdk'\); await import\('@anthropic-ai\/claude-agent-sdk'\)/u,
    );
  });
});
