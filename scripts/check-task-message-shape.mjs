#!/usr/bin/env node
/**
 * UX-25 (cycle 11): automated verifier for cycle-8/10 in-place edit
 * and cycle-9 per-task thread, reading the control ledger only.
 *
 * Background: the live verification path (Discord REST fetch via the
 * bot token) is blocked by the Auto Mode classifier as
 * "credential use beyond test scope." This script bypasses that block
 * by reading `task.delivery_observed` events the bot itself records
 * to its append-only JSONL ledger after each editReply / followUp.
 *
 * Same `messageId` across multiple `editReply` ops for one taskId =
 * cycle 8/10 in-place edit verified. Distinct `messageId` per op =
 * legacy followUp shape (regression).
 *
 * Usage:
 *   node scripts/check-task-message-shape.mjs <task-id> [--ledger PATH]
 *     [--include-status-replies]
 *
 * By default, separate command replies such as `/status` (`status-reply`) are
 * ignored even when they reference the same task id, because they land on their
 * own Discord interaction message and are not part of the original ask
 * lifecycle edit chain.
 *
 * Exits 0 on PASS (in-place observed) or NA (no events to evaluate);
 * 1 on FAIL (multiple distinct messageIds across editReply ops).
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stdout, stderr } from 'node:process';

const DEFAULT_LEDGER = 'runtime-state/research-control-events.jsonl';
const DEFAULT_IGNORED_EVENT_TYPES = new Set(['status-reply']);

function parseArgs(rawArgs) {
  const result = {
    taskId: undefined,
    ledgerPath: DEFAULT_LEDGER,
    includeStatusReplies: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--ledger' && index + 1 < rawArgs.length) {
      result.ledgerPath = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--include-status-replies') {
      result.includeStatusReplies = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      stdout.write(
        'Usage: check-task-message-shape.mjs <task-id> [--ledger PATH] [--include-status-replies]\n' +
          '\n' +
          'Reads `task.delivery_observed` events from the control ledger and\n' +
          'reports whether the cycle-8/10 in-place edit invariant held: every\n' +
          'task-lifecycle editReply for one taskId should land on the SAME Discord message id.\n' +
          'By default, separate /status interaction replies are ignored.\n',
      );
      exit(0);
    }
    if (arg.startsWith('-')) {
      stderr.write(`Unknown flag: ${arg}\n`);
      exit(2);
    }
    if (result.taskId === undefined) {
      result.taskId = arg;
    } else {
      stderr.write(`Unexpected positional arg: ${arg}\n`);
      exit(2);
    }
  }
  if (result.taskId === undefined) {
    stderr.write('Missing required <task-id> positional argument.\n');
    exit(2);
  }
  return result;
}

function readDeliveryEvents(ledgerPath, taskId) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    stderr.write(`Failed to read ledger ${ledgerPath}: ${String(error)}\n`);
    exit(2);
  }
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      event &&
      event.type === 'task.delivery_observed' &&
      event.taskId === taskId
    ) {
      events.push(event);
    }
  }
  return events;
}

function classify(events, { includeStatusReplies }) {
  const ignoredEvents = includeStatusReplies
    ? []
    : events.filter((event) =>
        DEFAULT_IGNORED_EVENT_TYPES.has(event?.payload?.eventType),
      );
  const evaluatedEvents = includeStatusReplies
    ? events
    : events.filter(
        (event) => !DEFAULT_IGNORED_EVENT_TYPES.has(event?.payload?.eventType),
      );
  const editReplyEvents = evaluatedEvents.filter(
    (event) => event?.payload?.operation === 'editReply',
  );
  const followUpEvents = evaluatedEvents.filter(
    (event) => event?.payload?.operation === 'followUp',
  );
  const editReplyMessageIds = new Set(
    editReplyEvents
      .map((event) => event?.payload?.messageId)
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const distinctEditReplyMessageCount = editReplyMessageIds.size;
  const inPlaceVerified =
    editReplyEvents.length >= 2 && distinctEditReplyMessageCount === 1;
  return {
    totalEvents: evaluatedEvents.length,
    observedEvents: events.length,
    ignoredEvents,
    editReplyCount: editReplyEvents.length,
    followUpCount: followUpEvents.length,
    distinctEditReplyMessageIds: [...editReplyMessageIds],
    inPlaceVerified,
    editReplyEvents,
    followUpEvents,
  };
}

function emitReport(taskId, ledgerPath, report) {
  stdout.write(`\nTask: ${taskId}\n`);
  stdout.write(`Ledger: ${ledgerPath}\n`);
  stdout.write(`Total evaluated task.delivery_observed events: ${report.totalEvents}\n`);
  if (report.ignoredEvents.length > 0) {
    stdout.write(
      `  Ignored separate command replies: ${report.ignoredEvents.length} of ${report.observedEvents} observed events\n`,
    );
  }
  stdout.write(`  editReply ops: ${report.editReplyCount}\n`);
  stdout.write(`  followUp ops: ${report.followUpCount}\n`);
  stdout.write(
    `  Distinct editReply messageIds: ${report.distinctEditReplyMessageIds.length}` +
      (report.distinctEditReplyMessageIds.length > 0
        ? ` (${report.distinctEditReplyMessageIds.join(', ')})`
        : '') +
      '\n',
  );
  stdout.write('\nPer-op trace:\n');
  for (const event of [...report.editReplyEvents, ...report.followUpEvents]) {
    const payload = event?.payload ?? {};
    stdout.write(
      `  ${event.timestamp}  op=${payload.operation}  eventType=${payload.eventType}  msgId=${payload.messageId ?? '(none)'}\n`,
    );
  }

  stdout.write('\nVerdict:\n');
  if (report.totalEvents === 0) {
    stdout.write(
      '  NA — no task.delivery_observed events for this task id.\n' +
        '       (The bot may pre-date cycle 11 or never delivered for this task.)\n',
    );
    return 'na';
  }
  if (report.inPlaceVerified) {
    stdout.write(
      '  PASS — cycle 8/10 in-place edit verified: ' +
        `${report.editReplyCount} editReply ops landed on a single message id.\n`,
    );
    return 'pass';
  }
  if (report.editReplyCount === 0) {
    stdout.write(
      '  NA — no editReply ops recorded; in-place invariant does not apply.\n',
    );
    return 'na';
  }
  if (report.editReplyCount === 1) {
    stdout.write(
      '  NA — only one editReply op; in-place comparison needs at least two.\n',
    );
    return 'na';
  }
  if (report.distinctEditReplyMessageIds.length === 0) {
    stdout.write(
      '  WARN — editReply ops landed but no messageId captured.\n' +
        '         (Adapter likely missing extractMessageId.)\n',
    );
    return 'warn';
  }
  stdout.write(
    `  FAIL — ${report.editReplyCount} editReply ops landed on ${report.distinctEditReplyMessageIds.length} distinct messages — in-place edit regressed.\n`,
  );
  return 'fail';
}

function main() {
  const { taskId, ledgerPath, includeStatusReplies } = parseArgs(argv.slice(2));
  const events = readDeliveryEvents(ledgerPath, taskId);
  const report = classify(events, { includeStatusReplies });
  const verdict = emitReport(taskId, ledgerPath, report);
  exit(verdict === 'fail' ? 1 : 0);
}

main();
