import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlatformSessionDirectory, dmrevKey } from '../src/directory.ts';
import { scoped } from '../src/platform.ts';
import { ORG, FakePlatform } from './fake-platform.ts';
import { storeFor } from './helpers.ts';

function dirFor(f: FakePlatform) {
  const api = scoped(f.deps().devrev(f.timerEvent()), 'service');
  return new PlatformSessionDirectory({ api, store: storeFor(f), env: 'qa', bot: 'tony' });
}

test('resolves the session parent from ai-agent.sessions.get', async () => {
  const f = new FakePlatform(); const m = f.newMentionDm();
  assert.deepEqual(await dirFor(f).dmOf(m.session), { dm: m.dm });
});

test('a session in a mapped job home resolves to the logical home id', async () => {
  const f = new FakePlatform(); const real = `${ORG}:dm/realhome`;
  f.insertRaw('work_record', `${dmrevKey('qa', 'tony', real)}@v1`, { logical: 'dm:desktop-release:5.2.11' });
  const session = f.sessionIn(real);
  assert.deepEqual(await dirFor(f).dmOf(session), { dm: 'dm:desktop-release:5.2.11' });
});

test('a forged or unknown session id never resolves to a caller-chosen DM', async () => {
  const f = new FakePlatform();
  const r = await dirFor(f).dmOf(`${ORG}:ai_agent_session/999999`);
  assert.ok('error' in r);
});

test('403 on sessions.get is an error result, not an exception, and is not remembered', async () => {
  const f = new FakePlatform(); const m = f.newMentionDm(); const d = dirFor(f);
  f.inject('ai-agent.sessions.get', { status: 403, type: 'forbidden' });
  const bad = await d.dmOf(m.session);
  assert.ok('error' in bad && /403/.test(bad.error));
  assert.deepEqual(await d.dmOf(m.session), { dm: m.dm });
});

test('429 and timeout on sessions.get are error results; empty parent is an error', async () => {
  const f = new FakePlatform(); const m = f.newMentionDm(); const d = dirFor(f);
  f.inject('ai-agent.sessions.get', { status: 429 }); f.inject('ai-agent.sessions.get', { timeout: 'before' });
  assert.ok('error' in await d.dmOf(m.session)); assert.ok('error' in await d.dmOf(m.session));
  assert.ok('error' in await d.dmOf(''));
  const orphan = f.newSession('');
  assert.ok('error' in await d.dmOf(orphan));
});

test('a store failure while mapping is an error result (no guess)', async () => {
  const f = new FakePlatform(); const m = f.newMentionDm(); const d = dirFor(f);
  f.inject('custom-objects.get', { status: 500, times: 10 });
  assert.ok('error' in await d.dmOf(m.session));
});

test('declares itself cacheable: the answer depends only on the session', () => {
  assert.equal(dirFor(new FakePlatform()).cacheable, true);
});

// ---- R51: thread resolution from the platform (live run 1 F1)
const CH = 'C0C4K4EGZT6';
/** The operation path: the caller token (the mention session's own user) reads its own DM. */
function callerDir(f: FakePlatform) {
  return new PlatformSessionDirectory({ api: scoped(f.deps().devrev(f.opEvent({})), 'caller'), store: storeFor(f), env: 'qa', bot: 'tony' });
}

test('R51: threadOf reads the channel and thread ts from the connector DM custom fields', async () => {
  const f = new FakePlatform(); const m = f.newConnectorDm(CH, '1791149910.562169', '1791149910.562169');
  assert.deepEqual(await callerDir(f).threadOf(m.session), { thread: `${CH}:1791149910.562169`, prompt_ts: '1791149910.562169' });
});

test('R51: a reply mention resolves to the thread root, not the prompt ts', async () => {
  const f = new FakePlatform(); const m = f.newConnectorDm(CH, '1791149910.562169', '1791150443.050169');
  assert.deepEqual(await callerDir(f).threadOf(m.session), { thread: `${CH}:1791149910.562169`, prompt_ts: '1791150443.050169' });
});

test('R51: a DM without connector fields, a 403 on chats.get, and an unknown session are error results', async () => {
  const f = new FakePlatform(); const plain = f.newMentionDm(); const d = callerDir(f);
  const none = await d.threadOf(plain.session);
  assert.ok('error' in none && /no Slack channel/.test(none.error));
  const m = f.newConnectorDm(CH, '1791149910.562169');
  f.inject('chats.get', { status: 403, type: 'forbidden' });
  const bad = await d.threadOf(m.session);
  assert.ok('error' in bad && /403/.test(bad.error));
  assert.deepEqual(await d.threadOf(m.session), { thread: `${CH}:1791149910.562169`, prompt_ts: '1791149910.562169' });
  assert.ok('error' in (await d.threadOf(`${ORG}:ai_agent_session/404`)));
});

test('R51: the fake is as strict as live: the owner token (devu/1) cannot read a DM it is not a member of', async () => {
  const f = new FakePlatform(); const m = f.newConnectorDm(CH, '1791149910.562169');
  f.chats.get(m.dm)!.users = [`${ORG}:devu/2`];
  const owner = scoped(f.deps().devrev(f.timerEvent()), 'owner');
  await assert.rejects(() => owner.call('chats.get', { id: m.dm }), /403|forbidden/);
});
