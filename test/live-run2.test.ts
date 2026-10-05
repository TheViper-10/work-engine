// Live run 2 repros (R61): thread continuity. Each test failed against the engine as of main 60baa5d.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { MemoryStore } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import { defineConfig } from '../src/config.ts';
import type { SessionDirectory, Spec } from '../src/types.ts';

const T0 = Date.UTC(2026, 0, 1);
const CH = 'C0C4K4EGZT6';
const A = `${CH}:1791149910.562169`;
const B = `${CH}:1791150443.050169`;
const C = `${CH}:1791167821.736989`;
const Q = `${CH}:1791156130.270059`;
const FAKE = `${CH}:1759651539.000000`;
const REAL = new Set([A, B, C, Q]);
const SPEC: Spec = {
  workflow: 'wf', version: 1, link_roles: ['request', 'side', 'qa'], one_open_job: true, target_pattern: '^\\d+\\.\\d+\\.\\d+$',
  people: { p: { slack: 'U1' } },
  gates: { g: { responders: { primary: ['p'], stand_ins: [] } } },
  milestones: {
    started: { audience: { roles: ['request'], promise_holders: true } },
    ready: { audience: { roles: ['request'], promise_holders: true }, outcome: true },
    ask: { audience: { roles: ['qa'], promise_holders: false }, audience_only: true },
  },
  actions: {},
  defaults: { next_wake_minutes: 30, promise_fallback_minutes: 240, operation_unknown_minutes: 30 },
};

function env(threads: Record<string, string> = {}) {
  const dir: SessionDirectory = {
    cacheable: false,
    async dmOf(sid, job) { return sid.startsWith('m') ? { dm: `dm:mention:${sid}` } : { dm: job!.dm }; },
    async threadOf(sid) { const t = threads[sid]; return t ? { thread: t } : { error: 'this conversation has no Slack thread' }; },
  };
  const engine = new Engine({
    store: new MemoryStore(), clock: new ManualClock(T0),
    sourceReader: { currentBuild: async () => 'b1' },
    slackReader: { findOwnPostAfter: async () => null, threadExists: async (t: string) => (REAL.has(t) ? t : false) },
    waker: { postWake: async () => {} },
    config: defineConfig({ env: 't', bot: 'b', ownBotUserId: 'UBOT', checks: {} }),
    specs: [SPEC], sessionDirectory: dir, strictThreads: true,
  });
  return engine;
}
const H = { session_id: 'h1' };
const MB = { session_id: 'mB' };
const MC = { session_id: 'mC' };
const open = (e: Engine, a: Record<string, unknown>, ctx: any = H) => e.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A, ...a } as any, ctx);
const view = async (e: Engine, j: string): Promise<any> => ((await e.jobView({ job: j }, H)) as any).jobs[0];

test('F1: a thread Slack does not know (a made-up ts) is refused with bad_thread and nothing is recorded or watched', async () => {
  const e = env({ mB: B });
  const j = (await open(e, {})).job as string;
  const r: any = await open(e, { thread: FAKE, role: 'request' }, MB);
  assert.equal(r.status, 'bad_thread');
  assert.match(r.say_to_tony, /not a thread that exists/);
  assert.deepEqual((await view(e, j)).threads.map((t: any) => t.thread), [A]);
  // say and promise_add to an unknown thread are refused too
  assert.equal((await e.say({ job: j, thread: FAKE, milestone: 'started' }, H)).status, 'bad_thread');
  // a mention session that passes a made-up ts for its own promise is held to its own conversation's thread
  const p: any = await e.promiseAdd({ job: j, thread: FAKE, about: 'ready' }, MB);
  assert.equal(p.status, 'promised');
  assert.equal(p.promise.thread, B);
});

test('F2: promise_add from a mention session is keyed to that session\'s thread, not the job\'s request thread', async () => {
  const e = env({ mB: B });
  const j = (await open(e, {})).job as string;
  const p: any = await e.promiseAdd({ job: j, thread: A, about: 'ready' }, MB);
  assert.equal(p.status, 'promised');
  assert.equal(p.promise.thread, B);
  assert.match(p.say_to_tony, /thread of this conversation/);
  const v = await view(e, j);
  assert.deepEqual(v.promises.map((x: any) => x.thread), [B]);
  // reaching the milestone owes it to A (request) and B (promise), nothing else
  await e.say({ job: j, thread: A, milestone: 'started' }, H);
  await e.checkpoint({ job: j, status: 'ok', reached: ['ready'] }, H);
  const v2 = await view(e, j);
  const owed = [...v2.owed, ...v2.claims].filter((d: any) => d.milestone === 'ready').map((d: any) => d.thread).sort();
  assert.deepEqual(owed, [A, B].sort());
});

test('F3: say go carries the exact post target (channel and thread_ts) and tells the home to reply in the thread', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  const r: any = await e.say({ job: j, thread: A, milestone: 'started' }, H);
  assert.equal(r.status, 'go');
  assert.deepEqual(r.post_to, { thread: A, channel: CH, thread_ts: '1791149910.562169' });
  assert.match(r.say_to_tony, /reply in thread C0C4K4EGZT6:1791149910\.562169/);
  assert.match(r.say_to_tony, /never as a new top-level message/);
  const v = await view(e, j);
  assert.deepEqual(v.threads[0], { thread: A, role: 'request', private: false, channel: CH, thread_ts: '1791149910.562169' });
});

test('F3: an own top-level post while the job has a linked thread is recorded and flagged, never a delivery', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  const r: any = await e.say({ job: j, thread: A, milestone: 'started' }, H);
  assert.equal(r.status, 'go');
  // the home posts at the top level instead of in the thread
  const ing: any = await e.ingest({ source: 'slack', delivery_id: `${CH}:1791165864.074369`, kind: 'message', sender_id: 'UBOT', ref: `slack:${CH}:1791165864.074369`, attrs: { ts: T0 + 1000, top_level: true, channel: CH } });
  assert.equal(ing.status, 'unthreaded_post');
  const v = await view(e, j);
  assert.ok(v.flags.some((f: any) => f.check === 'unthreaded_post'), 'flagged');
  assert.equal(v.sent.length, 0, 'not credited as a delivery');
  assert.equal(v.claims.length, 1, 'the claim is still open: the post has to go in the thread');
  // a top-level post in a channel the job has no thread in is not flagged
  const other: any = await e.ingest({ source: 'slack', delivery_id: 'CZZZZZZZZZ:1.000001', kind: 'message', sender_id: 'UBOT', attrs: { top_level: true, channel: 'CZZZZZZZZZ' } });
  assert.deepEqual(other.flagged, []);
});

test('F8: a private or unrelated thread gets no milestone deliveries unless it holds a promise for that milestone', async () => {
  const e = env({ mB: B, mC: C });
  const j = (await open(e, {})).job as string;
  // C links with no role: it joins as a side thread. C also links private, with role request named outright.
  const rC: any = await open(e, { thread: C, private: true }, MC);
  assert.equal(rC.ok, true);
  assert.equal((await view(e, j)).threads.find((t: any) => t.thread === C).role, 'side');
  const rQ: any = await open(e, { thread: Q, role: 'qa' }, H);
  assert.equal(rQ.ok, true);
  await e.promiseAdd({ job: j, thread: B, about: 'ready' }, MB);
  await e.say({ job: j, thread: A, milestone: 'started' }, H);
  await e.checkpoint({ job: j, status: 'ok', reached: ['ready'] }, H);
  const v = await view(e, j);
  const to = (m: string) => [...v.owed, ...v.claims, ...v.sent].filter((d: any) => d.milestone === m).map((d: any) => d.thread).sort();
  assert.deepEqual(to('started'), [A]);
  assert.deepEqual(to('ready'), [A, B].sort());
  // even when named as a request thread, a private thread is not in a role audience
  const e2 = env({ mC: C });
  const j2 = (await open(e2, {})).job as string;
  await open(e2, { thread: C, role: 'request', private: true }, MC);
  await e2.say({ job: j2, thread: A, milestone: 'started' }, H);
  const v2 = await view(e2, j2);
  assert.deepEqual([...v2.owed, ...v2.claims].map((d: any) => d.thread), [A]);
  // a promise from the private thread itself is honoured
  await e2.promiseAdd({ job: j2, thread: C, about: 'ready' }, MC);
  await e2.checkpoint({ job: j2, status: 'ok', reached: ['ready'] }, H);
  const v3 = await view(e2, j2);
  assert.deepEqual([...v3.owed, ...v3.claims].filter((d: any) => d.milestone === 'ready').map((d: any) => d.thread).sort(), [A, C].sort());
});

test('F1: a reply inside a thread links its root; the sign-off (audience_only) still goes only to the qa thread', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  await open(e, { thread: Q, role: 'qa' }, H);
  const wrong: any = await e.say({ job: j, thread: A, milestone: 'ask' }, H);
  assert.equal(wrong.status, 'wrong_audience');
  const ok: any = await e.say({ job: j, thread: Q, milestone: 'ask' }, H);
  assert.equal(ok.status, 'go');
  assert.equal(ok.post_to.thread_ts, '1791156130.270059');
});
