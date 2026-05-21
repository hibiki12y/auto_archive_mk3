import type { ResearchPlan } from '../core/research-plan-orchestrator.js';
import {
  loadResearchPlan,
  resolveResearchPlanPath,
} from './research-plan-loader.js';

export interface DiscordResearchPlanStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly loadPlan?: (
    planId: string,
    env?: NodeJS.ProcessEnv,
    cwd?: string,
  ) => ResearchPlan;
  readonly resolvePlanPath?: (
    planId: string,
    env?: NodeJS.ProcessEnv,
    cwd?: string,
  ) => string;
}

export interface DiscordResearchPlanSummary {
  readonly planId: string;
  readonly path: string;
  readonly subTaskCount: number;
  readonly synthesisTaskId: string;
}

export type DiscordResearchPlanLookup =
  | {
      readonly status: 'found';
      readonly summary: DiscordResearchPlanSummary;
      readonly plan: ResearchPlan;
    }
  | {
      readonly status: 'unavailable';
      readonly planId: string;
      readonly reason: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Thin Discord-side read-only store over the existing `/research-plan`
 * loader. It does not dispatch plans; it only validates that a mission
 * approval points at a loadable plan and returns a compact summary for
 * operator-facing handoff messages.
 */
export class DiscordResearchPlanStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string | undefined;
  private readonly loadPlan: NonNullable<DiscordResearchPlanStoreOptions['loadPlan']>;
  private readonly resolvePlanPath: NonNullable<
    DiscordResearchPlanStoreOptions['resolvePlanPath']
  >;

  constructor(options: DiscordResearchPlanStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
    this.loadPlan = options.loadPlan ?? loadResearchPlan;
    this.resolvePlanPath = options.resolvePlanPath ?? resolveResearchPlanPath;
  }

  inspect(planId: string): DiscordResearchPlanLookup {
    try {
      const path = this.resolvePlanPath(planId, this.env, this.cwd);
      const plan = this.loadPlan(planId, this.env, this.cwd);
      return {
        status: 'found',
        plan,
        summary: {
          planId,
          path,
          subTaskCount: plan.subTasks.length,
          synthesisTaskId: plan.synthesis.taskId,
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        planId,
        reason: errorMessage(error),
      };
    }
  }
}
