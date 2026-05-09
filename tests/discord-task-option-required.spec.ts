import { describe, expect, it } from 'vitest';

import { renderTaskOptionRequired } from '../src/discord/discord-result-renderer.js';

// UX-20 — graceful "task_id is required" reply replaces a raw throw
// across /status, /cancel, /rerun, /archive, /unarchive, /context, and
// /focus. Pure renderer test here; the handler-side wiring assertions
// live alongside the existing per-command Discord specs and would
// regress if the throw came back (because Discord renders raw throws
// as "interaction failed" with no editReply payload).

describe('renderTaskOptionRequired (UX-20)', () => {
  it('mentions the action name in code form', () => {
    const payload = renderTaskOptionRequired('status');
    expect(payload.content).toContain('`/status`');
    expect(payload.content).toContain('requires a `task_id` option');
  });
  it('always carries the /tasks discovery hint', () => {
    const payload = renderTaskOptionRequired('cancel');
    expect(payload.content).toContain('💡 Use `/tasks`');
    // Hint guides operators to the most natural source of valid ids.
    expect(payload.content).toContain('task id');
  });
  it('handles all seven task-scoped actions interchangeably', () => {
    for (const action of [
      'status',
      'cancel',
      'rerun',
      'archive',
      'unarchive',
      'context',
      'focus',
    ]) {
      const payload = renderTaskOptionRequired(action);
      expect(payload.content).toContain(`\`/${action}\``);
      expect(payload.content).toContain('💡');
    }
  });
});
