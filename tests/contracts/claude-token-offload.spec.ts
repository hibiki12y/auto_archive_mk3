import { describe, expect, it } from 'vitest';

import {
  CLAUDE_OFFLOAD_BUNDLE_ALLOWED_FIELDS,
  CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS,
  CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION,
  CLAUDE_OFFLOAD_PURPOSES,
  CLAUDE_OFFLOAD_REDACTION_BOUNDARY,
  ClaudeOffloadBundleError,
  createClaudeOffloadBundle,
  isClaudeOffloadBundle,
  type ClaudeOffloadBundleInput,
} from '../../src/contracts/claude-token-offload.js';

const BASE_INPUT: ClaudeOffloadBundleInput = Object.freeze({
  purpose: 'checkpoint-synthesis',
  sourceRefs: Object.freeze([
    'specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md',
    'specs/ARCHIVE/open-harness-parity-completion-audit-2026-05-05.md',
  ]) as readonly string[],
  acceptanceChecks: Object.freeze([
    'no live proof rows promoted from static evidence',
    'memory candidates name files only',
  ]) as readonly string[],
  content: 'Summarize current static parity state and remaining live-proof gates.',
});

describe('contracts/claude-token-offload', () => {
  it('publishes the canonical purposes and schema version', () => {
    expect(CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION).toBe(1);
    expect([...CLAUDE_OFFLOAD_PURPOSES]).toEqual([
      'checkpoint-synthesis',
      'live-proof-triage',
      'implementation-plan-critique',
      'memory-compaction-draft',
    ]);
    expect([...CLAUDE_OFFLOAD_BUNDLE_ALLOWED_FIELDS]).toEqual([
      'schemaVersion',
      'purpose',
      'sourceRefs',
      'acceptanceChecks',
      'redactionBoundary',
      'content',
    ]);
    expect([...CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS]).toEqual([
      'rawPrompt',
      'rawResponse',
      'rawInstruction',
      'token',
      'apiKey',
      'credential',
      'secret',
    ]);
  });

  it('builds a frozen bundle with the safe redaction boundary', () => {
    const bundle = createClaudeOffloadBundle(BASE_INPUT);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.purpose).toBe('checkpoint-synthesis');
    expect(bundle.sourceRefs).toEqual(BASE_INPUT.sourceRefs);
    expect(bundle.acceptanceChecks).toEqual(BASE_INPUT.acceptanceChecks);
    expect(bundle.redactionBoundary).toBe(CLAUDE_OFFLOAD_REDACTION_BOUNDARY);
    expect(bundle.content).toBe(BASE_INPUT.content);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.sourceRefs)).toBe(true);
    expect(Object.isFrozen(bundle.acceptanceChecks)).toBe(true);
    expect(isClaudeOffloadBundle(bundle)).toBe(true);
  });

  it('rejects input fields outside the positive allowlist', () => {
    expect(() =>
      createClaudeOffloadBundle({
        ...BASE_INPUT,
        // @ts-expect-error -- testing structural rejection
        notes: 'extra field',
      }),
    ).toThrow(ClaudeOffloadBundleError);
  });

  for (const banned of CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS) {
    it(`rejects input that nests a banned key "${banned}"`, () => {
      const malicious = {
        ...BASE_INPUT,
        // Nesting under content's sibling: tests deep banned-key check.
        acceptanceChecks: [
          ...BASE_INPUT.acceptanceChecks,
          'shape ok',
        ],
        content: BASE_INPUT.content,
      } as ClaudeOffloadBundleInput;
      // Force a banned key into the input top-level at runtime.
      const tampered = { ...malicious } as Record<string, unknown>;
      tampered[banned] = 'leaked';
      expect(() =>
        createClaudeOffloadBundle(tampered as unknown as ClaudeOffloadBundleInput),
      ).toThrow(ClaudeOffloadBundleError);
    });
  }

  it('rejects banned keys nested deep in the input object graph', () => {
    const tampered = {
      ...BASE_INPUT,
      acceptanceChecks: [
        ...BASE_INPUT.acceptanceChecks,
        'ok',
      ],
    } as Record<string, unknown>;
    tampered.nested = { deeper: { secret: 'oops' } };
    expect(() =>
      createClaudeOffloadBundle(tampered as unknown as ClaudeOffloadBundleInput),
    ).toThrow(/positive allowlist/);
  });

  it('rejects unsafe sourceRefs (raw content rather than path/anchor)', () => {
    expect(() =>
      createClaudeOffloadBundle({
        ...BASE_INPUT,
        sourceRefs: ['multi-line\nraw content'],
      }),
    ).toThrow(/safe path\/anchor/);
    expect(() =>
      createClaudeOffloadBundle({
        ...BASE_INPUT,
        sourceRefs: [],
      }),
    ).toThrow(/non-empty array/);
  });

  it('rejects oversized acceptanceChecks and content', () => {
    expect(() =>
      createClaudeOffloadBundle({
        ...BASE_INPUT,
        acceptanceChecks: ['x'.repeat(241)],
      }),
    ).toThrow(/240 chars/);
    expect(() =>
      createClaudeOffloadBundle({
        ...BASE_INPUT,
        content: 'x'.repeat(32 * 1024 + 1),
      }),
    ).toThrow(/32768 chars|exceeds/);
  });

  it('rejects unknown purposes', () => {
    expect(() =>
      createClaudeOffloadBundle({
        ...BASE_INPUT,
        // @ts-expect-error -- runtime guard
        purpose: 'final-decision',
      }),
    ).toThrow(/purpose must be one of/);
  });

  it('isClaudeOffloadBundle returns false on tampered boundary', () => {
    const bundle = createClaudeOffloadBundle(BASE_INPUT);
    const tampered = {
      ...bundle,
      redactionBoundary: { ...bundle.redactionBoundary, excludesSecrets: false },
    } as unknown;
    expect(isClaudeOffloadBundle(tampered)).toBe(false);
  });
});
