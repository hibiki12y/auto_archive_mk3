import {
  BoundaryValidationError,
  formatPath,
  requireObject,
  requireString,
  validateCheckpointLoad,
} from './boundary-validators.js';

export type ExecutionCheckpointSource = 'gitlab' | 'local-repo';

export const EXECUTION_CHECKPOINT_SOURCES = [
  'gitlab',
  'local-repo',
] as const satisfies readonly ExecutionCheckpointSource[];

export const EXECUTION_CHECKPOINT_SCHEMA_VERSION = 'execution-checkpoint/v1';

export interface ExecutionCheckpoint {
  source: ExecutionCheckpointSource;
  repositoryUrl: string;
  revision: string;
  publishedAt: string;
}

function assertExecutionCheckpointSource(
  value: unknown,
): asserts value is ExecutionCheckpointSource {
  if (
    typeof value !== 'string' ||
    !EXECUTION_CHECKPOINT_SOURCES.includes(value as ExecutionCheckpointSource)
  ) {
    throw new Error(
      `executionCheckpoint.source must be one of: ${EXECUTION_CHECKPOINT_SOURCES.join(', ')}`,
    );
  }
}

function assertCheckpointVersion(version: string): void {
  if (version !== EXECUTION_CHECKPOINT_SCHEMA_VERSION) {
    throw new TypeError(
      `unsupported execution checkpoint version: ${version}`,
    );
  }
}

function assertMeaningfulString(
  value: unknown,
  fieldName:
    | 'executionCheckpoint.repositoryUrl'
    | 'executionCheckpoint.revision'
    | 'executionCheckpoint.publishedAt',
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a meaningful string.`);
  }
}

function requireMeaningfulCheckpointString(
  value: unknown,
  path: ReadonlyArray<string | number>,
): asserts value is string {
  requireString(value, 'B-CKP', path);
  if (value.trim().length === 0) {
    throw new BoundaryValidationError(
      'B-CKP',
      `${formatPath(path)} must be a meaningful string.`,
    );
  }
}

function assertLoadableExecutionCheckpoint(
  raw: unknown,
  version: string,
): asserts raw is ExecutionCheckpoint {
  assertCheckpointVersion(version);
  requireObject(raw, 'B-CKP', ['executionCheckpoint']);

  const checkpoint = raw;
  requireString(
    checkpoint.source,
    'B-CKP',
    ['executionCheckpoint', 'source'],
  );
  if (
    !EXECUTION_CHECKPOINT_SOURCES.includes(
      checkpoint.source as ExecutionCheckpointSource,
    )
  ) {
    throw new BoundaryValidationError(
      'B-CKP',
      `executionCheckpoint.source must be one of: ${EXECUTION_CHECKPOINT_SOURCES.join(', ')}`,
    );
  }
  requireMeaningfulCheckpointString(checkpoint.repositoryUrl, [
    'executionCheckpoint',
    'repositoryUrl',
  ]);
  requireMeaningfulCheckpointString(checkpoint.revision, [
    'executionCheckpoint',
    'revision',
  ]);
  requireMeaningfulCheckpointString(checkpoint.publishedAt, [
    'executionCheckpoint',
    'publishedAt',
  ]);

  if (Number.isNaN(Date.parse(checkpoint.publishedAt))) {
    throw new BoundaryValidationError(
      'B-CKP',
      'executionCheckpoint.publishedAt must be a valid ISO 8601 string.',
    );
  }
}

export function createExecutionCheckpoint(
  input: ExecutionCheckpoint,
): ExecutionCheckpoint {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('executionCheckpoint must be an object.');
  }

  assertExecutionCheckpointSource(input.source);
  assertMeaningfulString(
    input.repositoryUrl,
    'executionCheckpoint.repositoryUrl',
  );
  assertMeaningfulString(input.revision, 'executionCheckpoint.revision');
  assertMeaningfulString(input.publishedAt, 'executionCheckpoint.publishedAt');

  if (Number.isNaN(Date.parse(input.publishedAt))) {
    throw new Error(
      'executionCheckpoint.publishedAt must be a valid ISO 8601 string.',
    );
  }

  return Object.freeze({
    source: input.source,
    repositoryUrl: input.repositoryUrl,
    revision: input.revision,
    publishedAt: input.publishedAt,
  });
}

export function cloneExecutionCheckpoint(
  checkpoint: ExecutionCheckpoint,
): ExecutionCheckpoint {
  return createExecutionCheckpoint(checkpoint);
}

export function loadExecutionCheckpoint(
  raw: unknown,
  version: string,
): ExecutionCheckpoint {
  const checkpoint = validateCheckpointLoad<ExecutionCheckpoint>(
    raw,
    (candidate) => assertLoadableExecutionCheckpoint(candidate, version),
    version,
  );
  return createExecutionCheckpoint(checkpoint);
}

export function deserializeExecutionCheckpoint(
  serialized: string,
  version: string,
): ExecutionCheckpoint {
  if (typeof serialized !== 'string') {
    throw new BoundaryValidationError(
      'B-CKP',
      'checkpoint payload must be a JSON string.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new BoundaryValidationError(
      'B-CKP',
      'checkpoint payload must be valid JSON.',
      error,
    );
  }

  return loadExecutionCheckpoint(raw, version);
}
