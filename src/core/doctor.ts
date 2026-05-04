import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  rateThrottleConfigFromEnv,
  type RateThrottleSnapshot,
} from './rate-throttle.js';

export type DoctorSectionStatus = 'pass' | 'warn' | 'fail';

export interface DoctorSection {
  readonly name: string;
  readonly status: DoctorSectionStatus;
  readonly details: readonly string[];
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly generatedAt: string;
  readonly sections: readonly DoctorSection[];
}

export interface DoctorReportInput {
  readonly ledgerEnabled: boolean;
  readonly accessPolicyEnabled: boolean;
  readonly authDatabaseEnabled?: boolean;
  readonly runtimeProviderScope: 'codex-sdk-only' | 'multi-provider' | 'unknown';
  readonly activeRuntimeProvider?: 'codex' | 'claude-agent';
  readonly computeMode?: string;
  readonly apptainerImage?: string;
  readonly agentInstanceEntry?: string;
  readonly modelOverride?: string;
  readonly messageContentIntent?: boolean;
  readonly approvalRegistryEnabled?: boolean;
  readonly executionApprovalPolicy?: 'single-use' | 'unsafe-disabled' | 'unknown';
  readonly toolLoopDetectorEnabled?: boolean;
  readonly subagentMaxSpawnDepth?: number;
  readonly gitLabEnabled?: boolean;
  readonly gitLabTokenConfigured?: boolean;
  readonly gitLabArtifactPublicationEnabled?: boolean;
  readonly codexAuthPath?: string;
  readonly codexAuthConfigured?: boolean;
  readonly anthropicAuthSource?: 'api-key' | 'claude-cli' | 'none';
  readonly anthropicCliPath?: string;
  readonly claudeModelOverride?: string;
  readonly planaAdvisorProvider?: 'claude-agent' | 'codex' | 'none';
  readonly planaAdvisorModel?: string;
  readonly planaAdvisorMaxCalls?: number;
  /**
   * PR5 — `'rate-throttle'` chokepoint enablement state. `true` iff at
   * least one provider has a finite cap (i.e. at least one
   * `AUTO_ARCHIVE_*_MAX_INFLIGHT` is a non-negative integer). When
   * undefined, the section is omitted entirely (pre-PR5 doctor output
   * preserved bit-for-bit on systems that have not enabled throttling).
   */
  readonly rateThrottleEnabled?: boolean;
  /**
   * PR5 — provider-by-provider live snapshot. Source of truth is the
   * runtime `RateThrottlePort.snapshot()` when wired; the
   * `buildDoctorReportFromEnv` helper derives a static config-only
   * snapshot (inflight=0) for env-only diagnostics.
   */
  readonly rateThrottleSnapshot?: ReadonlyArray<RateThrottleSnapshot>;
  readonly redactionProbe?: string;
  readonly generatedAt?: string;
  /**
   * TLS CA certificate preflight — value of SSL_CERT_FILE env var, if set.
   * Presence check (`sslCertFilePresent`) is resolved by `buildDoctorReportFromEnv`.
   */
  readonly sslCertFile?: string;
  /**
   * TLS CA certificate preflight — value of CODEX_CA_CERTIFICATE env var, if set.
   * Presence check (`codexCaCertificatePresent`) is resolved by `buildDoctorReportFromEnv`.
   */
  readonly codexCaCertificate?: string;
  /**
   * `true` iff `sslCertFile` points to an existing regular file (isFile).
   * `false` if the path was set but stat threw or the entry is not a regular file.
   * Undefined (treat as unset) when `sslCertFile` is not provided.
   */
  readonly sslCertFilePresent?: boolean;
  /**
   * `true` iff `codexCaCertificate` points to an existing regular file (isFile).
   * `false` if the path was set but stat threw or the entry is not a regular file.
   * Undefined (treat as unset) when `codexCaCertificate` is not provided.
   */
  readonly codexCaCertificatePresent?: boolean;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function redactedPathSummary(path: string | undefined): string {
  if (path === undefined || path.trim().length === 0) {
    return 'unset';
  }
  return `${basename(path)}#${shortHash(path)}`;
}

function section(name: string, status: DoctorSectionStatus, details: readonly string[], remediation?: string): DoctorSection {
  return { name, status, details, ...(remediation === undefined ? {} : { remediation }) };
}

export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const sections: DoctorSection[] = [];
  sections.push(
    section('Service readiness', input.ledgerEnabled ? 'pass' : 'warn', [
      `Ledger: ${input.ledgerEnabled ? 'enabled' : 'disabled'}`,
      `Message Content Intent: ${input.messageContentIntent === true ? 'enabled' : 'disabled/unknown'}`,
    ], input.ledgerEnabled ? undefined : 'Enable AUTO_ARCHIVE_CONTROL_LEDGER_PATH for replayable operations.'),
  );
  sections.push(
    section(
      'Discord auth/access policy',
      input.accessPolicyEnabled && input.authDatabaseEnabled === true ? 'pass' : 'warn',
      [
        `Access policy: ${input.accessPolicyEnabled ? 'enabled' : 'disabled'}`,
        `Auth database: ${input.authDatabaseEnabled === true ? 'enabled' : 'disabled'}`,
      ],
      input.authDatabaseEnabled === true ? undefined : 'Configure AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH or memory auth for explicit access state.',
    ),
  );
  const computeModeLabel = input.computeMode ?? 'default';
  const slurmApptainerActive =
    computeModeLabel === 'default' ||
    computeModeLabel === '' ||
    computeModeLabel === 'slurm-apptainer';
  const sandboxStatus: DoctorSectionStatus = slurmApptainerActive
    ? input.apptainerImage && input.apptainerImage.length > 0 &&
      input.agentInstanceEntry && input.agentInstanceEntry.length > 0
      ? 'pass'
      : 'warn'
    : 'warn';
  const providerLabel =
    input.runtimeProviderScope === 'codex-sdk-only'
      ? 'Codex SDK only'
      : input.runtimeProviderScope === 'multi-provider'
        ? `Multi-provider (Codex + Claude Agent); active: ${input.activeRuntimeProvider ?? 'codex'}`
        : 'unknown';
  sections.push(
    section(
      'Runtime provider scope',
      sandboxStatus,
      [
        `Provider: ${providerLabel}`,
        `Compute mode: ${computeModeLabel}`,
        `Apptainer image: ${input.apptainerImage && input.apptainerImage.length > 0 ? input.apptainerImage : 'unset'}`,
        `Agent-instance entry: ${input.agentInstanceEntry && input.agentInstanceEntry.length > 0 ? input.agentInstanceEntry : 'unset'}`,
      ],
      slurmApptainerActive
        ? sandboxStatus === 'pass'
          ? undefined
          : 'Set AUTO_ARCHIVE_APPTAINER_IMAGE and AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY so dispatch executes inside the apptainer sandbox.'
        : 'Production policy requires slurm-apptainer compute mode (sandboxed dispatch). Unset AUTO_ARCHIVE_COMPUTE_NODE for production runs.',
    ),
  );
  sections.push(
    section(
      'Codex auth mount / model override',
      input.codexAuthConfigured === false ? 'warn' : 'pass',
      [
        `Auth path: ${redactedPathSummary(input.codexAuthPath)}`,
        `Local auth configured: ${input.codexAuthConfigured === false ? 'no/unknown' : 'yes/unknown'}`,
        `Model override: ${input.modelOverride ?? 'unset'}`,
      ],
      input.codexAuthConfigured === false ? 'Mount ~/.codex/auth.json or provide AUTO_ARCHIVE_CODEX_API_KEY.' : undefined,
    ),
  );
  if (input.runtimeProviderScope === 'multi-provider') {
    const claudeActive = input.activeRuntimeProvider === 'claude-agent';
    const anthropicAuthSource = input.anthropicAuthSource ?? 'none';
    const claudeStatus: DoctorSectionStatus =
      claudeActive && anthropicAuthSource === 'none' ? 'fail' : 'pass';
    sections.push(
      section(
        'Anthropic auth / Claude model override',
        claudeStatus,
        [
          `Auth source: ${anthropicAuthSource}`,
          `Claude CLI path: ${redactedPathSummary(input.anthropicCliPath)}`,
          `Model override: ${input.claudeModelOverride ?? 'unset'}`,
          `Active provider: ${input.activeRuntimeProvider ?? 'codex'}`,
        ],
        claudeStatus === 'fail'
          ? 'Set AUTO_ARCHIVE_ANTHROPIC_API_KEY (production) or AUTO_ARCHIVE_CLAUDE_CLI_PATH (single-user dev).'
          : undefined,
      ),
    );
    const advisorProvider = input.planaAdvisorProvider ?? 'none';
    const dispatchProvider = input.activeRuntimeProvider ?? 'codex';
    const advisorRequiresAnthropic =
      advisorProvider === 'claude-agent' && anthropicAuthSource === 'none';
    const advisorStatus: DoctorSectionStatus = advisorRequiresAnthropic
      ? 'fail'
      : 'pass';
    const sameVendor =
      advisorProvider !== 'none' && advisorProvider === dispatchProvider;
    sections.push(
      section(
        'Plana runtime advisor',
        advisorStatus,
        [
          `Advisor provider: ${advisorProvider}`,
          `Dispatched task provider: ${dispatchProvider}`,
          `Cross-vendor: ${
            advisorProvider === 'none' ? 'n/a' : sameVendor ? 'no (same vendor)' : 'yes'
          }`,
          `Advisor model override: ${input.planaAdvisorModel ?? 'unset'}`,
          `Max advisor calls per dispatch: ${input.planaAdvisorMaxCalls ?? 'default'}`,
        ],
        advisorRequiresAnthropic
          ? 'Set AUTO_ARCHIVE_ANTHROPIC_API_KEY or AUTO_ARCHIVE_CLAUDE_CLI_PATH so the claude-agent advisor can authenticate.'
          : sameVendor
            ? 'Cross-vendor review benefit lost: advisor and dispatched task use the same provider. Consider unsetting the advisor or switching one of them.'
            : undefined,
      ),
    );
  }
  sections.push(
    section(
      'Approval registry status',
      input.approvalRegistryEnabled === true ? 'pass' : 'warn',
      [`Runtime approval registry: ${input.approvalRegistryEnabled === true ? 'enabled' : 'disabled'}`],
      input.approvalRegistryEnabled === true ? undefined : 'Wire RuntimeApprovalRegistry to Discord approve/deny for live approval resolution.',
    ),
  );
  sections.push(
    section(
      'Execution approval policy',
      input.executionApprovalPolicy === 'single-use' ? 'pass' : 'warn',
      [`Policy: ${input.executionApprovalPolicy ?? 'unknown'}`],
      input.executionApprovalPolicy === 'single-use' ? undefined : 'Use single-use execution approval records; allow-always is unsupported.',
    ),
  );
  sections.push(
    section(
      'Tool-loop detector status',
      input.toolLoopDetectorEnabled === false ? 'warn' : 'pass',
      [`Detector: ${input.toolLoopDetectorEnabled === false ? 'disabled' : 'enabled'}`],
    ),
  );
  sections.push(
    section('Subagent roster policy', 'pass', [
      `maxSpawnDepth: ${input.subagentMaxSpawnDepth ?? 1}`,
      'Nested depth-2 spawn: disabled',
    ]),
  );
  sections.push(
    section(
      'GitLab recording/artifact publication status',
      input.gitLabEnabled === true && input.gitLabTokenConfigured === false ? 'warn' : 'pass',
      [
        `GitLab: ${input.gitLabEnabled === true ? 'enabled' : 'disabled'}`,
        `Token configured: ${input.gitLabTokenConfigured === true ? 'yes' : input.gitLabEnabled === true ? 'no/unknown' : 'not required'}`,
        `Artifact publication: ${input.gitLabArtifactPublicationEnabled === true ? 'enabled' : 'disabled'}`,
      ],
      input.gitLabEnabled === true && input.gitLabTokenConfigured === false
        ? 'Set AUTO_ARCHIVE_GITLAB_TOKEN_ENV or AUTO_ARCHIVE_GITLAB_TOKEN without exposing the token in logs.'
        : undefined,
    ),
  );
  // TLS CA certificate preflight (F6 production-blocking case)
  {
    const sslSet = input.sslCertFile !== undefined && input.sslCertFile.length > 0;
    const codexSet = input.codexCaCertificate !== undefined && input.codexCaCertificate.length > 0;
    const sslMissing = sslSet && input.sslCertFilePresent === false;
    const codexMissing = codexSet && input.codexCaCertificatePresent === false;
    const tlsStatus: DoctorSectionStatus =
      sslMissing || codexMissing ? 'fail' : 'pass';
    const tlsDetails: string[] = [];
    if (!sslSet && !codexSet) {
      tlsDetails.push('SSL_CERT_FILE: unset (using system roots)');
      tlsDetails.push('CODEX_CA_CERTIFICATE: unset (using system roots)');
    } else {
      tlsDetails.push(
        `SSL_CERT_FILE: ${sslSet ? redactedPathSummary(input.sslCertFile) : 'unset'} — ${
          sslSet ? (input.sslCertFilePresent === true ? 'present' : 'MISSING') : 'n/a'
        }`,
      );
      tlsDetails.push(
        `CODEX_CA_CERTIFICATE: ${codexSet ? redactedPathSummary(input.codexCaCertificate) : 'unset'} — ${
          codexSet ? (input.codexCaCertificatePresent === true ? 'present' : 'MISSING') : 'n/a'
        }`,
      );
    }
    sections.push(
      section(
        'TLS CA certificate',
        tlsStatus,
        tlsDetails,
        tlsStatus === 'fail'
          ? 'SSL_CERT_FILE/CODEX_CA_CERTIFICATE points at a missing file. Either unset to use system roots, or fix the path. Codex SDK websocket TLS will fail closed otherwise.'
          : undefined,
      ),
    );
  }
  if (input.rateThrottleEnabled === true) {
    const snapshot = input.rateThrottleSnapshot ?? [];
    const overUtilized = snapshot.some(
      (entry) => entry.limit >= 0 && entry.utilizationPercent >= 80,
    );
    const saturated = snapshot.some(
      (entry) =>
        entry.limit >= 0 && entry.inflight >= entry.limit && entry.limit > 0,
    );
    const status: DoctorSectionStatus = saturated
      ? 'warn'
      : overUtilized
        ? 'warn'
        : 'pass';
    const details: string[] = snapshot.length === 0
      ? ['No provider snapshots available.']
      : snapshot.map((entry) => {
          const limitLabel = entry.limit < 0 ? 'unlimited' : String(entry.limit);
          const utilizationLabel =
            entry.limit < 0 ? 'n/a' : `${entry.utilizationPercent}%`;
          return `${entry.provider}: inflight=${entry.inflight} limit=${limitLabel} utilization=${utilizationLabel}`;
        });
    sections.push(
      section(
        'Rate-throttle (rate-throttle chokepoint)',
        status,
        details,
        saturated
          ? 'A provider is at its cap. Subsequent submissions will be admission-denied with reason="rate-throttle quota exhausted" until inflight drops.'
          : overUtilized
            ? 'A provider is at >=80% utilization. Consider raising AUTO_ARCHIVE_CODEX_MAX_INFLIGHT / AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT or sustained throughput will degrade.'
            : undefined,
      ),
    );
  }
  const probe = input.redactionProbe ?? 'sk-example-token glpat-example';
  const redactedProbe = probe.replace(/(?:sk-[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+)/g, '[REDACTED_SECRET]');
  sections.push(
    section('Secret redaction check', redactedProbe.includes('sk-') || redactedProbe.includes('glpat-') ? 'fail' : 'pass', [
      `Probe hash: ${shortHash(probe)}`,
      'Probe value: [redacted]',
    ]),
  );
  return { generatedAt: input.generatedAt ?? new Date().toISOString(), sections };
}

export function renderDoctorReport(report: DoctorReport): string {
  return [
    'Auto Archive doctor',
    `Generated: ${report.generatedAt}`,
    ...report.sections.flatMap((entry) => [
      '',
      `[${entry.status.toUpperCase()}] ${entry.name}`,
      ...entry.details.map((detail) => `- ${detail}`),
      ...(entry.remediation === undefined ? [] : [`Remediation: ${entry.remediation}`]),
    ]),
  ].join('\n');
}

export function buildDoctorReportFromEnv(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const gitLabEnabled = env['AUTO_ARCHIVE_GITLAB_ENABLED'] === 'true' || env['AUTO_ARCHIVE_GITLAB_ENABLED'] === '1';
  const tokenEnv = env['AUTO_ARCHIVE_GITLAB_TOKEN_ENV'] || 'GITLAB_TOKEN';

  // multi-provider-scope.md: provider is selected at bootstrap from
  // AUTO_ARCHIVE_RUNTIME_PROVIDER. Doctor reflects the active selection
  // plus the readiness of the alternate provider's auth surface.
  const runtimeProviderRaw = env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim();
  const activeRuntimeProvider: 'codex' | 'claude-agent' =
    runtimeProviderRaw === 'claude-agent' ? 'claude-agent' : 'codex';
  const anthropicApiKey = env['AUTO_ARCHIVE_ANTHROPIC_API_KEY']?.trim();
  const anthropicCliPath = env['AUTO_ARCHIVE_CLAUDE_CLI_PATH']?.trim();
  const anthropicAuthSource: 'api-key' | 'claude-cli' | 'none' =
    anthropicApiKey && anthropicApiKey.length > 0
      ? 'api-key'
      : anthropicCliPath && anthropicCliPath.length > 0
        ? 'claude-cli'
        : 'none';

  // PR5 — env-only static snapshot. The runtime port supplies the live
  // inflight count; without a wired port we fall back to inflight=0 so
  // doctor still reflects which provider has a configured cap.
  const throttleCfg = rateThrottleConfigFromEnv(env);
  const throttleEnabled =
    throttleCfg.codexMaxInflight >= 0 ||
    throttleCfg.claudeAgentMaxInflight >= 0;
  const throttleSnapshot: ReadonlyArray<RateThrottleSnapshot> = throttleEnabled
    ? [
        {
          provider: 'codex',
          inflight: 0,
          limit: throttleCfg.codexMaxInflight,
          utilizationPercent: 0,
        },
        {
          provider: 'claude-agent',
          inflight: 0,
          limit: throttleCfg.claudeAgentMaxInflight,
          utilizationPercent: 0,
        },
      ]
    : [];

  return buildDoctorReport({
    ledgerEnabled: Boolean(env['AUTO_ARCHIVE_CONTROL_LEDGER_PATH']),
    accessPolicyEnabled: true,
    authDatabaseEnabled: Boolean(env['AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH']),
    runtimeProviderScope: 'multi-provider',
    activeRuntimeProvider,
    computeMode: env['AUTO_ARCHIVE_COMPUTE_NODE'] ?? 'default',
    apptainerImage: env['AUTO_ARCHIVE_APPTAINER_IMAGE'],
    agentInstanceEntry: env['AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY'],
    modelOverride: env['AUTO_ARCHIVE_CODEX_MODEL'],
    messageContentIntent: env['AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT'] === '1',
    approvalRegistryEnabled: true,
    executionApprovalPolicy: 'single-use',
    toolLoopDetectorEnabled: true,
    subagentMaxSpawnDepth: 1,
    gitLabEnabled,
    gitLabTokenConfigured: gitLabEnabled ? Boolean(env['AUTO_ARCHIVE_GITLAB_TOKEN'] || env[tokenEnv]) : undefined,
    gitLabArtifactPublicationEnabled: env['AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED'] === 'true' || env['AUTO_ARCHIVE_GITLAB_ARTIFACT_PUBLISH_ENABLED'] === '1',
    codexAuthPath: env['CODEX_HOME'] === undefined ? undefined : `${env['CODEX_HOME']}/auth.json`,
    codexAuthConfigured: undefined,
    anthropicAuthSource,
    ...(anthropicCliPath === undefined ? {} : { anthropicCliPath }),
    ...(env['AUTO_ARCHIVE_CLAUDE_MODEL'] === undefined
      ? {}
      : { claudeModelOverride: env['AUTO_ARCHIVE_CLAUDE_MODEL'] }),
    planaAdvisorProvider:
      env['AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER']?.trim() === 'claude-agent'
        ? 'claude-agent'
        : env['AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER']?.trim() === 'codex'
          ? 'codex'
          : 'none',
    ...(env['AUTO_ARCHIVE_PLANA_ADVISOR_MODEL'] === undefined
      ? {}
      : { planaAdvisorModel: env['AUTO_ARCHIVE_PLANA_ADVISOR_MODEL'] }),
    ...(env['AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS'] === undefined ||
    env['AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS']?.trim() === ''
      ? {}
      : {
          planaAdvisorMaxCalls: Number(
            env['AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS'],
          ),
        }),
    ...(throttleEnabled
      ? {
          rateThrottleEnabled: true,
          rateThrottleSnapshot: throttleSnapshot,
        }
      : {}),
    ...(() => {
      const sslCertFile = env['SSL_CERT_FILE']?.trim();
      const codexCaCertificate = env['CODEX_CA_CERTIFICATE']?.trim();
      const result: {
        sslCertFile?: string;
        sslCertFilePresent?: boolean;
        codexCaCertificate?: string;
        codexCaCertificatePresent?: boolean;
      } = {};
      if (sslCertFile !== undefined && sslCertFile.length > 0) {
        result.sslCertFile = sslCertFile;
        try {
          result.sslCertFilePresent = statSync(sslCertFile).isFile();
        } catch {
          result.sslCertFilePresent = false;
        }
      }
      if (codexCaCertificate !== undefined && codexCaCertificate.length > 0) {
        result.codexCaCertificate = codexCaCertificate;
        try {
          result.codexCaCertificatePresent = statSync(codexCaCertificate).isFile();
        } catch {
          result.codexCaCertificatePresent = false;
        }
      }
      return result;
    })(),
  });
}
