import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/platform.ts';
import { BodyTooLargeError, MAX_BODY_BYTES, PlatformStore } from '../src/store-platform.ts';
import { makeKey } from '../../src/store.ts';
import { Crash, FakePlatform } from './fake-platform.ts';
import { storeFor } from './helpers.ts';

const K = (kind: string, id: string) => makeKey('qa', 'tony', kind, id);

test('putIfAbsent creates @v1 once; a duplicate returns the existing value', async () => {
  const f = new FakePlatform(); const s = storeFor(f);
  const a = await s.putIfAbsent(K('job', 'a'), { n: 1 });
  const b = await s.putIfAbsent(K('job', 'a'), { n: 2 });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.deepEqual(b.value, { n: 1 });
  assert.ok(f.rows.has(`${K('job', 'a')}@v1`));
});

test('rows carry the live schema fields and events go to work_event', async () => {
  const f = new FakePlatform(); const s = storeFor(f);
  await s.putIfAbsent(K('job', 'a'), { status: 'open' });
  await s.putIfAbsent(K('event', 'slack:C1:1.0'), { id: 'x' });
  const job = f.rows.get(`${K('job', 'a')}@v1`)!; const ev = f.rows.get(`${K('event', 'slack:C1:1.0')}@v1`)!;
  assert.equal(job.leaf_type, 'work_record'); assert.equal(ev.leaf_type, 'work_event');
  assert.deepEqual(Object.keys(job.custom_fields).sort(), ['tnt__body', 'tnt__job_key', 'tnt__kind', 'tnt__state', 'tnt__version']);
  assert.equal(ev.custom_fields.tnt__source, 'slack'); assert.equal(job.custom_fields.tnt__state, 'open');
  assert.equal(typeof job.custom_fields.tnt__body, 'string');
});

test('putIfVersion is a compare-and-set: success bumps, a stale writer learns the latest', async () => {
  const f = new FakePlatform(); const s = storeFor(f); const k = K('job', 'cas');
  assert.deepEqual(await s.putIfVersion(k, { v: 1 }, 0), { ok: true, version: 1 });
  assert.deepEqual(await s.putIfVersion(k, { v: 2 }, 1), { ok: true, version: 2 });
  const stale = await storeFor(f).putIfVersion(k, { v: 'x' }, 1);
  assert.deepEqual(stale, { ok: false, version: 2 });
  assert.deepEqual(await s.getVersioned(k), { value: { v: 2 }, version: 2 });
});

test('a 409 race: a competing writer takes @v2 between our read and our write', async () => {
  const f = new FakePlatform(); const s = storeFor(f); const k = K('job', 'race');
  await s.put(k, { v: 1 });
  f.raceBeforeCreate((u) => u === `${k}@v2`, () => f.insertRaw('work_record', `${k}@v2`, { v: 'theirs' }));
  const r = await s.putIfVersion(k, { v: 'mine' }, 1);
  assert.deepEqual(r, { ok: false, version: 2 });
  assert.deepEqual((await storeFor(f).get(k)), { v: 'theirs' });
});

test('put retries through a lost race and lands on the next version', async () => {
  const f = new FakePlatform(); const s = storeFor(f); const k = K('job', 'put');
  await s.put(k, { v: 1 });
  f.raceBeforeCreate((u) => u === `${k}@v2`, () => f.insertRaw('work_record', `${k}@v2`, { v: 'theirs' }));
  await s.put(k, { v: 'mine' });
  assert.deepEqual(await storeFor(f).getVersioned(k), { value: { v: 'mine' }, version: 3 });
});

test('20 parallel creates of one key: exactly one wins', async () => {
  const f = new FakePlatform(); const k = K('job', 'par');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => storeFor(f).putIfAbsent(k, { who: i })));
  assert.equal(results.filter((r) => r.created).length, 1);
  const winner = results.find((r) => r.created)!.value;
  for (const r of results) assert.deepEqual(r.value, winner);
});

test('latest version is found by probe and binary search for every N up to 300, in few calls', async () => {
  for (const n of [1, 2, 3, 4, 7, 8, 9, 31, 64, 100, 255, 256, 257, 300]) {
    const f = new FakePlatform(); const k = K('job', `n${n}`);
    for (let i = 1; i <= n; i += 1) f.insertRaw('work_record', `${k}@v${i}`, { i });
    f.clock.advance(60_000);
    const s = storeFor(f);
    const got = await s.getVersioned<{ i: number }>(k);
    assert.equal(got.version, n, `latest for N=${n}`); assert.equal(got.value!.i, n);
    assert.ok(s.calls.get + s.calls.list <= 30, `N=${n} used ${s.calls.get} gets and ${s.calls.list} lists`);
  }
});

test('absent key reads as version 0 with one get', async () => {
  const f = new FakePlatform(); const s = storeFor(f);
  assert.deepEqual(await s.getVersioned(K('job', 'none')), { value: null, version: 0 });
  assert.equal(s.calls.get, 1);
});

test('list lag: objects.list misses a fresh row while gets and CAS stay correct', async () => {
  const f = new FakePlatform(); f.listLagMs = 5000; const k = K('job', 'lag');
  const writer = storeFor(f);
  await writer.put(k, { v: 1 }); await writer.put(k, { v: 2 });
  // a second process: nothing cached. The list cannot see the rows yet (lag), the probe must still find v2.
  const reader = storeFor(f);
  const seen = await reader.getManyVersioned<{ v: number }>([k, K('job', 'absent')]);
  assert.equal(seen[0].version, 2); assert.equal(seen[0].value!.v, 2); assert.equal(seen[1].version, 0);
  assert.equal(f.log.filter((l) => l.path === 'objects.list').length > 0, true, 'the list was consulted');
  // and a CAS from that reader at the stale version 1 is rejected by the unique key, not by the list
  assert.deepEqual(await reader.putIfVersion(k, { v: 'x' }, 1), { ok: false, version: 2 });
  assert.deepEqual(await reader.putIfVersion(k, { v: 3 }, 2), { ok: true, version: 3 });
});

test('long key with a lagging list: the probe hint is only a lower bound', async () => {
  const f = new FakePlatform(); const k = K('job', 'long');
  for (let i = 1; i <= 40; i += 1) f.insertRaw('work_record', `${k}@v${i}`, { i });
  f.clock.advance(60_000);
  f.insertRaw('work_record', `${k}@v41`, { i: 41 }); // fresh: invisible to the list, visible to get
  assert.equal((await storeFor(f).getVersioned(k)).version, 41);
});

test('getManyVersioned batches lists at 100 keys and rejects more', async () => {
  const f = new FakePlatform(); const s = storeFor(f);
  const keys = Array.from({ length: 100 }, (_, i) => K('job', `m${i}`));
  await s.putIfAbsent(keys[0], { ok: true });
  const out = await storeFor(f).getManyVersioned(keys);
  assert.equal(out.length, 100); assert.equal(out[0].version, 1);
  await assert.rejects(s.getManyVersioned([...keys, 'x']), RangeError);
});

test('body over 131072 bytes fails loudly and writes nothing; exactly at the limit is accepted', async () => {
  const f = new FakePlatform(); const s = storeFor(f); const k = K('job', 'big');
  await assert.rejects(s.putIfAbsent(k, { pad: 'x'.repeat(MAX_BODY_BYTES) }), (e: Error) => e instanceof BodyTooLargeError && /131072/.test(e.message));
  assert.equal(f.rowCount(), 0);
  const overhead = JSON.stringify({ pad: '' }).length;
  await s.putIfAbsent(k, { pad: 'x'.repeat(MAX_BODY_BYTES - overhead) });
  assert.equal(f.rowCount(), 1);
  // multi-byte characters are counted as bytes, not characters
  await assert.rejects(s.putIfAbsent(K('job', 'mb'), { pad: '€'.repeat(50_000) }), BodyTooLargeError);
});

test('the fake itself rejects an oversized body with the live message', async () => {
  const f = new FakePlatform(); const api = f.deps().devrev(f.timerEvent());
  await assert.rejects(api.call('custom-objects.create', { leaf_type: 'work_record', unique_key: 'k@v1', custom_fields: { tnt__body: 'x'.repeat(MAX_BODY_BYTES + 1) } }, 'service'),
    (e: ApiError) => e.status === 400 && /too long, max allowed length is 131072/.test(e.message));
});

test('crash between two writes: the first is durable, the second never happened, and a new process continues', async () => {
  const f = new FakePlatform(); const a = K('job', 'a'); const b = K('index', 'b');
  f.crashAfterCreates(1);
  const s = storeFor(f);
  await assert.rejects(s.putIfAbsent(a, { first: true }), Crash);
  assert.ok(f.rows.has(`${a}@v1`), 'the write that the caller never saw is applied');
  assert.equal(f.rows.has(`${b}@v1`), false);
  const after = storeFor(f);
  assert.equal((await after.putIfAbsent(a, { first: 'again' })).created, false);
  assert.equal((await after.putIfAbsent(b, { second: true })).created, true);
  assert.deepEqual(await after.get(a), { first: true });
});

test('a timeout after the create landed is read back and treated as our write', async () => {
  const f = new FakePlatform(); const k = K('job', 'to');
  f.inject('custom-objects.create', { timeout: 'after' });
  const r = await storeFor(f).putIfAbsent(k, { mine: true });
  assert.equal(r.created, true);
  assert.equal(f.rowCount(), 1);
});

test('a timeout before the create is retried; a 429 is retried; a persistent 403 surfaces', async () => {
  const f = new FakePlatform(); const k = K('job', 'retry');
  f.inject('custom-objects.create', { timeout: 'before' }); f.inject('custom-objects.create', { status: 429, type: 'rate_limited' });
  assert.equal((await storeFor(f).putIfAbsent(k, { ok: 1 })).created, true);
  f.inject('custom-objects.create', { status: 403, type: 'forbidden', times: 5 });
  await assert.rejects(storeFor(f).putIfAbsent(K('job', 'denied'), { ok: 1 }), (e: ApiError) => e.status === 403);
  assert.equal(f.rows.has(`${K('job', 'denied')}@v1`), false);
});

test('a competing identical-looking create after an ambiguous timeout is not mistaken for ours', async () => {
  const f = new FakePlatform(); const k = K('job', 'amb');
  f.inject('custom-objects.create', { timeout: 'before' });
  f.raceBeforeCreate((u) => u === `${k}@v1`, () => undefined);
  f.insertRaw('work_record', `${k}@v1`, { theirs: true });
  const r = await storeFor(f).putIfAbsent(k, { mine: true });
  assert.equal(r.created, false); assert.deepEqual(r.value, { theirs: true });
});

test('a deleted key can be created again (platform fact)', async () => {
  const f = new FakePlatform(); const api = f.deps().devrev(f.timerEvent()); const k = K('job', 'del');
  await storeFor(f).putIfAbsent(k, { a: 1 });
  await api.call('custom-objects.delete', { id: f.rows.get(`${k}@v1`)!.id }, 'service');
  assert.equal((await storeFor(f).putIfAbsent(k, { a: 2 })).created, true);
});

test('the public get accepts id only; the adapter uses the internal get by unique_key', async () => {
  const f = new FakePlatform(); const s = storeFor(f);
  await s.putIfAbsent(K('job', 'g'), { a: 1 }); await storeFor(f).get(K('job', 'g'));
  assert.ok(f.log.some((l) => l.path === 'custom-objects.get' && l.status === 200));
  assert.equal(f.log.filter((l) => l.path === 'custom-objects.get' && l.status === 400).length, 0);
});

test('PlatformStore satisfies the engine Store shape', () => {
  const s: import('../../src/store.ts').Store = new PlatformStore({ api: { call: async () => ({}) } });
  assert.equal(typeof s.putIfVersion, 'function');
});
