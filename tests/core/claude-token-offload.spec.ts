import { describe, expect, it } from 'vitest';

import { createClaudeOffloadBundle } from '../../src/contracts/claude-token-offload.js';
import {
  CLAUDE_OFFLOAD_PROMPT_HEADER,
  CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION,
  CLAUDE_OFFLOAD_RESULT_SECTIONS,
  buildClaudeOffloadPrompt,
} from '../../src/core/claude-token-offload.js';

const BUNDLE_INPUT = {
  purpose: 'live-proof-triage',
  sourceRefs: [
    'specs/ARCHIVE/live-proof-matrix.md',
    'specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md',
  ],
  acceptanceChecks: [
    'no live-proof row promoted to PASS from static evidence',
    'memoryCandidates name file paths only',
  ],
  content:
    'Triage missing/weak evidence per surface; do not advance any operator-gated row.',
} as const;

describe('core/claude-token-offload prompt builder', () => {
  it('publishes the canonical result sections and schema version', () => {
    expect(CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION).toBe(1);
    expect([...CLAUDE_OFFLOAD_RESULT_SECTIONS]).toEqual([
      'status',
      'findings',
      'blockingGaps',
      'memoryCandidates',
      'residualRisk',
    ]);
  });

  it('renders a deterministic prompt with frozen forbidden-action clauses', () => {
    const bundle = createClaudeOffloadBundle(BUNDLE_INPUT);
    const prompt = buildClaudeOffloadPrompt(bundle);

    expect(prompt.purpose).toBe('live-proof-triage');
    expect(prompt.schemaVersion).toBe(CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION);
    expect(prompt.requiredResultSections).toBe(CLAUDE_OFFLOAD_RESULT_SECTIONS);

    expect(prompt.text).toContain(CLAUDE_OFFLOAD_PROMPT_HEADER.role);
    expect(prompt.text).toContain(CLAUDE_OFFLOAD_PROMPT_HEADER.authority);
    expect(prompt.text).toContain(CLAUDE_OFFLOAD_PROMPT_HEADER.toolUse);
    expect(prompt.text).toContain(CLAUDE_OFFLOAD_PROMPT_HEADER.voting);
    expect(prompt.text).toContain(CLAUDE_OFFLOAD_PROMPT_HEADER.redaction);
    expect(prompt.text).toContain(CLAUDE_OFFLOAD_PROMPT_HEADER.formatting);

    expect(prompt.text).toContain(
      'NEVER mark a row PASS — promotion requires operator-owned artifacts.',
    );
    expect(prompt.text).toContain('specs/ARCHIVE/live-proof-matrix.md');
    expect(prompt.text).toContain('memoryCandidates name file paths only');
    expect(prompt.text).toContain(
      'Triage missing/weak evidence per surface',
    );
  });

  it('renders the same output for the same input (purity)', () => {
    const bundle = createClaudeOffloadBundle(BUNDLE_INPUT);
    const a = buildClaudeOffloadPrompt(bundle);
    const b = buildClaudeOffloadPrompt(bundle);
    expect(a.text).toBe(b.text);
  });

  it('matches the pinned snapshot for live-proof-triage', () => {
    const bundle = createClaudeOffloadBundle(BUNDLE_INPUT);
    const prompt = buildClaudeOffloadPrompt(bundle);
    // Pin the exact prompt body so accidental wording changes are caught.
    expect(prompt.text).toMatchInlineSnapshot(`
"# Claude offload prompt v1

## Role

You are a read-only Claude consultation route invoked from the Codex parent.

## Authority

You are advisory-only. Codex owns all repository writes and the final completion decision.

## Tool use

Do not request tools. Do not propose edits. Do not write files.

## Voting

Do not vote. Do not promote live-proof rows from static evidence.

## Redaction

Treat all source references as paths or anchors. Do not request raw secret-bearing files (.env, credentials, raw transcripts).

## Purpose

live-proof-triage — Map missing or weak evidence per live-proof surface. NEVER mark a row PASS — promotion requires operator-owned artifacts.

## Source references (paths/anchors only)

refs:
  1. specs/ARCHIVE/live-proof-matrix.md
  2. specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md

## Acceptance checks

checks:
  1. no live-proof row promoted to PASS from static evidence
  2. memoryCandidates name file paths only

## Bundle content

Triage missing/weak evidence per surface; do not advance any operator-gated row.

## Output format

Reply with a single JSON object whose top-level keys are exactly: status, findings, blockingGaps, memoryCandidates, residualRisk.

Top-level keys (exact): status, findings, blockingGaps, memoryCandidates, residualRisk.

Each value MUST be a string or an array of strings. No nested objects.

If you cannot satisfy a section, return the literal string "N/A" for it."
`);
  });

  it('renders purpose-specific guidance for each purpose', () => {
    for (const purpose of [
      'checkpoint-synthesis',
      'live-proof-triage',
      'implementation-plan-critique',
      'memory-compaction-draft',
    ] as const) {
      const bundle = createClaudeOffloadBundle({ ...BUNDLE_INPUT, purpose });
      const prompt = buildClaudeOffloadPrompt(bundle);
      expect(prompt.text).toContain(`${purpose} —`);
    }
  });
});
