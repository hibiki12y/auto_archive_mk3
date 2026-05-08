import type {
  AgentRuntimeOptions,
  AgentRuntimeTraitRuntimeDecoratorResolver,
} from './agent-runtime.js';
import {
  createAutonomousResearchTraitRuntimeAgentOptionsFromEnv,
  type AutonomousResearchTraitRuntimeDecoratorResolverOptions,
} from './autonomous-research-trait-runtime-decorator-resolver.js';
import {
  createMethodologyTraitRuntimeAgentOptionsFromEnv,
  type MethodologyTraitRuntimeDecoratorResolverOptions,
} from './methodology-trait-runtime-decorator-resolver.js';
import type { TraitUsageTelemetryPort } from '../core/trait-usage-telemetry.js';
import { createMethodologyTraitUsageTelemetryMidCycleHooks } from './trait-usage-telemetry-runtime-hooks.js';

export type RepositoryTraitRuntimeDecoratorResolverOptions = Omit<
  MethodologyTraitRuntimeDecoratorResolverOptions &
    AutonomousResearchTraitRuntimeDecoratorResolverOptions,
  'workspaceRoot'
> & {
  readonly workspaceRoot?: string;
  readonly traitUsageTelemetry?: TraitUsageTelemetryPort;
};

export function combineTraitRuntimeDecoratorResolvers(
  resolvers: readonly AgentRuntimeTraitRuntimeDecoratorResolver[],
): AgentRuntimeTraitRuntimeDecoratorResolver {
  return async (input) => {
    const bindings = [];
    for (const resolver of resolvers) {
      bindings.push(...(await resolver(input)));
    }
    return bindings;
  };
}

export function createRepositoryTraitRuntimeAgentOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: RepositoryTraitRuntimeDecoratorResolverOptions = {},
): AgentRuntimeOptions {
  const resolvers: AgentRuntimeTraitRuntimeDecoratorResolver[] = [];
  const methodologyMidCycleHooks =
    createRepositoryMethodologyMidCycleHooks(options);
  const methodologyOptions = createMethodologyTraitRuntimeAgentOptionsFromEnv(
    env,
    methodologyMidCycleHooks === undefined
      ? options
      : { ...options, midCycleHooks: methodologyMidCycleHooks },
  );
  if (methodologyOptions.traitRuntimeDecoratorResolver !== undefined) {
    resolvers.push(methodologyOptions.traitRuntimeDecoratorResolver);
  }

  const autonomousResearchOptions =
    createAutonomousResearchTraitRuntimeAgentOptionsFromEnv(env, options);
  if (autonomousResearchOptions.traitRuntimeDecoratorResolver !== undefined) {
    resolvers.push(autonomousResearchOptions.traitRuntimeDecoratorResolver);
  }

  if (resolvers.length === 0) {
    return {};
  }
  if (resolvers.length === 1) {
    return { traitRuntimeDecoratorResolver: resolvers[0] };
  }
  return {
    traitRuntimeDecoratorResolver:
      combineTraitRuntimeDecoratorResolvers(resolvers),
  };
}

function createRepositoryMethodologyMidCycleHooks(
  options: RepositoryTraitRuntimeDecoratorResolverOptions,
): MethodologyTraitRuntimeDecoratorResolverOptions['midCycleHooks'] {
  if (options.traitUsageTelemetry === undefined) {
    return options.midCycleHooks;
  }

  return [
    ...(options.midCycleHooks ?? []),
    ...createMethodologyTraitUsageTelemetryMidCycleHooks(
      options.traitUsageTelemetry,
    ),
  ];
}
