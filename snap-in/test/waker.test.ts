import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoped } from '../src/platform.ts';
import { dmmapKey, dmrevKey, PlatformSessionDirectory } from '../src/directory.ts';
import { PlatformWaker, WAKE_GRACE_MS } from '../src/waker.ts';
import { ApiError } from '../src/platform.ts';
import { FakePlatform, TONY, OWNER_USER, WAKE_WORKFLOW } from './fake-platform.ts';
import { storeFor } from './helpers.ts';

function wakerFor(f: FakePlatform, o: { keyring?: boolean } = {}) {
  const ev = f.timerEvent();
  if (o.keyring === false) delete ev.input_data.resources.keyrings.owner_identity;
  const api = f.deps().devrev(ev);
  const store = storeFor(f);
  const waker = new PlatformWaker({ store, clock: f.clock, env: 'qa', bot: 'tony', chat: scoped(api, 'service'), owner: scoped(api, 'owner'), tonyAgent: TONY, wakeUser: OWNER_USER, wakeWorkflow: WAKE_WORKFLOW });
  return { waker, store, api };
}
const LOGICAL = 'dm:desktop-release:5.2.11';

test('first wake creates a hidden DM with Tony and the wake user, maps it both ways, and comments once', async () => {
  const f = new FakePlatform(); const { waker, store } = wakerFor(f);
  await waker.postWake(LOGICAL, 'wake one');
  const chats = [...f.chats.values()];
  assert.equal(chats.length, 1); assert.equal(chats[0].display_state, 'hidden');
  assert.deepEqual(chats[0].members, [TONY]); assert.deepEqual(chats[0].users, [OWNER_USER]);
  const map: any = await store.get(dmmapKey('qa', 'tony', LOGICAL));
  assert.equal(map.state, 'ready'); assert.equal(map.dm, chats[0].id); assert.equal(map.agent_version, f.tonyVersion);
  assert.deepEqual(await store.get(dmrevKey('qa', 'tony', chats[0].id)), { logical: LOGICAL });
  assert.equal(f.comments(chats[0].id).length, 1); assert.equal(f.comments(chats[0].id)[0].body, 'wake one');
});

test('the trigger goes through the owner keyring token, never the caller or service token', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  await waker.postWake(LOGICAL, 'who posts');
  assert.deepEqual(f.triggers.map((t) => t.by), ['owner']);
  assert.ok(f.log.filter((l) => l.path === 'workflows.trigger').every((l) => l.as === 'owner'));
});

test('a second wake reuses the same DM', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  await waker.postWake(LOGICAL, 'one'); f.clock.advanceMinutes(10); await waker.postWake(LOGICAL, 'two');
  assert.equal(f.chats.size, 1);
  assert.equal(f.comments([...f.chats.keys()][0]).length, 2);
});

test('exactly once: the same wake text twice posts one comment', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  await waker.postWake(LOGICAL, 'same'); await waker.postWake(LOGICAL, 'same');
  assert.equal(f.triggers.length, 1);
});

test('exactly once with a slow workflow: the retry reads the timeline, sees nothing yet, and does not resend inside the grace period', async () => {
  const f = new FakePlatform(); f.triggerDelayMs = 20_000; const { waker } = wakerFor(f);
  await waker.postWake(LOGICAL, 'slow');
  await assert.rejects(waker.postWake(LOGICAL, 'slow'), /already attempted/);
  assert.equal(f.triggers.length, 1);
  f.clock.advance(30_000);
  await waker.postWake(LOGICAL, 'slow'); // now visible: confirmed, nothing resent
  assert.equal(f.triggers.length, 1);
});

test('a timeout after the trigger ran: the retry finds the comment and does not post again', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  f.inject('workflows.trigger', { timeout: 'after' });
  await assert.rejects(waker.postWake(LOGICAL, 'maybe'), (e: ApiError) => e.status === 0);
  assert.equal(f.triggers.length, 1);
  await waker.postWake(LOGICAL, 'maybe');
  assert.equal(f.triggers.length, 1); assert.equal(f.comments([...f.chats.keys()][0]).length, 1);
});

test('a timeout before the trigger ran: resend only after the grace period, and then exactly once', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  f.inject('workflows.trigger', { timeout: 'before' });
  await assert.rejects(waker.postWake(LOGICAL, 'lost'));
  assert.equal(f.triggers.length, 0);
  await assert.rejects(waker.postWake(LOGICAL, 'lost'), /already attempted/);
  f.clock.advance(WAKE_GRACE_MS + 1000);
  await waker.postWake(LOGICAL, 'lost');
  assert.equal(f.triggers.length, 1);
});

test('a definite refusal (403) sends nothing and the next attempt may go at once', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  f.inject('workflows.trigger', { status: 403, type: 'forbidden' });
  await assert.rejects(waker.postWake(LOGICAL, 'denied'), (e: ApiError) => e.status === 403);
  assert.equal(f.triggers.length, 0);
  await waker.postWake(LOGICAL, 'denied');
  assert.equal(f.triggers.length, 1);
});

test('a different text while an earlier wake is unconfirmed is held back until the first is read back', async () => {
  const f = new FakePlatform(); f.triggerDelayMs = 60_000; const { waker } = wakerFor(f);
  await waker.postWake(LOGICAL, 'first text');
  f.clock.advance(10_000);
  await assert.rejects(waker.postWake(LOGICAL, 'first text, retimed'), /earlier wake/);
  assert.equal(f.triggers.length, 1);
  f.clock.advance(60_000);
  await waker.postWake(LOGICAL, 'first text, retimed'); // first is now visible: no second comment stacked
  assert.equal(f.triggers.length, 1);
});

test('missing owner keyring: postWake throws, nothing is posted, and the DM mapping is kept', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f, { keyring: false });
  await assert.rejects(waker.postWake(LOGICAL, 'nokey'), /owner_identity/);
  assert.equal(f.triggers.length, 0);
  // nothing was sent, so once the keyring is present the retry goes at once (no grace wait)
  const again = wakerFor(f);
  await again.waker.postWake(LOGICAL, 'nokey');
  assert.equal(f.triggers.length, 1);
});

test('crash between chats.create and the dmmap write leaves at most one orphan and never two mapped homes', async () => {
  const f = new FakePlatform(); const first = wakerFor(f);
  f.inject('chats.update', { status: 500, times: 10 }); // the process dies here: DM created, mapping still "creating"
  await assert.rejects(first.waker.postWake(LOGICAL, 'crash'));
  assert.equal(f.chats.size, 1);
  f.clearRules();
  const second = wakerFor(f);
  await second.waker.postWake(LOGICAL, 'crash');
  assert.ok(f.chats.size <= 2);
  const map: any = await second.store.get(dmmapKey('qa', 'tony', LOGICAL));
  assert.equal(map.state, 'ready');
  const mapped = [...f.chats.values()].filter((c) => c.id === map.dm);
  assert.equal(mapped.length, 1); assert.equal(mapped[0].display_state, 'hidden');
  assert.equal(f.comments(map.dm).length, 1);
});

test('stale version: a changed default version is reported and nothing is posted into the old home', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  await waker.postWake(LOGICAL, 'v1');
  f.tonyVersion = `${TONY}:version/2`; f.clock.advanceMinutes(10);
  const r = await waker.postWake(LOGICAL, 'after publish');
  assert.deepEqual(r, { stale_version: true });
  assert.equal(f.triggers.length, 1);
});

test('after the engine replaces the home, the new logical id gets its own DM at the new version', async () => {
  const f = new FakePlatform(); const { waker, store } = wakerFor(f);
  await waker.postWake(LOGICAL, 'v1');
  f.tonyVersion = `${TONY}:version/2`;
  await waker.postWake(`${LOGICAL}:g2`, 'g2 wake');
  assert.equal(f.chats.size, 2);
  const map: any = await store.get(dmmapKey('qa', 'tony', `${LOGICAL}:g2`));
  assert.equal(map.agent_version, f.tonyVersion);
  const dir = new PlatformSessionDirectory({ api: scoped(f.deps().devrev(f.timerEvent()), 'service'), store: storeFor(f), env: 'qa', bot: 'tony' });
  assert.deepEqual(await dir.dmOf(f.sessionIn(map.dm)), { dm: `${LOGICAL}:g2` });
});

test('429 on chats.create surfaces so the engine keeps its wake reason', async () => {
  const f = new FakePlatform(); const { waker } = wakerFor(f);
  f.inject('chats.create', { status: 429, type: 'rate_limited' });
  await assert.rejects(waker.postWake(LOGICAL, 'busy'), (e: ApiError) => e.status === 429);
  assert.equal(f.triggers.length, 0);
});
