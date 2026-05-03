/**
 * M10 Stage 2 — ACP prompt bridge.
 *
 * Translates one ACP `prompt` request into a stream of
 * `sessionUpdate` notifications and a final `PromptResponse`. The
 * bridge depends only on:
 *
 *   - an `AcpPromptDriver` (injected) that produces a stream of
 *     `AcpPromptStreamEvent` values for a given prompt input
 *   - the live `AgentSideConnection` (so the bridge can call
 *     `connection.sessionUpdate(...)` for each chunk)
 *
 * The Stage 2 bridge does NOT know about Dispatcher / Arona /
 * RuntimeEventStream. Stage 3 will land a concrete driver
 * (`DispatcherBackedPromptDriver`) that bridges `prompt` to
 * `dispatcher.submit(...)` and converts `RuntimeEvent` into
 * `AcpPromptStreamEvent`. By then the IDE-side permission and slash
 * surface are also wired, so the dispatcher integration lands together.
 *
 * Cancellation contract:
 *
 *   - `run` accepts an `AbortSignal`. The signal is passed straight
 *     to the driver. The bridge also checks `signal.aborted` between
 *     events so a cancel that arrives during the consumer's accept
 *     turn surfaces immediately.
 *   - On any abort path (signal already aborted, signal aborted
 *     mid-stream, `done` event with `stopReason: 'cancelled'`), the
 *     bridge returns `PromptResponse { stopReason: 'cancelled' }`
 *     WITHOUT throwing. Callers must NOT see an `AbortError` from
 *     `run`.
 *   - The bridge calls `connection.sessionUpdate(...)` with `await`
 *     so backpressure on the wire propagates to the driver.
 *
 * Failure contract:
 *
 *   - If the driver iterator throws, the bridge re-throws (caller
 *     sees the error). It does NOT translate driver errors into
 *     `stopReason` values — driver-level failures are programming
 *     errors, not user-visible turn endings.
 *   - The bridge does not retry. There is no internal queue.
 */

import type {
  AgentSideConnection,
  ContentBlock,
  PromptResponse,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';

/** What the driver receives for one prompt turn. */
export interface AcpPromptDriverInput {
  readonly sessionId: string;
  readonly cwd: string;
  /** The prompt content blocks supplied by the client. */
  readonly content: readonly ContentBlock[];
  /** Additional workspace roots advertised at session creation. */
  readonly additionalDirectories: readonly string[];
}

/**
 * A single event the driver emits while a prompt is in flight.
 * Discriminated union so the bridge can do exhaustive switch.
 */
export type AcpPromptStreamEvent =
  | {
      readonly kind: 'text-chunk';
      readonly text: string;
    }
  | {
      readonly kind: 'thought-chunk';
      readonly text: string;
    }
  | {
      readonly kind: 'tool-call-started';
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind?: ToolKind;
    }
  | {
      readonly kind: 'tool-call-update';
      readonly toolCallId: string;
      readonly status: ToolCallStatus;
      readonly content?: readonly ToolCallContent[];
    }
  | {
      readonly kind: 'done';
      readonly stopReason: StopReason;
    };

/**
 * The driver responsible for actually running a prompt. Stage 2
 * ships only the interface; Stage 3 supplies a real implementation
 * backed by the dispatcher.
 *
 * The driver MUST honor `signal` and stop emitting events promptly
 * once it aborts. The driver MAY emit a final `done` event with
 * `stopReason: 'cancelled'` after seeing the signal — the bridge
 * accepts either (signal-only or `done`-with-cancelled) as a clean
 * cancellation.
 */
export interface AcpPromptDriver {
  drive(
    input: AcpPromptDriverInput,
    signal: AbortSignal,
  ): AsyncIterable<AcpPromptStreamEvent>;
}

export interface AcpPromptBridgeOptions {
  readonly driver: AcpPromptDriver;
}

export class AcpPromptBridge {
  private readonly driver: AcpPromptDriver;

  constructor(options: AcpPromptBridgeOptions) {
    this.driver = options.driver;
  }

  /**
   * Drive one prompt turn. Streams `sessionUpdate` notifications onto
   * `connection` and resolves with a `PromptResponse`.
   */
  async run(
    connection: AgentSideConnection,
    input: AcpPromptDriverInput,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    if (signal.aborted) {
      return { stopReason: 'cancelled' };
    }

    let stopReason: StopReason = 'end_turn';
    const stream = this.driver.drive(input, signal);

    for await (const event of stream) {
      if (signal.aborted) {
        stopReason = 'cancelled';
        break;
      }
      switch (event.kind) {
        case 'text-chunk': {
          await connection.sessionUpdate({
            sessionId: input.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: event.text },
            },
          });
          break;
        }
        case 'thought-chunk': {
          await connection.sessionUpdate({
            sessionId: input.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: event.text },
            },
          });
          break;
        }
        case 'tool-call-started': {
          await connection.sessionUpdate({
            sessionId: input.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: event.toolCallId,
              title: event.title,
              status: 'pending',
              ...(event.toolKind === undefined ? {} : { kind: event.toolKind }),
            },
          });
          break;
        }
        case 'tool-call-update': {
          await connection.sessionUpdate({
            sessionId: input.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: event.toolCallId,
              status: event.status,
              ...(event.content === undefined
                ? {}
                : { content: [...event.content] }),
            },
          });
          break;
        }
        case 'done': {
          stopReason = event.stopReason;
          // Don't break out of the for-await loop — the iterator is
          // expected to terminate after `done`. We just record the
          // stopReason and let the loop naturally end on the next
          // (absent) iteration.
          break;
        }
        default: {
          // Exhaustiveness check. If a future stage adds a new event
          // kind without updating the bridge, TypeScript will fail
          // compilation here.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    }

    if (signal.aborted) {
      stopReason = 'cancelled';
    }
    return { stopReason };
  }
}
