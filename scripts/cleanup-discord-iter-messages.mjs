#!/usr/bin/env node
/**
 * One-shot cleanup of bot-authored test messages from the iter1-iter7
 * peekaboo eval-improve loop. Scope: only messages authored by the bot
 * itself in CHANNEL_ID. Other operator/user content is never touched.
 *
 * Required env: AUTO_ARCHIVE_DISCORD_TOKEN
 * Required arg: --channel <id>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

function loadEnv() {
  if (process.env.AUTO_ARCHIVE_DISCORD_TOKEN) return process.env.AUTO_ARCHIVE_DISCORD_TOKEN;
  const text = readFileSync(`${REPO_ROOT}/.env`, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^AUTO_ARCHIVE_DISCORD_TOKEN=(.*)$/);
    if (m) return m[1].trim();
  }
  throw new Error('AUTO_ARCHIVE_DISCORD_TOKEN not found');
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

const TOKEN = loadEnv();
const CHANNEL_ID = arg('--channel');
const DRY_RUN = process.argv.includes('--dry-run');
if (!CHANNEL_ID) {
  console.error('--channel <id> required');
  process.exit(2);
}

const BASE = 'https://discord.com/api/v10';
const HEADERS = {
  Authorization: `Bot ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'auto_archive_mk3-cleanup (peekaboo-eval-improve-loop, 2026-05-06)',
};

async function discord(method, path, body) {
  const init = { method, headers: HEADERS };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  if (res.status === 429) {
    const retry = await res.json();
    const ms = Math.max(1000, Math.ceil((retry.retry_after ?? 1) * 1000));
    console.error(`[rate-limited] sleeping ${ms}ms`);
    await new Promise((r) => setTimeout(r, ms));
    return discord(method, path, body);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

async function getBotId() {
  const me = await discord('GET', '/users/@me');
  return me.id;
}

async function listMessages(beforeId) {
  const qs = new URLSearchParams({ limit: '100' });
  if (beforeId) qs.set('before', beforeId);
  return discord('GET', `/channels/${CHANNEL_ID}/messages?${qs}`);
}

function isYoungerThan14Days(snowflake) {
  const ms = Number((BigInt(snowflake) >> 22n) + 1420070400000n);
  const ageMs = Date.now() - ms;
  return ageMs < 14 * 24 * 60 * 60 * 1000 - 60 * 1000;
}

async function bulkDelete(ids) {
  if (ids.length === 0) return;
  if (ids.length === 1) {
    await discord('DELETE', `/channels/${CHANNEL_ID}/messages/${ids[0]}`);
    return;
  }
  await discord('POST', `/channels/${CHANNEL_ID}/messages/bulk-delete`, {
    messages: ids,
  });
}

async function main() {
  const botId = await getBotId();
  console.log(`bot user id: ${botId}`);
  console.log(`channel    : ${CHANNEL_ID}`);
  console.log(`dryRun     : ${DRY_RUN}`);
  let cursor;
  let scanned = 0;
  let toDelete = [];
  while (true) {
    const batch = await listMessages(cursor);
    if (batch.length === 0) break;
    scanned += batch.length;
    for (const msg of batch) {
      if (msg.author?.id === botId && isYoungerThan14Days(msg.id)) {
        toDelete.push(msg.id);
      }
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  console.log(`scanned: ${scanned} messages, to delete: ${toDelete.length}`);
  if (DRY_RUN) {
    console.log(JSON.stringify(toDelete.slice(0, 20)));
    return;
  }
  while (toDelete.length > 0) {
    const slice = toDelete.splice(0, 100);
    await bulkDelete(slice);
    console.log(`deleted batch: ${slice.length} (remaining ${toDelete.length})`);
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
