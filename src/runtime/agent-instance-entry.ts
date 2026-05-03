#!/usr/bin/env node
/**
 * Apptainer container entry script.
 *
 * Reads a serialized `DispatchPlan` (JSON) from stdin, runs the
 * AgentRuntime + CodexRuntimeDriver inside the container, writes the
 * resulting `TerminalEvidence` (JSON) to stdout, and streams lifecycle
 * observations to stderr (newline-delimited JSON, one event per line).
 *
 * Containment posture:
 *   - Plana inside the container is a no-op default. Admission/approval
 *     and runtime policy decisions already settled on the host before
 *     the host invoked `apptainer exec`. The container is the sandbox;
 *     anything the agent does is bounded by the apptainer capability set
 *     compiled from the plan's traits.
 *   - Cancellation: a SIGTERM (delivered by `scancel` propagating to the
 *     container PID 1) aborts the in-progress AgentRuntime call via the
 *     RuntimeCancellationBoundary `cancel`.
 *
 * Stdio contract:
 *   - stdin   : a single JSON object matching `DispatchPlan` shape
 *   - stdout  : a single JSON object matching `TerminalEvidence` shape
 *               (one trailing newline)
 *   - stderr  : zero or more `{phase, taskId, instanceId, observedAt, ...}`
 *               objects, one per line. The host parses these to fan out
 *               LifecycleObserver notifications without waiting for exit.
 */

import { AgentRuntime } from './agent-runtime.js';
import { createMethodologyTraitRuntimeAgentOptionsFromEnv } from './methodology-trait-runtime-decorator-resolver.js';
import { Plana } from '../core/plana.js';
import type {
  LifecyclePhaseObservation,
} from '../contracts/dispatch-lifecycle.js';
import type { DispatchPlan } from '../core/task.js';
import type { TerminalEvidence } from '../contracts/terminal-evidence.js';
import {
  createVetoPath,
  type VetoPath,
} from '../contracts/veto.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeCancellationReceipt,
  RuntimeTerminalCause,
} from '../contracts/runtime-driver.js';

const ENTRY_PROVENANCE = 'agent-instance-entry';

async function readStdinJson(): Promise<DispatchPlan> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) {
    throw new Error('agent-instance-entry: stdin contained no DispatchPlan JSON.');
  }
  return JSON.parse(raw) as DispatchPlan;
}

function emitLifecycle(observation: LifecyclePhaseObservation): void {
  // Best-effort stderr write. We never fail the dispatch because of an
  // observation serialization or write error.
  try {
    process.stderr.write(`${JSON.stringify(observation)}\n`);
  } catch {
    // swallow
  }
}

function buildContainerCancellationBoundary(taskId: string): {
  boundary: RuntimeCancellationBoundary;
  signalCancel: (reason: string) => void;
} {
  let cancelReceipt: RuntimeCancellationReceipt | undefined;
  let cancelCause: RuntimeTerminalCause | undefined;
  let resolveTerminal: ((cause: RuntimeTerminalCause) => void) | undefined;
  const terminalCausePromise = new Promise<RuntimeTerminalCause>((resume) => {
    resolveTerminal = resume;
  });

  const cancelInternal = (
    reason: string,
    veto?: VetoPath,
  ): RuntimeCancellationReceipt => {
    const requestedAt = new Date().toISOString();
    if (cancelReceipt !== undefined) {
      return cancelReceipt;
    }
    cancelReceipt = {
      taskId,
      reason,
      provenance: ENTRY_PROVENANCE,
      requestedAt,
    };
    cancelCause = veto
      ? {
          kind: 'runtime-veto',
          taskId,
          reason,
          provenance: ENTRY_PROVENANCE,
          requestedAt,
          veto,
        }
      : {
          kind: 'external-cancel',
          taskId,
          reason,
          provenance: ENTRY_PROVENANCE,
          requestedAt,
        };
    resolveTerminal?.(cancelCause);
    return cancelReceipt;
  };

  const boundary: RuntimeCancellationBoundary = {
    cancel(veto: VetoPath): RuntimeCancellationReceipt {
      return cancelInternal(veto.reason ?? 'runtime-veto', veto);
    },
    latchRuntimeVeto(veto: VetoPath): RuntimeTerminalCause {
      cancelInternal(veto.reason ?? 'runtime-veto', veto);
      return cancelCause as RuntimeTerminalCause;
    },
    currentTerminalCause(): RuntimeTerminalCause | undefined {
      return cancelCause;
    },
    whenTerminalCause(): Promise<RuntimeTerminalCause> {
      return terminalCausePromise;
    },
    closeExternalCancellation(): void {
      // No external port to close inside the container.
    },
  };

  return {
    boundary,
    signalCancel: (reason: string) => {
      cancelInternal(reason);
    },
  };
}

async function main(): Promise<void> {
  const plan = await readStdinJson();
  const { boundary, signalCancel } = buildContainerCancellationBoundary(
    plan.taskId,
  );

  const onSignal = (sig: NodeJS.Signals) => {
    signalCancel(`container received ${sig}`);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const runtime = new AgentRuntime(
    undefined,
    createMethodologyTraitRuntimeAgentOptionsFromEnv(process.env),
  );
  // Container-side Plana is intentionally permissive on trait-module
  // admission: the host already settled admission/approval before invoking
  // `apptainer exec`. Wiring an explicit always-undefined trait hook
  // (rather than `new Plana()`) opts out of the kernel default-deny in
  // `Plana.consumeTrait` for `kind:'trait-module'` so the container can
  // execute methodology evidence decorators wired by the host.
  const plana = new Plana({ trait: () => undefined });

  let evidence: TerminalEvidence;
  try {
    evidence = await runtime.execute(
      plan,
      plana,
      boundary,
      (observation) => emitLifecycle(observation),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `non-Error rejection: ${String(error)}`;
    // Emit a terminal-failure observation for the host's stderr stream so
    // the lifecycle fan-out still observes a `terminal` phase before the
    // process exits non-zero.
    emitLifecycle({
      phase: 'terminal',
      taskId: plan.taskId,
      instanceId: `agent-instance-entry-${plan.taskId}`,
      observedAt: new Date().toISOString(),
      cause: {
        kind: 'driver-failure',
        taskId: plan.taskId,
        runtimeInstanceId: `agent-instance-entry-${plan.taskId}`,
        observedAt: new Date().toISOString(),
        provenance: ENTRY_PROVENANCE,
        phase: 'agent-instance-entry',
        message,
      },
    });
    process.stdout.write(
      JSON.stringify({
        kind: 'agent-instance-entry-error',
        taskId: plan.taskId,
        message,
      }) + '\n',
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(evidence) + '\n');
}

void main().catch((error) => {
  process.stderr.write(
    `agent-instance-entry top-level rejection: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(2);
});

void createVetoPath; // retain import for future veto plumbing without an unused-import error.
