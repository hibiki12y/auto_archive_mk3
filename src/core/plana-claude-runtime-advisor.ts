/**
 * Claude-backed Plana runtime advisor.
 *
 * Calls the Claude Agent SDK with a single-shot prompt that summarizes one
 * `RuntimeEvent` and asks Claude to return a JSON verdict. Used to provide
 * a *different perspective* on dispatched task progress when the dispatched
 * task itself runs on Codex (or vice-versa) per
 * `specs/CLARIFICATIONS/multi-provider-scope.md` §Advisor 패턴.
 *
 * Hard constraints (advisor port invariants):
 *   - Single prompt per advised event. No tools, no files, no MCP.
 *   - Sampling: only `item.completed` (`error` / `agent_message` / `reasoning`
 *     types) and `approval.requested`. Other events return `'skip'`
 *     immediately without calling Claude.
 *   - Per-instance call cap. Once the cap is hit, all subsequent reviews
 *     return `'skip'` (advisor self-throttles).
 *   - Fail-open. Network errors, parse errors, unexpected response shapes
 *     all return `'approve'` so an advisor outage cannot stall dispatch.
 */

import type { AgentInstance } from '../contracts/runtime-driver.js';
import type {
  RuntimeEvent,
} from '../contracts/runtime-event.js';
import type {
  ClaudeAgentQueryFactory,
  ClaudeAgentQueryOptions,
  ClaudeAgentSDKMessage,
} from '../runtime/claude-agent-runtime-adapter.js';
import type {
  PlanaAdvisorInput,
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from './plana-runtime-advisor.js';

export const PLANA_CLAUDE_ADVISOR_PROVENANCE =
  'plana-claude-runtime-advisor' as const;

export interface PlanaClaudeRuntimeAdvisorOptions {
  readonly queryFactory: ClaudeAgentQueryFactory;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly anthropicApiKey?: string;
  readonly maxAdvisorCallsPerInstance?: number;
  /**
   * Optional logger called with the advisor's prompt and parsed verdict for
   * each consulted event. Useful for `runtime-state/plana-advisor-events.jsonl`
   * audit ledgers; out-of-scope for the in-process advisor itself.
   */
  readonly onAdvise?: (record: {
    readonly instanceId: string;
    readonly eventKind: string;
    readonly prompt: string;
    readonly responseText: string;
    readonly verdict: PlanaAdvisorVerdict;
  }) => void;
}

const DEFAULT_MAX_ADVISOR_CALLS = 5;

const ADVISED_KINDS = new Set<RuntimeEvent['kind']>([
  'item.completed',
  'item.failed',
  'approval.requested',
]);

const ADVISED_ITEM_TYPES = new Set([
  'error',
  'agent_message',
  'reasoning',
]);

interface ClaudeVerdictPayload {
  readonly verdict?: unknown;
  readonly reason?: unknown;
}

function shouldConsult(event: RuntimeEvent): boolean {
  if (!ADVISED_KINDS.has(event.kind)) return false;
  if (event.kind === 'item.completed') {
    return ADVISED_ITEM_TYPES.has((event).item.type);
  }
  if (event.kind === 'item.failed') {
    return ADVISED_ITEM_TYPES.has((event).item.type);
  }
  return true;
}

function summarizeEvent(event: RuntimeEvent): string {
  switch (event.kind) {
    case 'item.completed': {
      const e = event;
      return `event=item.completed type=${e.item.type} summary=${JSON.stringify(
        e.item.summary.slice(0, 400),
      )}`;
    }
    case 'item.failed': {
      const e = event;
      return `event=item.failed type=${e.item.type} summary=${JSON.stringify(
        e.item.summary.slice(0, 200),
      )} failure=${JSON.stringify(e.failure.message.slice(0, 200))}`;
    }
    case 'approval.requested': {
      const e = event;
      return `event=approval.requested kind=${e.request.kind} reason=${JSON.stringify(
        e.request.reason.slice(0, 200),
      )} command=${JSON.stringify(e.request.command ?? '')}`;
    }
    default:
      return `event=${event.kind}`;
  }
}

const ADVISOR_INSTRUCTION =
  'You are a strict review advisor for an autonomous research agent. ' +
  'You will receive ONE event from the agent and must decide whether to allow it to continue. ' +
  'Reply ONLY with a single-line JSON object matching one of these two shapes:\n' +
  '  {"verdict":"approve"}\n' +
  '  {"verdict":"veto","reason":"<short string>"}\n' +
  'Veto only if the event shows: hallucinated facts, unsafe shell commands, attempts to exfiltrate secrets, ' +
  'destructive operations on production data, or clear violation of the user task. ' +
  'Otherwise, approve. Do NOT call tools. Do NOT explain. JSON only.';

function buildPrompt(input: PlanaAdvisorInput): string {
  const { plan, event } = input;
  return [
    ADVISOR_INSTRUCTION,
    '',
    `task_id=${plan.taskId}`,
    `instruction=${JSON.stringify(plan.instruction.slice(0, 500))}`,
    summarizeEvent(event),
  ].join('\n');
}

function parseVerdictText(text: string): PlanaAdvisorVerdict {
  if (typeof text !== 'string' || text.length === 0) {
    return { status: 'approve' };
  }
  // F17: iterate every JSON-object substring; veto-wins fail-safe, so any
  // parseable block carrying `verdict:'veto'` triggers veto regardless of
  // ordering or sibling `verdict:'approve'` blocks.
  for (const match of text.matchAll(/\{[^}]*\}/g)) {
    let parsed: ClaudeVerdictPayload;
    try {
      parsed = JSON.parse(match[0]) as ClaudeVerdictPayload;
    } catch {
      continue;
    }
    if (parsed?.verdict === 'veto') {
      const reason =
        typeof parsed.reason === 'string' && parsed.reason.length > 0
          ? parsed.reason.slice(0, 1000)
          : 'plana-claude advisor flagged the event without a reason';
      return {
        status: 'veto',
        reason,
        provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
      };
    }
  }
  return { status: 'approve' };
}

async function collectResponseText(
  handle: AsyncIterable<ClaudeAgentSDKMessage>,
): Promise<string> {
  const parts: string[] = [];
  for await (const message of handle) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      continue;
    }
    if (message.type === 'result') {
      if (typeof message.result === 'string' && message.result.length > 0) {
        return parts.length === 0 ? message.result : parts.join('\n');
      }
      break;
    }
  }
  return parts.join('\n');
}

export class PlanaClaudeRuntimeAdvisor implements PlanaRuntimeAdvisor {
  private readonly queryFactory: ClaudeAgentQueryFactory;
  private readonly model: string | undefined;
  private readonly fallbackModel: string | undefined;
  private readonly pathToClaudeCodeExecutable: string | undefined;
  private readonly anthropicApiKey: string | undefined;
  private readonly maxAdvisorCalls: number;
  private readonly onAdvise:
    | PlanaClaudeRuntimeAdvisorOptions['onAdvise']
    | undefined;
  private readonly callCounts = new Map<string, number>();

  constructor(options: PlanaClaudeRuntimeAdvisorOptions) {
    if (typeof options.queryFactory !== 'function') {
      throw new TypeError(
        'PlanaClaudeRuntimeAdvisor requires a queryFactory.',
      );
    }
    this.queryFactory = options.queryFactory;
    this.model = options.model;
    this.fallbackModel = options.fallbackModel;
    this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
    this.anthropicApiKey = options.anthropicApiKey;
    this.maxAdvisorCalls = Math.max(
      0,
      Math.floor(options.maxAdvisorCallsPerInstance ?? DEFAULT_MAX_ADVISOR_CALLS),
    );
    this.onAdvise = options.onAdvise;
  }

  async review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict> {
    if (!shouldConsult(input.event)) {
      return { status: 'skip' };
    }
    if (!this.tryClaim(input.instance)) {
      return { status: 'skip' };
    }

    const prompt = buildPrompt(input);
    const queryOptions: ClaudeAgentQueryOptions = {
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.fallbackModel === undefined
        ? {}
        : { fallbackModel: this.fallbackModel }),
      ...(this.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }),
      ...(this.anthropicApiKey === undefined
        ? {}
        : { env: { ANTHROPIC_API_KEY: this.anthropicApiKey } }),
      permissionMode: 'bypassPermissions',
      maxTurns: 1,
      includePartialMessages: false,
    };

    let responseText: string;
    try {
      const handle = this.queryFactory({ prompt, options: queryOptions });
      responseText = await collectResponseText(handle);
    } catch {
      const fallback: PlanaAdvisorVerdict = { status: 'approve' };
      this.onAdvise?.({
        instanceId: input.instance.instanceId,
        eventKind: input.event.kind,
        prompt,
        responseText: '<advisor error>',
        verdict: fallback,
      });
      return fallback;
    }

    const verdict = parseVerdictText(responseText);
    this.onAdvise?.({
      instanceId: input.instance.instanceId,
      eventKind: input.event.kind,
      prompt,
      responseText,
      verdict,
    });
    return verdict;
  }

  private tryClaim(instance: AgentInstance): boolean {
    if (this.maxAdvisorCalls <= 0) return false;
    const used = this.callCounts.get(instance.instanceId) ?? 0;
    if (used >= this.maxAdvisorCalls) return false;
    this.callCounts.set(instance.instanceId, used + 1);
    return true;
  }
}
