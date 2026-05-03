/**
 * PR5 — `src/core/rate-throttle.ts` 단위 테스트.
 *
 * 책임 범위: provider별 inflight counter, lease reserve/release 사이클,
 * env config 파싱, isQuotaAvailable, snapshot.
 *
 * Spec: `specs/CURRENT/dispatcher-rate-throttle.md`.
 */

import { describe, expect, it } from 'vitest';

import {
  createRateThrottle,
  rateThrottleConfigFromEnv,
  type RateThrottleConfig,
} from '../src/core/rate-throttle.js';

const fixedClock = (iso: string) => (): Date => new Date(iso);

describe('rateThrottleConfigFromEnv', () => {
  it('returns -1 (unlimited) for both providers when env is empty', () => {
    const cfg = rateThrottleConfigFromEnv({});
    expect(cfg).toEqual({
      codexMaxInflight: -1,
      claudeAgentMaxInflight: -1,
    });
  });

  it('parses non-negative integers', () => {
    const cfg = rateThrottleConfigFromEnv({
      AUTO_ARCHIVE_CODEX_MAX_INFLIGHT: '3',
      AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT: '0',
    });
    expect(cfg).toEqual({ codexMaxInflight: 3, claudeAgentMaxInflight: 0 });
  });

  it('treats empty string as unset', () => {
    const cfg = rateThrottleConfigFromEnv({
      AUTO_ARCHIVE_CODEX_MAX_INFLIGHT: '',
    });
    expect(cfg.codexMaxInflight).toBe(-1);
  });

  it('rejects non-finite values as -1', () => {
    const cfg = rateThrottleConfigFromEnv({
      AUTO_ARCHIVE_CODEX_MAX_INFLIGHT: 'NaN',
      AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT: 'abc',
    });
    expect(cfg).toEqual({
      codexMaxInflight: -1,
      claudeAgentMaxInflight: -1,
    });
  });

  it('rejects negative values as -1 (unlimited fallback, not literal -2)', () => {
    const cfg = rateThrottleConfigFromEnv({
      AUTO_ARCHIVE_CODEX_MAX_INFLIGHT: '-5',
    });
    expect(cfg.codexMaxInflight).toBe(-1);
  });

  it('floors decimal inputs', () => {
    const cfg = rateThrottleConfigFromEnv({
      AUTO_ARCHIVE_CODEX_MAX_INFLIGHT: '2.9',
    });
    expect(cfg.codexMaxInflight).toBe(2);
  });
});

describe('createRateThrottle — unlimited (fail-open default)', () => {
  const cfg: RateThrottleConfig = {
    codexMaxInflight: -1,
    claudeAgentMaxInflight: -1,
  };

  it('isQuotaAvailable always true', () => {
    const t = createRateThrottle(cfg);
    expect(t.isQuotaAvailable('codex')).toBe(true);
    expect(t.isQuotaAvailable('claude-agent')).toBe(true);
  });

  it('reserve always returns a lease', () => {
    const t = createRateThrottle(cfg, {
      clock: fixedClock('2026-05-02T10:00:00.000Z'),
    });
    const lease = t.reserve('codex');
    expect(lease).toBeDefined();
    expect(lease).toEqual({
      provider: 'codex',
      leasedAt: '2026-05-02T10:00:00.000Z',
    });
  });

  it('snapshot reports utilizationPercent=0 for unlimited', () => {
    const t = createRateThrottle(cfg);
    t.reserve('codex');
    t.reserve('codex');
    const snap = t.snapshot();
    const codex = snap.find((s) => s.provider === 'codex');
    expect(codex).toBeDefined();
    expect(codex?.inflight).toBe(2);
    expect(codex?.limit).toBe(-1);
    expect(codex?.utilizationPercent).toBe(0);
  });
});

describe('createRateThrottle — bounded cap', () => {
  it('reserves up to limit, then returns undefined', () => {
    const t = createRateThrottle({
      codexMaxInflight: 2,
      claudeAgentMaxInflight: -1,
    });
    expect(t.reserve('codex')).toBeDefined();
    expect(t.reserve('codex')).toBeDefined();
    expect(t.reserve('codex')).toBeUndefined();
    expect(t.isQuotaAvailable('codex')).toBe(false);
  });

  it('release frees a slot for subsequent reserve', () => {
    const t = createRateThrottle({
      codexMaxInflight: 1,
      claudeAgentMaxInflight: -1,
    });
    const lease = t.reserve('codex');
    expect(t.reserve('codex')).toBeUndefined();
    expect(lease).toBeDefined();
    if (lease !== undefined) {
      t.release(lease);
    }
    expect(t.isQuotaAvailable('codex')).toBe(true);
    expect(t.reserve('codex')).toBeDefined();
  });

  it('per-provider isolation — codex saturation does not block claude-agent', () => {
    const t = createRateThrottle({
      codexMaxInflight: 1,
      claudeAgentMaxInflight: 1,
    });
    expect(t.reserve('codex')).toBeDefined();
    expect(t.reserve('codex')).toBeUndefined();
    // Claude Agent still has its own slot
    expect(t.isQuotaAvailable('claude-agent')).toBe(true);
    expect(t.reserve('claude-agent')).toBeDefined();
    expect(t.reserve('claude-agent')).toBeUndefined();
  });

  it('zero limit blocks all reserve calls', () => {
    const t = createRateThrottle({
      codexMaxInflight: 0,
      claudeAgentMaxInflight: -1,
    });
    expect(t.isQuotaAvailable('codex')).toBe(false);
    expect(t.reserve('codex')).toBeUndefined();
  });

  it('release on saturated counter does not go negative', () => {
    const t = createRateThrottle({
      codexMaxInflight: 2,
      claudeAgentMaxInflight: -1,
    });
    const lease = t.reserve('codex');
    expect(lease).toBeDefined();
    if (lease !== undefined) {
      t.release(lease);
      // Double release must not underflow
      t.release(lease);
    }
    const snap = t.snapshot();
    const codex = snap.find((s) => s.provider === 'codex');
    expect(codex?.inflight).toBe(0);
  });

  it('snapshot reports utilizationPercent for bounded cap', () => {
    const t = createRateThrottle({
      codexMaxInflight: 4,
      claudeAgentMaxInflight: -1,
    });
    t.reserve('codex');
    t.reserve('codex');
    t.reserve('codex');
    const snap = t.snapshot();
    const codex = snap.find((s) => s.provider === 'codex');
    expect(codex?.inflight).toBe(3);
    expect(codex?.limit).toBe(4);
    expect(codex?.utilizationPercent).toBe(75);
  });

  it('snapshot includes both providers regardless of usage', () => {
    const t = createRateThrottle({
      codexMaxInflight: 1,
      claudeAgentMaxInflight: 1,
    });
    const snap = t.snapshot();
    expect(snap.map((s) => s.provider).sort()).toEqual([
      'claude-agent',
      'codex',
    ]);
  });
});
