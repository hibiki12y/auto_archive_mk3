# CODE_STANDARDS.md  
## Auto Archive TypeScript Rewrite — Final Authoritative Standard

**Status**: APPROVED  
**Effective Date**: 2026-02-25  
**Runtime Baseline**: Node.js 22 LTS (`>=22.12.0 <23`)  
**Language Baseline**: TypeScript strict mode  
**Architecture Baseline**: Hexagonal Core + Microkernel Plugin Layer

---

## 1. Architecture Overview

Auto Archive uses a **Hexagonal Architecture** for core business logic and a **Microkernel Plugin Layer** for skills/connectors because this combination gives strict boundary control, testable use-case orchestration, and controlled runtime extensibility. The domain and application core remain stable and framework-agnostic, while skill and connector modules evolve independently behind typed ports, Zod schemas, Result-based error channels, and lifecycle contracts.

### Architecture Diagram (ASCII)

```text
                           ┌────────────────────────────────────┐
                           │           Entry Points             │
                           │  Discord Gateway / CLI / Scheduler │
                           └─────────────────┬──────────────────┘
                                             │
                                             ▼
                 ┌──────────────────────────────────────────────┐
                 │              Application Layer               │
                 │  Use Cases + Command Mediator + Orchestration│
                 └───────────────┬──────────────────────────────┘
                                 │ (inbound/outbound ports)
        ┌────────────────────────┼──────────────────────────┐
        ▼                        ▼                          ▼
┌────────────────┐      ┌────────────────────┐      ┌────────────────────┐
│  Domain Core   │◀────▶│ Typed Domain Events │◀────▶│ Microkernel Runtime │
│ Entities/Rules │      │    (PubSub Bus)     │      │ Skills/Connectors   │
└────────────────┘      └────────────────────┘      └─────────┬──────────┘
                                                               │
                                                               ▼
                                   ┌─────────────────────────────────────────┐
                                   │      Infrastructure Adapters            │
                                   │ OpenAI / PostgreSQL / Discord / MCP     │
                                   └─────────────────────────────────────────┘
```

### Layer Dependency Rules

1. `domain` MUST depend on nothing except `shared` pure utilities/types.
2. `application` MAY depend on `domain`, `ports`, `shared`, `errors`.
3. `ports` MUST define contracts only; no adapter logic.
4. `infrastructure` MAY depend on `ports`, `domain` types, `config`, `errors`.
5. `composition_root` is the **only** place where concrete classes are instantiated and wired.
6. `skills` and `connectors` MUST interact with core only through declared ports/contracts.
7. Upward dependency is forbidden (e.g., `domain` importing `infrastructure` is invalid).

---

## 2. Project Structure

### Canonical Directory Tree (Complete)

```text
./ (project root)
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── tsconfig.build.json
├── eslint.config.mjs
├── prettier.config.cjs
├── vitest.config.ts
├── pact.config.ts
├── .editorconfig
├── .npmrc
├── .gitignore
├── .env.example
├── Dockerfile
├── docker-compose.test.yml
├── README.md
├── CODE_STANDARDS.md
├── docs/
│   ├── architecture/
│   │   ├── decisions.md
│   │   ├── ports.md
│   │   └── event-catalog.md
│   ├── runbooks/
│   │   ├── operations.md
│   │   ├── incident-response.md
│   │   └── dependency-upgrades.md
│   └── adr/
│       └── .gitkeep
├── scripts/
│   ├── validate-env.ts
│   ├── check-boundaries.ts
│   ├── smoke-test.ts
│   └── release-check.ts
├── src/
│   ├── index.ts
│   ├── composition_root/
│   │   ├── bootstrap.ts
│   │   ├── lifecycle.ts
│   │   ├── providers.ts
│   │   └── index.ts
│   ├── config/
│   │   ├── env.schema.ts
│   │   ├── config.ts
│   │   ├── feature-flags.ts
│   │   └── index.ts
│   ├── errors/
│   │   ├── error-codes.ts
│   │   ├── app-error.ts
│   │   ├── boundary-mappers.ts
│   │   └── index.ts
│   ├── shared/
│   │   ├── brand.ts
│   │   ├── result.ts
│   │   ├── logger.ts
│   │   ├── time.ts
│   │   ├── ids.ts
│   │   └── index.ts
│   ├── domain/
│   │   ├── entities/
│   │   │   ├── task.ts
│   │   │   ├── skill.ts
│   │   │   ├── connector.ts
│   │   │   └── archive.ts
│   │   ├── value-objects/
│   │   │   ├── ids.ts
│   │   │   ├── budget.ts
│   │   │   └── state.ts
│   │   ├── events/
│   │   │   ├── domain-event.ts
│   │   │   ├── event-names.ts
│   │   │   └── payloads.ts
│   │   ├── services/
│   │   │   ├── orchestration-policy.ts
│   │   │   └── validation-policy.ts
│   │   └── index.ts
│   ├── ports/
│   │   ├── inbound/
│   │   │   ├── command-bus.port.ts
│   │   │   ├── event-bus.port.ts
│   │   │   ├── archive-service.port.ts
│   │   │   └── index.ts
│   │   ├── outbound/
│   │   │   ├── llm-client.port.ts
│   │   │   ├── db-client.port.ts
│   │   │   ├── skill-registry.port.ts
│   │   │   ├── connector-registry.port.ts
│   │   │   ├── discord-gateway.port.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── application/
│   │   ├── mediator/
│   │   │   ├── mediator.ts
│   │   │   ├── command-map.ts
│   │   │   └── index.ts
│   │   ├── commands/
│   │   │   ├── archive-thread.command.ts
│   │   │   ├── register-skill.command.ts
│   │   │   ├── register-connector.command.ts
│   │   │   └── index.ts
│   │   ├── handlers/
│   │   │   ├── archive-thread.handler.ts
│   │   │   ├── register-skill.handler.ts
│   │   │   ├── register-connector.handler.ts
│   │   │   └── index.ts
│   │   ├── use-cases/
│   │   │   ├── run-supervisor.use-case.ts
│   │   │   ├── load-skill.use-case.ts
│   │   │   ├── connect-adapter.use-case.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── microkernel/
│   │   ├── skills/
│   │   │   ├── skill-module.ts
│   │   │   ├── skill-loader.ts
│   │   │   ├── composition.ts
│   │   │   ├── registry.ts
│   │   │   ├── manifests/
│   │   │   │   └── .gitkeep
│   │   │   └── modules/
│   │   │       ├── researcher/
│   │   │       │   ├── v1.ts
│   │   │       │   ├── input.schema.ts
│   │   │       │   ├── output.schema.ts
│   │   │       │   └── index.ts
│   │   │       ├── analyst/
│   │   │       │   ├── v1.ts
│   │   │       │   ├── input.schema.ts
│   │   │       │   ├── output.schema.ts
│   │   │       │   └── index.ts
│   │   │       └── synthesizer/
│   │   │           ├── v1.ts
│   │   │           ├── input.schema.ts
│   │   │           ├── output.schema.ts
│   │   │           └── index.ts
│   │   ├── connectors/
│   │   │   ├── connector-module.ts
│   │   │   ├── connector-manager.ts
│   │   │   ├── capabilities.ts
│   │   │   ├── lifecycle.ts
│   │   │   └── modules/
│   │   │       ├── openai/
│   │   │       │   ├── v1.ts
│   │   │       │   └── index.ts
│   │   │       ├── postgres/
│   │   │       │   ├── v1.ts
│   │   │       │   └── index.ts
│   │   │       └── discord/
│   │   │           ├── v1.ts
│   │   │           └── index.ts
│   │   └── index.ts
│   └── infrastructure/
│       ├── providers/
│       │   ├── openai/
│       │   │   ├── openai-client.adapter.ts
│       │   │   └── index.ts
│       │   ├── postgres/
│       │   │   ├── pg-pool.adapter.ts
│       │   │   ├── repositories/
│       │   │   │   ├── task.repository.ts
│       │   │   │   ├── skill.repository.ts
│       │   │   │   └── connector.repository.ts
│       │   │   └── index.ts
│       │   ├── discord/
│       │   │   ├── discord-client.adapter.ts
│       │   │   └── index.ts
│       │   └── index.ts
│       ├── events/
│       │   ├── in-memory-event-bus.adapter.ts
│       │   └── index.ts
│       └── index.ts
├── tests/
│   ├── unit/
│   │   ├── domain/
│   │   │   └── .gitkeep
│   │   ├── application/
│   │   │   └── .gitkeep
│   │   └── microkernel/
│   │       └── .gitkeep
│   ├── integration/
│   │   ├── postgres.integration.spec.ts
│   │   ├── discord.integration.spec.ts
│   │   └── openai.integration.spec.ts
│   ├── contract/
│   │   ├── openai.contract.spec.ts
│   │   ├── discord.contract.spec.ts
│   │   └── pact/
│   │       └── .gitkeep
│   ├── property/
│   │   ├── result.property.spec.ts
│   │   └── state-machine.property.spec.ts
│   ├── fixtures/
│   │   ├── skills/
│   │   │   └── .gitkeep
│   │   └── payloads/
│   │       └── .gitkeep
│   └── setup/
│       ├── global-setup.ts
│       ├── global-teardown.ts
│       └── test-env.ts
└── output/
    ├── reports/
    │   └── .gitkeep
    └── coverage/
        └── .gitkeep
```

### What Goes Where and Why

- `domain`: pure invariants and business rules, no framework/runtime SDK imports.
- `application`: orchestration use-cases and command handling.
- `ports`: stable contracts between core and adapters.
- `infrastructure`: all external SDK/database/network implementations.
- `microkernel`: dynamic skill/connector loading, composition, lifecycle.
- `composition_root`: wiring only, no business logic.
- `tests`: split by test type (`unit`, `integration`, `contract`, `property`).
- `docs/adr`: architecture decisions and changes only.

### Required Module Build Priority (Implementation Sequence)

`composition_root → config → errors → types(shared/domain value objects) → dispatch(application mediator) → agent_registry(microkernel registry) → skill_loader → providers(infrastructure adapters) → supervisor(use-case orchestration) → discord_bot(adapter entrypoint)`

---

## 3. TypeScript Configuration

### `tsconfig.json` (Authoritative)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": false,
    "esModuleInterop": false,
    "skipLibCheck": false,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"],
  "exclude": ["dist", "coverage", "node_modules"]
}
```

### ESLint Flat Config (Key Rules)

```ts
import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'output/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      'import/no-default-export': 'error',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'always',
          groups: [['builtin', 'external'], ['internal'], ['parent', 'sibling', 'index']]
        }
      ],
      'unused-imports/no-unused-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }]
    }
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
);
```

### Prettier Config

```js
module.exports = {
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf'
};
```

---

## 4. Naming Conventions

| Category | Convention | Example |
|---|---|---|
| Files | `kebab-case` + semantic suffix | `archive-thread.handler.ts` |
| Directories | `kebab-case` | `composition_root` is the only snake_case exception |
| Types / Classes / Enums | `PascalCase` | `SkillModule`, `ConnectorState` |
| Interfaces | `PascalCase`, no `I` prefix | `CommandHandler` |
| Variables / Functions | `camelCase` | `loadSkillModule()` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_DISPATCH_RETRIES` |
| Env vars | `AUTO_ARCHIVE_*` | `AUTO_ARCHIVE_OPENAI_API_KEY` |
| Tests | `<unit>.spec.ts` variants by level | `skill-loader.integration.spec.ts` |
| Skill IDs | dot-separated + version suffix | `skill.researcher.summarize.v1` |
| Connector IDs | dot-separated + domain | `connector.openai.primary.v1` |
| Domain events | `<context>.<aggregate>.<past-tense>.v<major>` | `archive.task.created.v1` |
| Commands | `<verb>-<noun>.command.ts` | `register-skill.command.ts` |

---

## 5. Module Organization

### Layer Responsibilities

- `domain`: entities, value objects, domain events, pure policies.
- `application`: command mediator, use-cases, orchestration policies.
- `ports`: interfaces for inbound/outbound dependencies.
- `infrastructure`: adapter implementations.
- `microkernel`: plugin contracts and runtime extension engine.

### Import Rules (Hard Restrictions)

| From → To | Allowed |
|---|---|
| `domain` → `shared` | ✅ |
| `domain` → `application/ports/infrastructure` | ❌ |
| `application` → `domain/ports/shared/errors` | ✅ |
| `application` → `infrastructure` | ❌ |
| `ports` → `domain/shared` types only | ✅ |
| `infrastructure` → `ports/domain/shared/errors/config` | ✅ |
| `microkernel` → `ports/domain/shared/errors` | ✅ |
| `composition_root` → all | ✅ |

### Barrel Export Policy

1. `index.ts` barrels are allowed only at module boundaries.
2. No `export *` in boundary barrels; use explicit named exports.
3. Internal folders MUST import concrete paths, not parent barrel, to avoid circular dependencies.
4. Cross-layer imports through barrel are forbidden if they bypass rules.

---

## 6. Type System Patterns

### Discriminated Unions for State Machines

```ts
export type TaskState =
  | { readonly kind: 'queued'; readonly queuedAt: Date }
  | { readonly kind: 'running'; readonly startedAt: Date; readonly attempt: number }
  | { readonly kind: 'succeeded'; readonly finishedAt: Date; readonly outputRef: string }
  | { readonly kind: 'failed'; readonly finishedAt: Date; readonly reason: string }
  | { readonly kind: 'dead_letter'; readonly finishedAt: Date; readonly retryGeneration: number }
  | { readonly kind: 'suspended'; readonly suspendedAt: Date; readonly checkpoint: string; readonly resumeAfter?: Date };

export const assertNever = (value: never): never => {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
};

export const isTerminal = (state: TaskState): boolean => {
  switch (state.kind) {
    case 'queued':
    case 'running':
    case 'suspended':
      return false;
    case 'succeeded':
    case 'failed':
    case 'dead_letter':
      return true;
    default:
      return assertNever(state);
  }
};
```

> **Inspired by LangGraph**: Long-running LLM tasks may need to survive process restarts
> or pause for human-in-the-loop review. The `suspended` state stores a checkpoint reference
> for resumption. See: LangGraph durable runtime pattern.

### Branded Types for IDs

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TaskId = Brand<string, 'TaskId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type ConnectorId = Brand<string, 'ConnectorId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

export const toTaskId = (value: string): TaskId => value as TaskId;
export const toSkillId = (value: string): SkillId => value as SkillId;
export const toConnectorId = (value: string): ConnectorId => value as ConnectorId;
export const toCorrelationId = (value: string): CorrelationId => value as CorrelationId;
```

### `Result<T, E>` Canonical Implementation

```ts
// §6: Result<T, E> — use `neverthrow` library (v8+)
import { ok, err, Result, ResultAsync } from 'neverthrow';

export type { Result, ResultAsync } from 'neverthrow';

export interface AppError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

// Re-export neverthrow constructors for convenience
export { ok, err, okAsync, errAsync, fromPromise, fromThrowable } from 'neverthrow';

// Usage examples:
// Synchronous: ok(value) / err({ code: 'X', message: 'Y', retryable: false })
// Async: okAsync(value) / errAsync(error) / fromPromise(promise, mapError)
// Chaining: result.map(fn).andThen(fn).mapErr(fn).match({ ok: fn, err: fn })
```

**Why neverthrow over custom**: Battle-tested library with `ResultAsync` for async chaining,
`fromPromise`/`fromThrowable` boundary converters, and `.match()` pattern matching.
Chosen over Effect-TS (excessive paradigm shift) and custom implementation (lacks combinators).
See: https://github.com/supermacro/neverthrow

### Zod Schema Patterns

```ts
import { z } from 'zod';

export const SkillInputSchema = z
  .object({
    taskId: z.string().uuid(),
    objective: z.string().min(1).max(4_000),
    context: z.record(z.string(), z.unknown()).default({}),
    maxTokens: z.number().int().positive().max(128_000)
  })
  .strict();

export type SkillInput = z.infer<typeof SkillInputSchema>;

export const parseSkillInput = (raw: unknown): SkillInput => SkillInputSchema.parse(raw);
```

Boundary rule: every external payload (`process.env`, Discord payload, OpenAI response, DB row, plugin manifest) MUST be validated by Zod before use.

### Pattern Matching: Native Switch over ts-pattern

Auto Archive uses **native `switch` + `assertNever`** for discriminated union exhaustiveness,
NOT the `ts-pattern` library.

**Rationale**:
- `ts-pattern` can cause punishing compile times for moderately complex discriminated unions.
- Native `switch` with TypeScript's `--noFallthroughCasesInSwitch` and `assertNever` default
  provides compile-time exhaustiveness checking with zero runtime overhead.
- The `assertNever` pattern is simpler, dependency-free, and universally understood.

**Banned**: `ts-pattern` is not permitted in this project.

---

## 7. SkillModule Architecture

### Complete `SkillModule` Interface

```ts
import { z } from 'zod';

import type { Result } from '../shared/result.js';

export type SkillTier = 'T1_READ' | 'T2_WRITE' | 'T3_EXECUTE';

export interface McpToolRef {
  readonly name: string;
  readonly timeoutMs: number;
  readonly retries: 0 | 1 | 2 | 3;
}

export interface SkillConstraintSet {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly allowedCapabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
  readonly timeoutMs: number;
}

export interface SkillProtocol {
  readonly mode: 'react' | 'direct' | 'deliberative';
  readonly maxTurns: number;
  readonly requiresToolCalls: boolean;
  readonly outputFormat: 'json' | 'text';
}

export interface SkillCompositionPolicy {
  readonly composable: boolean;
  readonly operators: readonly ('pipe' | 'extend' | 'merge')[];
  readonly conflictPolicy: 'left_wins' | 'right_wins' | 'error';
}

export interface SkillExecutionContext {
  readonly correlationId: string;
  readonly now: Date;
  readonly logger: { info: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

export interface ValidationRule<I, O> {
  readonly id: string;
  readonly description: string;
  validate(input: I, output: O): Result<void, { code: string; message: string; retryable: false }>;
}

export interface SkillLifecycleHooks<I, O> {
  onLoad?(ctx: SkillExecutionContext): Promise<void>;
  beforeExecute?(input: I, ctx: SkillExecutionContext): Promise<I>;
  afterExecute?(output: O, ctx: SkillExecutionContext): Promise<O>;
  onError?(error: unknown, ctx: SkillExecutionContext): Promise<void>;
  onUnload?(ctx: SkillExecutionContext): Promise<void>;
}

export interface SkillModule<I, O> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tier: SkillTier;
  readonly systemPrompt: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly tools: readonly McpToolRef[];
  readonly constraints: SkillConstraintSet;
  readonly validationRules: readonly ValidationRule<I, O>[];
  readonly protocol: SkillProtocol;
  readonly composition: SkillCompositionPolicy;
  readonly lifecycle: SkillLifecycleHooks<I, O>;
  execute(input: I, ctx: SkillExecutionContext): Promise<Result<O, { code: string; message: string; retryable: boolean }>>;
}
```

### Skill Composition Model (`pipe`, `extend`, `merge`)

```ts
import { Err, Ok, type Result } from '../shared/result.js';

import type { SkillExecutionContext, SkillModule } from './skill-module.js';

interface SkillError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export const pipeSkills = <A, B, C>(
  first: SkillModule<A, B>,
  second: SkillModule<B, C>
): SkillModule<A, C> => ({
  ...first,
  id: `${first.id}|pipe|${second.id}`,
  name: `${first.name} -> ${second.name}`,
  version: first.version,
  outputSchema: second.outputSchema,
  async execute(input: A, ctx: SkillExecutionContext): Promise<Result<C, SkillError>> {
    const firstRes = await first.execute(input, ctx);
    if (!firstRes.ok) {
      return firstRes;
    }
    return second.execute(firstRes.value, ctx);
  }
});

export const extendSkill = <I, O>(
  base: SkillModule<I, O>,
  extension: Partial<SkillModule<I, O>>
): SkillModule<I, O> => ({
  ...base,
  ...extension,
  id: extension.id ?? `${base.id}.extended`,
  composition: {
    ...base.composition,
    ...(extension.composition ?? {})
  }
});

export const mergeSkills = <I, O>(
  left: SkillModule<I, O>,
  right: SkillModule<I, O>
): Result<SkillModule<I, O>, SkillError> => {
  const duplicateRuleIds = new Set(left.validationRules.map((rule) => rule.id));
  for (const rule of right.validationRules) {
    if (duplicateRuleIds.has(rule.id)) {
      return Err({
        code: 'SKL_MERGE_RULE_CONFLICT',
        message: `Duplicate validation rule: ${rule.id}`,
        retryable: false
      });
    }
  }

  return Ok({
    ...left,
    id: `${left.id}|merge|${right.id}`,
    name: `${left.name}+${right.name}`,
    tools: [...left.tools, ...right.tools],
    validationRules: [...left.validationRules, ...right.validationRules]
  });
};
```

### Skill Loading Pipeline (Required Sequence)

1. Resolve module path: `src/microkernel/skills/modules/<skillName>/<version>.js`.
2. `import()` module dynamically.
3. Validate module shape (`default` export exists and has required fields).
   > **ESLint override**: Plugin module files (`src/microkernel/**/modules/**/*.ts`) are exempt from `import/no-default-export` per §13.4 exception.
4. Validate `inputSchema`/`outputSchema` are Zod schemas.
5. Validate SemVer compatibility and uniqueness (`id + version`).
6. Execute `lifecycle.onLoad`.
7. Register to in-memory registry and persist metadata to DB.
8. Publish event `skill.registry.updated.v1`.

### Example Skill Structure

```ts
import { z } from 'zod';

import { Ok, type Result } from '../../../shared/result.js';
import type { SkillExecutionContext, SkillModule } from '../../skills/skill-module.js';

const InputSchema = z
  .object({
    objective: z.string().min(1),
    evidence: z.array(z.string()).max(50)
  })
  .strict();

const OutputSchema = z
  .object({
    summary: z.string().min(1),
    confidence: z.number().min(0).max(1)
  })
  .strict();

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface SkillError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

const researcherV1: SkillModule<Input, Output> = {
  id: 'skill.researcher.summarize.v1',
  name: 'researcher-summarize',
  version: '1.0.0',
  tier: 'T1_READ',
  systemPrompt: 'Summarize evidence with traceable confidence.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  tools: [{ name: 'memory_search', timeoutMs: 5_000, retries: 1 }],
  constraints: {
    maxInputBytes: 256_000,
    maxOutputBytes: 64_000,
    allowedCapabilities: ['KB_READ'],
    deniedCapabilities: ['KB_WRITE_GLOBAL'],
    timeoutMs: 20_000
  },
  validationRules: [],
  protocol: {
    mode: 'direct',
    maxTurns: 1,
    requiresToolCalls: false,
    outputFormat: 'json'
  },
  composition: {
    composable: true,
    operators: ['pipe', 'extend', 'merge'],
    conflictPolicy: 'error'
  },
  lifecycle: {},
  async execute(input: Input, _ctx: SkillExecutionContext): Promise<Result<Output, SkillError>> {
    return Ok({
      summary: `${input.objective}\n\nEvidence count: ${input.evidence.length}`,
      confidence: 0.8
    });
  }
};

export default researcherV1;
```

### Plugin API Boundary (Backstage Pattern)

All skill and connector modules MUST import core types exclusively through the plugin API boundary:

```text
src/microkernel/api/
├── index.ts          ← public exports for plugin authors
├── types.ts          ← SkillModule, ConnectorModule, Result, AppError re-exports
├── context.ts        ← SkillExecutionContext, ConnectorLifecycle re-exports
└── schemas.ts        ← shared Zod utilities for plugin schemas
```

**Import rule**: Plugin modules (`src/microkernel/**/modules/`) MUST import from `../../api/index.js`, NEVER from `../../../shared/`, `../../../domain/`, or `../../../ports/`.

```ts
// ✅ Correct: import from plugin API
import { type SkillModule, type Result, ok, err } from '../../api/index.js';

// ❌ Forbidden: reaching into core internals
import { type Result } from '../../../shared/result.js';
```

This pattern (inspired by Backstage's `@backstage/plugin-api`) ensures plugins remain decoupled from core internals, enabling independent evolution of both plugin and core APIs.

---

## 8. ConnectorModule Architecture

### Complete `ConnectorModule` Interface

```ts
import { z } from 'zod';

import type { Result } from '../shared/result.js';

export type ConnectorState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'SHUTDOWN';

export interface ConnectorCapability {
  readonly name: string;
  readonly version: string;
  readonly required: boolean;
}

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxCalls: number;
  readonly rollingWindowMs: number;
}

export interface ConnectorMetricsSpec {
  readonly namespace: string;
  readonly labels: readonly string[];
}

export interface ConnectorLifecycle<TConfig, TPorts> {
  connect(config: TConfig, ports: TPorts): Promise<Result<void, { code: string; message: string; retryable: boolean }>>;
  healthCheck(): Promise<Result<{ latencyMs: number; details: Record<string, unknown> }, { code: string; message: string; retryable: boolean }>>;
  reconnect(): Promise<Result<void, { code: string; message: string; retryable: boolean }>>;
  gracefulShutdown(): Promise<Result<void, { code: string; message: string; retryable: false }>>;
}

export interface ConnectorModule<TConfig, TPorts> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly implements: readonly string[];
  readonly configSchema: z.ZodType<TConfig>;
  readonly capabilities: readonly ConnectorCapability[];
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly lifecycle: ConnectorLifecycle<TConfig, TPorts>;
  readonly metrics: ConnectorMetricsSpec;
}
```

### Connector Lifecycle Management

State transitions are strict:

- `DISCONNECTED -> CONNECTING -> CONNECTED`
- `CONNECTED -> DEGRADED` on health failure threshold.
- `DEGRADED -> CONNECTED` on successful reconnect.
- Any state -> `SHUTDOWN` on process stop.

### Port Binding Pattern

```ts
import { Err, Ok, type Result } from '../shared/result.js';

interface Ports {
  readonly dbClient: { ping: () => Promise<boolean> };
  readonly eventBus: { publish: (event: string, payload: unknown) => Promise<void> };
}

interface BindingError {
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
}

export const bindPorts = (ports: Partial<Ports>): Result<Ports, BindingError> => {
  if (!ports.dbClient || !ports.eventBus) {
    return Err({
      code: 'CON_BIND_MISSING_PORT',
      message: 'Required ports missing: dbClient/eventBus',
      retryable: false
    });
  }
  return Ok({
    dbClient: ports.dbClient,
    eventBus: ports.eventBus
  });
};
```

### Capability Negotiation

```ts
import { Err, Ok, type Result } from '../shared/result.js';

interface NegotiationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
}

export const negotiateCapabilities = (
  required: readonly string[],
  supported: readonly string[]
): Result<readonly string[], NegotiationError> => {
  const missing = required.filter((capability) => !supported.includes(capability));
  if (missing.length > 0) {
    return Err({
      code: 'CON_CAP_NEGOTIATION_FAILED',
      message: `Missing capabilities: ${missing.join(', ')}`,
      retryable: false
    });
  }
  return Ok(required);
};
```

### Unified LLM Provider Registry (Vercel AI SDK Pattern)

The application layer MUST NOT call LLM connectors directly. Instead, use a `LlmProviderRegistry` port:

```ts
export interface LlmProviderRegistry {
  readonly defaultProvider: string;
  get(providerId: string): ConnectorModule<unknown, unknown> | undefined;
  listCapabilities(): ReadonlyMap<string, readonly ConnectorCapability[]>;
  route(requiredCapabilities: readonly string[]): Result<ConnectorModule<unknown, unknown>, AppError>;
}
```

**Routing rules**:
1. Application use-cases call `registry.route(['structured-output', 'tool-use'])`.
2. Registry selects the best-matching available provider.
3. If primary provider is degraded, registry applies the fallback chain automatically.
4. Fallback chain order is configurable via `config.llmFallbackOrder`.

This prevents tight coupling between use-cases and specific LLM providers.

---

## 9. Error Handling

### Error Hierarchy

```ts
export type ErrorCategory =
  | 'config'
  | 'validation'
  | 'domain'
  | 'application'
  | 'skill'
  | 'connector'
  | 'external'
  | 'infrastructure'
  | 'security';

export abstract class AppError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly retryable: boolean;

  protected constructor(
    code: string,
    category: ErrorCategory,
    message: string,
    retryable: boolean,
    cause?: unknown
  ) {
    super(message, { cause });
    this.code = code;
    this.category = category;
    this.retryable = retryable;
  }
}
```

### Throw vs Return `Result`

| Case | Rule |
|---|---|
| Expected business failure (validation fail, policy reject, capability mismatch) | Return `Result.Err` |
| External transient failure (rate limit, timeout, network) | Return `Result.Err` with `retryable: true` |
| Programmer bug (invariant break, unreachable branch, null deref) | Throw exception |
| Startup hard failure (invalid env, missing secret) | Throw exception and terminate process |
| Boundary controllers (Discord handler, HTTP endpoint) | Catch exceptions and map to typed error response |

### Error Code Taxonomy

- `CFG_*`: configuration
- `VAL_*`: validation
- `DOM_*`: domain rule
- `APP_*`: application orchestration
- `SKL_*`: skill lifecycle/composition
- `CON_*`: connector lifecycle/capability
- `EXT_*`: third-party API
- `INF_*`: infra (DB/network/runtime)
- `SEC_*`: security/sandbox/capabilities

Examples:
- `CFG_ENV_INVALID`
- `VAL_INPUT_SCHEMA_FAILED`
- `DOM_TRANSITION_INVALID`
- `SKL_MERGE_RULE_CONFLICT`
- `CON_CAP_NEGOTIATION_FAILED`
- `EXT_OPENAI_RATE_LIMIT`
- `INF_PG_POOL_EXHAUSTED`
- `SEC_CAPABILITY_DENIED`

### Boundary Error Translation

```ts
import { Err, type Result } from '../shared/result.js';
import { AppError } from './app-error.js';

class ExternalError extends AppError {
  public constructor(code: string, message: string, retryable: boolean, cause?: unknown) {
    super(code, 'external', message, retryable, cause);
  }
}

export const mapOpenAiBoundaryError = (error: unknown): Result<never, ExternalError> => {
  if (error instanceof Error) {
    const maybeStatus = (error as { status?: number }).status;
    if (maybeStatus === 429) {
      return Err(new ExternalError('EXT_OPENAI_RATE_LIMIT', error.message, true, error));
    }
    if (maybeStatus === 408 || maybeStatus === 504) {
      return Err(new ExternalError('EXT_OPENAI_TIMEOUT', error.message, true, error));
    }
    return Err(new ExternalError('EXT_OPENAI_UNKNOWN', error.message, false, error));
  }

  return Err(new ExternalError('EXT_OPENAI_NON_ERROR_THROW', 'Unknown throw type', false, error));
};
```

---

## 10. Dependency Injection

### Composition Root Pattern (Canonical)

```ts
import OpenAI from 'openai';
import { Pool } from 'pg';

import { createMediator } from '../application/mediator/mediator.js';
import { loadConfig } from '../config/config.js';
import { createLogger } from '../shared/logger.js';

export interface AppRuntime {
  readonly mediator: ReturnType<typeof createMediator>;
  readonly shutdown: () => Promise<void>;
}

export const bootstrap = async (): Promise<AppRuntime> => {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  const pgPool = new Pool({
    connectionString: config.pgUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000
  });

  const openai = new OpenAI({
    apiKey: config.openAiApiKey,
    timeout: 30_000,
    maxRetries: 2
  });

  const mediator = createMediator({
    logger,
    pgPool,
    openai
  });

  return {
    mediator,
    shutdown: async (): Promise<void> => {
      await pgPool.end();
      logger.info('shutdown-complete');
    }
  };
};
```

### Constructor Injection Conventions

1. Inject dependencies through constructor parameters only.
2. Constructor arguments MUST be interfaces/contracts where possible.
3. A class with more than 6 dependencies requires split/refactor review.
4. No static service locator, no module-global singletons for mutable runtime services.

### Container Introduction Threshold

Use manual constructor DI by default. Introduce container only when **all** conditions hold:

1. More than **20 modules** in active runtime graph.
2. At least **3 lifetimes** are needed (`singleton`, `request/job`, `transient`).
3. Manual wiring exceeds **250 lines** in composition root.
4. New feature delivery blocked by wiring complexity in 2 consecutive iterations.

If introduced, allowed container: `awilix` only; reflection/decorator DI containers are banned.

---

## 11. Event System

### Typed Domain Events

```ts
export type DomainEvent =
  | {
      readonly type: 'archive.task.created.v1';
      readonly at: string;
      readonly payload: { taskId: string; projectId: string; source: 'discord' | 'cli' };
    }
  | {
      readonly type: 'archive.task.completed.v1';
      readonly at: string;
      readonly payload: { taskId: string; durationMs: number; qualityScore: number };
    }
  | {
      readonly type: 'skill.registry.updated.v1';
      readonly at: string;
      readonly payload: { skillId: string; version: string; action: 'added' | 'removed' | 'updated' };
    };
```

### Mediator Pattern for Commands

```ts
import type { Result } from '../../shared/result.js';

export interface Command<TName extends string, TPayload> {
  readonly name: TName;
  readonly payload: TPayload;
  readonly correlationId: string;
}

export interface CommandHandler<C extends Command<string, unknown>, R, E> {
  handle(command: C): Promise<Result<R, E>>;
}

export class Mediator {
  private readonly handlers = new Map<string, CommandHandler<Command<string, unknown>, unknown, BaseError>>();

  public register<C extends Command<string, unknown>, R, E extends BaseError>(
    commandName: C['name'],
    handler: CommandHandler<C, R, E>
  ): void {
    // Store handler with widened type — type safety ensured by register() signature
    this.handlers.set(
      commandName,
      handler as unknown as CommandHandler<Command<string, unknown>, unknown, BaseError>
    );
  }

  public async execute<R, E extends BaseError>(
    command: Command<string, unknown>
  ): Promise<Result<R, E | MediatorError>> {
    const handler = this.handlers.get(command.name);
    if (!handler) {
      return err({
        code: 'APP_COMMAND_HANDLER_NOT_FOUND',
        message: `No handler for command: ${command.name}`,
        retryable: false,
      } satisfies MediatorError);
    }
    // Runtime type safety: handler was registered with matching command name
    return handler.handle(command) as unknown as Promise<Result<R, E>>;
  }
}

interface MediatorError extends BaseError {
  readonly code: 'APP_COMMAND_HANDLER_NOT_FOUND';
}
```

> **Type assertion note**: The Mediator uses `as unknown as` casts internally due to
> TypeScript's Map erasure. This is confined to the Mediator internals. Add an ESLint
> override for `src/application/mediator/mediator.ts` to allow `assertionStyle: 'as'` in this file only.

### Event Naming Conventions

Pattern: `<context>.<aggregate>.<past-tense-action>.v<major>`

- Must be lowercase.
- Must be semantic and immutable.
- Version increments on breaking payload change.
- Example regex: `^[a-z]+\\.[a-z]+\\.[a-z]+\\.v[1-9]\\d*$`.

---

## 12. Testing Architecture

### Unit Test Conventions

- Framework: `vitest`.
- Naming: `*.spec.ts`.
- Scope: pure functions/classes with isolated dependencies.
- Mocks: explicit typed fakes over deep dynamic mocks.

### Integration Testing (Testcontainers)

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

describe('postgres adapter integration', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16.3-alpine')
      .withDatabase('auto_archive')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
  });

  afterAll(async () => {
    await container.stop();
  });

  it('connects successfully', async () => {
    expect(container.getConnectionUri()).toContain('postgresql://');
  });
});
```

### Contract Tests (Pact)

```ts
import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, it } from 'vitest';

describe('OpenAI connector contract', () => {
  it('matches provider contract', async () => {
    const provider = new PactV4({
      consumer: 'auto-archive-ts',
      provider: 'openai-connector',
      dir: 'tests/contract/pact'
    });

    provider
      .given('model is available')
      .uponReceiving('a completion request')
      .withRequest({
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: MatchersV3.regex('Bearer .+', 'Bearer token') }
      })
      .willRespondWith({
        status: 200,
        body: {
          id: MatchersV3.string('resp_123'),
          output_text: MatchersV3.string('ok')
        }
      });
  });
});
```

### Property-Based Tests (`fast-check`)

Use for:
- state transitions,
- Result combinators (`map`/`andThen`) laws,
- parser/idempotency invariants.

### Coverage Targets (Minimum)

| Module Category | Line | Branch | Function |
|---|---:|---:|---:|
| `domain` | 95% | 95% | 95% |
| `application` | 90% | 90% | 90% |
| `microkernel` | 90% | 90% | 90% |
| `ports` | 100% (type-only verification) | N/A | N/A |
| `infrastructure` | 80% | 75% | 85% |
| `config/errors/shared` | 95% | 90% | 95% |
| global threshold | 88% | 85% | 88% |

### Test Naming Conventions

- Unit: `<subject>.spec.ts`
- Integration: `<subject>.integration.spec.ts`
- Contract: `<provider>.contract.spec.ts`
- Property: `<subject>.property.spec.ts`

---

## 13. Core Dependencies

### Runtime Dependencies (Pinned Ranges)

| Package | Version Range | Rationale |
|---|---|---|
| `discord.js` | `^14.19.3` | Discord gateway/events/interactions |
| `neverthrow`  | `^8.1.1`  | Result<T, E> type-safe error handling with ResultAsync combinators |
| `openai` | `^5.1.0` | LLM API client (structured response support) |
| `pg` | `^8.13.3` | PostgreSQL driver and pooling |
| `zod` | `^3.24.2` | runtime schema validation at all boundaries |
| `pino` | `^9.7.0` | low-overhead structured logging |
| `pino-http` | `^10.5.0` | HTTP/context log binding |
| `semver` | `^7.7.1` | plugin version negotiation |

### Dev Dependencies (Pinned Ranges)

| Package | Version Range | Rationale |
|---|---|---|
| `typescript` | `^5.8.2` | strict compiler and type system |
| `tsx` | `^4.20.3` | TS runtime for scripts/dev |
| `tsup` | `^8.4.0` | fast build/bundle for deploy |
| `vitest` | `^3.2.4` | primary test framework |
| `@vitest/coverage-v8` | `^3.2.4` | coverage via V8 |
| `testcontainers` | `^10.16.0` | integration test infra |
| `@testcontainers/postgresql` | `^10.16.0` | PostgreSQL integration fixture |
| `@pact-foundation/pact` | `^13.2.1` | contract tests |
| `fast-check` | `^3.23.2` | property-based testing |
| `eslint` | `^9.21.0` | linting |
| `typescript-eslint` | `^8.25.0` | TS-aware linting |
| `eslint-plugin-import` | `^2.31.0` | import boundaries/order |
| `eslint-plugin-unused-imports` | `^4.1.4` | dead import prevention |
| `prettier` | `^3.5.3` | formatting |
| `@types/node` | `^22.13.14` | Node.js typings |

### Required `package.json` Baseline

```json
{
  "name": "auto-archive-ts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12.0 <23"
  },
  "packageManager": "pnpm@10.5.2",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --sourcemap",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "test:integration": "vitest run tests/integration",
    "test:contract": "vitest run tests/contract"
  }
}
```

### Banned Patterns

1. Service Locator pattern and global mutable singleton registry.
2. Reflection/decorator DI frameworks (`inversify`, `tsyringe`) before threshold criteria are met.
3. `any` and `@ts-ignore` without linked issue and expiry date.
4. Default exports in production modules — **exception**: microkernel plugin modules (`src/microkernel/**/modules/**/v1.ts`) use `export default` for `import()` dynamic loading.
5. Parsing LLM structured output with regex.
6. Direct `process.env` access outside `config/`.
7. Domain/application imports from SDKs (`discord.js`, `pg`, `openai`).
8. Unbounded caches/maps in long-running runtime.
9. Silent catch blocks (`catch {}`) without logging and typed mapping.
10. Wildcard barrel re-export (`export *`) at layer boundaries.

---

## 14. Risk Mitigations

### Runtime Type Safety at LLM Boundaries

- Validate every request/response with Zod.
- Reject schema-mismatched outputs with typed `VAL_*` errors.
- Enforce maximum token/result sizes before parse.
- Keep tool-call payloads in JSON mode only.

```ts
import { z } from 'zod';

const LlmResponseSchema = z
  .object({
    action: z.enum(['SEARCH', 'LOOKUP', 'DONE']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1).max(8_000)
  })
  .strict();

export const parseLlmResponse = (raw: unknown) => LlmResponseSchema.safeParse(raw);
```

### Memory Management for Long-Running Bot

- Max in-flight tasks: `1000`.
- Discord message cache lifetime: `900s`.
- DB pool max connections: `20`.
- Soft RSS guardrail: `512MB` (warn).
- Hard RSS guardrail: `768MB` (graceful restart).
- Soak test requirement: 24h with RSS growth <= `15%` and no monotonic leak trend.

### Event Loop Protection

- Track event-loop delay using `perf_hooks.monitorEventLoopDelay`.
- Warning threshold: `p95 > 20ms` for 3 consecutive minutes.
- Critical threshold: `p95 > 40ms` for 5 consecutive minutes -> degrade mode.
- CPU-heavy transforms MUST run in worker threads (`Piscina` or `worker_threads` pool).

```ts
import { monitorEventLoopDelay } from 'node:perf_hooks';

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

setInterval(() => {
  const p95Ms = histogram.percentile(95) / 1e6;
  if (p95Ms > 40) {
    // trigger degraded mode
  }
  histogram.reset();
}, 60_000).unref();
```

### Deployment Optimization

- Bundle with `tsup` (ESM, sourcemaps, declarations).
- Multi-stage Docker build with production-only dependencies.
- Health endpoints for readiness/liveness.
- Startup must complete in `< 10s` with healthy DB/Discord/OpenAI connectivity.
- Use structured JSON logs and bounded log payload size (`max 16KB/event`).

---

## 15. Implementation Principles

### HALO Principles (Project-Specific)

1. **H — Hexagonal Boundaries First**  
   Every feature starts with port contracts and domain/application separation before adapter coding.

2. **A — Assert External Data Always**  
   All boundary data must pass Zod parsing (`safeParse`/`parse`) before entering core logic.

3. **L — Limit Blast Radius**  
   Use `Result` for expected failures, circuit breakers for connector boundaries, and explicit capability controls.

4. **O — Observable by Default**  
   Every command, event, connector lifecycle change, and failure path emits structured logs with correlation IDs.

### Code Review Checklist (Mandatory)

- [ ] Layer boundaries respected (no forbidden imports).
- [ ] All external inputs validated with Zod.
- [ ] `Result` used for expected failures; throws only for invariant/programmer faults.
- [ ] Domain state transitions are exhaustive and tested.
- [ ] New error codes follow taxonomy and include retryability semantics.
- [ ] Mediator commands include correlation IDs.
- [ ] Skill/connector modules include version + schema + lifecycle hooks.
- [ ] No unbounded data structures in runtime path.
- [ ] Integration tests cover DB/Discord/OpenAI adapters.
- [ ] Contract tests updated for changed external payloads.
- [ ] Property tests added for stateful logic.
- [ ] Coverage thresholds met.
- [ ] Performance impact measured against SLOs.
- [ ] No banned patterns introduced.

### Performance Guidelines (Concrete Targets)

- Slash-command ACK latency: `p95 <= 1.5s`
- End-to-end archive completion: `p95 <= 8s`
- DB query latency: `p95 <= 50ms`, `p99 <= 120ms`
- OpenAI connector timeout: `30_000ms` hard timeout
- Event publish latency in-process: `p95 <= 5ms`
- Startup readiness: `< 10s`
- Event-loop delay: `p95 <= 20ms` steady-state
- Crash-free runtime: `>= 99.9%` over 7-day window

---

## 16. Hermes-Derived Anti-Patterns

Hermes Agent v0.12.0(`resource/hermes-agent/AGENTS.md` "Known Pitfalls" 섹션)는 운영 중 누적된 8개의 금지 패턴을 명문화한다. 이 패턴들은 OpenClaw → Hermes로 4년 이상 운영되며 실제 incident을 통해 검증된 **이식 가능한** 룰이다. auto_archive_mk3에 동일 패턴이 발생할 위험이 있어 본 표준에 흡수한다.

각 룰은 **Rule / Why / How to apply** 3-단으로 기술한다.

### 16.1 Profile-Aware Path Resolution

**Rule**: 프로세스가 사용자 환경에 쓰는 모든 상태 경로(설정, 캐시, 로그, 자격증명, 세션 DB)는 환경변수로 오버라이드 가능한 헬퍼 함수를 통해서만 해석한다. `Path.home() / ".auto-archive"`, `~/.auto-archive`, `process.env.HOME + "/.auto-archive"` 같은 직접 표현은 금지.

**Why**: Hermes는 `~/.hermes` 하드코드 5건이 동시에 발견된 PR #3575 이전까지 multi-instance(profile) 격리가 깨져 있었다. `HERMES_HOME` 환경변수가 설정되어도 모듈-레벨 상수가 import 시점에 `~/.hermes`로 굳어 있어 `_apply_profile_override()`가 무력화되었다. auto_archive_mk3가 향후 profile/multi-instance를 도입할 때 동일 incident을 미리 차단한다.

**How to apply**:
- `AUTO_ARCHIVE_HOME` 환경변수 + `getAutoArchiveHome(): string` 헬퍼를 단일 진입점으로 두고, 모든 상태 경로 해석을 그 헬퍼를 거치게 한다.
- 헬퍼는 import 시점이 아니라 호출 시점에 환경변수를 읽는다(또는 부트스트랩에서 한 번 캡처 후 freeze).
- 사용자 노출 메시지(로그, 예외, Discord 응답)는 `displayAutoArchiveHome()` 같은 별도 헬퍼로 사람이 읽을 형태(예: `~/`)로 출력한다.
- 테스트에서 `process.env.HOME`을 mock하면 반드시 `AUTO_ARCHIVE_HOME`도 함께 mock한다.

### 16.2 Prompt-Cache Invariant — No Mid-Conversation Mutation

**Rule**: 동일 세션 내에서 system prompt, 활성 toolset, 메모리 컨텐츠, prompt-cache 브레이크포인트 위치를 변경하지 않는다. 변경이 필요하면 새 session_id를 발행하고 `parent_session_id` 체인을 보존한다.

**Why**: Hermes `AGENTS.md` "Prompt Caching Must Not Break" 섹션은 캐시 깨짐이 비용 폭증으로 직결됨을 명시한다. 동일 세션에서 시스템 프롬프트가 1바이트만 바뀌어도 Anthropic prompt cache의 prefix가 모두 무효화되어 4개 cache_control 브레이크포인트가 지키던 ~75% 입력 토큰 절감이 사라진다. compaction은 *유일한 예외*이며, 그조차 새 세션을 만든다.

**How to apply**:
- `AgentRuntime` / `RuntimeDriver`는 한 세션 내에서 시스템 프롬프트를 immutable로 취급한다.
- toolset 변경/메모리 reload가 필요한 슬래시 명령은 **deferred invalidation** 기본(다음 세션부터 적용) + opt-in `--now` 플래그로 즉시 적용. Hermes의 `/skills install --now` 패턴 차용.
- compaction 이벤트 시 새 session_id 발행 + `parent_session_id` 보존. M3(prompt-cache invariant) 작업이 이 룰을 코드 레벨에서 강제한다.

### 16.3 Process-Global Save/Restore Around Child Execution

**Rule**: 모듈-레벨 또는 process-global 캐시(예: 해석된 도구 이름, TTL 캐시, 카운터)는 자식 에이전트(subagent / nested AgentRuntime / spawned worker) 실행 전후로 명시적 save/restore 패턴을 사용한다.

**Why**: Hermes `tools/delegate_tool.py:_run_single_child()`는 `_last_resolved_tool_names` global을 자식 실행 전에 capture, 자식 실행 후에 restore한다. 이를 빼먹으면 자식이 `check_fn()` 결과를 부모의 캐시에 덮어써서 부모의 다음 턴이 stale 상태가 된다. auto_archive_mk3 subagent / nested AgentRuntime에 동일 위험.

**How to apply**:
- subagent spawn 직전에 모든 모듈-레벨 캐시 값을 local 변수로 capture.
- subagent 종료 직후(성공/실패/타임아웃 모두) restore.
- `try/finally` 블록으로 예외 경로에서도 restore 보장.
- 가능하면 process-global을 피하고 explicit context object로 dependency-inject — 다만 SDK level 캐시처럼 회피 불가능한 경우 save/restore가 차선책.

### 16.4 No Cross-Tool Name Hardcoding in Tool Schemas

**Rule**: 도구 스키마의 `description` 필드에 다른 toolset의 도구 이름을 하드코드하지 않는다(예: browser 도구의 description에 "prefer web_search" 같은 문구).

**Why**: 그 도구가 비활성(API 키 미설정, toolset 비활성)인 환경에서 모델이 존재하지 않는 도구를 호출하려고 시도한다. Hermes는 `model_tools.py:get_tool_definitions()`의 후처리 블록에서 *동적으로* 가용한 다른 도구를 cross-reference로 추가하는 패턴(`browser_navigate` / `execute_code` 후처리)을 사용한다.

**How to apply**:
- 스키마 description은 그 도구 자체의 동작만 설명한다.
- 다른 도구로의 추천이 필요하면 `getToolDefinitions()` 후처리에서 가용성 체크 후 동적으로 description에 부착한다.
- 테스트: 한 toolset만 활성화한 상태에서 schema을 dump해서 하드코드된 cross-reference이 없는지 grep.

### 16.5 Squash-Merge Base Parity Check

**Rule**: PR을 squash merge하기 전에 base 브랜치가 main과 동기화되어 있는지 확인한다. 동기화되지 않은 stale base에서 squash merge하면 *무관한 파일*의 stale 버전이 main의 최근 fix를 silent하게 덮어쓴다.

**Why**: Hermes는 이 incident으로 PR 후 `git diff HEAD~1..HEAD`에서 예상치 못한 deletion이 다수 발견. squash merge가 해당 PR이 건드리지도 않은 파일을 stale state로 되돌렸다.

**How to apply**:
- merge 전 워크트리에서 `git fetch origin main && git rebase origin/main`(또는 `git reset --hard origin/main` 후 PR commits 재적용).
- merge 후 `git diff HEAD~1..HEAD`에서 PR 범위 밖 파일의 변경(특히 deletion)이 있으면 즉시 revert 후 재조사.
- CI에 base parity check 추가 검토(예: PR base가 main에서 N커밋 이상 떨어진 경우 warn).

### 16.6 No Dead Code Wire-In Without E2E Validation

**Rule**: 사용되지 않은 채로 남아 있던 모듈을 활성 코드 경로에 연결할 때, mock이 아닌 실제 import / 실제 임시 환경(`AUTO_ARCHIVE_HOME` redirect)으로 E2E 테스트한 후에만 wire한다.

**Why**: Hermes에서 dead code는 dead인 이유가 있었다. 활성화하려는 작성자는 그 이유를 모르며, 단위 테스트의 mock으로는 그 이유가 드러나지 않는다. 실제 resolution chain을 거쳐야 처음으로 실패가 나타난다.

**How to apply**:
- dead module wire-in PR의 description에 E2E 시나리오와 결과를 명시.
- 가능하면 mock 없이 실제 어댑터/실제 SDK/실제 env로 한 번은 통과시킨 다음 unit test로 정착.
- "왜 dead였는지" 5분 이상 git blame으로 조사 — 의도적으로 비활성화된 경우(보안, 호환성, 미해결 이슈) 다시 묻어둔다.

### 16.7 Tests Must Not Write to User Home

**Rule**: 테스트는 사용자 home 디렉토리(`$HOME`, `~`, `process.env.HOME`)에 어떤 파일도 쓰지 않는다. autouse fixture로 임시 디렉토리에 redirect한다.

**Why**: Hermes의 `tests/conftest.py`는 `_isolate_hermes_home` autouse fixture로 모든 테스트의 `HERMES_HOME`을 `tmp_path`로 redirect한다. 이 fixture 없이는 dev machine에서 테스트를 돌리면 실제 `~/.hermes`의 사용자 데이터가 오염되거나 삭제된다. CI는 ephemeral이라 즉시 발견 안 되지만 dev에서 사고가 누적된다.

**How to apply**:
- vitest의 `setupFiles`나 testcontainers fixture로 `AUTO_ARCHIVE_HOME`을 매 테스트마다 임시 디렉토리로 redirect.
- 추가로 `process.env.HOME`을 mock하는 테스트는 `AUTO_ARCHIVE_HOME`도 함께 set(profile 동작 정확 시뮬레이션).
- 테스트 종료 후 cleanup 자동화(테스트 프레임워크의 afterEach 또는 tmp_path autouse).

### 16.8 No Change-Detector Tests

**Rule**: 변경되도록 *설계된* 데이터(model 카탈로그, config 버전 번호, enum 카운트, provider 모델 목록)를 snapshot으로 assert하는 테스트를 작성하지 않는다. 관계(invariant, contract)를 assert한다.

**Why**: 모델 카탈로그/설정 버전 같은 데이터는 routine update가 본질이다. snapshot test는 모든 routine update에 CI 빨간불을 켜고, 엔지니어 시간이 "테스트 고치기"에 소진된다. 행동 커버리지는 0이다.

**How to apply**:
- ❌ `assert "gemini-2.5-pro" in _PROVIDER_MODELS["gemini"]` (snapshot)
- ❌ `assert DEFAULT_CONFIG["_config_version"] == 21` (literal)
- ❌ `assert len(_PROVIDER_MODELS["huggingface"]) == 8` (count)
- ✅ `assert "gemini" in _PROVIDER_MODELS && _PROVIDER_MODELS["gemini"].length >= 1` (catalog plumbing works)
- ✅ `assert raw["_config_version"] === DEFAULT_CONFIG["_config_version"]` (migration bumps to current)
- ✅ `for m in models: assert contextLengthsLowercase.has(m.toLowerCase())` (every model has context length entry)
- 룰: 테스트가 *현재 데이터의 스냅샷*처럼 읽히면 삭제. *두 데이터의 관계*에 대한 contract처럼 읽히면 유지.
- 리뷰어는 신규 change-detector 테스트를 거부하고, 작성자는 invariant 형태로 변환 후 재요청한다.

---

> 본 §16의 8개 룰은 Hermes Agent의 4년 이상 운영 incident에서 추출된 이식 가능 패턴이다. auto_archive_mk3는 v0.12.0 시점의 Hermes를 reference로 두며, 새 incident이 발견되면 본 절을 갱신한다. 출처: `documents/references/hermes-agent/` 및 `resource/hermes-agent/AGENTS.md`.

---

## Final Enforcement Notes

- This document is the **authoritative standard** for the TypeScript rewrite.
- Any deviation requires an ADR entry and explicit approval.
- If a rule conflicts with implementation convenience, the rule wins unless formally overridden.
