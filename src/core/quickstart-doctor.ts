export const QUICKSTART_DOCTOR_SCHEMA_VERSION = 1;
export const QUICKSTART_DOCTOR_PROFILE = 'first-run';

export interface QuickstartDoctorCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface QuickstartDoctorCliOptions {
  readonly profile: typeof QUICKSTART_DOCTOR_PROFILE;
  readonly generatedAt?: string;
}

export interface QuickstartDoctorEnvCheck {
  readonly name: string;
  readonly status: 'configured' | 'missing';
  readonly purpose: string;
}

export interface QuickstartDoctorCommandStep {
  readonly label: string;
  readonly command: string;
  readonly liveServiceContact: boolean;
  readonly note: string;
}

export interface QuickstartDoctorReport {
  readonly schemaVersion: typeof QUICKSTART_DOCTOR_SCHEMA_VERSION;
  readonly profile: typeof QUICKSTART_DOCTOR_PROFILE;
  readonly generatedAt: string;
  readonly activeProvider: 'codex' | 'claude-agent';
  readonly envChecks: readonly QuickstartDoctorEnvCheck[];
  readonly commandSteps: readonly QuickstartDoctorCommandStep[];
  readonly boundary: {
    readonly environmentValuesRendered: false;
    readonly credentialFilesRead: false;
    readonly providerContacted: false;
    readonly liveServicesContacted: false;
    readonly filesMutated: false;
  };
}

const FIRST_RUN_ENV_CHECKS = Object.freeze([
  {
    name: 'AUTO_ARCHIVE_CONTROL_LEDGER_PATH',
    purpose: 'replayable control-plane ledger',
  },
  {
    name: 'AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH',
    purpose: 'explicit Discord access/auth state',
  },
  {
    name: 'AUTO_ARCHIVE_APPTAINER_IMAGE',
    purpose: 'dispatch sandbox image reference',
  },
  {
    name: 'AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY',
    purpose: 'agent instance entrypoint for sandboxed dispatch',
  },
] as const);

export function parseQuickstartDoctorCliArgs(
  argv: readonly string[],
): QuickstartDoctorCliOptions | 'help' {
  let profile: typeof QUICKSTART_DOCTOR_PROFILE = QUICKSTART_DOCTOR_PROFILE;
  let generatedAt: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        return 'help';
      case '--profile': {
        const value = requireCliValue(argv, index, '--profile');
        if (value !== QUICKSTART_DOCTOR_PROFILE) {
          throw new Error('--profile must be first-run.');
        }
        profile = value;
        index += 1;
        break;
      }
      case '--generated-at': {
        const value = requireCliValue(argv, index, '--generated-at');
        if (!isIsoInstant(value)) {
          throw new Error('--generated-at must be a valid ISO-8601 UTC timestamp.');
        }
        generatedAt = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }
  return generatedAt === undefined ? { profile } : { profile, generatedAt };
}

export function buildQuickstartDoctorReportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: QuickstartDoctorCliOptions = { profile: QUICKSTART_DOCTOR_PROFILE },
): QuickstartDoctorReport {
  const activeProvider =
    env['AUTO_ARCHIVE_RUNTIME_PROVIDER']?.trim() === 'claude-agent'
      ? 'claude-agent'
      : 'codex';
  const providerSurface =
    activeProvider === 'claude-agent'
      ? 'claude-agent-runtime-provider'
      : 'codex-runtime-provider';
  return Object.freeze({
    schemaVersion: QUICKSTART_DOCTOR_SCHEMA_VERSION,
    profile: options.profile,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    activeProvider,
    envChecks: FIRST_RUN_ENV_CHECKS.map((check) =>
      Object.freeze({
        ...check,
        status:
          env[check.name] !== undefined && env[check.name]?.trim().length !== 0
            ? 'configured'
            : 'missing',
      }),
    ),
    commandSteps: Object.freeze([
      {
        label: 'Static service doctor',
        command: 'pnpm doctor',
        liveServiceContact: false,
        note: 'Builds and renders local readiness without contacting Discord, GitLab, or providers.',
      },
      {
        label: 'Provider run-plan check',
        command: 'pnpm runtime:driver:check -- --pretty',
        liveServiceContact: false,
        note: 'Shows provider/model/auth-source classification without reading credential values or instantiating a RuntimeDriver.',
      },
      {
        label: 'Live-proof manifest skeleton',
        command: `pnpm live:proof:report -- --print-template --surface ${providerSurface} --pretty > runtime-state/live-proof.json`,
        liveServiceContact: false,
        note: 'Creates an operator-owned redacted manifest skeleton; replace WARN template data with retained live evidence before promotion.',
      },
      {
        label: 'Operator-approved provider smoke',
        command: `pnpm runtime:provider:smoke -- --provider ${activeProvider} --out runtime-state/provider-terminal-evidence.json`,
        liveServiceContact: true,
        note: 'Contacts the selected provider; run only when operator auth/cost approval is in scope.',
      },
      {
        label: 'Retained provider scorecard',
        command: `pnpm runtime:provider:evidence:report -- --evidence runtime-state/provider-terminal-evidence.json --provider ${activeProvider} --pretty`,
        liveServiceContact: false,
        note: 'Scores retained TerminalEvidence without contacting providers or rendering raw task/transcript content.',
      },
    ]),
    boundary: Object.freeze({
      environmentValuesRendered: false,
      credentialFilesRead: false,
      providerContacted: false,
      liveServicesContacted: false,
      filesMutated: false,
    }),
  });
}

export function renderQuickstartDoctorReport(
  report: QuickstartDoctorReport,
): string {
  return [
    `Quickstart doctor — ${report.profile}`,
    `Generated: ${report.generatedAt}`,
    `Active provider: ${report.activeProvider}`,
    '',
    'Environment names to configure (values are not rendered):',
    ...report.envChecks.map(
      (check) => `- [${check.status}] ${check.name} — ${check.purpose}`,
    ),
    '',
    'Safe first-run command path:',
    ...report.commandSteps.map(
      (step, index) =>
        `${index + 1}. ${step.label}\n   ${step.command}\n   liveServiceContact=${String(step.liveServiceContact)} — ${step.note}`,
    ),
    '',
    'Boundary:',
    `- env values rendered: ${String(report.boundary.environmentValuesRendered)}`,
    `- credential files read: ${String(report.boundary.credentialFilesRead)}`,
    `- provider contacted by this command: ${String(report.boundary.providerContacted)}`,
    `- live services contacted by this command: ${String(report.boundary.liveServicesContacted)}`,
    `- files mutated by this command: ${String(report.boundary.filesMutated)}`,
  ].join('\n');
}

export function runQuickstartDoctorCli(
  argv: readonly string[],
  io: QuickstartDoctorCliIo = process,
  env: NodeJS.ProcessEnv = process.env,
): number {
  let options: QuickstartDoctorCliOptions | 'help';
  try {
    options = parseQuickstartDoctorCliArgs(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (options === 'help') {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const report = buildQuickstartDoctorReportFromEnv(env, options);
  io.stdout.write(`${renderQuickstartDoctorReport(report)}\n`);
  return 0;
}

const USAGE = `Usage: pnpm quickstart:doctor -- [--profile first-run]

Print a guided, secret-safe first-run path that ties /doctor, runtime run-plan
inspection, live-proof template export, and retained provider scorecards into
one operator journey. The command does not read credential files, contact live
services, render environment values, mutate files, or run provider smoke by
itself.`;

function requireCliValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function isIsoInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
