import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelDeniedError, HARD_DENIED_CHANNEL, MAX_THREADS_PER_TICK, PlatformSlackReader, SlackPoller, assertAllowed, normThread, parseAllowlist, parseThread } from '../src/slack.ts';
import { makeKey, MemoryStore } from '../../src/store.ts';
import type { IngestEvent } from '../../src/types.ts';
import { ALLOWED, FakePlatform, OWN_BOT, PROTECTED } from './fake-platform.ts';
import { storeFor } from './helpers.ts';
import { HARRY, OWNER_SLACK } from './helpers.ts';

function pollerFor(f: FakePlatform, allow: string[] = [ALLOWED]) {
  const events: IngestEvent[] = [];
  const poller = new SlackPoller({ api: f.deps().slack(f.timerEvent()), store: storeFor(f), clock: f.clock, env: 'qa', bot: 'tony', allow, ownBotUserId: OWN_BOT, ingest: async (e) => { events.push(e); return { ok: true, status: 'ok' }; } });
  return { poller, events };
}

test('the protected channel is hard-denied even if an install input lists it', () => {
  assert.equal(HARD_DENIED_CHANNEL, 'C08TJE6SDME');
  assert.deepEqual(parseAllowlist('C0C4K4EGZT6,C08TJE6SDME'), ['C0C4K4EGZT6']);
  assert.deepEqual(parseAllowlist(undefined), ['C0C4K4EGZT6']);
  assert.throws(() => assertAllowed(['C08TJE6SDME', ALLOWED], PROTECTED), ChannelDeniedError);
  assert.throws(() => assertAllowed([ALLOWED], 'C0OTHER00001'), ChannelDeniedError);
  assertAllowed([ALLOWED], ALLOWED);
});

test('thread ids normalise from the connector form', () => {
  assert.deepEqual(parseThread(`slack:${ALLOWED}:1700000000.000100`), { channel: ALLOWED, ts: '1700000000.000100' });
  assert.equal(normThread(`slack:${ALLOWED}:1700000000.000100`), `${ALLOWED}:1700000000.000100`);
  assert.equal(parseThread('not a thread'), null);
});

test('watch refuses a thread outside the allowlist and the protected channel', async () => {
  const f = new FakePlatform(); const { poller } = pollerFor(f);
  assert.equal(await poller.watch(`${PROTECTED}:1700000000.000100`, 'j'), false);
  assert.equal(await poller.watch('C0OTHER00001:1700000000.000100', 'j'), false);
  assert.equal(await poller.watch(`${ALLOWED}:1700000000.000100`, 'j'), true);
  assert.equal((await poller.watched()).length, 1);
  await poller.watch(`${ALLOWED}:1700000000.000100`, 'j');
  assert.equal((await poller.watched()).length, 1);
});

test('a poll ingests human, Tony and other-bot posts with the right sender kinds and advances the cursor', async () => {
  const f = new FakePlatform(); const { poller, events } = pollerFor(f);
  const root = f.root(ALLOWED, OWNER_SLACK, 'request'); await poller.watch(`${ALLOWED}:${root}`, 'j');
  f.postSlack(ALLOWED, root, { user: OWNER_SLACK, text: 'go' });
  f.postSlack(ALLOWED, root, { user: OWN_BOT, bot_id: 'B1', text: 'posted' });
  f.postSlack(ALLOWED, root, { user: HARRY, bot_id: 'B2', bot_profile: { id: 'B2', name: 'harry' }, text: 'signoff' });
  const r = await poller.poll();
  assert.equal(r.ingested, 3);
  assert.deepEqual(events.map((e) => [e.sender_id, e.sender_kind]), [[OWNER_SLACK, 'human'], [OWN_BOT, 'human'], [HARRY, 'other_bot']]);
  assert.ok(events.every((e) => e.source === 'slack' && e.thread === `${ALLOWED}:${root}` && e.delivery_id.startsWith(`${ALLOWED}:`)));
  assert.equal(typeof events[0].attrs!.ts, 'number');
  const again = await poller.poll();
  assert.equal(again.ingested, 0); assert.equal(events.length, 3);
});

test('an owner user-token post that carries bot_id/app_id is human; real bot messages stay other_bot', async () => {
  const f = new FakePlatform(); const { poller, events } = pollerFor(f);
  const root = f.root(ALLOWED, OWNER_SLACK, 'request'); await poller.watch(`${ALLOWED}:${root}`, 'j');
  f.postSlackAsUserToken(ALLOWED, root, 'U042GEDM4BB', 'go');
  f.postSlack(ALLOWED, root, { user: HARRY, bot_id: 'B2', bot_profile: { id: 'B2', name: 'harry' }, text: 'profile bot' });
  f.postSlack(ALLOWED, root, { user: HARRY, bot_id: 'B3', subtype: 'bot_message', text: 'subtype bot' });
  f.postSlack(ALLOWED, root, { bot_id: 'B4', subtype: 'bot_message', text: 'webhook, no user' });
  f.postSlack(ALLOWED, root, { user: OWN_BOT, bot_id: 'B1', bot_profile: { id: 'B1', name: 'tony' }, text: 'own' });
  const r = await poller.poll();
  assert.equal(r.ingested, 5);
  assert.deepEqual(events.map((e) => [e.sender_id, e.sender_kind]), [['U042GEDM4BB', 'human'], [HARRY, 'other_bot'], [HARRY, 'other_bot'], ['B4', 'other_bot'], [OWN_BOT, 'human']]);
});

test('the cursor does not advance past a failed ingest, so the message is retried', async () => {
  const f = new FakePlatform(); let fail = true; const seen: string[] = [];
  const poller = new SlackPoller({ api: f.deps().slack(f.timerEvent()), store: storeFor(f), clock: f.clock, env: 'qa', bot: 'tony', allow: [ALLOWED], ownBotUserId: OWN_BOT, ingest: async (e) => { if (fail) return { ok: false, status: 'boom' }; seen.push(e.delivery_id); return { ok: true }; } });
  const root = f.root(ALLOWED, OWNER_SLACK, 'r'); await poller.watch(`${ALLOWED}:${root}`, 'j');
  f.postSlack(ALLOWED, root, { user: OWNER_SLACK, text: 'one' });
  const bad = await poller.poll(); assert.equal(bad.ingested, 0); assert.equal(bad.errors.length, 1);
  fail = false;
  assert.equal((await poller.poll()).ingested, 1); assert.equal(seen.length, 1);
});

test('a 429 or timeout on one thread is reported and does not stop the others', async () => {
  const f = new FakePlatform(); const { poller, events } = pollerFor(f);
  const a = f.root(ALLOWED, OWNER_SLACK, 'a'); const b = f.root(ALLOWED, OWNER_SLACK, 'b');
  await poller.watch(`${ALLOWED}:${a}`, 'j1'); await poller.watch(`${ALLOWED}:${b}`, 'j2');
  f.postSlack(ALLOWED, a, { user: OWNER_SLACK, text: 'x' }); f.postSlack(ALLOWED, b, { user: OWNER_SLACK, text: 'y' });
  f.failSlack('ratelimited', 1);
  const r1 = await poller.poll();
  assert.equal(r1.errors.length, 1); assert.equal(r1.ingested, 1);
  f.failSlack('timeout', 1);
  const r2 = await poller.poll();
  assert.equal(r2.errors.length, 1); assert.equal(r2.ingested, 0);
  await poller.poll();
  assert.equal(new Set(events.map((e) => e.delivery_id)).size, 2);
});

test('a tick reads at most 20 threads', async () => {
  const f = new FakePlatform(); const { poller } = pollerFor(f);
  for (let i = 0; i < 25; i += 1) { const r = f.root(ALLOWED, OWNER_SLACK, `t${i}`); await poller.watch(`${ALLOWED}:${r}`, `j${i}`); }
  const r = await poller.poll();
  assert.equal(r.polled, MAX_THREADS_PER_TICK); assert.equal(f.slackReads.length, MAX_THREADS_PER_TICK);
});

test('a watched thread whose channel was removed from the allowlist is skipped and never read', async () => {
  const f = new FakePlatform(); const store = storeFor(f);
  const key = makeKey('qa', 'tony', 'watch', 'all');
  await store.putIfAbsent(key, { items: [{ channel: PROTECTED, thread_ts: '1700000000.000100', job: 'j', last_ts: '1700000000.000100' }, { channel: 'C0OTHER00001', thread_ts: '1.1', job: 'j', last_ts: '1.1' }] });
  const { poller } = pollerFor(f);
  const r = await poller.poll();
  assert.equal(r.skipped, 2); assert.equal(f.slackReads.length, 0);
});

test('SlackReader.findOwnPostAfter returns Tony post after the claim, flags relay replies, and ignores others', async () => {
  const f = new FakePlatform();
  const reader = new PlatformSlackReader({ api: f.deps().slack(f.timerEvent()), allow: [ALLOWED], ownBotUserId: OWN_BOT });
  const root = f.root(ALLOWED, OWNER_SLACK, 'r'); const thread = `${ALLOWED}:${root}`;
  const claim = f.clock.now();
  f.clock.advance(5000);
  assert.equal(await reader.findOwnPostAfter(thread, claim), null);
  f.postSlack(ALLOWED, root, { user: OWNER_SLACK, text: 'human' });
  assert.equal(await reader.findOwnPostAfter(thread, claim), null);
  f.postSlack(ALLOWED, root, { user: OWN_BOT, text: 'relay', metadata: { event_type: 'slack_agent_chat' } });
  const relay = await reader.findOwnPostAfter(thread, claim); assert.equal(relay!.relay, true);
  f.clock.advance(1000);
  const ts = f.postSlack(ALLOWED, root, { user: OWN_BOT, text: 'tool post' });
  const late = await reader.findOwnPostAfter(thread, f.clock.now() - 500);
  assert.equal(late!.link, `slack:${ALLOWED}:${ts}`); assert.equal(late!.relay, false);
  assert.equal(await reader.findOwnPostAfter(thread, f.clock.now() + 1_000_000), null);
});

test('SlackReader refuses channels outside the allowlist without calling Slack', async () => {
  const f = new FakePlatform();
  const reader = new PlatformSlackReader({ api: f.deps().slack(f.timerEvent()), allow: [ALLOWED], ownBotUserId: OWN_BOT });
  await assert.rejects(reader.findOwnPostAfter(`${PROTECTED}:1700000000.000100`, 0), ChannelDeniedError);
  assert.equal(f.slackReads.length, 0);
  assert.equal(await reader.findOwnPostAfter('garbage', 0), null);
});

test('a timeout from Slack surfaces as an error the engine treats as not found', async () => {
  const f = new FakePlatform();
  const reader = new PlatformSlackReader({ api: f.deps().slack(f.timerEvent()), allow: [ALLOWED], ownBotUserId: OWN_BOT });
  f.failSlack('timeout');
  await assert.rejects(reader.findOwnPostAfter(`${ALLOWED}:1700000000.000100`, 0));
});

test('MemoryStore also works with the poller (store interface only)', async () => {
  const f = new FakePlatform();
  const poller = new SlackPoller({ api: f.deps().slack(f.timerEvent()), store: new MemoryStore(), clock: f.clock, env: 'qa', bot: 'tony', allow: [ALLOWED], ownBotUserId: OWN_BOT, ingest: async () => ({ ok: true }) });
  assert.equal(await poller.watch(`${ALLOWED}:1700000000.000100`, 'j'), true);
});

test('R61 SlackReader.threadExists: a real thread gives its root, a reply gives the root, an unknown ts is false, Slack errors are null', async () => {
  const f = new FakePlatform();
  const reader = new PlatformSlackReader({ api: f.deps().slack(f.timerEvent()), allow: [ALLOWED], ownBotUserId: OWN_BOT });
  const root = f.root(ALLOWED, OWNER_SLACK, 'r');
  const reply = f.postSlack(ALLOWED, root, { user: OWNER_SLACK, text: 'reply' });
  assert.equal(await reader.threadExists(`${ALLOWED}:${root}`), `${ALLOWED}:${root}`);
  assert.equal(await reader.threadExists(`${ALLOWED}:${reply}`), `${ALLOWED}:${root}`);
  assert.equal(await reader.threadExists(`${ALLOWED}:1759651539.000000`), false);
  assert.equal(await reader.threadExists('not a thread'), null);
  await assert.rejects(() => reader.threadExists(`${PROTECTED}:${root}`), ChannelDeniedError);
  f.failSlack('timeout', 1);
  assert.equal(await reader.threadExists(`${ALLOWED}:${root}`), null);
});

test('R62: authorOf returns the Slack author of the thread root or of a given message, null when unknown', async () => {
  const f = new FakePlatform();
  const root = f.postSlack(ALLOWED, null, { user: HARRY, text: 'release?' });
  const reply = f.postSlack(ALLOWED, root, { user: OWNER_SLACK, text: 'hi' });
  const r = new PlatformSlackReader({ api: f.deps().slack(f.timerEvent()), allow: [ALLOWED], ownBotUserId: OWN_BOT });
  assert.equal(await r.authorOf(`${ALLOWED}:${root}`), HARRY);
  assert.equal(await r.authorOf(`${ALLOWED}:${root}`, reply), OWNER_SLACK);
  assert.equal(await r.authorOf(`${ALLOWED}:${root}`, '1.1'), null);
  assert.equal(await r.authorOf('not-a-thread'), null);
});
