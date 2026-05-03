import { describe, expect, it } from 'vitest';

import {
  BoundaryValidationError,
  EXECUTION_CHECKPOINT_SCHEMA_VERSION,
  createExecutionCheckpoint,
  deserializeExecutionCheckpoint,
  loadExecutionCheckpoint,
} from '../../src/index.js';

describe('B-CKP execution checkpoint load seam', () => {
  it('loads a valid persisted checkpoint at the checkpoint boundary', () => {
    const persisted = JSON.parse(
      JSON.stringify(
        createExecutionCheckpoint({
          source: 'gitlab',
          repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
          revision: 'deadbeefcafebabe',
          publishedAt: '2025-01-01T00:00:00.000Z',
        }),
      ),
    ) as unknown;

    const loaded = loadExecutionCheckpoint(
      persisted,
      EXECUTION_CHECKPOINT_SCHEMA_VERSION,
    );

    expect(loaded).toEqual({
      source: 'gitlab',
      repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
      revision: 'deadbeefcafebabe',
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('deserializes a valid checkpoint JSON payload through the same load seam', () => {
    const serialized = JSON.stringify({
      source: 'local-repo',
      repositoryUrl: '/workspace/repo',
      revision: '0123456789abcdef',
      publishedAt: '2025-01-01T00:00:00.000Z',
    });

    expect(
      deserializeExecutionCheckpoint(
        serialized,
        EXECUTION_CHECKPOINT_SCHEMA_VERSION,
      ),
    ).toEqual({
      source: 'local-repo',
      repositoryUrl: '/workspace/repo',
      revision: '0123456789abcdef',
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('rejects a corrupt checkpoint payload fail-closed at load time', () => {
    let caught: unknown;
    try {
      loadExecutionCheckpoint(
        {
          source: 'gitlab',
          repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
          revision: 'deadbeefcafebabe',
          publishedAt: 'not-an-iso-timestamp',
        },
        EXECUTION_CHECKPOINT_SCHEMA_VERSION,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoundaryValidationError);
    expect((caught as BoundaryValidationError).boundary).toBe('B-CKP');
    expect((caught as BoundaryValidationError).message).toContain(
      'executionCheckpoint.publishedAt must be a valid ISO 8601 string.',
    );
  });

  it('rejects malformed checkpoint JSON at the deserialization boundary', () => {
    let caught: unknown;
    try {
      deserializeExecutionCheckpoint(
        '{"source":"gitlab"',
        EXECUTION_CHECKPOINT_SCHEMA_VERSION,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoundaryValidationError);
    expect((caught as BoundaryValidationError).boundary).toBe('B-CKP');
    expect((caught as BoundaryValidationError).message).toBe(
      '[B-CKP] checkpoint payload must be valid JSON.',
    );
  });

  it('rejects missing or empty checkpoint versions before attempting to load', () => {
    const persisted = {
      source: 'gitlab',
      repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
      revision: 'deadbeefcafebabe',
      publishedAt: '2025-01-01T00:00:00.000Z',
    };

    for (const version of [undefined, ''] as const) {
      let caught: unknown;
      try {
        loadExecutionCheckpoint(persisted, version as unknown as string);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BoundaryValidationError);
      expect((caught as BoundaryValidationError).boundary).toBe('B-CKP');
      expect((caught as BoundaryValidationError).message).toBe(
        '[B-CKP] checkpoint version must be a non-empty string.',
      );
    }
  });

  it('rejects unsupported checkpoint versions fail-closed at load time', () => {
    let caught: unknown;
    try {
      loadExecutionCheckpoint(
        {
          source: 'gitlab',
          repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
          revision: 'deadbeefcafebabe',
          publishedAt: '2025-01-01T00:00:00.000Z',
        },
        'execution-checkpoint/v2',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoundaryValidationError);
    expect((caught as BoundaryValidationError).boundary).toBe('B-CKP');
    expect((caught as BoundaryValidationError).message).toBe(
      '[B-CKP] unsupported execution checkpoint version: execution-checkpoint/v2',
    );
  });
});
