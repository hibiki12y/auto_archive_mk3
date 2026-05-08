import type {
  ControlPlaneEvent,
  ControlPlaneObserverPort,
} from './control-plane-ledger.js';

export const AUTO_ARCHIVE_OTEL_LOGS_URL = 'AUTO_ARCHIVE_OTEL_LOGS_URL';
export const AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES =
  'AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 2_000;
const MAX_ATTRIBUTE_LENGTH = 128;

export interface ControlPlaneOtelFetchInit {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export type ControlPlaneOtelFetch = (
  url: string,
  init: ControlPlaneOtelFetchInit,
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export type ControlPlaneOtelLogger = (
  event: string,
  details: Record<string, unknown>,
) => void;

export interface ControlPlaneOtelLogsEmitterOptions {
  readonly url: string;
  readonly resourceAttributes?: Record<string, string>;
  readonly fetch?: ControlPlaneOtelFetch;
  readonly logger?: ControlPlaneOtelLogger;
  readonly exportTimeoutMs?: number;
}

export interface ControlPlaneOtelLogsEmitterEnvOptions {
  readonly fetch?: ControlPlaneOtelFetch;
  readonly logger?: ControlPlaneOtelLogger;
}

type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number };

interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

function asStringAttribute(value: string): OtlpAnyValue {
  return { stringValue: value.slice(0, MAX_ATTRIBUTE_LENGTH) };
}

function asOtlpAttributeValue(value: unknown): OtlpAnyValue | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return asStringAttribute(value);
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return undefined;
}

function toOtlpAttributes(
  attributes: Record<string, unknown>,
): OtlpKeyValue[] {
  return Object.entries(attributes)
    .flatMap(([key, value]) => {
      const otlpValue = asOtlpAttributeValue(value);
      return otlpValue === undefined ? [] : [{ key, value: otlpValue }];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function timestampUnixNano(timestamp: string): string {
  const millis = Date.parse(timestamp);
  const finiteMillis = Number.isFinite(millis) ? millis : Date.now();
  return String(BigInt(finiteMillis) * 1_000_000n);
}

function parseResourceAttributes(rawValue: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {
    'service.name': 'auto-archive',
    'service.namespace': 'auto-archive',
  };
  if (rawValue === undefined || rawValue.trim() === '') {
    return attributes;
  }

  for (const pair of rawValue.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) {
      attributes[key] = value;
    }
  }
  return attributes;
}

function safePayloadAttributes(event: ControlPlaneEvent): Record<string, unknown> {
  return {
    'aa.control.lifecycle.phase':
      event.payload['phase'] ?? event.payload['lifecyclePhase'],
    'aa.control.lifecycle.scope': event.payload['scope'],
    'aa.control.command.name': event.payload['commandName'],
  };
}

function controlPlaneEventAttributes(
  event: ControlPlaneEvent,
): Record<string, unknown> {
  return {
    'aa.control.event.id': event.eventId,
    'aa.control.event.type': event.type,
    'aa.control.schema.version': event.schemaVersion,
    'aa.control.actor.kind': event.actor.kind,
    'aa.control.channel.kind': event.channel?.kind,
    'aa.control.task.id': event.taskId,
    'aa.control.correlation.id': event.correlationId,
    'aa.control.trust.source': event.trust.source,
    'aa.control.trust.input_trust': event.trust.inputTrust,
    ...safePayloadAttributes(event),
  };
}

function buildOtlpLogsPayload(
  event: ControlPlaneEvent,
  resourceAttributes: Record<string, string>,
): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: toOtlpAttributes(resourceAttributes),
        },
        scopeLogs: [
          {
            scope: {
              name: 'auto-archive.control-plane',
              version: String(event.schemaVersion),
            },
            logRecords: [
              {
                timeUnixNano: timestampUnixNano(event.timestamp),
                observedTimeUnixNano: timestampUnixNano(new Date().toISOString()),
                severityText: 'INFO',
                body: {
                  stringValue: `control-plane ${event.type}`,
                },
                attributes: toOtlpAttributes(controlPlaneEventAttributes(event)),
              },
            ],
          },
        ],
      },
    ],
  });
}

function defaultFetch(): ControlPlaneOtelFetch | undefined {
  return typeof globalThis.fetch === 'function'
    ? globalThis.fetch
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ControlPlaneOtelLogsEmitter implements ControlPlaneObserverPort {
  private readonly url: string;
  private readonly resourceAttributes: Record<string, string>;
  private readonly fetchOverride?: ControlPlaneOtelFetch;
  private readonly logger?: ControlPlaneOtelLogger;
  private readonly exportTimeoutMs: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(options: ControlPlaneOtelLogsEmitterOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `${AUTO_ARCHIVE_OTEL_LOGS_URL} must be an http(s) URL when provided.`,
      );
    }
    this.url = parsed.toString();
    this.resourceAttributes = {
      ...parseResourceAttributes(undefined),
      ...options.resourceAttributes,
    };
    this.fetchOverride = options.fetch;
    this.logger = options.logger;
    const exportTimeoutMs = options.exportTimeoutMs;
    this.exportTimeoutMs =
      exportTimeoutMs !== undefined &&
      Number.isInteger(exportTimeoutMs) &&
      exportTimeoutMs > 0
        ? exportTimeoutMs
        : DEFAULT_EXPORT_TIMEOUT_MS;
  }

  observe(event: ControlPlaneEvent): void {
    const task = this.emit(event).catch((error: unknown) => {
      this.log('control-plane-otel-export-failed', {
        eventId: event.eventId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...this.pending]).then(() => undefined),
      delay(timeoutMs),
    ]);
  }

  private async emit(event: ControlPlaneEvent): Promise<void> {
    const fetchFn = this.fetchOverride ?? defaultFetch();
    if (fetchFn === undefined) {
      this.log('control-plane-otel-fetch-unavailable', {
        eventId: event.eventId,
        eventType: event.type,
      });
      return;
    }

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.exportTimeoutMs);
    });
    const fetchPromise = fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildOtlpLogsPayload(event, this.resourceAttributes),
      signal: controller.signal,
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (response === 'timeout') {
      this.log('control-plane-otel-export-timeout', {
        eventId: event.eventId,
        eventType: event.type,
        timeoutMs: this.exportTimeoutMs,
      });
      return;
    }
    if (!response.ok) {
      this.log('control-plane-otel-export-non-2xx', {
        eventId: event.eventId,
        eventType: event.type,
        status: response.status,
      });
    }
  }

  private log(event: string, details: Record<string, unknown>): void {
    try {
      this.logger?.(event, details);
    } catch {
      // Exporter diagnostics must never perturb the control-plane append path.
    }
  }
}

export function createControlPlaneOtelLogsEmitterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ControlPlaneOtelLogsEmitterEnvOptions = {},
): ControlPlaneOtelLogsEmitter | undefined {
  const url = env[AUTO_ARCHIVE_OTEL_LOGS_URL]?.trim();
  if (url === undefined || url === '') {
    return undefined;
  }
  return new ControlPlaneOtelLogsEmitter({
    url,
    resourceAttributes: parseResourceAttributes(
      env[AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES],
    ),
    ...options,
  });
}
