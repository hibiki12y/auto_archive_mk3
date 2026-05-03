import { describe, expect, it } from 'vitest';

async function loadHealthModule() {
  const modulePath = '../scripts/check-discord-core-stack.mjs';
  return import(modulePath) as Promise<{
    evaluateDiscordCoreStackHealth(input: {
      serviceName?: string;
      composePsJson: string;
      inspectStateJson?: string;
      containerId?: string;
      logText: string;
    }): {
      ok: boolean;
      state: string;
      containerId?: string;
      observedEvents: string[];
      missingEvents: string[];
      reasons: string[];
    };
    parseDiscordServiceLifecycleEvents(logText: string): Array<{
      event: string;
      pid?: number;
    }>;
  }>;
}

describe('Discord Docker core stack health gate', () => {
  it('requires a running Compose service and Discord gateway readiness events', async () => {
    const { evaluateDiscordCoreStackHealth } = await loadHealthModule();
    const composePsJson = JSON.stringify({
      Service: 'discord-service',
      Name: 'auto-archive-discord-service',
      ID: 'container-1234',
      State: 'running',
    });
    const logText = [
      '2026-04-25T18:00:00Z discord-service-bot-lifecycle {"event":"client-ready-wait-complete","pid":1}',
      '2026-04-25T18:00:01Z discord-service-bot-lifecycle {"event":"command-registration-complete","pid":1}',
    ].join('\n');

    expect(
      evaluateDiscordCoreStackHealth({
        composePsJson,
        inspectStateJson: JSON.stringify({ Running: true }),
        containerId: 'container-1234',
        logText,
      }),
    ).toMatchObject({
      ok: true,
      state: 'running',
      containerId: 'container-1234',
      missingEvents: [],
    });
  });

  it('rejects a running container that has not reached Discord readiness', async () => {
    const { evaluateDiscordCoreStackHealth } = await loadHealthModule();
    const composePsJson = JSON.stringify({
      Service: 'discord-service',
      Name: 'auto-archive-discord-service',
      ID: 'container-5678',
      State: 'running',
    });
    const report = evaluateDiscordCoreStackHealth({
      composePsJson,
      inspectStateJson: JSON.stringify({ Running: true }),
      containerId: 'container-5678',
      logText: 'discord-service-bot-lifecycle {"event":"client-login-start","pid":1}',
    });

    expect(report.ok).toBe(false);
    expect(report.missingEvents).toEqual([
      'client-ready-wait-complete',
      'command-registration-complete',
    ]);
    expect(report.reasons.join('\n')).toContain('Current Docker container');
  });

  it('extracts lifecycle JSON from Docker log lines only', async () => {
    const { parseDiscordServiceLifecycleEvents } = await loadHealthModule();

    expect(
      parseDiscordServiceLifecycleEvents(
        [
          '[decorations are ignored]',
          'discord-service-bot-lifecycle {"event":"client-ready","pid":99}',
          'discord-service-bot-lifecycle not-json',
        ].join('\n'),
      ),
    ).toEqual([{ event: 'client-ready', pid: 99 }]);
  });
});
