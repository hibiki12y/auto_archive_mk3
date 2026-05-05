---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
source_paths:
  - src/control/control-plane-ledger.ts
  - src/control/control-plane-otel-emitter.ts
  - src/control/task-health-control-plane-recorder.ts
  - src/discord/discord-service-bootstrap.ts
  - tests/control-plane-ledger.spec.ts
  - tests/control-plane-otel-emitter.spec.ts
  - tests/task-health-control-plane-recorder.spec.ts
  - tests/discord-service-bootstrap.spec.ts
scope: Control-plane ledger feed and default-off OTLP HTTP logs observer.
---

# Control-plane OTLP logs and feed posture

The control-plane JSONL ledger remains the durable source of truth. The
OpenTelemetry path is an observe-only mirror attached after successful appends;
it is not required for Discord service readiness, task admission, approval
records, replay, or `/feed`.

## Operator controls

- `AUTO_ARCHIVE_OTEL_LOGS_URL` — default unset/off. When set, it must be an
  `http` or `https` OTLP HTTP logs endpoint, normally ending in `/v1/logs`.
- `AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES` — optional comma-separated
  `key=value` labels added to the OTLP resource. `service.name=auto-archive`
  and `service.namespace=auto-archive` are emitted by default.
- `/doctor` — when `AUTO_ARCHIVE_OTEL_LOGS_URL` is configured, renders a
  redacted `protocol#hash` endpoint summary, resource-attribute counts,
  invalid pair count, export timeout, fail-open mode, and payload boundary. It
  does not contact the collector or emit a test event.

## Safety boundary

The exporter deliberately emits low-cardinality and correlation metadata only:
event type/id, task id, correlation id, trust/source fields, actor/channel kind,
and selected scalar payload fields (`phase` / `lifecyclePhase`, `scope`,
`commandName`). It does not export raw payloads, Discord message content,
instructions, free-form reasons, records, approvals, or operator-authored text
fields.

Task-health stall events use the allowlisted `task.health_stalled` type with
`payload.phase=stalled` and `payload.scope=task-health`. The recorder does not
copy task instructions, Discord content, user ids, channel ids, or free-form
operator text into the event payload.

The Discord service can schedule the recorder only when both task-health
environment gates are positive integers:

- `AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS` enables the observer and defines the
  no-progress threshold.
- `AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS` enables the local ledger
  recording interval. It does not send Discord messages; it only appends safe
  control-plane events that `/feed kind=task` and OTLP observers may inspect.

## Failure model

Ledger appends are fail-open with respect to observers:

1. the event is created and persisted first;
2. trait hook observers keep their existing fail-open behavior;
3. generic observer ports are invoked after append and any returned async work
   is not awaited by the ledger;
4. observer throws, fetch errors, per-export timeouts, and non-2xx collector
   responses are contained;
5. each export is bounded to two seconds by default, and service shutdown asks
   observers to flush with the same two-second bound.

This means an unavailable collector may reduce observability completeness but
must not affect control-plane correctness.

## Proof split

Repository tests cover parse allowlisting, observer fail-open behavior, OTLP
payload shaping, fetch failure containment, shutdown timeout behavior, and
`/doctor` redacted config diagnostics. Live collector delivery remains
operator-gated because it requires a configured OTLP collector endpoint outside
the repository.
