import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { MemoryStore, makeKey } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import { defineConfig, CHECK_NAMES } from '../src/config.ts';
import type { CheckMode, CheckName, Spec } from '../src/types.ts';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;
const BOT = 'UBOT';

const SPEC: Spec = {
  workflow: 'wf-test',
  version: 1,
  link_roles: ['role1', 'role2', 'role3'],
  resources: ['r1'],
  people: { p1: { slack: 'U1' }, p2: { slack: 'U2' }, p3: { slack: 'U3' } },
  gates: {
    g1: { responders: { primary: ['p1'], stand_ins: ['p2'] } },
    g2: { responders: { primary: ['p3'], stand_ins: [] } },
  },
  milestones: {
    m1: { audience: { roles: ['role1'], promise_holders: true }, opens_ask: 'g1' },
    m2: { audience: { roles: ['role3'], promise_holders: false }, opens_ask: 'g2' },
    m_final: { audience: { roles: ['role1', 'role3'], promise_holders: true } },
  },
  actions: {
    a1: { resource: 'r1', gate: 'g1', proved_by: 'ev_a1' },
    a2: { gate: 'g2' },
    a3: { resource: 'r1' },
    a4: {},
  },
  defaults: { next_wake_minutes: 30, promise_fallback_minutes: 240, operation_unknown_minutes: 30 },
};

function setup(checks: Partial<Record<CheckName, CheckMode>> = {}) {
  const store = new MemoryStore();
  const clock = new ManualClock(T0);
  const builds: Record<string, string | null> = { g1: 'b1', g2: 'b1' };
  const slack: Record<string, { link?: string } | null> = {};
  const wakes: Array<{ dm: string; text: string }> = [];
  const engine = new Engine({
    store, clock,
    sourceReader: { currentBuild: async (_j, gate) => builds[gate] ?? null },
    slackReader: { findOwnPostAfter: async (thread) => slack[thread] ?? null },
    waker: { postWake: async (dm, text) => { wakes.push({ dm, text }); } },
    config: defineConfig({ env: 'test', bot: 'bot', ownBotUserId: BOT, checks }),
    specs: [SPEC],
  });
  return { store, clock, builds, slack, wakes, engine };
}
type Env = ReturnType<typeof setup>;

const S1 = { session_id: 's1' };
const S2 = { session_id: 's2' };

async function open(e: Env, target = 't1', thread = 'A', ctx: { session_id?: string } = S1, extra: Record<string, unknown> = {}) {
  const r = await e.engine.jobOpen({ workflow: 'wf-test', target, thread, ...extra }, ctx);
  return r.job as string;
}
async function ok(e: Env, jobs: string[]) {
  assert.deepEqual(await e.engine.checkInvariants(jobs), []);
}
function flagsOf(view: any): string[] { return view.jobs[0].flags.map((f: any) => f.check); }

test('store: getMany over 100 keys throws, key helper, putIfAbsent', async () => {
  const s = new MemoryStore();
  await assert.rejects(() => s.getMany(Array.from({ length: 101 }, (_, i) => `k${i}`)), /at most 100/);
  assert.equal((await s.getMany(Array.from({ length: 100 }, (_, i) => `k${i}`))).length, 100);
  assert.equal(makeKey('dev', 'b', 'job', 'x:y'), 'work-engine:dev:b:job:x:y');
  assert.equal((await s.putIfAbsent('k', 1)).created, true);
  assert.deepEqual(await s.putIfAbsent('k', 2), { created: false, value: 1 });
  assert.equal('list' in s || 'scan' in s, false);
});

test('config: every check defaults to flag; missing_session is not configurable', () => {
  const c = defineConfig({ env: 'e', bot: 'b', ownBotUserId: 'U', checks: { lease_held: 'hold', missing_session: 'hold' } });
  for (const n of CHECK_NAMES) assert.equal(c.checks[n], n === 'lease_held' ? 'hold' : 'flag');
  assert.equal('missing_session' in c.checks, false);
  assert.equal(c.runTimeoutMinutes, 20);
  assert.equal(c.sweepMinutes, 5);
});

test('job_open: create, join, replace, queue, bad input never throws', async () => {
  const e = setup();
  const r1 = await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, S1);
  assert.equal(r1.status, 'opened');
  assert.equal(r1.work_run, 'you');
  assert.match(r1.say_to_tony, /Opened wf-test:t1/);
  const r2 = await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'B', role: 'role2' }, S2);
  assert.equal(r2.status, 'joined');
  assert.equal(r2.work_run, 'other');
  assert.match(r2.say_to_tony, /Already running/);
  const v = await e.engine.jobView({ thread: 'B' }, S2);
  assert.equal((v.jobs as any[])[0].threads.length, 2);
  // queue
  const q = await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'C', intent: 'queue' }, S2);
  assert.equal(q.status, 'queued');
  // replace: old job (nothing in flight) is cancelled, new one opens
  const rep = await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'D', intent: 'replace' }, S2);
  assert.equal(rep.status, 'opened');
  const old = await e.engine.jobView({ job: 'wf-test:t1' }, S2);
  assert.equal((old.jobs as any[])[0].status, 'cancelled');
  // bad input
  assert.equal((await e.engine.jobOpen({ workflow: 'nope', target: 't', thread: 'x' }, S1)).ok, false);
  assert.equal((await e.engine.jobOpen({ workflow: 'wf-test', target: '', thread: 'x' }, S1)).ok, false);
  await ok(e, ['wf-test:t1', 'wf-test:t1#2', 'wf-test:t1#3']);
});

test('job_open: replace with an operation in flight gives cancel_requested', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.intend({ job, action: 'a3', ref: 'x' }, S1);
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'B', intent: 'replace' }, S2);
  const v = await e.engine.jobView({ job });
  assert.equal((v.jobs as any[])[0].status, 'cancel_requested');
  await ok(e, [job, 'wf-test:t1#2']);
});

test('job_view: unlinked thread lists open jobs; several jobs on one thread', async () => {
  const e = setup();
  await open(e, 't1', 'A');
  const none = await e.engine.jobView({ thread: 'ZZ' });
  assert.equal(none.status, 'no_job_here');
  assert.match(none.say_to_tony, /wf-test:t1/);
  await open(e, 't2', 'A');
  const many = await e.engine.jobView({ thread: 'A' });
  assert.equal((many.jobs as any[]).length, 2);
  assert.match(many.say_to_tony, /2 jobs/);
  assert.equal((await e.engine.jobView({})).ok, false);
  assert.equal((await e.engine.jobView({ job: 'missing' })).ok, false);
});

test('intend: records in flight, takes the lease, answers the ask, idempotent per job+action+ref', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  const r1 = await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
  assert.equal(r1.status, 'clear');
  assert.equal((r1.operation as any).outcome, 'in_flight');
  const r2 = await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
  assert.equal(r2.status, 'already_recorded');
  assert.equal((r2.operation as any).key, (r1.operation as any).key);
  const v = await e.engine.jobView({ job });
  const j = (v.jobs as any[])[0];
  assert.equal(j.operations.length, 1);
  assert.equal(j.open_asks.length, 0, 'ask marked answered');
  await ok(e, [job]);
  // unknown action: recorded, no refusal
  const r3 = await e.engine.intend({ job, action: 'zz', ref: 'q' }, S1);
  assert.equal(r3.ok, true);
  assert.equal((await e.engine.intend({ job, action: '', ref: 'q' }, S1)).ok, false);
});

for (const mode of ['flag', 'hold'] as const) {
  test(`checks under ${mode}: superseded_run`, async () => {
    const e = setup({ superseded_run: mode });
    const job = await open(e, 't1', 'A', S1);
    const r = await e.engine.intend({ job, action: 'a4', ref: 'x' }, S2);
    if (mode === 'hold') {
      assert.equal(r.status, 'hold');
      assert.match(r.say_to_tony, /superseded_run/);
      assert.equal((r.operation as any).outcome, 'held');
    } else {
      assert.equal(r.status, 'clear');
      assert.match(r.say_to_tony, /superseded_run/);
    }
    assert.ok(flagsOf(await e.engine.jobView({ job })).includes('superseded_run'));
    await ok(e, [job]);
  });

  test(`checks under ${mode}: job_cancelled`, async () => {
    const e = setup({ job_cancelled: mode });
    const job = await open(e);
    await e.engine.checkpoint({ job, status: 'cancelled' }, S1);
    const r = await e.engine.intend({ job, action: 'a4', ref: 'x' }, S1);
    assert.equal(r.status, mode === 'hold' ? 'hold' : 'clear');
    assert.match(r.say_to_tony, /job_cancelled/);
    if (mode === 'flag') {
      // flagged work on a cancelled job must not leave the job closed with an operation in flight
      assert.equal((await e.engine.jobView({ job })).jobs ? ((await e.engine.jobView({ job })).jobs as any[])[0].status : '', 'cancel_requested');
    }
    await ok(e, [job]);
  });

  test(`checks under ${mode}: lease_held`, async () => {
    const e = setup({ lease_held: mode });
    const a = await open(e, 't1', 'A', S1);
    const b = await open(e, 't2', 'B', S2);
    assert.equal((await e.engine.intend({ job: a, action: 'a3', ref: 'x' }, S1)).status, 'clear');
    const r = await e.engine.intend({ job: b, action: 'a3', ref: 'y' }, S2);
    assert.equal(r.status, mode === 'hold' ? 'hold' : 'clear');
    assert.match(r.say_to_tony, /lease_held/);
    // when held, b must not own the lease; when flagged, lease stays with a
    assert.deepEqual(await e.engine.checkInvariants([a, b]), []);
    if (mode === 'hold') assert.equal((r.operation as any).lease_taken, false);
    else assert.equal((r.operation as any).lease_taken, false, 'flag mode never steals the lease');
  });

  test(`checks under ${mode}: build_changed`, async () => {
    const e = setup({ build_changed: mode });
    const job = await open(e);
    await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
    e.builds.g1 = 'b2';
    const r = await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
    assert.equal(r.status, mode === 'hold' ? 'hold' : 'clear');
    assert.match(r.say_to_tony, /build b1.*b2/);
    if (mode === 'hold') assert.match(r.say_to_tony, /Ask the responders again for build b2/);
    await ok(e, [job]);
  });
}

test('sender_not_listed: stand-in accepted, stranger flagged or held', async () => {
  for (const mode of ['flag', 'hold'] as const) {
    const e = setup({ sender_not_listed: mode });
    const job = await open(e);
    await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
    await e.engine.ingest({ source: 'slack', delivery_id: 'stand', kind: 'message', thread: 'A', sender_id: 'U2' });
    await e.engine.ingest({ source: 'slack', delivery_id: 'bad', kind: 'message', thread: 'A', sender_id: 'U9' });
    const bad = await e.engine.intend({ job, action: 'a4', ref: 'x', because: 'slack:bad' }, S1);
    assert.doesNotMatch(bad.say_to_tony, /sender_not_listed/, 'a4 has no gate so there is no list to check');
    const bad2 = await e.engine.intend({ job, action: 'a1', ref: 'x2', because: 'slack:bad' }, S1);
    assert.match(bad2.say_to_tony, /sender_not_listed/);
    assert.equal(bad2.status, mode === 'hold' ? 'hold' : 'clear');
    const good = await e.engine.intend({ job, action: 'a1', ref: 'x3', because: 'slack:stand' }, S1);
    assert.doesNotMatch(good.say_to_tony, /sender_not_listed/);
    await ok(e, [job]);
  }
});

test('missing session is flagged; a consequential call is held (A2 replaces D1 never-hold), reads still work', async () => {
  // A2 (job-home contract): missing identity never establishes action authority, so intend answers hold
  // whatever the check config says. The flag stays visible and the read is never refused.
  const e = setup();
  const job = await open(e, 't1', 'A', {});
  const r = await e.engine.intend({ job, action: 'a4', ref: 'x' }, {});
  assert.equal(r.status, 'hold');
  assert.equal(r.reason, 'ownership_unconfirmed');
  const v = await e.engine.jobView({ job });
  assert.ok(flagsOf(v).includes('missing_session'));
  assert.ok(flagsOf(v).includes('identity_unconfirmed'));
  assert.equal(flagsOf(v).filter((f: string) => f === 'superseded_run').length, 0);
  await ok(e, [job]);
});

test('say: go, already_claimed, busy, already_sent', async () => {
  const e = setup();
  const job = await open(e);
  const g = await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  assert.equal(g.status, 'go');
  assert.match(g.say_to_tony, /ask for g1 on build b1/);
  e.clock.advance(2 * MIN);
  const again = await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  assert.equal(again.status, 'go', 'the owner gets go again');
  const other = await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S2);
  assert.equal(other.status, 'busy', 'a second session is told not to post while the claim is fresh');
  assert.match(other.say_to_tony, /Do not post/);
  const busy = await e.engine.say({ job, thread: 'A', milestone: 'm_final' }, S1);
  assert.equal(busy.status, 'busy');
  assert.match(busy.say_to_tony, /a claim for m1 is open/);
  e.clock.advance(11 * MIN);
  const stale = await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S2);
  assert.equal(stale.status, 'already_claimed', 'a stale claim is handed over with a read-the-thread instruction');
  assert.match(stale.say_to_tony, /post only if the message is absent/);
  await e.engine.ingest({ source: 'slack', delivery_id: 'p1', kind: 'message', thread: 'A', sender_id: BOT, attrs: { link: 'https://x/p1', ts: e.clock.now() } });
  const sent = await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  assert.equal(sent.status, 'already_sent');
  assert.equal(sent.link, 'https://x/p1');
  assert.equal((await e.engine.say({ job, thread: 'A', milestone: 'm_final' }, S1)).status, 'go');
  assert.equal((await e.engine.say({ job: 'none', thread: 'A', milestone: 'm1' }, S1)).ok, false);
  await ok(e, [job]);
});

test('say: first claim marks the milestone reached (tony_reported)', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  const v = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(v[0].milestones.m1.source, 'tony_reported');
});

test('ingest: own-bot post matches the claim, fulfils the promise; duplicate is ignored', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'B', role: 'role2' }, S1);
  await e.engine.promiseAdd({ job, thread: 'B', about: 'm1', fallback_time: 60 }, S1);
  await e.engine.say({ job, thread: 'B', milestone: 'm1' }, S1);
  e.clock.advance(1000);
  const ev = { source: 'slack', delivery_id: 'post1', kind: 'message', thread: 'B', sender_id: BOT, attrs: { ts: e.clock.now() } };
  const r = await e.engine.ingest(ev);
  assert.match(r.say_to_tony, /matched the m1 claim/);
  const dup = await e.engine.ingest(ev);
  assert.equal(dup.status, 'duplicate');
  const v = (await e.engine.jobView({ job })).jobs as any[];
  assert.deepEqual(v[0].sent.map((s: any) => s.thread), ['B']);
  assert.equal(v[0].promises[0].state, 'fulfilled');
  assert.equal(v[0].claims.length, 0);
  await ok(e, [job]);
});

test('ingest: own-bot post with no claim is recorded and flagged unclaimed_post', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.ingest({ source: 'slack', delivery_id: 'x', kind: 'message', thread: 'A', sender_id: BOT });
  const v = await e.engine.jobView({ job });
  assert.ok(flagsOf(v).includes('unclaimed_post'));
  await ok(e, [job]);
});

test('ingest: unblock rules set next wake to now (responder, other bot, watched ref)', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  await e.engine.checkpoint({ job, status: 'waiting', next_wake_in: '120m' }, S1);
  e.clock.advance(MIN);
  await e.engine.ingest({ source: 'slack', delivery_id: 'h', kind: 'message', thread: 'A', sender_id: 'U5' });
  let j = (await e.engine.jobView({ job })).jobs as any[];
  // A4 (replaces the earlier "a stranger does not wake"): every human message in a linked thread is an inbox
  // item, and an item for an idle home sets the wake to now. The owner reads it and decides.
  assert.equal(j[0].next_wake_at, e.clock.now(), 'a stranger message is an inbox item and wakes the idle home');
  assert.equal(j[0].inbox_unprocessed, 1);
  await e.engine.checkpoint({ job, status: 'waiting', next_wake_in: '120m' }, S1);
  await e.engine.ingest({ source: 'slack', delivery_id: 'resp', kind: 'message', thread: 'A', sender_id: 'U1' });
  j = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(j[0].next_wake_at, e.clock.now(), 'responder wakes');
  await e.engine.checkpoint({ job, status: 'waiting', next_wake_in: '120m' }, S1);
  await e.engine.ingest({ source: 'slack', delivery_id: 'bot', kind: 'message', thread: 'A', sender_kind: 'other_bot', sender_id: 'UOTHER' });
  j = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(j[0].next_wake_at, e.clock.now(), 'other bot wakes');
  await e.engine.intend({ job, action: 'a3', ref: 'pr9' }, S1);
  await e.engine.checkpoint({ job, status: 'waiting', next_wake_in: '120m' }, S1);
  await e.engine.ingest({ source: 'ext', delivery_id: 'w', kind: 'unrelated', ref: 'pr9' });
  j = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(j[0].next_wake_at, e.clock.now(), 'watched ref wakes');
  await ok(e, [job]);
});

test('ingest: proved_by event verifies the operation and releases the lease', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
  await e.engine.ingest({ source: 'ext', delivery_id: 'd1', kind: 'ev_a1', ref: 'pr1', attrs: { gate: 'g1' } });
  const j = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(j[0].operations[0].outcome, 'done');
  assert.equal(j[0].operations[0].source, 'webhook_verified');
  await ok(e, [job]);
});

test('promise_add: fallback required, default applied and said; duplicates are no-ops', async () => {
  const e = setup();
  const job = await open(e);
  const r = await e.engine.promiseAdd({ job, thread: 'B', about: 'm_final' }, S1);
  assert.equal(r.status, 'promised');
  assert.match(r.say_to_tony, /default of 240 minutes/);
  assert.equal(((r.promise as any).fallback_at - e.clock.now()) / MIN, 240);
  const r2 = await e.engine.promiseAdd({ job, thread: 'B', about: 'm_final', fallback_time: 10 }, S1);
  assert.equal(r2.status, 'already_promised');
  const r3 = await e.engine.promiseAdd({ job, thread: 'C', about: 'm1', fallback_time: new Date(e.clock.now() + 5 * MIN).toISOString() }, S1);
  assert.equal(((r3.promise as any).fallback_at - e.clock.now()) / MIN, 5);
  assert.equal((await e.engine.promiseAdd({ job, thread: '', about: 'm1' }, S1)).ok, false);
  await ok(e, [job]);
});

test('promise past fallback: sweep marks it due and wakes', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.promiseAdd({ job, thread: 'B', about: 'm_final', fallback_time: 10 }, S1);
  await e.engine.checkpoint({ job, status: 'waiting', next_wake_in: '600m' }, S1);
  e.clock.advance(11 * MIN);
  e.clock.advance(5 * MIN);
  const sw = await e.engine.sweep();
  assert.equal((sw as any).promises_due, 1);
  assert.equal(e.wakes.length, 1);
  assert.match(e.wakes[0].text, /promise due: m_final to B/);
  await ok(e, [job]);
});

test('checkpoint: commits status, reached milestones, outcomes; next wake always set', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
  const r = await e.engine.checkpoint({ job, status: 'merging', waiting_for: 'CI', next_wake_in: '5m', reached: ['m1'], operations: [{ ref: 'pr1', outcome: 'done', note: 'ok' }] }, S1);
  assert.equal(r.status, 'open');
  assert.equal(r.next_wake_at, e.clock.now() + 5 * MIN);
  const j = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(j[0].operations[0].outcome, 'done');
  assert.ok(j[0].milestones.m1);
  assert.equal(j[0].owed.length, 1, 'm1 is owed to the role1 thread');
  const d = await e.engine.checkpoint({ job, status: 'x' }, S1);
  assert.equal(d.next_wake_at, e.clock.now() + 30 * MIN, 'spec default wake');
  // lease released: another job can take r1 cleanly
  const b = await open(e, 't2', 'B', S2);
  assert.equal((await e.engine.intend({ job: b, action: 'a3', ref: 'z' }, S2)).status, 'clear');
  assert.doesNotMatch((await e.engine.intend({ job: b, action: 'a3', ref: 'z2' }, S2)).say_to_tony, /lease_held/);
  await ok(e, [job, b]);
});

test('checkpoint done while deliveries are owed => closing; closes when the post is seen', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.checkpoint({ job, status: 'x', reached: ['m_final'] }, S1);
  const r = await e.engine.checkpoint({ job, status: 'done' }, S1);
  assert.equal(r.status, 'closing');
  assert.match(r.say_to_tony, /still owed: m_final to A/);
  assert.equal(typeof r.next_wake_at, 'number');
  await ok(e, [job]);
  // the sweep wakes with the owed reason
  e.clock.advance(31 * MIN);
  await e.engine.sweep();
  assert.match(e.wakes.at(-1)!.text, /still owed: m_final to A/);
  // deliver it
  const s = await e.engine.say({ job, thread: 'A', milestone: 'm_final' }, S2);
  assert.equal(s.status, 'go');
  await e.engine.ingest({ source: 'slack', delivery_id: 'fin', kind: 'message', thread: 'A', sender_id: BOT, attrs: { ts: e.clock.now() } });
  const v = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(v[0].status, 'done');
  await ok(e, [job]);
  // done without owed closes at once
  const j2 = await open(e, 't2', 'Q');
  assert.equal((await e.engine.checkpoint({ job: j2, status: 'done' }, S1)).status, 'done');
});

test('checkpoint cancelled with an operation in flight => cancel_requested, then cancelled on outcome', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
  const r = await e.engine.checkpoint({ job, status: 'cancelled' }, S1);
  assert.equal(r.status, 'cancel_requested');
  assert.match(r.say_to_tony, /in flight/);
  assert.equal((await e.engine.checkInvariants([job])).length, 0);
  const r2 = await e.engine.checkpoint({ job, status: 'cancelled', operations: [{ ref: 'pr1', outcome: 'failed', note: 'aborted' }] }, S1);
  assert.equal(r2.status, 'cancelled');
  await ok(e, [job]);
});

test('operation in flight past the timeout shows unknown; sweep turns it unknown and wakes', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.intend({ job, action: 'a1', ref: 'pr1' }, S1);
  await e.engine.checkpoint({ job, status: 'publishing', next_wake_in: '600m' }, S1);
  e.clock.advance(31 * MIN);
  const view = await e.engine.jobView({ job });
  assert.match(view.say_to_tony, /a1 pr1 unknown/);
  await e.engine.sweep();
  assert.equal(e.wakes.length, 1);
  assert.match(e.wakes[0].text, /operation a1 pr1 has no outcome/);
  const j = (await e.engine.jobView({ job })).jobs as any[];
  assert.equal(j[0].operations[0].outcome, 'unknown');
  // Tony can resolve it later
  await e.engine.checkpoint({ job, status: 'x', operations: [{ ref: 'pr1', outcome: 'done' }] }, S1);
  await ok(e, [job]);
});

test('sweep wakes a job whose next wake passed; twin wake is a no-op', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.checkpoint({ job, status: 'waiting', next_wake_in: '5m' }, S1);
  e.clock.advance(4 * MIN);
  assert.equal(((await e.engine.sweep()) as any).woke.length, 0, 'not yet');
  e.clock.advance(2 * MIN);
  const sw = await e.engine.sweep();
  assert.deepEqual((sw as any).woke, [job]);
  assert.equal(e.wakes.length, 1);
  assert.equal(e.wakes[0].dm, `dm:${job}`);
  assert.match(e.wakes[0].text, /job_view/);
  // twin: a second wake while the run is active does nothing
  const twin = await e.engine.wake(job, 'twin');
  assert.equal(twin.status, 'run_active');
  assert.equal(e.wakes.length, 1);
  // two wakes racing with no active run create one run
  const e2 = setup();
  const j2 = await open(e2);
  await e2.engine.checkpoint({ job: j2, status: 'w', next_wake_in: '1m' }, S1);
  e2.clock.advance(25 * MIN);
  const [a, b] = await Promise.all([e2.engine.wake(j2, 'one'), e2.engine.wake(j2, 'two')]);
  assert.deepEqual([a.status, b.status].sort(), ['run_active', 'woke']);
  assert.equal(e2.wakes.length, 1);
  // first session to call binds the pending run
  const r = await e2.engine.intend({ job: j2, action: 'a4', ref: 'x' }, S2);
  assert.equal(r.status, 'clear');
  assert.doesNotMatch(r.say_to_tony, /superseded_run/);
  await ok(e2, [j2]);
  await ok(e, [job]);
});

test('sweep: unseen claim is reconciled through the Slack reader; missed post never double counts', async () => {
  const e = setup();
  const job = await open(e);
  await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  e.clock.advance(6 * MIN);
  let sw = await e.engine.sweep();
  assert.equal((sw as any).claims_not_seen, 1);
  assert.match((await e.engine.jobView({ job })).say_to_tony, /claimed, not seen yet/);
  e.slack['A'] = { link: 'https://x/found' };
  e.clock.advance(6 * MIN);
  sw = await e.engine.sweep();
  assert.equal((sw as any).claims_reconciled, 1);
  const again = await e.engine.say({ job, thread: 'A', milestone: 'm1' }, S1);
  assert.equal(again.status, 'already_sent');
  // the connector then shows up late: still sent once
  await e.engine.ingest({ source: 'slack', delivery_id: 'late', kind: 'message', thread: 'A', sender_id: BOT, attrs: { ts: e.clock.now() } });
  await ok(e, [job]);
});

test('private evidence from one thread is shown to another thread as held', async () => {
  const e = setup();
  const job = await open(e, 't1', 'A');
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'P', role: 'role2', private: true }, S1);
  await e.engine.ingest({ source: 'slack', delivery_id: 'secret', kind: 'message', thread: 'P', sender_id: 'U5' });
  const fromA = await e.engine.jobView({ thread: 'A' });
  assert.match(fromA.say_to_tony, /held: evidence from another thread/);
  assert.doesNotMatch(fromA.say_to_tony, /U5/);
  const fromP = await e.engine.jobView({ thread: 'P' });
  assert.match(fromP.say_to_tony, /U5/);
  await ok(e, [job]);
});

test('run: a session that is not the work run is flagged on writes, and takes over after the run times out', async () => {
  const e = setup();
  const job = await open(e, 't1', 'A', S1);
  await e.engine.checkpoint({ job, status: 'note' }, S2);
  assert.ok(flagsOf(await e.engine.jobView({ job })).includes('not_work_run'));
  e.clock.advance(21 * MIN);
  const r = await e.engine.intend({ job, action: 'a4', ref: 'x' }, S2);
  assert.doesNotMatch(r.say_to_tony, /superseded_run/);
  await ok(e, [job]);
});

test('answers always carry say_to_tony and never throw on bad input', async () => {
  const e = setup();
  const calls = await Promise.all([
    e.engine.jobOpen({ workflow: 'wf-test', target: '', thread: '' }),
    e.engine.jobView({}),
    e.engine.intend({ job: 'none', action: 'a', ref: 'b' }),
    e.engine.say({ job: 'none', thread: 't', milestone: 'm' }),
    e.engine.promiseAdd({ job: 'none', thread: 't', about: 'm' }),
    e.engine.checkpoint({ job: 'none', status: 'x' }),
    e.engine.ingest({ source: '', delivery_id: '', kind: '' }),
    e.engine.wake('none', 'r'),
  ]);
  for (const c of calls) {
    assert.equal(typeof c.say_to_tony, 'string');
    assert.ok(c.say_to_tony.length > 10);
  }
});

// ---------------------------------------------------------------- job-home contract (A1 to A4, R20 to R24)

import { FakeSessionDirectory, homeForAllSessions } from '../src/session-directory.ts';

function homeSetup(extra: { inboxMaxUnprocessed?: number; noticeCoalesceMinutes?: number; identityEscalateMinutes?: number; guidanceVersion?: string } = {}) {
  const store = new MemoryStore();
  const clock = new ManualClock(T0);
  const dir = new FakeSessionDirectory();
  const wakes: Array<{ dm: string; text: string }> = [];
  const state = { stale: false, builds: { g1: 'b1', g2: 'b1' } as Record<string, string | null> };
  const engine = new Engine({
    store, clock, sessionDirectory: dir,
    sourceReader: { currentBuild: async (_j, g) => state.builds[g] ?? null },
    slackReader: { findOwnPostAfter: async () => null },
    waker: { postWake: async (dm, text) => { wakes.push({ dm, text }); if (state.stale && !/notice/.test(text)) { state.stale = false; return { stale_version: true }; } } },
    config: defineConfig({ env: 'test', bot: 'bot', ownBotUserId: BOT, ...extra }),
    specs: [SPEC],
  });
  const JOB = 'wf-test:t1';
  dir.set('h1', `dm:${JOB}`); dir.set('h2', `dm:${JOB}:g2`); dir.set('m1', 'dm:mention:m1');
  return { store, clock, dir, wakes, state, engine, JOB };
}
const H1 = { session_id: 'h1' };
const M1 = { session_id: 'm1' };

test('A1: a mention session can read, join and promise, but intend and say are routed to the owner', async () => {
  const e = homeSetup();
  const r = await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, M1);
  assert.equal(r.work_run, 'none', 'a mention session never becomes the work run');
  const h = await e.engine.checkpoint({ job: e.JOB, status: 'working' }, H1);
  assert.equal(h.ok, true);
  const i = await e.engine.intend({ job: e.JOB, action: 'a3', ref: 'x' }, M1);
  assert.equal(i.status, 'route');
  assert.equal(i.operation, undefined);
  const s = await e.engine.say({ job: e.JOB, thread: 'A', milestone: 'm1' }, M1);
  assert.equal(s.status, 'route');
  assert.match(s.say_to_tony, /job owner will tell/);
  const c = await e.engine.checkpoint({ job: e.JOB, status: 'done', operations: [{ ref: 'x', action: 'a3', outcome: 'done' }], reached: ['m1'] }, M1);
  assert.equal((c as any).job_status, 'open', 'a non-home checkpoint never changes status');
  assert.match(c.say_to_tony, /not applied/);
  const q = await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'B', intent: 'replace' }, M1);
  assert.equal(q.status, 'route');
  assert.equal((await e.engine.promiseAdd({ job: e.JOB, thread: 'A', about: 'm_final' }, M1)).status, 'promised');
  const v = (await e.engine.jobView({ job: e.JOB }, H1)).jobs as any[];
  assert.ok(v[0].inbox_unprocessed >= 4);
  assert.equal(v[0].status, 'open');
  const run = await e.store.get<any>(makeKey('test', 'bot', 'run', `${e.JOB}:1`));
  assert.equal(run.session_id, 'h1');
  await ok(e as unknown as Env, [e.JOB]);
});

test('A2: lookup failure or no session holds consequential calls in every config; reads and promises work; escalates', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  e.dir.set('h3', `dm:${e.JOB}`); // a session whose lookup was never cached
  const H3 = { session_id: 'h3' };
  e.dir.fail('*');
  for (const [name, r] of [
    ['intend', await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'x' }, H3)],
    ['say', await e.engine.say({ job: e.JOB, thread: 'A', milestone: 'm1' }, H3)],
    ['checkpoint', await e.engine.checkpoint({ job: e.JOB, status: 'done' }, H3)],
    ['no session', await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'x' }, {})],
  ] as const) {
    assert.equal(r.status, 'hold', name);
    assert.equal(r.reason, 'ownership_unconfirmed', name);
  }
  const job = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.equal(job.op_keys.length, 0);
  assert.equal(job.status, 'open');
  assert.equal((await e.engine.promiseAdd({ job: e.JOB, thread: 'A', about: 'm_final' }, H3)).status, 'promised');
  const v = await e.engine.jobView({ job: e.JOB }, H3);
  assert.ok(flagsOf(v).includes('identity_unconfirmed'));
  const job2 = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.match(job2.wake_reasons.join(';'), /identity unconfirmed for h3; resume from the job home/);
  e.clock.advanceMinutes(31);
  await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'x' }, H3);
  await e.engine.sweep();
  assert.ok(flagsOf(await e.engine.jobView({ job: e.JOB }, H1)).includes('escalate'));
  assert.ok(e.wakes.some((w) => /escalate: identity/.test(w.text)));
  e.dir.fail('*', false); // failures are never cached
  assert.equal((await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'x' }, H3)).status, 'clear');
  assert.equal((await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB))).identity, null);
});

test('A1: successful lookups are cached, failures are not', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'x' }, H1);
  await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'y' }, H1);
  assert.equal(e.dir.lookups, 1);
  e.dir.fail('m1');
  await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'z' }, M1);
  await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'z' }, M1);
  assert.equal(e.dir.lookups, 3);
});

test('A3: replaceHome bumps the generation, fences the old session, hands over unknown operations', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.intend({ job: e.JOB, action: 'a3', ref: 'x' }, H1);
  const r = await e.engine.replaceHome(e.JOB, 'test');
  assert.equal(r.status, 'replaced');
  const job = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.equal(job.generation, 2);
  assert.equal(job.dm_id, `dm:${e.JOB}:g2`);
  assert.deepEqual(job.homes.map((h: any) => h.closed_at !== null), [true, false]);
  assert.match(e.wakes[e.wakes.length - 1].text, /read back first: a3 x \(unknown\)/);
  assert.equal(e.wakes[e.wakes.length - 1].dm, `dm:${e.JOB}:g2`);
  const old = await e.engine.checkpoint({ job: e.JOB, status: 'done' }, H1);
  assert.equal(old.status, 'superseded');
  assert.match(old.say_to_tony, /moved to a new home/);
  assert.equal((await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'q' }, H1)).status, 'superseded');
  assert.equal((await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB))).status, 'open');
  assert.equal((await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'q' }, { session_id: 'h2' })).status, 'clear');
  await ok(e as unknown as Env, [e.JOB]);
});

test('A3: a wake that reports a stale version replaces the home', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  e.state.stale = true;
  e.clock.advanceMinutes(45);
  await e.engine.sweep();
  assert.equal((await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB))).generation, 2);
  assert.equal(e.wakes[e.wakes.length - 1].dm, `dm:${e.JOB}:g2`);
});

test('A4: inbox items are per job, ambiguous for shared threads, folded over the bound, acknowledged by processed', async () => {
  const e = homeSetup({ inboxMaxUnprocessed: 3 });
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't2', thread: 'A' }, H1);
  await e.engine.ingest({ source: 'slack', delivery_id: 'x1', kind: 'message', thread: 'A', sender_id: 'U1' });
  let v = (await e.engine.jobView({ job: 'wf-test:t1' }, H1)).jobs as any[];
  assert.equal(v[0].inbox.length, 1);
  assert.equal(v[0].inbox[0].ambiguous, true);
  const amb = await e.engine.intend({ job: 'wf-test:t1', action: 'a2', ref: 'p', because: 'slack:x1' }, H1);
  assert.ok(flagsOf(await e.engine.jobView({ job: 'wf-test:t1' }, H1)).includes('ambiguous_association'));
  assert.match(amb.say_to_tony, /ambiguous_association/);
  for (let i = 0; i < 6; i++) await e.engine.ingest({ source: 'slack', delivery_id: `m${i}`, kind: 'message', thread: 'A', sender_id: 'U9' });
  v = (await e.engine.jobView({ job: 'wf-test:t1' }, H1)).jobs as any[];
  assert.ok(v[0].inbox.some((i: any) => i.count > 0), 'overflow item');
  assert.equal(v[0].inbox.filter((i: any) => i.count).length, 1);
  const explicit = await e.engine.checkpoint({ job: 'wf-test:t1', status: 'working', processed: ['slack:x1'] }, H1);
  assert.match(explicit.say_to_tony, /processed/);
  v = (await e.engine.jobView({ job: 'wf-test:t1' }, H1)).jobs as any[];
  assert.equal(v[0].inbox_unprocessed, 0, 'items shown in the view are processed by the next owner checkpoint');
});

test('A4: a notice is posted into an active home, coalesced; an idle home is woken instead', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.intend({ job: e.JOB, action: 'a4', ref: 'x' }, H1); // the owner is mid-work: run active
  await e.engine.ingest({ source: 'slack', delivery_id: 'a', kind: 'message', thread: 'A', sender_id: 'U9' });
  await e.engine.ingest({ source: 'slack', delivery_id: 'b', kind: 'message', thread: 'A', sender_id: 'U9' });
  assert.equal(e.wakes.filter((w) => /notice/.test(w.text)).length, 1);
  e.clock.advanceMinutes(3);
  await e.engine.ingest({ source: 'slack', delivery_id: 'c', kind: 'message', thread: 'A', sender_id: 'U9' });
  assert.equal(e.wakes.filter((w) => /notice/.test(w.text)).length, 2);
  e.clock.advanceMinutes(60); // the run goes quiet
  await e.engine.ingest({ source: 'slack', delivery_id: 'd', kind: 'message', thread: 'A', sender_id: 'U9' });
  const job = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.ok(job.next_wake_at <= e.clock.now(), 'idle home: wake now');
});

test('A4: input after the job ended is a late item and never reopens it', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.checkpoint({ job: e.JOB, status: 'done' }, H1);
  await e.engine.ingest({ source: 'slack', delivery_id: 'l', kind: 'message', thread: 'A', sender_id: 'U1' });
  const v = (await e.engine.jobView({ job: e.JOB }, H1)).jobs as any[];
  assert.equal(v[0].status, 'done');
  assert.equal(v[0].late.length, 1);
});

test('R20 and R21: a revoked go is caught at intend; a cancel from an unlisted sender is recorded and flagged', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.say({ job: e.JOB, thread: 'A', milestone: 'm1' }, H1);
  await e.engine.ingest({ source: 'slack', delivery_id: 'go', kind: 'message', thread: 'A', sender_id: 'U1' });
  e.clock.advance(MIN);
  await e.engine.ingest({ source: 'slack', delivery_id: 'stop', kind: 'message', thread: 'A', sender_id: 'U1', attrs: { inbox_kind: 'cancel' } });
  const r = await e.engine.intend({ job: e.JOB, action: 'a1', ref: 'pr', because: 'slack:go' }, H1);
  assert.match(r.say_to_tony, /revoked/);
  await e.engine.ingest({ source: 'slack', delivery_id: 'cx', kind: 'message', thread: 'A', sender_id: 'U9', attrs: { inbox_kind: 'cancel' } });
  assert.ok(flagsOf(await e.engine.jobView({ job: e.JOB }, H1)).includes('sender_not_listed'));
});

test('R22: a cancel with an unknown operation keeps the lease and a wake until readback', async () => {
  const e = homeSetup();
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  await e.engine.intend({ job: e.JOB, action: 'a3', ref: 'x' }, H1);
  const c = await e.engine.checkpoint({ job: e.JOB, status: 'cancelled', operations: [{ ref: 'x', action: 'a3', outcome: 'unknown' }] }, H1);
  assert.equal((c as any).job_status, 'cancelled');
  const lk = makeKey('test', 'bot', 'lease', 'r1');
  assert.equal((await e.store.get<any>(lk)).holder_job, e.JOB);
  let job = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.deepEqual(job.cleanup_pending, [`${e.JOB}:a3:x`]);
  assert.notEqual(job.next_wake_at, null);
  e.clock.advanceMinutes(125);
  await e.engine.sweep();
  job = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.equal(job.cleanup_escalated, true);
  await e.engine.checkpoint({ job: e.JOB, status: 'working', operations: [{ ref: 'x', action: 'a3', outcome: 'failed' }] }, H1);
  assert.equal((await e.store.get<any>(lk)).holder_job, null);
  job = await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB));
  assert.deepEqual(job.cleanup_pending, []);
  assert.equal(job.next_wake_at, null);
  await ok(e as unknown as Env, [e.JOB]);
});

test('R23: no check changes with the contract; config defaults for the new bounds', () => {
  const c = defineConfig({ env: 'e', bot: 'b', ownBotUserId: 'U' });
  assert.equal(c.identityEscalateMinutes, 30);
  assert.equal(c.noticeCoalesceMinutes, 2);
  assert.equal(c.inboxMaxUnprocessed, 50);
  for (const n of CHECK_NAMES) assert.equal(c.checks[n], 'flag');
});

test('R24: guidance_version is recorded at open from config or deps; a later change shows in the view', async () => {
  const e = homeSetup({ guidanceVersion: 'g-aaa' });
  await e.engine.jobOpen({ workflow: 'wf-test', target: 't1', thread: 'A' }, H1);
  assert.equal((await e.store.get<any>(makeKey('test', 'bot', 'job', e.JOB))).guidance_version, 'g-aaa');
  const e2 = new Engine({ store: e.store, clock: e.clock, sessionDirectory: e.dir, sourceReader: { currentBuild: async () => 'b1' }, slackReader: { findOwnPostAfter: async () => null }, waker: { postWake: async () => {} }, config: defineConfig({ env: 'test', bot: 'bot', ownBotUserId: BOT }), specs: [SPEC], guidanceVersion: 'g-bbb' });
  const v = await e2.jobView({ job: e.JOB }, H1);
  assert.match(v.say_to_tony, /Guidance changed/);
});

test('default directory homeForAllSessions maps every session to the job home (harness transition only)', async () => {
  const e = setup();
  const job = await open(e);
  assert.equal((await e.engine.intend({ job, action: 'a4', ref: 'x' }, S2)).status, 'clear');
  assert.deepEqual(await homeForAllSessions.dmOf('any', { id: 'j', dm: 'dm:j', generation: 1 }), { dm: 'dm:j' });
});

test('unknown milestone ids: say, promise_add and checkpoint record nothing for them and answer with the spec ids', async () => {
  const e = setup();
  const job = await open(e);
  const list = 'm1, m2, m_final';
  const sy = await e.engine.say({ job, thread: 'A', milestone: 'pr_open' }, S1);
  assert.equal(sy.ok, true);
  assert.equal(sy.status, 'unknown_milestone');
  assert.deepEqual(sy.unknown_milestones, ['pr_open']);
  assert.match(sy.say_to_tony, new RegExp(`unknown milestone pr_open; this job's milestones are: ${list}`));
  const pa = await e.engine.promiseAdd({ job, thread: 'A', about: 'signoff' }, S1);
  assert.equal(pa.status, 'unknown_milestone');
  assert.deepEqual(pa.unknown_milestones, ['signoff']);
  const cp = await e.engine.checkpoint({ job, status: 'working', reached: ['qa_approved', 'm1'] }, S1);
  assert.equal(cp.ok, true);
  assert.deepEqual(cp.unknown_milestones, ['qa_approved']);
  assert.match(cp.say_to_tony, /unknown milestone qa_approved; this job's milestones are: m1, m2, m_final/);
  assert.match(cp.say_to_tony, /Milestone m1 marked reached/);
  const v = await e.engine.jobView({ job }, S1);
  const j = (v.jobs as any[])[0];
  assert.deepEqual(Object.keys(j.milestones), ['m1']);
  assert.deepEqual(j.spec_milestones, [{ id: 'm1', reached: true }, { id: 'm2', reached: false }, { id: 'm_final', reached: false }]);
  assert.match(v.say_to_tony, /Milestones \(use these ids\): m1 reached, m2 not reached, m_final not reached/);
  assert.deepEqual(j.promises, []);
  assert.equal(j.claims.length, 0);
  assert.equal(j.owed.filter((d: any) => d.milestone === 'pr_open' || d.milestone === 'qa_approved').length, 0);
  assert.ok(flagsOf(v).includes('unknown_milestone'));
  await ok(e, [job]);
});

test('checkpoint reached given as a single string is read as one id, not a failure', async () => {
  const e = setup();
  const job = await open(e);
  const cp = await e.engine.checkpoint({ job, status: 'working', reached: 'm1' as unknown as string[] }, S1);
  assert.equal(cp.ok, true);
  assert.match(cp.say_to_tony, /Milestone m1 marked reached/);
  const cp2 = await e.engine.checkpoint({ job, status: 'working', reached: 'bogus' as unknown as string[] }, S1);
  assert.deepEqual(cp2.unknown_milestones, ['bogus']);
});
