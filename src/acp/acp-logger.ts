/**
 * M10 Stage 5 — shared structured logger seam for the ACP module.
 *
 * Every diagnostic emitted by `src/acp/**` flows through an
 * `AcpLogger`. The default implementation writes one ndjson line to
 * stderr per event so the line never collides with the ACP wire on
 * stdout. Operators that want a different sink (syslog, file, OTel,
 * etc.) inject their own logger via the relevant `*Options.logger`
 * field.
 *
 * Stable label inventory (Stage 5):
 *
 *   acp-entrypoint-error                stdio main caught a connection error
 *   acp-entrypoint-fatal                main() rejected outside its try/catch
 *   acp-session-store-write-failed      JsonAcpSessionStore write threw; in-memory state still authoritative
 *   acp-session-store-read-failed       JsonAcpSessionStore read threw on a non-ENOENT condition
 *   acp-permission-denied               PermissionBridge produced a denied decision (carries `reason`)
 *   acp-slash-commands-notify-failed    available_commands_update notification threw on the wire
 *
 * Adding a new label: keep the `acp-` prefix, name the *event* (not
 * the location), and document the payload shape in the runbook
 * (`documents/host-setup-acp.md`).
 */

export type AcpLogLevel = 'info' | 'warn' | 'error';

export interface AcpLogEvent {
  readonly level: AcpLogLevel;
  /** Stable identifier; MUST start with `acp-`. */
  readonly label: string;
  /** Optional one-line human-readable message. */
  readonly message?: string;
  /** Optional structured payload — JSON-serializable. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type AcpLogger = (event: AcpLogEvent) => void;

/**
 * Default logger: one ndjson line per event written to stderr.
 * Stdout is reserved for the ACP wire — diagnostic output written
 * there would be parsed as JSON-RPC and corrupt the connection.
 *
 * Each line is `<label> {<json>}` so a `grep` against the label
 * still works even when payloads are large.
 */
export const defaultAcpLogger: AcpLogger = (event) => {
  const body: Record<string, unknown> = {
    level: event.level,
    label: event.label,
  };
  if (event.message !== undefined) body.message = event.message;
  if (event.payload !== undefined) body.payload = event.payload;
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    // Fall back to a minimal payload if the structured one is not
    // JSON-serializable (e.g. contains a BigInt or a cycle).
    serialized = JSON.stringify({
      level: event.level,
      label: event.label,
      message: event.message ?? '<unserializable payload>',
    });
  }
  process.stderr.write(`${event.label} ${serialized}\n`);
};

/**
 * Adapter — compose a child logger that prefixes every event with
 * a stable `scope` payload field. Useful in tests so log assertions
 * can identify which subsystem emitted a given event.
 */
export function withScope(parent: AcpLogger, scope: string): AcpLogger {
  return (event) =>
    parent({
      ...event,
      payload: {
        scope,
        ...(event.payload ?? {}),
      },
    });
}
