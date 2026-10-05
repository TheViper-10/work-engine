// Live run 1 repros (R51 onward). Each test failed against the engine as of main 7bbb694.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { MemoryStore } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import { defineConfig } from '../src/config.ts';
import type { SessionDirectory, Spec } from '../src/types.ts';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const CH = 'C0C4K4EGZT6';
const A = `${CH}:1791149910.562169`;
const B = `${CH}:1791150443.050169`;
const SPEC: Spec = {
  workflow: 'wf', version: 1, link_roles: ['request', 'side', 'qa'], one_open_job: true, target_pattern: '^\\d+\\.\\d+\\.\\d+$',
  people: { p: { slack: 'U1' } },
  gates: { g: { responders: { primary: ['p'], stand_ins: [] } } },
  milestones: {
    started: { audience: { roles: ['request'], promise_holders: true } },
    ready: { audience: { roles: ['request'], promise_holders: true }, outcome: true },
  },
  actions: {},
  defaults: { next_wake_minutes: 30, promise_fallback_minutes: 240, operation_unknown_minutes: 30 },
};

function env(o: { threads?: Record<string, string>; linkThread?: (l: string) => string | null } = {}) {
  const clock = new ManualClock(T0);
  const wakes: Array<{ dm: string; text: string; key: string }> = [];
  const dir: SessionDirectory = {
    cacheable: false,
    async dmOf(sid, job) { return sid.startsWith('m') ? { dm: `dm:mention:${sid}` } : { dm: job!.dm }; },
    async threadOf(sid) { const t = o.threads?.[sid]; return t ? { thread: t } : { error: 'this conversation has no Slack thread' }; },
  };
  const engine = new Engine({
    store: new MemoryStore(), clock,
    sourceReader: { currentBuild: async () => 'b1' },
    slackReader: { findOwnPostAfter: async () => null, threadOfLink: async (l: string) => (o.linkThread ? o.linkThread(l) : null) },
    waker: { postWake: async (dm, text, key) => { wakes.push({ dm, text, key }); } },
    config: defineConfig({ env: 't', bot: 'b', ownBotUserId: 'UBOT', checks: {} }),
    specs: [SPEC], sessionDirectory: dir, strictThreads: true,
  });
  return { engine, clock, wakes };
}
const H = { session_id: 'h1' };
const M1 = { session_id: 'm1' };
const open = (e: ReturnType<typeof env>, a: Record<string, unknown>, ctx = H) => e.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A, ...a } as any, ctx);

test('F1a: a DevRev DM id is not a thread: job_open, job_view, say and promise_add answer bad_thread and record nothing', async () => {
  const e = env();
  const dm = 'don:core:devrev:dm/10PhocjLu';
  const r = await open(e, { thread: dm }, M1);
  assert.equal(r.status, 'bad_thread');
  assert.match(r.say_to_tony, /external_ref|<channel>:<ts>/);
  const j = (await open(e, {})).job as string;
  assert.equal((await e.engine.jobView({ thread: dm }, M1)).status, 'bad_thread');
  assert.equal((await e.engine.say({ job: j, thread: dm, milestone: 'started' }, H)).status, 'bad_thread');
  assert.equal((await e.engine.promiseAdd({ job: j, thread: dm, about: 'ready' }, M1)).status, 'bad_thread');
  const v: any = await e.engine.jobView({ job: j }, H);
  assert.deepEqual(v.jobs[0].threads.map((t: any) => t.thread), [A]);
});

test('F1a: slack:<C>:<ts> and a Slack permalink are normalized to <C>:<ts>', async () => {
  const e = env();
  const r1: any = await open(e, { thread: `slack:${A}` }, M1);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.view.threads.map((t: any) => t.thread), [A]);
  const r2: any = await open(e, { thread: `https://devrev.slack.com/archives/${CH}/p1791150443050169`, role: 'side' }, M1);
  assert.deepEqual(r2.view.threads.map((t: any) => t.thread).sort(), [A, B].sort());
});

test('F1b: a mention session that omits or botches the thread gets the one the platform holds for its conversation', async () => {
  const e = env({ threads: { m1: A } });
  const r: any = await e.engine.jobOpen({ workflow: 'wf', target: '5.2.11' } as any, M1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.view.threads.map((t: any) => t.thread), [A]);
  assert.match(r.say_to_tony, /thread of this conversation/);
  const e2 = env({ threads: { m1: A } });
  const r2: any = await open(e2, { thread: 'don:core:devrev:dm/10PhocjLu' }, M1);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.view.threads.map((t: any) => t.thread), [A]);
});

test('F1b: when the platform cannot say, the answer is bad_thread with words on where the thread is', async () => {
  const e = env();
  const r = await e.engine.jobOpen({ workflow: 'wf', target: '5.2.11' } as any, M1);
  assert.equal(r.status, 'bad_thread');
  assert.match(r.say_to_tony, /external_ref/);
});

test('F2/F3: target next, empty or not a version joins the open job of the workflow instead of making a second one', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  for (const target of ['next', '', 'latest', 'v5']) {
    const r: any = await open(e, { target, thread: B, role: 'side' }, M1);
    assert.equal(r.status, 'joined', `target "${target}"`);
    assert.equal(r.job, j);
  }
  const v: any = await e.engine.jobView({ job: j }, H);
  assert.deepEqual(v.jobs[0].threads.map((t: any) => t.thread).sort(), [A, B].sort());
  assert.equal(((await e.engine.jobView({ thread: B }, M1)) as any).jobs.length, 1);
});

test('F2/F3: a plain join with another version joins the open job with a flag; queue and replace are the explicit ways', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  const r: any = await open(e, { target: '5.2.12', thread: B }, M1);
  assert.equal(r.status, 'joined');
  assert.equal(r.job, j);
  assert.match(r.say_to_tony, /5\.2\.12/);
  const v: any = await e.engine.jobView({ job: j }, H);
  assert.ok(v.jobs[0].flags.some((f: any) => f.check === 'target_mismatch'));
  const q: any = await open(e, { target: '5.2.12', thread: B, intent: 'queue' }, H);
  assert.equal(q.status, 'queued');
  assert.equal(q.job, 'wf:5.2.12');
});

test('F2/F3: with no open job a placeholder target is refused with words, not recorded as a job', async () => {
  const e = env();
  const r = await open(e, { target: 'next' });
  assert.equal(r.status, 'bad_target');
  assert.match(r.say_to_tony, /target/);
});

test('F2/F3: replace with another version cancels the open job and opens the new one', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  const r: any = await open(e, { target: '5.2.12', thread: B, intent: 'replace' }, H);
  assert.equal(r.status, 'opened');
  assert.equal(r.job, 'wf:5.2.12');
  assert.notEqual(((await e.engine.jobView({ job: j }, H)) as any).jobs[0].status, 'open');
});

test('F9: say with a post link from another thread answers wrong_thread and marks nothing sent', async () => {
  const other = `${CH}:1791150390.480389`;
  const e = env({ linkThread: (l) => (l.includes('480389') ? A : l.includes('999') ? null : B) });
  const j = (await open(e, {})).job as string;
  await open(e, { thread: B, role: 'side' });
  await e.engine.checkpoint({ job: j, status: 'working', reached: ['started'] }, H);
  const bad = await e.engine.say({ job: j, thread: B, milestone: 'started', posted_link: `slack:${other}` }, H);
  assert.equal(bad.status, 'wrong_thread');
  assert.match(bad.say_to_tony, new RegExp(A.replace('.', '\\.')));
  const v: any = await e.engine.jobView({ job: j }, H);
  assert.equal((v.jobs[0].sent ?? []).filter((d: any) => d.thread === B).length, 0);
  const ok = await e.engine.say({ job: j, thread: B, milestone: 'started', posted_link: `slack:${CH}:1791150500.000100` }, H);
  assert.equal(ok.status, 'confirmed');
});

test('F10: an outcome milestone is reached only through checkpoint.reached; say before that claims nothing', async () => {
  const e = env();
  const j = (await open(e, {})).job as string;
  const r = await e.engine.say({ job: j, thread: A, milestone: 'ready' }, H);
  assert.equal(r.status, 'not_reached');
  assert.match(r.say_to_tony, /checkpoint/);
  const v: any = await e.engine.jobView({ job: j }, H);
  assert.deepEqual(Object.keys(v.jobs[0].milestones ?? {}), []);
  assert.equal((await e.engine.say({ job: j, thread: A, milestone: 'ready', posted_link: `slack:${CH}:1791150500.000100` }, H)).status, 'not_reached');
  await e.engine.checkpoint({ job: j, status: 'working', reached: ['ready'] }, H);
  assert.equal((await e.engine.say({ job: j, thread: A, milestone: 'ready' }, H)).status, 'go');
  // a non-outcome milestone keeps the claim-on-say behaviour
  assert.equal((await e.engine.say({ job: j, thread: B, milestone: 'started' }, H)).status, 'go');
});

test('F4: a home first wake nobody answers is re-woken after 5 minutes, bounded; a home that read the job is not', async () => {
  const e = env();
  const j = (await open(e, {}, M1)).job as string; // opened from a non-home session: the engine wakes the home
  await e.engine.sweep();
  assert.equal(e.wakes.length, 1);
  for (const n of [2, 3, 4]) {
    e.clock.set(e.clock.now() + 5 * MIN);
    await e.engine.sweep();
    assert.equal(e.wakes.length, Math.min(n, 4), `wake ${n}`);
  }
  e.clock.set(e.clock.now() + 5 * MIN);
  await e.engine.sweep();
  assert.equal(e.wakes.length, 4, 'bounded: after the bound the ordinary cadence applies');
  assert.notEqual(new Set(e.wakes.map((w) => w.key)).size, 1, 'each re-wake is its own wake key');
  // a home that reads the job has answered
  const e2 = env();
  const j2 = (await open(e2, {}, M1)).job as string;
  await e2.engine.sweep();
  await e2.engine.jobView({ job: j2 }, H);
  e2.clock.set(e2.clock.now() + 6 * MIN);
  await e2.engine.sweep();
  assert.equal(e2.wakes.length, 1);
  void j;
});
