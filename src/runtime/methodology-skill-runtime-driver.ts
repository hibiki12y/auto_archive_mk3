import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';
import type { TraitRuntimeDecoratorContext } from '../contracts/trait-runtime-hook.js';
import {
  createMethodologySkillEvidenceCheckpoint,
  formatMethodologySkillEvidenceCheckpointDetail,
  type MethodologySkillSelection,
} from '../contracts/methodology-skill.js';

const METHODOLOGY_SKILL_RUNTIME_STEP = 'methodology-skill.checkpoint';

async function emitMethodologySkillCheckpoint(
  context: RuntimeExecutionContext,
  checkpoint: ReturnType<typeof createMethodologySkillEvidenceCheckpoint>,
): Promise<void> {
  try {
    await context.emit({
      kind: 'agent-step',
      step: METHODOLOGY_SKILL_RUNTIME_STEP,
      detail: formatMethodologySkillEvidenceCheckpointDetail(checkpoint),
    });
  } catch (emitError) {
    // Evidence-only decorator: checkpoint emission is best-effort and must not
    // change delegate result/throw semantics. Surface the failure as a
    // structured stderr line so operators can observe lost methodology
    // evidence without affecting dispatch.
    try {
      console.error(
        `methodology-evidence-emit-failed ${JSON.stringify({
          event: 'methodology-evidence-emit-failed',
          taskId: context.plan.taskId,
          checkpoint: checkpoint.checkpoint,
          errorMessage:
            emitError instanceof Error ? emitError.message : String(emitError),
        })}`,
      );
    } catch {
      // best-effort log; never fail the decorator because of a serialization
      // or logger error.
    }
  }
}

export class MethodologySkillRuntimeDriver implements RuntimeDriver {
  constructor(
    private readonly delegate: RuntimeDriver,
    private readonly selection: MethodologySkillSelection,
  ) {}

  async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
    if (!this.selection.requested) {
      return this.delegate.run(context);
    }

    await emitMethodologySkillCheckpoint(
      context,
      createMethodologySkillEvidenceCheckpoint({
        ...this.selection,
        checkpoint: 'runtime-decoration-start',
        taskId: context.plan.taskId,
      }),
    );

    try {
      const result = await this.delegate.run(context);
      await emitMethodologySkillCheckpoint(
        context,
        createMethodologySkillEvidenceCheckpoint({
          ...this.selection,
          checkpoint: 'runtime-decoration-complete',
          taskId: context.plan.taskId,
          completionStatus: 'delegate-returned',
          causeKind: result.cause.kind,
        }),
      );
      return result;
    } catch (error) {
      await emitMethodologySkillCheckpoint(
        context,
        createMethodologySkillEvidenceCheckpoint({
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

export function createMethodologySkillRuntimeDriver(
  delegate: RuntimeDriver,
  selection: MethodologySkillSelection,
): MethodologySkillRuntimeDriver {
  return new MethodologySkillRuntimeDriver(delegate, selection);
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
  const selection: MethodologySkillSelection = {
    requested: context.requested,
    selectedSkillId: 'agent-methodology-origin',
    selectedProfileId: 'evidence-only-runtime',
    runtimeDecorationIntent: 'evidence-only',
    runtimeDecorationEnforcement: context.manifest.runtime.enforcement,
  };
  return selection.requested
    ? createMethodologySkillRuntimeDriver(delegate, selection)
    : delegate;
}
