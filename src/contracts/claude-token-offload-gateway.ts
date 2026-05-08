/**
 * `ClaudeOffloadGateway` — narrow port for the Claude consultation route
 * used by the token offload orchestrator
 * (`src/core/claude-token-offload-service.ts`).
 *
 * The kernel-side service depends on this port (`import type` only) so
 * that the actual transport — the local `claude-gateway` MCP, the
 * `@anthropic-ai/claude-agent-sdk`, or a deterministic fake in tests —
 * can be swapped without leaking adapter types into `core/`.
 *
 * Implementations MUST honor the offload contract:
 *   - Read-only consultation: do not request tools, do not write files.
 *   - Single prompt per call. No streaming side effects.
 *   - Return `status: 'error'` with a structured `errorCategory` for
 *     quota / auth / model / network / timeout failures (the orchestrator
 *     normalizes these into `WARN`).
 *   - If the underlying provider asks to call tools, set
 *     `toolUseRequested: true` so the orchestrator can WARN
 *     `tool-use-degraded`.
 *
 * The port intentionally surfaces *only* the response envelope. Raw
 * prompts and raw responses are never written back to the parent: the
 * orchestrator parses the response text into the structured offload
 * sections and discards the raw text after normalization.
 */

import type {
  ClaudeOffloadErrorCategory,
  ClaudeOffloadGatewayEnvelope,
  ClaudeOffloadTokenUsage,
} from '../core/claude-token-offload-result.js';
import type { ClaudeOffloadPurpose } from './claude-token-offload.js';

export interface ClaudeOffloadGatewayRequest {
  /** Renderable prompt text built by `buildClaudeOffloadPrompt`. */
  readonly prompt: string;
  /** The bundle purpose, surfaced for telemetry/routing only. */
  readonly purpose: ClaudeOffloadPurpose;
  /**
   * Optional model preference. Implementations may ignore this and pick
   * a default. The orchestrator surfaces the actually-used model via
   * `ClaudeOffloadGatewayEnvelope.model`.
   */
  readonly modelPreference?: string;
  /**
   * Optional timeout in milliseconds. Implementations should map
   * deadline-elapsed errors to `errorCategory: 'timeout'`.
   */
  readonly timeoutMs?: number;
}

export interface ClaudeOffloadGateway {
  consult(request: ClaudeOffloadGatewayRequest): Promise<ClaudeOffloadGatewayEnvelope>;
}

export type {
  ClaudeOffloadErrorCategory,
  ClaudeOffloadGatewayEnvelope,
  ClaudeOffloadTokenUsage,
};
