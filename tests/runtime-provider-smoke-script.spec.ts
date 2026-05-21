import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('provider TerminalEvidence smoke script', () => {
  it('is wired as the live provider evidence producer without reading dotenv files', () => {
    const script = readFileSync('scripts/provider-terminal-evidence-smoke.mjs', 'utf8');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts: Record<string, string>;
    };

    expect(pkg.scripts['runtime:provider:smoke']).toBe(
      'pnpm build && node scripts/provider-terminal-evidence-smoke.mjs',
    );
    expect(script).toContain('createTerminalEvidence');
    expect(script).toContain('resolveCodexBootstrapResolution');
    expect(script).toContain('AUTO_ARCHIVE_CODEX_CLI_HOME_MODE');
    expect(script).toContain('isolated-auth');
    expect(script).toContain('ClaudeAgentRuntimeDriver');
    expect(script).toContain('--provider <provider>');
    expect(script).toContain('--out <path>');
    expect(script).toContain('[redacted-provider-output]');
    expect(script).toContain('function redactReviewedItem');
    expect(script).not.toContain('...event.item');
    expect(script).toContain('provider smoke denies tool use');
    expect(script).not.toContain('dotenv');
    expect(script).not.toContain("readFileSync('.env");
    expect(script).not.toContain('raw provider responses.');
  });
});
