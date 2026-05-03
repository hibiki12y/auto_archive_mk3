/**
 * Circuit breaker for Discord delivery. §2.5.
 *
 * States:
 *   - closed     : normal operation
 *   - open       : fast-fail; new sends route directly to DLQ
 *   - half-open  : a single probe is admitted to test recovery
 *
 * Trip condition (simplified per work-order: in-memory only):
 *   - >= consecutiveFailureThreshold consecutive failures while closed
 *
 * Recovery:
 *   - After cooldownMs in OPEN, the next acquire() flips to HALF_OPEN and
 *     admits exactly one probe. Success closes the circuit; failure re-opens
 *     with doubled cooldown (capped at maxCooldownMs).
 */

import type { DiscordCircuitState } from './discord-delivery-types.js';

export interface DiscordCircuitBreakerOptions {
  readonly consecutiveFailureThreshold?: number;
  readonly cooldownMs?: number;
  readonly maxCooldownMs?: number;
  readonly now?: () => number;
}

export type DiscordCircuitAcquireOutcome =
  | { readonly admit: true; readonly probe: boolean }
  | { readonly admit: false; readonly reason: 'circuit-open' };

const DEFAULTS = {
  consecutiveFailureThreshold: 10,
  cooldownMs: 30_000,
  maxCooldownMs: 5 * 60_000,
};

export class DiscordCircuitBreaker {
  private state: DiscordCircuitState = 'closed';
  private consecutiveFailures = 0;
  private currentCooldownMs: number;
  private openedAtMs = 0;
  private probeInFlight = false;

  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(options: DiscordCircuitBreakerOptions = {}) {
    this.threshold =
      options.consecutiveFailureThreshold ?? DEFAULTS.consecutiveFailureThreshold;
    this.baseCooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
    this.maxCooldownMs = options.maxCooldownMs ?? DEFAULTS.maxCooldownMs;
    this.currentCooldownMs = this.baseCooldownMs;
    this.now = options.now ?? Date.now;
  }

  getState(): DiscordCircuitState {
    return this.state;
  }

  /**
   * Decide whether to admit the next send. Mutates internal state when
   * transitioning open → half-open after cooldown.
   */
  acquire(): DiscordCircuitAcquireOutcome {
    if (this.state === 'closed') {
      return { admit: true, probe: false };
    }
    if (this.state === 'half-open') {
      if (this.probeInFlight) {
        return { admit: false, reason: 'circuit-open' };
      }
      this.probeInFlight = true;
      return { admit: true, probe: true };
    }
    // open: check if cooldown has elapsed
    if (this.now() - this.openedAtMs >= this.currentCooldownMs) {
      this.state = 'half-open';
      this.probeInFlight = true;
      return { admit: true, probe: true };
    }
    return { admit: false, reason: 'circuit-open' };
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.probeInFlight = false;
      this.currentCooldownMs = this.baseCooldownMs;
      return;
    }
    if (this.state === 'open') {
      // Defensive: should not happen — open never admits non-probe sends.
      this.state = 'closed';
      this.currentCooldownMs = this.baseCooldownMs;
    }
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      this.probeInFlight = false;
      this.openedAtMs = this.now();
      this.currentCooldownMs = Math.min(
        this.currentCooldownMs * 2,
        this.maxCooldownMs,
      );
      this.state = 'open';
      return;
    }
    if (this.state === 'open') {
      // Already open; nothing further to do.
      return;
    }
    // closed
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
      this.openedAtMs = this.now();
      this.currentCooldownMs = this.baseCooldownMs;
    }
  }

  /** Test/observability hook — current cooldown window. */
  currentCooldown(): number {
    return this.currentCooldownMs;
  }
}
