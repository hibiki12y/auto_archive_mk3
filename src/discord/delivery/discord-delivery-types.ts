/**
 * Shared types for the Discord delivery reliability layer.
 *
 * Spec: specs/wu-disc-discord-delivery-reliability.md
 *
 * Storage: in-memory ring buffer + LRU set are the source of truth for the
 * live process. Optional pluggable persistence (JSONL DLQ at
 * `runtime-state/discord-dlq.jsonl`, append-log delivered keys at
 * `runtime-state/discord-delivered-keys.log`) provides best-effort survival
 * across orchestrator restart per spec §2.3 and §5. See
 * `discord-delivery-persistence.ts` for the file-based implementations and
 * `discord-delivery-metrics.ts` for the §2 metrics surface.
 */

import type { DiscordMessagePayload } from '../discord-result-renderer.js';

/**
 * §3 Failure Taxonomy. Mirrors the WU-H 4-axis Codex classification surface
 * for cross-surface consistency (spec §9 soft synergy).
 */
export type DiscordDeliveryFailureClass =
  | 'rate-limit'
  | 'quota-exhausted'
  | 'transient'
  | 'permanent'
  | 'circuit-open';

/**
 * §5 Idempotency Key Schema event types.
 */
export type DiscordDeliveryEventType =
  | 'ask-veto'
  | 'ask-accepted'
  | 'running-update'
  | 'terminal-result'
  | 'status-reply'
  | 'cancel-ack'
  | 'rerun-reply'
  | 'archive-reply'
  | 'unarchive-reply'
  | 'tasks-reply'
  | 'traits-reply'
  | 'agenda-reply'
  | 'history-reply'
  | 'context-reply'
  | 'escalate-reply'
  | 'feed-reply'
  | 'doctor-reply'
  | 'subagents-reply'
  | 'focus-reply'
  | 'auth-reply'
  | 'config-reply'
  | 'help-reply'
  | 'quickstart-reply'
  | 'access-denied'
  | 'approval-reply'
  | 'insights-reply'
  | 'research-plan-accepted'
  | 'research-plan-progress'
  | 'research-plan-final'
  | 'research-plan-error'
  | 'buffered-followup';

export interface DiscordDeliveryIdempotencyKeyParts {
  taskId: string;
  eventType: DiscordDeliveryEventType;
  sequence: number;
}

export function buildDiscordIdempotencyKey(
  parts: DiscordDeliveryIdempotencyKeyParts,
): string {
  return `${parts.taskId}:${parts.eventType}:${parts.sequence}`;
}

/**
 * Logical operation kinds the queue can perform on a Discord interaction.
 * Each one corresponds to a method on the interaction adapter.
 */
export type DiscordDeliveryOperation = 'editReply' | 'followUp';

export interface DiscordDeliveryRequest {
  readonly idempotencyKey: string;
  readonly operation: DiscordDeliveryOperation;
  readonly payload: DiscordMessagePayload;
  /**
   * Best-effort logical context. Used for DLQ entries and structured logs.
   */
  readonly context?: {
    readonly taskId?: string;
    readonly userId?: string;
    readonly channelId?: string;
    readonly eventType?: DiscordDeliveryEventType;
  };
}

export interface DiscordDeliverySuccess {
  readonly outcome: 'success';
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly deduped: boolean;
}

export interface DiscordDeliveryFailure {
  readonly outcome: 'dlq';
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly failureClass: DiscordDeliveryFailureClass;
  readonly lastError: {
    readonly name: string;
    readonly message: string;
    readonly status?: number;
  };
}

export type DiscordDeliveryResult =
  | DiscordDeliverySuccess
  | DiscordDeliveryFailure;

export interface DiscordDeliveryDlqEntry {
  readonly idempotencyKey: string;
  readonly operation: DiscordDeliveryOperation;
  readonly payload: DiscordMessagePayload;
  readonly context?: DiscordDeliveryRequest['context'];
  readonly attempts: number;
  readonly failureClass: DiscordDeliveryFailureClass;
  readonly lastError: {
    readonly name: string;
    readonly message: string;
    readonly status?: number;
  };
  readonly recordedAtMs: number;
}

export type DiscordCircuitState = 'closed' | 'open' | 'half-open';
