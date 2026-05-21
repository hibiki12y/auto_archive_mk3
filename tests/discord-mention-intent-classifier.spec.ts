import { describe, expect, it } from 'vitest';

import {
  classifyMentionTaskIntent,
  MentionChatHintState,
} from '../src/discord/discord-mention-intent-classifier.js';

// UX-26 (cycle 12) — heuristic mention classifier + per-channel
// task-confirm TTL state.

describe('classifyMentionTaskIntent', () => {
  describe('task-explicit', () => {
    it('classifies a `task:` prefix as task-explicit', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: 'task: build a vm at results/foo',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('task-explicit');
    });

    it('classifies "task로 처리해줘" / "처리해줘" as task-explicit', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: '메르센 소수 task로 처리해줘',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('task-explicit');
      expect(
        classifyMentionTaskIntent({
          instruction: '이거 처리해줘',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('task-explicit');
    });

    it('classifies the English "dispatch" keyword as task-explicit', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: 'dispatch a vm-create task',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('task-explicit');
    });
  });

  describe('task-confirm', () => {
    it('classifies a short "yes" as task-confirm WHEN there is a prior chat hint', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: 'yes',
          hasPriorChatHint: true,
        }).kind,
      ).toBe('task-confirm');
      expect(
        classifyMentionTaskIntent({
          instruction: '네 진행',
          hasPriorChatHint: true,
        }).kind,
      ).toBe('task-confirm');
    });

    it('falls back to chat-only when there is NO prior chat hint', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: 'yes',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('chat-only');
    });

    it('does NOT classify a long message as task-confirm even with prior hint', () => {
      // Long messages are not "yes" answers; they go through the
      // chat-with-task-hint path again.
      const longish = 'yes please dispatch this and run analysis with full report attached';
      const result = classifyMentionTaskIntent({
        instruction: longish,
        hasPriorChatHint: true,
      });
      expect(result.kind).not.toBe('task-confirm');
    });
  });

  describe('chat-with-task-hint', () => {
    it('classifies long messages as chat-with-task-hint', () => {
      const longMsg = 'a'.repeat(80);
      expect(
        classifyMentionTaskIntent({
          instruction: longMsg,
          hasPriorChatHint: false,
        }).kind,
      ).toBe('chat-with-task-hint');
    });

    it('classifies "compute-y" verbs (분석/조사/계산/출력/구해/찾아 etc.) as chat-with-task-hint', () => {
      for (const instruction of [
        '메르센 소수를 출력',
        '경로를 분석',
        '데이터 조사',
        '값을 계산',
        '코드를 작성',
        'analyze this commit',
        'compute the answer',
      ]) {
        const result = classifyMentionTaskIntent({
          instruction,
          hasPriorChatHint: false,
        });
        expect(result.kind, `for "${instruction}"`).toBe('chat-with-task-hint');
      }
    });
  });

  describe('chat-only', () => {
    it('classifies a short greeting as chat-only', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: '안녕',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('chat-only');
      expect(
        classifyMentionTaskIntent({
          instruction: 'hi',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('chat-only');
    });

    it('classifies an empty / whitespace instruction as chat-only', () => {
      expect(
        classifyMentionTaskIntent({
          instruction: '   ',
          hasPriorChatHint: false,
        }).kind,
      ).toBe('chat-only');
    });
  });
});

describe('MentionChatHintState', () => {
  it('records and returns an active hint within TTL', () => {
    let nowMs = 1_000_000;
    const state = new MentionChatHintState({
      ttlMs: 5_000,
      now: () => nowMs,
    });
    state.recordHint({
      channelId: 'c1',
      userId: 'u1',
      originalInstruction: 'compute mersenne primes',
    });
    nowMs += 1_000;
    const active = state.getActiveHint('c1', 'u1');
    expect(active).toBeDefined();
    expect(active!.originalInstruction).toBe('compute mersenne primes');
  });

  it('returns undefined for an expired hint', () => {
    let nowMs = 1_000_000;
    const state = new MentionChatHintState({
      ttlMs: 1_000,
      now: () => nowMs,
    });
    state.recordHint({
      channelId: 'c1',
      userId: 'u1',
      originalInstruction: 'compute',
    });
    nowMs += 2_000;
    expect(state.getActiveHint('c1', 'u1')).toBeUndefined();
  });

  it('isolates hints per (channel, user)', () => {
    const state = new MentionChatHintState({ ttlMs: 5_000 });
    state.recordHint({ channelId: 'c1', userId: 'u1', originalInstruction: 'a' });
    expect(state.getActiveHint('c1', 'u1')).toBeDefined();
    expect(state.getActiveHint('c2', 'u1')).toBeUndefined();
    expect(state.getActiveHint('c1', 'u2')).toBeUndefined();
  });

  it('consumeHint clears after read; clearHint removes by key', () => {
    const state = new MentionChatHintState({ ttlMs: 5_000 });
    state.recordHint({ channelId: 'c1', userId: 'u1', originalInstruction: 'a' });
    expect(state.consumeHint('c1', 'u1')?.originalInstruction).toBe('a');
    expect(state.getActiveHint('c1', 'u1')).toBeUndefined();

    state.recordHint({ channelId: 'c1', userId: 'u1', originalInstruction: 'b' });
    expect(state.clearHint('c1', 'u1')).toBe(true);
    expect(state.size()).toBe(0);
  });
});
