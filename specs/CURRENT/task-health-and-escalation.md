---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
source_paths:
  - src/contracts/runtime-mid-cycle-observer.ts
  - src/core/task-stall-observer.ts
  - src/core/plana.ts
  - src/core/doctor.ts
  - src/control/task-health-control-plane-recorder.ts
  - src/discord/discord-service-bootstrap.ts
  - src/discord/discord-command-handlers.ts
  - src/discord/discord-result-renderer.ts
  - tests/task-stall-observer.spec.ts
  - tests/runtime-mid-cycle-observer.contract.spec.ts
  - tests/task-health-control-plane-recorder.spec.ts
  - tests/discord-service-bootstrap.spec.ts
  - tests/discord-always-on-control.spec.ts
scope: Task-bound runtime health observation and operator escalation posture.
---

# Task health and escalation posture

This document records the repository-local task-health path for in-flight task
observation. The Discord service now wires the observer into Plana when the
operator sets a calibrated threshold. It still does not claim live
stall-threshold tuning or background Discord push delivery.

## RuntimeMidCycleObserver

`RuntimeMidCycleObserver` is an observe-only hook over runtime stream events:

- `observe({ taskId, instanceId, event })` is called in Plana registration
  order for every runtime event.
- Plana catches each observer throw, logs `mid-cycle-observer-threw`, and
  continues to sibling observers and normal runtime review.
- `release(taskId)` is mandatory. Plana invokes it when stream consumption
  terminates, including early return and consumer-error paths.
- Observers do not emit into the same runtime stream and do not own task
  cancellation. Escalation remains an explicit operator/control-plane action.

## TaskStallObserver

`TaskStallObserver` is default-off. It is enabled only when
`AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS` is a positive integer.

Behavior:

- Any observed runtime event counts as progress for the task.
- `tick(nowMs)` returns one `stall` signal per task when the elapsed time since
  last progress reaches the configured threshold.
- Duplicate signals are suppressed until a new runtime event advances the
  task's progress timestamp.
- `currentStalls(nowMs)` is non-consuming and backs the on-demand `/doctor`
  status view.
- `release(taskId)` clears all task-bound state.

The repository deliberately does not ship a default threshold. Runtime/provider
latency varies by site, so operators should collect live interval evidence
before enabling this observer in production.

## Discord service wiring

`startDiscordServiceBootstrap` creates one task-health binding from the resolved
service environment:

- unset or invalid `AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS`: no observer is
  passed to Plana and `/doctor` reports the task-health observer as disabled.
- positive integer threshold: the same `TaskStallObserver` instance is passed
  to Plana via `midCycleObservers` and exposed to `/doctor` through a dynamic
  `inFlightProblems` getter.

The binding is on-demand: `/doctor` reads `currentStalls(Date.now())` when the
operator asks for diagnostics. It does not start a background timer and does
not push alerts to Discord by itself.

## Durable control-plane stall events

`task-health-control-plane-recorder` provides the durable evidence bridge for
hosts that already run a bounded tick loop. The Discord service provides a
default-off coordinator controlled by
`AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS`:

- `recordTaskHealthStallsToControlPlaneLedger(source, ledger, nowMs)` calls the
  source `tick(nowMs)` method and appends one `task.health_stalled`
  control-plane event for each emitted stall signal.
- if `AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS` is unset, invalid, or
  no stall observer is enabled, no interval is scheduled.
- if both `AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS` and
  `AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS` are positive integers, the
  service schedules a local interval that records emitted stall signals to the
  configured control ledger.
- The event is system/trusted, task-scoped, and uses `phase=stalled` plus
  `scope=task-health` so `/feed kind=task` can show it without raw task
  instructions, Discord message content, user ids, channel ids, or free-form
  reasons.
- Append failures are contained per signal and reported through an optional
  logger; one bad ledger append does not block later stall signals.
- service shutdown clears the interval before returning from `stop()`.

This is not a Discord push loop. It is the static, replayable evidence surface
needed before a future operator-approved background delivery loop can be added.

## Doctor surface

`/doctor` and `pnpm run doctor` render task-health observer status. In the live
Discord service, `/doctor` additionally reads current in-flight stall problems
from the wired observer when the threshold is enabled:

- disabled: warns and points operators to
  `AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS` calibration.
- enabled with no signals: pass.
- enabled with stall signals: warn and directs operators to inspect with
  `/status`, `/history`, `/feed`, or `/escalate`.

## Live proof boundary

Live PASS for task health requires an operator-gated artifact showing:

1. selected threshold and basis for that threshold;
2. one long-running task with runtime events observed;
3. one no-progress interval producing a stall signal and, when the recorder is
   used, a `task.health_stalled` ledger event visible through `/feed kind=task`;
4. the task state clearing on terminal release;
5. operator follow-up through `/status`, `/history`, `/feed`, or `/escalate`.
