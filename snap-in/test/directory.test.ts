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
