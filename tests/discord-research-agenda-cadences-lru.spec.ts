/**
 * LRU bound on `DiscordResearchAgenda.cadences` (audit 2026-05-04
 * follow-up). Same audit class as PR #18 / #19 / #21 / #22.
 *
 * Cadences are NOT enumerated externally — `getCadence(conversationId)`
 * is the only public read, so eviction surfaces as the same `undefined`
 * a never-set conversation would observe (graceful degradation).
 *
 * The ledger remains the authoritative store; replay re-loads in
 * deterministic ledger order so an eviction that fired in-memory
 * during the producing process re-fires identically on restart.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DiscordResearchAgenda,
  InMemoryControlPlaneLedger,
} from '../src/index.js';

describe('DiscordResearchAgenda — cadences LRU bound', () => {
  it('within the cap, getCadence returns the most recent value per conversation', () => {
    const agenda = new DiscordResearchAgenda({ maxCadences: 3 });
    agenda.setCadence({
      cadence: 'daily',
      userId: 'u-1',
      conversationId: 'conv-a',
    });
    agenda.setCadence({
      cadence: 'weekly',
      userId: 'u-1',
      conversationId: 'conv-a',
    });
    expect(agenda.getCadence('conv-a')?.cadence).toBe('weekly');
  });

  it('evicts the oldest conversation when the cap is exceeded', () => {
    const agenda = new DiscordResearchAgenda({ maxCadences: 2 });
    agenda.setCadence({
      cadence: 'first',
      userId: 'u-1',
      conversationId: 'conv-1',
    });
    agenda.setCadence({
      cadence: 'second',
      userId: 'u-1',
      conversationId: 'conv-2',
    });
    expect(agenda.getCadence('conv-1')?.cadence).toBe('first');
    expect(agenda.getCadence('conv-2')?.cadence).toBe('second');

    agenda.setCadence({
      cadence: 'third',
      userId: 'u-1',
      conversationId: 'conv-3',
    });
    // conv-1 was the oldest — evicted. conv-2 / conv-3 remain.
    expect(agenda.getCadence('conv-1')).toBeUndefined();
    expect(agenda.getCadence('conv-2')?.cadence).toBe('second');
    expect(agenda.getCadence('conv-3')?.cadence).toBe('third');
  });

  it('re-setting an existing conversation refreshes its recency (no premature eviction)', () => {
    const agenda = new DiscordResearchAgenda({ maxCadences: 2 });
    agenda.setCadence({ cadence: 'a-1', userId: 'u', conversationId: 'A' });
    agenda.setCadence({ cadence: 'b-1', userId: 'u', conversationId: 'B' });
    // Touch A so it becomes the most-recent — B is now oldest.
    agenda.setCadence({ cadence: 'a-2', userId: 'u', conversationId: 'A' });
    // Adding C should evict B, not A.
    agenda.setCadence({ cadence: 'c-1', userId: 'u', conversationId: 'C' });
    expect(agenda.getCadence('A')?.cadence).toBe('a-2');
    expect(agenda.getCadence('B')).toBeUndefined();
    expect(agenda.getCadence('C')?.cadence).toBe('c-1');
  });

  it('emits a structured warn line on eviction from setCadence', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const agenda = new DiscordResearchAgenda({ maxCadences: 1 });
      agenda.setCadence({ cadence: 'old', userId: 'u', conversationId: 'X' });
      agenda.setCadence({ cadence: 'new', userId: 'u', conversationId: 'Y' });

      const evictionCalls = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('discord-research-agenda.cadences.evicted '),
      );
      expect(evictionCalls).toHaveLength(1);
      const payloadJson = (evictionCalls[0][0] as string).slice(
        'discord-research-agenda.cadences.evicted '.length,
      );
      const payload = JSON.parse(payloadJson) as {
        evictedConversationId: string;
        cap: number;
        replacedBy: string;
      };
      expect(payload.evictedConversationId).toBe('X');
      expect(payload.cap).toBe(1);
      expect(payload.replacedBy).toBe('Y');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('replay does NOT emit eviction warn lines (startup-time rollover is silent)', () => {
    const ledger = new InMemoryControlPlaneLedger();
    // Producer with no cap — fills the ledger with 3 distinct cadences.
    const producer = new DiscordResearchAgenda({ ledger });
    producer.setCadence({ cadence: 'p1', userId: 'u', conversationId: 'p-1' });
    producer.setCadence({ cadence: 'p2', userId: 'u', conversationId: 'p-2' });
    producer.setCadence({ cadence: 'p3', userId: 'u', conversationId: 'p-3' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Replay with a smaller cap — the cap should fire silently
      // during replay so the bootstrap log stays clean.
      const replayed = new DiscordResearchAgenda({ ledger, maxCadences: 2 });
      const evictionCalls = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('discord-research-agenda.cadences.evicted '),
      );
      expect(evictionCalls).toHaveLength(0);
      // The most-recently-replayed pair survives.
      expect(replayed.getCadence('p-1')).toBeUndefined();
      expect(replayed.getCadence('p-2')?.cadence).toBe('p2');
      expect(replayed.getCadence('p-3')?.cadence).toBe('p3');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('default cap does not fire on small workloads', () => {
    const agenda = new DiscordResearchAgenda();
    for (let i = 0; i < 50; i++) {
      agenda.setCadence({
        cadence: `c-${i}`,
        userId: 'u',
        conversationId: `conv-${i}`,
      });
    }
    expect(agenda.getCadence('conv-0')?.cadence).toBe('c-0');
    expect(agenda.getCadence('conv-49')?.cadence).toBe('c-49');
  });

  it('floors fractional cap and clamps non-positive cap to the documented minimum', () => {
    const fractional = new DiscordResearchAgenda({ maxCadences: 2.9 });
    fractional.setCadence({ cadence: 'a', userId: 'u', conversationId: 'a' });
    fractional.setCadence({ cadence: 'b', userId: 'u', conversationId: 'b' });
    fractional.setCadence({ cadence: 'c', userId: 'u', conversationId: 'c' });
    // 2.9 → 2; oldest 'a' was evicted.
    expect(fractional.getCadence('a')).toBeUndefined();
    expect(fractional.getCadence('b')?.cadence).toBe('b');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const zero = new DiscordResearchAgenda({ maxCadences: 0 });
      zero.setCadence({ cadence: 'z1', userId: 'u', conversationId: 'z1' });
      zero.setCadence({ cadence: 'z2', userId: 'u', conversationId: 'z2' });
      // 0 clamped to MIN_MAX_CADENCES=1 — z1 evicted.
      expect(zero.getCadence('z1')).toBeUndefined();
      expect(zero.getCadence('z2')?.cadence).toBe('z2');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
