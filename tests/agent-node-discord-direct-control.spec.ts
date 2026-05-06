import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

async function loadDirectControlModule() {
  const modulePath = '../scripts/agent-node-discord-direct-control.mjs';
  return import(modulePath) as Promise<{
    buildRemoteScript(): string;
    isDirectControlEntrypoint(moduleUrl?: string, argv?: readonly string[]): boolean;
    parseArgs(argv: readonly string[]): { mode: string; message?: string } & Record<string, unknown>;
    looksNaturallyAddressed(message: string): boolean;
  }>;
}

function captureStderr<T>(fn: () => T): { value: T; stderr: string } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // @ts-expect-error overriding the runtime signature is intentional in this test scaffold
  process.stderr.write = (chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    const value = fn();
    return { value, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

describe('agent-node Discord direct-control helper', () => {
  it('uses the observed compatible Peekaboo click coords shape first', async () => {
    const { buildRemoteScript } = await loadDirectControlModule();
    const script = buildRemoteScript();

    expect(script.indexOf("{ coords: x + ',' + y }")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("{ coords: x + ',' + y }")).toBeLessThan(
      script.indexOf('{ coords: { x, y } }'),
    );
    expect(script.indexOf("{ coords: x + ',' + y }")).toBeLessThan(
      script.indexOf('{ x, y }'),
    );
  });

  it('prefers system clipboard paste before the flaky focus-sensitive paste tool', async () => {
    const { buildRemoteScript } = await loadDirectControlModule();
    const script = buildRemoteScript();

    expect(script.indexOf("execFileSync('/usr/bin/pbcopy'")).toBeGreaterThanOrEqual(
      0,
    );
    expect(script.indexOf("execFileSync('/usr/bin/pbcopy'")).toBeLessThan(
      script.indexOf("client.callTool('paste'"),
    );
  });

  it('reports live-control proxy readiness on the emitted status object', async () => {
    const { buildRemoteScript } = await loadDirectControlModule();
    const script = buildRemoteScript();

    expect(script).toContain('const proxyConfig = readProxy();');
    expect(script).toContain('socketPath: proxyConfig.socketPath');
    expect(script).toContain('token: proxyConfig.token');
    expect(script).toContain('proxy.ready = true;');
    expect(script).not.toContain('const proxy = readProxy();');
  });

  it('can capture a post-submit GUI image instead of relying on OCR text', async () => {
    const { buildRemoteScript } = await loadDirectControlModule();
    const script = buildRemoteScript();

    expect(script).toContain("const observeMode = process.env.OBSERVE_MODE ?? 'see';");
    expect(script).toContain("client.callTool('image'");
    expect(script).toContain("stage: 'capture-after-submit-image'");
    expect(script).toContain("format: 'png'");
    expect(script).toContain("captureTarget: 'default-after-discord-focus'");
    expect(script).not.toContain("app_target: 'Discord'");
    expect(script).toContain("if (observeMode === 'see' || observeMode === 'both')");
    expect(script).toContain("if (observeMode === 'image' || observeMode === 'both')");
  });

  it('honors --image-capture-delay-ms before snapping the post-submit PNG', async () => {
    const { buildRemoteScript } = await loadDirectControlModule();
    const script = buildRemoteScript();

    expect(script).toContain('IMAGE_CAPTURE_DELAY_MS');
    expect(script).toContain("stage: 'image-capture-delay'");
    expect(script).toContain('imageCaptureDelayMs > 0');
    expect(script).toContain('await sleep(imageCaptureDelayMs)');
  });

  it('does not run the live helper when imported as a module', async () => {
    const { isDirectControlEntrypoint } = await loadDirectControlModule();
    const scriptPath = resolve('scripts/agent-node-discord-direct-control.mjs');
    const moduleUrl = pathToFileURL(scriptPath).href;

    expect(isDirectControlEntrypoint(moduleUrl, ['node', scriptPath])).toBe(true);
    expect(
      isDirectControlEntrypoint(moduleUrl, ['node', 'tests/import-only.ts']),
    ).toBe(false);
  });

  it('rejects messages that exceed the Discord 2000-char hard limit before SSH', async () => {
    const { parseArgs } = await loadDirectControlModule();
    const overflow = 'a'.repeat(1901);
    expect(() =>
      parseArgs(['node', 'helper', '--mode', 'slash-ask', '--message', overflow]),
    ).toThrowError(/exceeds 1900 characters/);
  });

  it('accepts messages exactly at the safe-headroom boundary', async () => {
    const { parseArgs } = await loadDirectControlModule();
    const boundary = 'a'.repeat(1900);
    expect(() =>
      parseArgs(['node', 'helper', '--mode', 'slash-ask', '--message', boundary]),
    ).not.toThrow();
  });

  it('warns when natural-ask is missing both a leader phrase and a natural address', async () => {
    const { parseArgs } = await loadDirectControlModule();
    const { stderr } = captureStderr(() =>
      parseArgs([
        'node',
        'helper',
        '--mode',
        'natural-ask',
        '--mention-user-id',
        '1234',
        '--message',
        'Build a parser for our DSL',
      ]),
    );
    expect(stderr).toContain('without an explicit leader phrase');
  });

  it('does not warn when natural-ask uses an explicit research leader phrase', async () => {
    const { parseArgs } = await loadDirectControlModule();
    const { stderr } = captureStderr(() =>
      parseArgs([
        'node',
        'helper',
        '--mode',
        'natural-ask',
        '--mention-user-id',
        '1234',
        '--message',
        'Implementation research task — build a parser for our DSL',
      ]),
    );
    expect(stderr).not.toContain('without an explicit leader phrase');
  });

  it('does not warn when natural-ask uses a natural address prefix', async () => {
    const { parseArgs, looksNaturallyAddressed } = await loadDirectControlModule();
    expect(looksNaturallyAddressed('Arona, please build a parser')).toBe(true);
    const { stderr } = captureStderr(() =>
      parseArgs([
        'node',
        'helper',
        '--mode',
        'natural-ask',
        '--mention-user-id',
        '1234',
        '--message',
        'Arona, please build a parser',
      ]),
    );
    expect(stderr).not.toContain('without an explicit leader phrase');
  });

  it('does not emit the leader-phrase warning for slash-ask mode', async () => {
    const { parseArgs } = await loadDirectControlModule();
    const { stderr } = captureStderr(() =>
      parseArgs([
        'node',
        'helper',
        '--mode',
        'slash-ask',
        '--message',
        'Build a parser',
      ]),
    );
    expect(stderr).toBe('');
  });
});
