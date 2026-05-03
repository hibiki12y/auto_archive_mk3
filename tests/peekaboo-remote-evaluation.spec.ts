import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  PEEKABOO_REMOTE_EVALUATION_STANDARD,
  buildPeekabooBatchPlan,
  buildPeekabooEvidenceAudit,
  buildPeekabooReadinessReport,
  buildPeekabooEvaluationPlan,
  buildPeekabooTurnCommand,
  buildTurnMarker,
  mapPeekabooRemediations,
  normalizePeekabooReadinessError,
  parsePeekabooReadinessReport,
} from '../src/remote/peekaboo-remote-evaluation.js';
import {
  callPeekabooMcpTool,
  handleMcpJsonRpcMessage,
  listPeekabooMcpTools,
} from '../src/remote/peekaboo-remote-eval-mcp.js';

describe('peekaboo remote evaluation standard', () => {
  it('defines the user-authored GUI path as the standard boundary', () => {
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.protocolVersion).toBe(
      '2026-04-25',
    );
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.purpose.join('\n')).toContain(
      'real macOS agent-node GUI path',
    );
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.nonGoals.join('\n')).toContain(
      'Do not send user messages with a bot token',
    );
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.evidencePacketFields).toContain(
      'matchedReply',
    );
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.evidencePacketFields).toContain(
      'artifactPath',
    );
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.mcpTools).toContain(
      'peekaboo_remote_eval_batch_plan',
    );
  });

  it('points the standard authority at a checked-in repository guide', () => {
    expect(PEEKABOO_REMOTE_EVALUATION_STANDARD.authority).toBe(
      'specs/GUIDES/peekaboo-remote-evaluation-mcp.md',
    );
    expect(
      existsSync(
        resolve(process.cwd(), PEEKABOO_REMOTE_EVALUATION_STANDARD.authority),
      ),
    ).toBe(true);
  });

  it('builds bounded turn markers and a first-turn smoke plan', () => {
    const plan = buildPeekabooEvaluationPlan({
      runId: 'mcp live eval',
      goal: 'standardize Peekaboo remote Discord validation',
      maxTurns: 3,
      target: 'arona',
      firstMode: 'natural-ask',
    });

    expect(plan.runId).toBe('mcp_live_eval');
    expect(plan.markers).toEqual([
      'mcp_live_eval_T01',
      'mcp_live_eval_T02',
      'mcp_live_eval_T03',
    ]);
    expect(plan.firstTurn.pollMode).toBe('task-lifecycle');
    expect(plan.firstTurn.expectedAuthorId).toBe('1476113538320957451');
    expect(plan.closeout.join('\n')).toContain(
      'Do not claim live success',
    );
  });

  it('rejects invalid marker turn numbers', () => {
    expect(() => buildTurnMarker('RUN', 0)).toThrow(/turnNumber/);
    expect(() => buildTurnMarker('RUN', 100)).toThrow(/turnNumber/);
  });
});

describe('peekaboo remote evaluation command builder', () => {
  it('defaults to dry-run and expected command-response polling for slash status', () => {
    const command = buildPeekabooTurnCommand({
      runId: 'RUN',
      mode: 'slash-status',
      message: 'discord-task-abc123',
      expectTaskId: 'discord-task-abc123',
    });

    expect(command.dryRun).toBe(true);
    expect(command.mutatesRemoteGui).toBe(false);
    expect(command.marker).toBe('RUN_T01');
    expect(command.pollMode).toBe('command-response');
    expect(command.args).toContain('--dry-run');
    expect(command.args).toContain('--expect-task-id');
    expect(command.args).toContain('discord-task-abc123');
  });

  it('routes slash-focus and slash-unfocus through command-response polling', () => {
    const focus = buildPeekabooTurnCommand({
      runId: 'RUN',
      mode: 'slash-focus',
      message: 'discord-task-focus-target',
    });
    expect(focus.mode).toBe('slash-focus');
    expect(focus.pollMode).toBe('command-response');
    expect(focus.args).toContain('slash-focus');

    const unfocus = buildPeekabooTurnCommand({
      runId: 'RUN',
      mode: 'slash-unfocus',
      message: '',
    });
    expect(unfocus.mode).toBe('slash-unfocus');
    expect(unfocus.pollMode).toBe('command-response');
    expect(unfocus.args).toContain('slash-unfocus');
  });

  it('requires explicit live opt-in for remote GUI mutation', () => {
    expect(() =>
      buildPeekabooTurnCommand({
        runId: 'RUN',
        message: 'live mutation is not implicit',
        dryRun: false,
      }),
    ).toThrow(/allowLive=true/);

    expect(
      buildPeekabooTurnCommand({
        runId: 'RUN',
        message: 'approved live mutation',
        dryRun: false,
        allowLive: true,
      }).mutatesRemoteGui,
    ).toBe(true);
  });

  it('builds probe commands that fail closed before live Discord submit', () => {
    const command = buildPeekabooTurnCommand({
      runId: 'RUN',
      message: 'probe only',
      probe: true,
      dryRun: false,
    });

    expect(command.executionMode).toBe('probe');
    expect(command.probe).toBe(true);
    expect(command.mutatesRemoteGui).toBe(false);
    expect(command.args).toContain('--probe');
    expect(command.args).not.toContain('--dry-run');
    expect(command.evidenceExpectation).toContain('Probe verifies staged readiness only');
  });

  it('passes explicit REST observation environment controls without repoRoot workarounds', () => {
    const command = buildPeekabooTurnCommand({
      runId: 'RUN',
      message: 'discord-task-observe123',
      mode: 'slash-status',
      expectTaskId: 'discord-task-observe123',
      dryRun: false,
      allowLive: true,
      envFile: '/tmp/operator-approved-auto-archive.env',
      botTokenEnv: 'AUTO_ARCHIVE_DISCORD_TOKEN_FOR_TEST',
    });

    expect(command.args).toContain('--env-file');
    expect(command.args).toContain('/tmp/operator-approved-auto-archive.env');
    expect(command.args).toContain('--bot-token-env');
    expect(command.args).toContain('AUTO_ARCHIVE_DISCORD_TOKEN_FOR_TEST');
    expect(command.args).not.toContain('--no-rest');
    expect(command.mutatesRemoteGui).toBe(true);
  });
});

describe('peekaboo remote batch planning', () => {
  it('rejects bounded batch turn counts outside 5-10', () => {
    expect(() =>
      buildPeekabooBatchPlan({
        runId: 'batch',
        executionMode: 'precheck',
        maxTurns: 4,
      }),
    ).toThrow(/maxTurns must be an integer from 5 to 10/);

    expect(() =>
      buildPeekabooBatchPlan({
        runId: 'batch',
        executionMode: 'precheck',
        maxTurns: 11,
      }),
    ).toThrow(/maxTurns must be an integer from 5 to 10/);
  });

  it('builds a precheck batch plan with exactly one non-mutating probe template', () => {
    const plan = buildPeekabooBatchPlan({
      runId: 'batch precheck',
      executionMode: 'precheck',
      maxTurns: 5,
      target: 'arona',
    });

    expect(plan.executionMode).toBe('precheck');
    expect(plan.autonomousExecution).toBe(false);
    expect(plan.plannedTurnMarkers).toEqual([
      'batch_precheck_T01',
      'batch_precheck_T02',
      'batch_precheck_T03',
      'batch_precheck_T04',
      'batch_precheck_T05',
    ]);
    expect(plan.turns).toEqual([]);
    expect(plan.precheckCommand).toMatchObject({
      marker: 'batch_precheck_PRECHECK',
      correlationId: 'batch_precheck:batch:precheck',
      expectedAuthorId: '1476113538320957451',
      command: {
        executionMode: 'probe',
        probe: true,
        mutatesRemoteGui: false,
      },
    });
  });

  it('rejects live batch plans without explicit live opt-in or precheck proof', () => {
    expect(() =>
      buildPeekabooBatchPlan({
        runId: 'batch live',
        executionMode: 'live',
        maxTurns: 5,
      }),
    ).toThrow(/allowLive=true/);

    expect(() =>
      buildPeekabooBatchPlan({
        runId: 'batch live',
        executionMode: 'live',
        maxTurns: 5,
        allowLive: true,
      }),
    ).toThrow(/require precheck proof/i);
  });

  it('builds live batch plans only from positive precheck proof and rejects ambiguous mixed input', () => {
    expect(() =>
      buildPeekabooBatchPlan({
        runId: 'batch live',
        executionMode: 'live',
        maxTurns: 5,
        allowLive: true,
        precheckOnly: true,
        precheck: {
          probeRunId: 'probe batch live',
          probeTurnMarker: 'batch_live_PRECHECK',
          probeProxyReady: true,
          submitReady: true,
        },
      }),
    ).toThrow(/precheckOnly=true/);

    const plan = buildPeekabooBatchPlan({
      runId: 'batch live',
      executionMode: 'live',
      maxTurns: 5,
      allowLive: true,
      target: 'plana',
      precheck: {
        probeRunId: 'probe batch live',
        probeTurnMarker: 'batch_live_PRECHECK',
        probeProxyReady: true,
        submitReady: true,
      },
    });

    expect(plan.precheckCommand).toBeUndefined();
    expect(plan.precheckProof).toMatchObject({
      probeRunId: 'probe_batch_live',
      probeTurnMarker: 'batch_live_PRECHECK',
      probeProxyReady: true,
      submitReady: true,
    });
    expect(plan.turns).toHaveLength(5);
    expect(plan.turns.map((turn) => turn.marker)).toEqual([
      'batch_live_T01',
      'batch_live_T02',
      'batch_live_T03',
      'batch_live_T04',
      'batch_live_T05',
    ]);
    expect(plan.turns[0]).toMatchObject({
      turnNumber: 1,
      marker: 'batch_live_T01',
      correlationId: 'batch_live:batch:turn:01',
      expectedAuthorId: '1494347028971655238',
      command: {
        executionMode: 'live',
        mutatesRemoteGui: true,
      },
    });
    expect(plan.turns[4]).toMatchObject({
      turnNumber: 5,
      marker: 'batch_live_T05',
      correlationId: 'batch_live:batch:turn:05',
      command: {
        executionMode: 'live',
        mutatesRemoteGui: true,
      },
    });
  });
});

describe('peekaboo project-local Codex MCP helper', () => {
  it('defines project-local Codex command variants without editing global MCP config', () => {
    const helper = readFileSync(
      'scripts/dev/codex-with-peekaboo-mcp.mjs',
      'utf8',
    );

    expect(helper).toContain("const serverName = 'peekaboo-remote-eval'");
    expect(helper).toContain('scripts/start-peekaboo-remote-eval-mcp.mjs');
    expect(helper).toContain('mcp_servers.${serverName}.command="node"');
    expect(helper).toContain('mcp_servers.${serverName}.args=[');
    expect(helper).toContain("args: ['exec', ...codexRepoArgs, ...extraArgs]");
    expect(helper).toContain("args: ['mcp', ...mcpConfigArgs, 'list', '--json'");
    expect(helper).toContain('--print-command');
    expect(helper).toContain('avoids `codex mcp add`');
    expect(helper).not.toContain('/home/deepsky/.codex/config.toml');
  });

  it('documents the actionable hint used when interactive Codex lacks a TTY', () => {
    const helper = readFileSync(
      'scripts/dev/codex-with-peekaboo-mcp.mjs',
      'utf8',
    );

    expect(helper).toContain('requires a terminal (TTY)');
    expect(helper).toContain('pnpm peekaboo:codex:exec');
    expect(helper).toContain('pnpm peekaboo:codex:mcp-list');
    expect(helper).toContain('process.exit(2)');
  });

  it('documents the local helper as per-invocation rather than repository-scoped install', () => {
    const guide = readFileSync(
      'specs/GUIDES/peekaboo-remote-evaluation-mcp.md',
      'utf8',
    );

    expect(guide).toMatch(/project-local per-invocation MCP\s+injection/u);
    expect(guide).toContain('not a first-class Codex CLI repository-scoped install');
    expect(guide).toContain('artifactPath');
    expect(guide).toContain('GUI submit without REST/matched reply evidence is WARN');
  });

  it('exposes package scripts for local Codex MCP injection', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['peekaboo:codex']).toBe(
      'node scripts/dev/codex-with-peekaboo-mcp.mjs',
    );
    expect(pkg.scripts['peekaboo:codex:exec']).toBe(
      'node scripts/dev/codex-with-peekaboo-mcp.mjs exec',
    );
    expect(pkg.scripts['peekaboo:codex:mcp-list']).toBe(
      'node scripts/dev/codex-with-peekaboo-mcp.mjs mcp-list',
    );
  });
});

describe('peekaboo remote readiness helpers', () => {
  it('keeps live readiness unknown when REST observation is explicitly skipped', () => {
    const report = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: false,
      marker: 'NO_REST_T01',
      expectedTaskId: 'discord-task-no-rest',
    });

    expect(report.overallStatus).toBe('unknown');
    expect(report.liveSubmitPerformed).toBe(true);
    expect(report.matchedReplyObserved).toBe(false);
    expect(report.evidence.submit.status).toBe('attempted');
    expect(report.evidence.matchedReply).toMatchObject({
      status: 'missing',
      summary: expect.stringContaining('REST observation was skipped'),
    });
  });

  it('emits split probe readiness fields without inferring live proxy readiness', () => {
    const probe = buildPeekabooReadinessReport({
      phase: 'probe',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      probeProxyReady: true,
    });

    expect(probe).toMatchObject({
      phase: 'probe',
      proxyReady: true,
      probeProxyReady: true,
      liveProxyReady: false,
      submitReady: true,
      liveOk: false,
    });
  });

  it('distinguishes probe readiness from matched-reply live success', () => {
    const probe = buildPeekabooReadinessReport({
      phase: 'probe',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: false,
      error: {
        code: 'PEEKABOO_LIST_TOOLS_FAILED',
        message: 'Proxy list tools failed: Request timed out',
        domain: 'TRANSPORT',
        retryable: true,
      },
    });

    expect(probe.submitReady).toBe(false);
    expect(probe.proxyReady).toBe(false);
    expect(probe.probeProxyReady).toBe(false);
    expect(probe.liveProxyReady).toBe(false);
    expect(probe.liveOk).toBe(false);
    expect(probe.highestReady).toBe('BRIDGE_PRESENT');
    expect(
      probe.checks.find((check) => check.label === 'PROXY_READY')?.error?.remediations.join('\n'),
    ).toContain('desktop-control-bridge.json');
    expect(probe.checks.find((check) => check.label === 'PROXY_READY')?.summary).toBe(
      'Peekaboo proxy initialize/list-tools readiness failed.',
    );

    const live = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      matchedReplyObserved: false,
    });

    expect(live.submitReady).toBe(true);
    expect(live.liveOk).toBe(false);
    expect(live.checks.find((check) => check.label === 'LIVE_OK')?.status).toBe('failed');
    expect(live.checks.find((check) => check.label === 'PROXY_READY')?.summary).toBe(
      'Live-control proxy readiness was reported ready.',
    );
  });

  it('keeps live submit readiness compatible without inferring probe proxy readiness', () => {
    const live = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      liveProxyReady: false,
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: false,
      matchedReplyObserved: false,
    });

    expect(live).toMatchObject({
      phase: 'live',
      proxyReady: false,
      probeProxyReady: false,
      liveProxyReady: false,
      submitReady: true,
    });
  });

  it('classifies staged live evidence as attempted, captured, weak, or missing', () => {
    const captured = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'RUN_T01',
      expectedTaskId: 'discord-task-42',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      ack: {
        observedAt: '2026-04-26T00:00:02.000Z',
        taskId: 'discord-task-42',
        matchedOn: ['task-id', 'author'],
      },
      matchedReply: {
        observedAt: '2026-04-26T00:00:05.000Z',
        taskId: 'discord-task-42',
        marker: 'RUN_T01',
        matchedOn: ['task-id', 'marker'],
      },
      relatedReplyCount: 2,
    });

    expect(captured.evidence.submit.status).toBe('attempted');
    expect(captured.evidence.taskCorrelation.status).toBe('captured');
    expect(captured.evidence.ack.status).toBe('captured');
    expect(captured.evidence.matchedReply.status).toBe('captured');

    const weak = buildPeekabooReadinessReport({
      phase: 'live',
      configOk: true,
      sshOk: true,
      bridgePresent: true,
      proxyReady: true,
      marker: 'RUN_T02',
      submitAttempted: true,
      controlOk: true,
      restObservationAttempted: true,
      ack: {
        observedAt: '2026-04-26T00:01:02.000Z',
        matchedOn: ['author', 'timing'],
      },
      relatedReplyCount: 1,
    });

    expect(weak.evidence.ack.status).toBe('weak');
    expect(weak.evidence.taskCorrelation.status).toBe('weak');
    expect(weak.evidence.matchedReply.status).toBe('weak');
  });

  it('adds deterministic task-correlation scoring without changing legacy evidence statuses', () => {
    const strong = buildPeekabooEvidenceAudit({
      phase: 'live',
      marker: 'RUN_T10',
      submitAttempted: true,
      ack: {
        observedAt: '2026-04-26T00:10:02.000Z',
        marker: 'RUN_T10',
        matchedOn: ['marker', 'author'],
      },
    });
    expect(strong.taskCorrelation.status).toBe('captured');
    expect(strong.taskCorrelation.correlationScore).toBe('strong');
    expect(strong.taskCorrelation.scoringFactors?.map((factor) => factor.signal)).toEqual([
      'marker',
      'author',
    ]);

    const moderate = buildPeekabooEvidenceAudit({
      phase: 'live',
      marker: 'RUN_T11',
      submitAttempted: true,
      ack: {
        observedAt: '2026-04-26T00:11:02.000Z',
        matchedOn: ['author', 'timing'],
      },
    });
    expect(moderate.taskCorrelation.status).toBe('weak');
    expect(moderate.taskCorrelation.correlationScore).toBe('moderate');
    expect(
      moderate.taskCorrelation.scoringFactors?.map((factor) => factor.signal),
    ).toEqual(['author', 'timing']);

    const weakScore = buildPeekabooEvidenceAudit({
      phase: 'live',
      marker: 'RUN_T12',
      submitAttempted: true,
      ack: {
        observedAt: '2026-04-26T00:12:02.000Z',
        matchedOn: ['lifecycle-shape'],
      },
    });
    expect(weakScore.taskCorrelation.status).toBe('weak');
    expect(weakScore.taskCorrelation.correlationScore).toBe('weak');
    expect(
      weakScore.taskCorrelation.scoringFactors?.map((factor) => factor.signal),
    ).toEqual(['lifecycle-shape']);

    const none = buildPeekabooEvidenceAudit({
      phase: 'live',
      marker: 'RUN_T13',
      submitAttempted: true,
      relatedReplyCount: 1,
    });
    expect(none.taskCorrelation.status).toBe('weak');
    expect(none.taskCorrelation.correlationScore).toBe('none');
    expect(none.taskCorrelation.scoringFactors).toEqual([]);
  });

  it('keeps legacy readiness payloads backward compatible by synthesizing split proxy readiness and evidence', () => {
    const parsed = parsePeekabooReadinessReport({
      phase: 'live',
      overallStatus: 'failed',
      highestReady: 'SUBMIT_READY',
      submitReady: true,
      liveOk: false,
      liveSubmitPerformed: true,
      matchedReplyObserved: false,
      checks: [
        {
          label: 'PROXY_READY',
          status: 'ready',
          summary: 'Legacy proxy readiness succeeded.',
        },
      ],
      summary: 'legacy payload',
    });

    expect(parsed).toMatchObject({
      proxyReady: true,
      probeProxyReady: false,
      liveProxyReady: true,
      evidence: {
        submit: { status: 'attempted' },
        matchedReply: { status: 'missing' },
      },
    });
  });

  it('maps timeout-like tool-list failures to actionable remediation hints', () => {
    const error = normalizePeekabooReadinessError({
      code: 'PEEKABOO_LIST_TOOLS_FAILED',
      message: 'Proxy list tools failed: Request timed out',
      domain: 'TRANSPORT',
      retryable: true,
    });

    expect(error).toMatchObject({
      code: 'PEEKABOO_LIST_TOOLS_FAILED',
      domain: 'TRANSPORT',
      retryable: true,
    });
    expect(mapPeekabooRemediations(error ?? {}).join('\n')).toContain('--probe');
  });

  it('builds standalone evidence audits for helper and MCP payloads', () => {
    const evidence = buildPeekabooEvidenceAudit({
      phase: 'probe',
      marker: 'RUN_T03',
    });

    expect(evidence.submit.status).toBe('skipped');
    expect(evidence.ack.status).toBe('skipped');
  });
});

describe('peekaboo remote evaluation MCP surface', () => {
  it('lists the standardized tool surface', () => {
    const tools = listPeekabooMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'peekaboo_remote_eval_standard',
      'peekaboo_remote_eval_plan',
      'peekaboo_remote_eval_batch_plan',
      'peekaboo_remote_eval_run_turn',
      'peekaboo_remote_eval_evidence_append',
      'peekaboo_remote_eval_evidence_query',
    ]);
  });

  it('exposes the bounded batch plan tool with a closed nested precheck schema', () => {
    const batchTool = listPeekabooMcpTools().find(
      (tool) => tool.name === 'peekaboo_remote_eval_batch_plan',
    ) as { inputSchema: Record<string, unknown> } | undefined;
    expect(batchTool).toBeDefined();

    const inputSchema = batchTool?.inputSchema as {
      additionalProperties: boolean;
      required: readonly string[];
      properties: Record<string, unknown>;
    };
    expect(inputSchema.additionalProperties).toBe(false);
    expect(inputSchema.required).toEqual(['runId', 'executionMode']);
    expect(inputSchema.properties.maxTurns).toMatchObject({
      type: 'integer',
      minimum: 5,
      maximum: 10,
    });
    expect(inputSchema.properties.precheck).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['probeRunId', 'probeTurnMarker', 'probeProxyReady', 'submitReady'],
    });
  });

  it('describes closed evidence append payload schemas down to nested record fields', () => {
    const appendTool = listPeekabooMcpTools().find(
      (tool) => tool.name === 'peekaboo_remote_eval_evidence_append',
    ) as { inputSchema: Record<string, unknown> } | undefined;
    expect(appendTool).toBeDefined();

    const inputSchema = appendTool?.inputSchema as {
      properties: Record<string, unknown>;
    };
    const recordSchema = inputSchema.properties.record as {
      additionalProperties: boolean;
      required: readonly string[];
      properties: Record<string, unknown>;
    };
    expect(recordSchema.additionalProperties).toBe(false);
    expect(recordSchema.required).toEqual([
      'runId',
      'turnMarker',
      'correlationId',
      'readiness',
      'evidence',
    ]);
    expect(recordSchema.properties.readiness).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['phase', 'overallStatus'],
    });
    expect(recordSchema.properties.evidence).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['submit', 'taskCorrelation', 'ack', 'matchedReply'],
    });
    expect(inputSchema.properties.readiness).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['phase', 'overallStatus'],
    });
    expect(inputSchema.properties.evidence).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['submit', 'taskCorrelation', 'ack', 'matchedReply'],
    });
  });

  it('exposes explicit REST observation env controls on the run-turn schema', () => {
    const runTurnTool = listPeekabooMcpTools().find(
      (tool) => tool.name === 'peekaboo_remote_eval_run_turn',
    ) as { inputSchema: Record<string, unknown> } | undefined;
    expect(runTurnTool).toBeDefined();

    const inputSchema = runTurnTool?.inputSchema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(inputSchema.additionalProperties).toBe(false);
    expect(inputSchema.properties.envFile).toMatchObject({
      type: 'string',
    });
    expect(inputSchema.properties.artifactPath).toBeUndefined();
    expect(inputSchema.properties.botTokenEnv).toMatchObject({
      type: 'string',
    });
  });

  it('handles initialize and tools/list JSON-RPC messages', () => {
    const initialize = handleMcpJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(initialize).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: 'auto-archive-peekaboo-remote-eval' },
      },
    });

    const tools = handleMcpJsonRpcMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    expect(JSON.stringify(tools)).toContain('peekaboo_remote_eval_run_turn');
  });

  it('returns a standardized dry-run helper command through the MCP tool', () => {
    const result = callPeekabooMcpTool('peekaboo_remote_eval_run_turn', {
      runId: 'MCP_DRY',
      mode: 'slash-status',
      message: 'discord-task-mcpdry123',
      expectTaskId: 'discord-task-mcpdry123',
      dryRun: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('discord-task-mcpdry123');
    expect(result.content[0]?.text).toContain('"dryRun": true');
    expect(result.content[0]?.text).toContain('"pollMode": "command-response"');
    expect(result.content[0]?.text).toContain('"phase": "dry-run"');
  });

  it('returns dry-run helper commands with explicit REST observation env controls', () => {
    const result = callPeekabooMcpTool('peekaboo_remote_eval_run_turn', {
      runId: 'MCP_ENV',
      mode: 'slash-status',
      message: 'discord-task-env123',
      expectTaskId: 'discord-task-env123',
      dryRun: true,
      envFile: '/tmp/operator-approved-auto-archive.env',
      botTokenEnv: 'AUTO_ARCHIVE_DISCORD_TOKEN_FOR_TEST',
    });

    const structured = result.structuredContent as {
      command: { args: readonly string[] };
    };
    expect(result.isError).toBeUndefined();
    expect(structured.command.args).toContain('--env-file');
    expect(structured.command.args).toContain(
      '/tmp/operator-approved-auto-archive.env',
    );
    expect(structured.command.args).toContain('--bot-token-env');
    expect(structured.command.args).toContain(
      'AUTO_ARCHIVE_DISCORD_TOKEN_FOR_TEST',
    );
  });

  it('returns a bounded precheck batch plan without executing remote GUI state', () => {
    const result = callPeekabooMcpTool('peekaboo_remote_eval_batch_plan', {
      runId: 'batch plan',
      executionMode: 'precheck',
      maxTurns: 5,
      target: 'arona',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      runId: 'batch_plan',
      executionMode: 'precheck',
      maxTurns: 5,
      autonomousExecution: false,
      plannedTurnMarkers: [
        'batch_plan_T01',
        'batch_plan_T02',
        'batch_plan_T03',
        'batch_plan_T04',
        'batch_plan_T05',
      ],
      turns: [],
      precheckCommand: {
        marker: 'batch_plan_PRECHECK',
        command: {
          executionMode: 'probe',
          probe: true,
          mutatesRemoteGui: false,
        },
      },
    });
  });

  it('rejects MCP batch planning calls that omit executionMode', () => {
    expect(() =>
      callPeekabooMcpTool('peekaboo_remote_eval_batch_plan', {
        runId: 'missing execution mode',
      }),
    ).toThrow(/executionMode is required/);
  });

  it('rejects unsafe live batch planning without explicit proof and with ambiguous mixed input', () => {
    expect(() =>
      callPeekabooMcpTool('peekaboo_remote_eval_batch_plan', {
        runId: 'batch live',
        executionMode: 'live',
        maxTurns: 5,
      }),
    ).toThrow(/allowLive=true/);

    expect(() =>
      callPeekabooMcpTool('peekaboo_remote_eval_batch_plan', {
        runId: 'batch live',
        executionMode: 'live',
        maxTurns: 5,
        allowLive: true,
      }),
    ).toThrow(/require precheck proof/i);

    expect(() =>
      callPeekabooMcpTool('peekaboo_remote_eval_batch_plan', {
        runId: 'batch live',
        executionMode: 'live',
        maxTurns: 5,
        allowLive: true,
        probe: true,
        precheck: {
          probeRunId: 'batch live',
          probeTurnMarker: 'batch_live_PRECHECK',
          probeProxyReady: true,
          submitReady: true,
        },
      }),
    ).toThrow(/Ambiguous batch invocation: probe=true/);
  });

  it('supports an injected executor for MCP turn execution tests', () => {
    const result = callPeekabooMcpTool(
      'peekaboo_remote_eval_run_turn',
      {
        runId: 'MCP_FAKE',
        mode: 'message',
        message: 'plain Discord message',
        expectTaskId: 'discord-task-live123',
        dryRun: false,
        allowLive: true,
      },
      {
        executor: (_command, args) => ({
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            ok: true,
            args,
            probeResult: {
              remote: {
                proxy: { ready: true },
              },
            },
            control: {
              ok: true,
              submitAttempted: true,
              ssh: { ok: true },
              bridge: { exists: true },
              proxy: { ready: false },
            },
            observation: {
              acknowledgement: {
                id: 'msg-ack',
                authorId: '1476113538320957451',
                timestamp: '2026-04-26T00:00:02.000Z',
                content: 'Accepted discord-task-live123',
              },
              matchedReply: {
                id: 'msg-reply',
                authorId: '1476113538320957451',
                timestamp: '2026-04-26T00:00:05.000Z',
                content: 'MCP_FAKE_T01 discord-task-live123 completed',
              },
              related: [
                {
                  id: 'msg-ack',
                  authorId: '1476113538320957451',
                  timestamp: '2026-04-26T00:00:02.000Z',
                  content: 'Accepted discord-task-live123',
                },
                {
                  id: 'msg-reply',
                  authorId: '1476113538320957451',
                  timestamp: '2026-04-26T00:00:05.000Z',
                  content: 'MCP_FAKE_T01 discord-task-live123 completed',
                },
              ],
            },
          }),
          stderr: '',
        }),
      },
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      helperResult: { ok: true },
      readiness: {
        phase: 'live',
        proxyReady: false,
        probeProxyReady: true,
        liveProxyReady: false,
        submitReady: true,
        liveOk: true,
        evidence: {
          submit: { status: 'attempted' },
          ack: { status: 'captured' },
          matchedReply: { status: 'captured' },
        },
      },
    });
  });

  it('passes probe helper readiness payloads through the MCP wrapper', () => {
    const result = callPeekabooMcpTool(
      'peekaboo_remote_eval_run_turn',
      {
        runId: 'MCP_PROBE',
        mode: 'message',
        message: 'probe only',
        probe: true,
      },
      {
        executor: (_command, args) => ({
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            ok: true,
            probe: true,
            readiness: {
              phase: 'probe',
              overallStatus: 'ready',
              highestReady: 'SUBMIT_READY',
              submitReady: true,
              liveOk: false,
              liveSubmitPerformed: false,
              matchedReplyObserved: false,
              checks: [
                {
                  label: 'CONFIG_OK',
                  status: 'ready',
                  summary: 'Local helper configuration parsed and sanitized.',
                },
                {
                  label: 'SSH_OK',
                  status: 'ready',
                  summary: 'SSH reachability was confirmed for the remote macOS host.',
                },
                {
                  label: 'BRIDGE_PRESENT',
                  status: 'ready',
                  summary: 'desktop-control-bridge.json was present and readable.',
                },
                {
                  label: 'PROXY_READY',
                  status: 'ready',
                  summary: 'Peekaboo proxy initialize/list-tools readiness succeeded.',
                },
                {
                  label: 'SUBMIT_READY',
                  status: 'ready',
                  summary: 'Probe verified the pre-submit gates needed for live Discord control.',
                },
                {
                  label: 'LIVE_OK',
                  status: 'skipped',
                  summary: 'No live Discord submission was attempted.',
                },
              ],
              summary: 'Probe confirmed submit readiness without performing a live Discord submission.',
            },
          }),
          stderr: args.includes('--probe') ? '' : 'expected --probe',
        }),
      },
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      command: {
        executionMode: 'probe',
        probe: true,
        mutatesRemoteGui: false,
      },
      readiness: {
        phase: 'probe',
        proxyReady: true,
        probeProxyReady: true,
        liveProxyReady: false,
        submitReady: true,
        liveSubmitPerformed: false,
      },
    });
  });

  it('returns bounded live batch templates only after explicit precheck proof', () => {
    const result = callPeekabooMcpTool('peekaboo_remote_eval_batch_plan', {
      runId: 'batch live',
      executionMode: 'live',
      maxTurns: 6,
      allowLive: true,
      target: 'plana',
      precheck: {
        probeRunId: 'probe batch live',
        probeTurnMarker: 'batch_live_PRECHECK',
        probeProxyReady: true,
        submitReady: true,
        recordedAt: '2026-04-27T01:02:03.000Z',
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      runId: 'batch_live',
      executionMode: 'live',
      maxTurns: 6,
      autonomousExecution: false,
      precheckProof: {
        probeRunId: 'probe_batch_live',
        probeTurnMarker: 'batch_live_PRECHECK',
        probeProxyReady: true,
        submitReady: true,
      },
    });

    const structured = result.structuredContent as {
      plannedTurnMarkers: readonly string[];
      turns: Array<{
        marker: string;
        correlationId: string;
        command: { executionMode: string; mutatesRemoteGui: boolean };
      }>;
    };
    expect(structured.plannedTurnMarkers).toEqual([
      'batch_live_T01',
      'batch_live_T02',
      'batch_live_T03',
      'batch_live_T04',
      'batch_live_T05',
      'batch_live_T06',
    ]);
    expect(structured.turns).toHaveLength(6);
    expect(structured.turns[0]).toMatchObject({
      marker: 'batch_live_T01',
      correlationId: 'batch_live:batch:turn:01',
      command: {
        executionMode: 'live',
        mutatesRemoteGui: true,
      },
    });
    expect(structured.turns[5]).toMatchObject({
      marker: 'batch_live_T06',
      correlationId: 'batch_live:batch:turn:06',
      command: {
        executionMode: 'live',
        mutatesRemoteGui: true,
      },
    });
  });

  it('appends and queries normalized evidence digests through the MCP ledger tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-mcp-ledger-'));
    try {
      const ledgerPath = join(dir, 'peekaboo-evidence.jsonl');
      const readiness = buildPeekabooReadinessReport({
        phase: 'live',
        configOk: true,
        sshOk: true,
        bridgePresent: true,
        proxyReady: true,
        marker: 'MCP_LEDGER_T01',
        expectedTaskId: 'discord-task-mcp-ledger',
        submitAttempted: true,
        controlOk: true,
        restObservationAttempted: true,
        matchedReply: {
          observedAt: '2026-04-27T00:30:05.000Z',
          taskId: 'discord-task-mcp-ledger',
          marker: 'MCP_LEDGER_T01',
          matchedOn: ['marker', 'task-id'],
        },
      });

      const append = callPeekabooMcpTool('peekaboo_remote_eval_evidence_append', {
        ledgerPath,
        runId: 'MCP_LEDGER',
        turnMarker: 'MCP_LEDGER_T01',
        correlationId: 'corr-mcp-ledger',
        channelId: 'channel-mcp',
        readiness,
        evidence: readiness.evidence,
        outcome: 'PASS',
      });
      expect(append.structuredContent).toMatchObject({
        ok: true,
        ledgerPath,
        record: {
          runId: 'MCP_LEDGER',
          turnMarker: 'MCP_LEDGER_T01',
          correlationId: 'corr-mcp-ledger',
          taskId: 'discord-task-mcp-ledger',
          channelId: 'channel-mcp',
          phase: 'live',
          outcome: 'PASS',
        },
      });

      const query = callPeekabooMcpTool('peekaboo_remote_eval_evidence_query', {
        ledgerPath,
        runId: 'MCP_LEDGER',
        correlationId: 'corr-mcp-ledger',
        limit: 1,
      });
      expect(query.structuredContent).toMatchObject({
        ok: true,
        ledgerPath,
        count: 1,
        records: [
          {
            runId: 'MCP_LEDGER',
            turnMarker: 'MCP_LEDGER_T01',
            correlationId: 'corr-mcp-ledger',
            taskId: 'discord-task-mcp-ledger',
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects evidence appends that omit required correlation ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-peekaboo-mcp-ledger-'));
    try {
      const ledgerPath = join(dir, 'peekaboo-evidence.jsonl');
      const readiness = buildPeekabooReadinessReport({
        phase: 'probe',
        configOk: true,
        sshOk: true,
        bridgePresent: true,
        probeProxyReady: true,
      });

      expect(() =>
        callPeekabooMcpTool('peekaboo_remote_eval_evidence_append', {
          ledgerPath,
          runId: 'MCP_LEDGER',
          turnMarker: 'MCP_LEDGER_T01',
          readiness,
          evidence: readiness.evidence,
        }),
      ).toThrow(/correlationId is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
