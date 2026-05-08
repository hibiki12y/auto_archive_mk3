import { describe, expect, it } from 'vitest';

import {
  buildClaudeAgentAuthFingerprint,
  type ClaudeAgentBootstrapResolution,
} from '../../src/runtime/claude-agent-bootstrap-settings.js';
import {
  buildCodexAuthFingerprint,
  CODEX_API_KEY_ENV,
  type CodexBootstrapResolution,
} from '../../src/runtime/codex-bootstrap-settings.js';

const CLAUDE_API_KEY_ENV_NAME = 'AUTO_ARCHIVE_ANTHROPIC_API_KEY';

function codexCliResolution(
  options: { codexPathOverride?: string } = {},
): CodexBootstrapResolution {
  return {
    options: {
      ...(options.codexPathOverride === undefined
        ? {}
        : { codexPathOverride: options.codexPathOverride }),
    },
    runtimeConfig: {},
    authSource: 'codex-cli',
  };
}

function codexApiKeyResolution(): CodexBootstrapResolution {
  return {
    options: { apiKey: 'sk-codex-secret' },
    runtimeConfig: {},
    authSource: 'api-key',
  };
}

function codexNoneResolution(): CodexBootstrapResolution {
  return {
    options: {},
    runtimeConfig: {},
    authSource: 'none',
  };
}

function claudeCliResolution(
  options: { pathToClaudeCodeExecutable?: string } = {},
): ClaudeAgentBootstrapResolution {
  return {
    ...(options.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
    authSource: 'claude-cli',
  };
}

function claudeApiKeyResolution(): ClaudeAgentBootstrapResolution {
  return {
    anthropicApiKey: 'sk-claude-secret',
    authSource: 'api-key',
  };
}

describe('Codex auth fingerprint (P2-C-2 commit 1)', () => {
  it('captures cli-path and settings file path for codex-cli source — never the api key', () => {
    const fp = buildCodexAuthFingerprint(
      codexCliResolution({ codexPathOverride: '/usr/local/bin/codex' }),
      { HOME: '/home/operator' },
    );
    expect(fp.authSource).toBe('codex-cli');
    expect(fp.cliPath).toBe('/usr/local/bin/codex');
    expect(fp.settingsFilePath).toBe('/home/operator/.codex/auth.json');
    expect(fp.apiKeyEnvVarName).toBeUndefined();
    // No secret material may surface anywhere on the fingerprint object.
    expect(JSON.stringify(fp)).not.toContain('sk-codex');
  });

  it('records the env var *name* (never the value) for api-key source', () => {
    const fp = buildCodexAuthFingerprint(codexApiKeyResolution());
    expect(fp.authSource).toBe('api-key');
    expect(fp.apiKeyEnvVarName).toBe(CODEX_API_KEY_ENV);
    expect(fp.cliPath).toBeUndefined();
    expect(fp.settingsFilePath).toBeUndefined();
    // Critical: the resolved api key must not leak into the fingerprint.
    expect(JSON.stringify(fp)).not.toContain('sk-codex-secret');
  });

  it('returns a bare none fingerprint with no other fields', () => {
    const fp = buildCodexAuthFingerprint(codexNoneResolution());
    expect(fp).toEqual({ authSource: 'none' });
  });

  it('two codex-cli fingerprints are equal iff cliPath and settingsFilePath match', () => {
    const a = buildCodexAuthFingerprint(
      codexCliResolution({ codexPathOverride: '/usr/local/bin/codex' }),
      { HOME: '/home/operator' },
    );
    const b = buildCodexAuthFingerprint(
      codexCliResolution({ codexPathOverride: '/usr/local/bin/codex' }),
      { HOME: '/home/operator' },
    );
    expect(a).toEqual(b);
    const c = buildCodexAuthFingerprint(
      codexCliResolution({ codexPathOverride: '/opt/codex' }),
      { HOME: '/home/operator' },
    );
    expect(a).not.toEqual(c);
    const d = buildCodexAuthFingerprint(
      codexCliResolution({ codexPathOverride: '/usr/local/bin/codex' }),
      { HOME: '/home/different' },
    );
    expect(a).not.toEqual(d);
  });

  it('different authSource discriminators are never equal', () => {
    const cli = buildCodexAuthFingerprint(codexCliResolution(), {
      HOME: '/home/operator',
    });
    const apiKey = buildCodexAuthFingerprint(codexApiKeyResolution());
    expect(cli.authSource).not.toBe(apiKey.authSource);
    expect(cli).not.toEqual(apiKey);
  });
});

describe('Claude-agent auth fingerprint (P2-C-2 commit 1)', () => {
  it('captures cli-path for claude-cli source — never the api key', () => {
    const fp = buildClaudeAgentAuthFingerprint(
      claudeCliResolution({ pathToClaudeCodeExecutable: '/usr/local/bin/claude' }),
    );
    expect(fp.authSource).toBe('claude-cli');
    expect(fp.cliPath).toBe('/usr/local/bin/claude');
    expect(fp.apiKeyEnvVarName).toBeUndefined();
    expect(fp.settingsFilePath).toBeUndefined();
  });

  it('records the env var *name* (never the value) for api-key source', () => {
    const fp = buildClaudeAgentAuthFingerprint(claudeApiKeyResolution());
    expect(fp.authSource).toBe('api-key');
    expect(fp.apiKeyEnvVarName).toBe(CLAUDE_API_KEY_ENV_NAME);
    expect(fp.cliPath).toBeUndefined();
    // Critical: the resolved api key must not leak into the fingerprint.
    expect(JSON.stringify(fp)).not.toContain('sk-claude-secret');
  });

  it('returns a bare none fingerprint when no auth source is configured', () => {
    const fp = buildClaudeAgentAuthFingerprint({
      authSource: 'none',
    });
    expect(fp).toEqual({ authSource: 'none' });
  });

  it('inequality on cliPath drift across two claude-cli fingerprints', () => {
    const a = buildClaudeAgentAuthFingerprint(
      claudeCliResolution({ pathToClaudeCodeExecutable: '/old/path/claude' }),
    );
    const b = buildClaudeAgentAuthFingerprint(
      claudeCliResolution({ pathToClaudeCodeExecutable: '/new/path/claude' }),
    );
    expect(a).not.toEqual(b);
  });
});
