import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Codex CLI/app project compatibility surface', () => {
  it('ships a parseable project-scoped Codex config with safe app and MCP defaults', () => {
    const config = readFileSync('.codex/config.toml', 'utf8');

    expect(config).toContain('project_doc_fallback_filenames = ["codex.md", "README.md"]');
    expect(config).toContain('[features]');
    expect(config).toContain('multi_agent = true');
    expect(config).toContain('apps = true');
    expect(config).toContain('hooks = false');
    expect(config).toContain('memories = false');
    expect(config).toContain('[features.multi_agent_v2]');
    expect(config).toContain('enabled = true');
    expect(config).toContain('max_concurrent_threads_per_session = 4');
    expect(config).not.toContain('max_threads =');
    expect(config).toContain('[apps._default]');
    expect(config).toContain('default_tools_approval_mode = "prompt"');
    expect(config).toContain('destructive_enabled = false');
    expect(config).toContain('open_world_enabled = false');
    expect(config).toContain('[agents.explorer]');
    expect(config).toContain('[agents.worker]');
    expect(config).toContain('[agents.verifier]');
    expect(config).toContain('[mcp_servers."peekaboo-remote-eval"]');
    expect(config).toContain('args = ["scripts/start-peekaboo-remote-eval-mcp.mjs"]');
    expect(config).toContain('codex-cli 0.130.0');
  });

  it('keeps Codex project config trackable while excluding local state and credentials', () => {
    const gitignore = readFileSync('.gitignore', 'utf8');

    expect(gitignore).toContain('.codex/auth.json');
    expect(gitignore).toContain('.codex/models_cache.json');
    expect(gitignore).toContain('.codex/sessions/');
    expect(gitignore).toContain('.codex/shell_snapshots/');
    expect(gitignore).not.toContain('.codex/config.toml');
  });

  it('documents the Codex app/CLI/cloud operator path and local verifier', () => {
    const readme = readFileSync('README.md', 'utf8');
    const codex = readFileSync('codex.md', 'utf8');

    expect(readme).toContain('Project-local Codex compatibility');
    expect(readme).toContain('project-scoped `.codex/config.toml`');
    expect(readme).toContain('pnpm codex:compat:verify');
    expect(readme).toContain('does not read');
    expect(readme).toContain('codex-cli 0.130.0');
    expect(readme).toContain('codex -C "$REPO_ROOT"');
    expect(readme).toContain('not a replacement for upstream Codex schema validation');
    expect(codex).toContain('Codex app/cloud notes');
    expect(codex).toContain('Cloud threads clone the GitHub repository branch');
    expect(codex).toContain('bash .codex/verify_alignment.sh');
    expect(codex).toContain('not a complete upstream Codex schema proof');
  });

  it('validates the Codex compatibility surface with the checked-in alignment script', () => {
    const mode = statSync('.codex/verify_alignment.sh').mode;
    expect((mode & 0o100) !== 0).toBe(true);

    const output = execFileSync('bash', ['.codex/verify_alignment.sh'], {
      encoding: 'utf8',
    });

    expect(output).toContain('codex-alignment: PASS');
  });
});
