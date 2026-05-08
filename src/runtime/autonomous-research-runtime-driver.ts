import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';
import type { TraitRuntimeDecoratorContext } from '../contracts/trait-runtime-hook.js';
import {
  createAutonomousResearchEvidenceCheckpoint,
  formatAutonomousResearchEvidenceCheckpointDetail,
  type AutonomousResearchTraitSelection,
} from '../contracts/autonomous-research-trait.js';

const AUTONOMOUS_RESEARCH_RUNTIME_STEP = 'autonomous-research.checkpoint';

async function emitAutonomousResearchCheckpoint(
  context: RuntimeExecutionContext,
  checkpoint: ReturnType<typeof createAutonomousResearchEvidenceCheckpoint>,
): Promise<void> {
  try {
    await context.emit({
      kind: 'agent-step',
      step: AUTONOMOUS_RESEARCH_RUNTIME_STEP,
      detail: formatAutonomousResearchEvidenceCheckpointDetail(checkpoint),
    });
  } catch (emitError) {
    // Evidence-only decorator: checkpoint emission is best-effort and must not
    // alter delegate result/throw semantics.
    try {
      console.error(
        `autonomous-research-evidence-emit-failed ${JSON.stringify({
          event: 'autonomous-research-evidence-emit-failed',
          taskId: context.plan.taskId,
          checkpoint: checkpoint.checkpoint,
          errorMessage:
            emitError instanceof Error ? emitError.message : String(emitError),
        })}`,
      );
    } catch {
      // best-effort log; never fail the decorator because of logger failure.
    }
  }
}

export class AutonomousResearchRuntimeDriver implements RuntimeDriver {
  constructor(
    private readonly delegate: RuntimeDriver,
    private readonly selection: AutonomousResearchTraitSelection,
  ) {}

  async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
    if (!this.selection.requested) {
      return this.delegate.run(context);
    }

    await emitAutonomousResearchCheckpoint(
      context,
      createAutonomousResearchEvidenceCheckpoint({
        ...this.selection,
        checkpoint: 'runtime-decoration-start',
        taskId: context.plan.taskId,
      }),
    );

    try {
      const result = await this.delegate.run(context);
      await emitAutonomousResearchCheckpoint(
        context,
        createAutonomousResearchEvidenceCheckpoint({
          ...this.selection,
          checkpoint: 'runtime-decoration-complete',
          taskId: context.plan.taskId,
          completionStatus: 'delegate-returned',
          causeKind: result.cause.kind,
        }),
      );
      return result;
    } catch (error) {
      await emitAutonomousResearchCheckpoint(
        context,
        createAutonomousResearchEvidenceCheckpoint({
          ...this.selection,
          checkpoint: 'runtime-decoration-error',
          taskId: context.plan.taskId,
          completionStatus: 'delegate-threw',
        }),
      );
      throw error;
    }
  }
}

export function createAutonomousResearchRuntimeDriver(
  delegate: RuntimeDriver,
  selection: AutonomousResearchTraitSelection,
): AutonomousResearchRuntimeDriver {
  return new AutonomousResearchRuntimeDriver(delegate, selection);
}

export function composeTraitRuntimeDriver(
  delegate: RuntimeDriver,
  context: TraitRuntimeDecoratorContext,
): RuntimeDriver {
  if (!context.requested) {
    return delegate;
  }
  if (context.manifest.runtime.hook !== 'evidence-decorator') {
    throw new TypeError(
      'composeTraitRuntimeDriver requires an evidence-decorator TraitModule manifest.',
    );
  }
  const selection: AutonomousResearchTraitSelection = {
    requested: context.requested,
    selectedTraitId: 'autonomous-research-goal-loop',
    selectedProfileId: 'dgm-bounded-archive-runtime',
    runtimeDecorationIntent: 'bounded-archive-evidence',
    runtimeDecorationEnforcement: context.manifest.runtime.enforcement,
  };
  return selection.requested
    ? createAutonomousResearchRuntimeDriver(delegate, selection)
    : delegate;
}
