import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

async function loadDirectControlModule() {
  const modulePath = '../scripts/agent-node-discord-direct-control.mjs';
  return import(modulePath) as Promise<{
    buildRemoteScript(): string;
    isDirectControlEntrypoint(moduleUrl?: string, argv?: readonly string[]): boolean;
  }>;
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

  it('does not run the live helper when imported as a module', async () => {
    const { isDirectControlEntrypoint } = await loadDirectControlModule();
    const scriptPath = resolve('scripts/agent-node-discord-direct-control.mjs');
    const moduleUrl = pathToFileURL(scriptPath).href;

    expect(isDirectControlEntrypoint(moduleUrl, ['node', scriptPath])).toBe(true);
    expect(
      isDirectControlEntrypoint(moduleUrl, ['node', 'tests/import-only.ts']),
    ).toBe(false);
  });
});
