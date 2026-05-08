/**
 * Pure deterministic prompt builder for the Claude token offload route.
 *
 * The Codex parent constructs a `ClaudeOffloadBundle`, then this helper
 * renders the bundle into a single read-only prompt. The output is a
 * fixed-shape string with frozen header clauses so snapshot tests can pin
 * the forbidden-action text. The builder does not call Claude, read
 * files, or mutate memory; it is a pure function of its input.
 *
 * Required result sections (Claude must produce these top-level keys):
 *   - status
 *   - findings
 *   - blockingGaps
 *   - memoryCandidates
 *   - residualRisk
 *
 * Forbidden actions baked into the prompt:
 *   - No tool use (advisor-only).
 *   - No vote / no decision authority.
 *   - No edits or file writes.
 *   - No promotion of live-proof rows from static evidence.
 */

import {
  CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION,
  type ClaudeOffloadBundle,
  type ClaudeOffloadPurpose,
} from '../contracts/claude-token-offload.js';

export const CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION = 1 as const;

export const CLAUDE_OFFLOAD_RESULT_SECTIONS = Object.freeze([
  'status',
  'findings',
  'blockingGaps',
  'memoryCandidates',
  'residualRisk',
] as const);

export type ClaudeOffloadResultSection =
  (typeof CLAUDE_OFFLOAD_RESULT_SECTIONS)[number];

export const CLAUDE_OFFLOAD_PROMPT_HEADER = Object.freeze({
  role: 'You are a read-only Claude consultation route invoked from the Codex parent.',
  authority:
    'You are advisory-only. Codex owns all repository writes and the final completion decision.',
  toolUse: 'Do not request tools. Do not propose edits. Do not write files.',
  voting: 'Do not vote. Do not promote live-proof rows from static evidence.',
  formatting:
    'Reply with a single JSON object whose top-level keys are exactly: status, findings, blockingGaps, memoryCandidates, residualRisk.',
  redaction:
    'Treat all source references as paths or anchors. Do not request raw secret-bearing files (.env, credentials, raw transcripts).',
} as const);

export type ClaudeOffloadPromptHeader = typeof CLAUDE_OFFLOAD_PROMPT_HEADER;

const PURPOSE_INSTRUCTIONS: Readonly<Record<ClaudeOffloadPurpose, string>> =
  Object.freeze({
    'checkpoint-synthesis':
      'Summarize the cited checkpoints. Status MUST reflect whether the active goal is complete; static parity alone is not completion.',
    'live-proof-triage':
      'Map missing or weak evidence per live-proof surface. NEVER mark a row PASS — promotion requires operator-owned artifacts.',
    'implementation-plan-critique':
      'Critique the cited plan for failure modes, missing gates, and unsupported assumptions. Reply as evidence, not as a directive.',
    'memory-compaction-draft':
      'Propose a single compact superseding capsule. Drop verbose command logs and never include secrets, raw prompts, or raw responses.',
  });

export interface ClaudeOffloadPrompt {
  readonly schemaVersion: typeof CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION;
  readonly bundleSchemaVersion: typeof CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION;
  readonly purpose: ClaudeOffloadPurpose;
  readonly text: string;
  readonly requiredResultSections: readonly ClaudeOffloadResultSection[];
}

function renderList(prefix: string, entries: readonly string[]): string {
  if (entries.length === 0) {
    return `${prefix}\n  (none)`;
  }
  return `${prefix}\n${entries
    .map((entry, index) => `  ${index + 1}. ${entry}`)
    .join('\n')}`;
}

export function buildClaudeOffloadPrompt(
  bundle: ClaudeOffloadBundle,
): ClaudeOffloadPrompt {
  const header = CLAUDE_OFFLOAD_PROMPT_HEADER;
  const purposeInstruction = PURPOSE_INSTRUCTIONS[bundle.purpose];

  const sections = [
    `# Claude offload prompt v${CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION}`,
    `## Role`,
    header.role,
    `## Authority`,
    header.authority,
    `## Tool use`,
    header.toolUse,
    `## Voting`,
    header.voting,
    `## Redaction`,
    header.redaction,
    `## Purpose`,
    `${bundle.purpose} — ${purposeInstruction}`,
    `## Source references (paths/anchors only)`,
    renderList('refs:', bundle.sourceRefs),
    `## Acceptance checks`,
    renderList('checks:', bundle.acceptanceChecks),
    `## Bundle content`,
    bundle.content,
    `## Output format`,
    header.formatting,
    `Top-level keys (exact): ${CLAUDE_OFFLOAD_RESULT_SECTIONS.join(', ')}.`,
    `Each value MUST be a string or an array of strings. No nested objects.`,
    `If you cannot satisfy a section, return the literal string "N/A" for it.`,
  ];

  const text = sections.join('\n\n');

  return Object.freeze({
    schemaVersion: CLAUDE_OFFLOAD_PROMPT_SCHEMA_VERSION,
    bundleSchemaVersion: CLAUDE_OFFLOAD_BUNDLE_SCHEMA_VERSION,
    purpose: bundle.purpose,
    text,
    requiredResultSections: CLAUDE_OFFLOAD_RESULT_SECTIONS,
  });
}
