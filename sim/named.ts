// Deterministic named cases. Each asserts specific outcomes and then the full invariant set.
import assert from 'node:assert/strict';
import { World, MIN, OWNER, PRIVATE_THREAD, WF } from './world.ts';
import { checkState } from './invariants.ts';

const J = `${WF}:T1`;
const QA_GATE = 'approve-desktop-qa-latest';
type Mode = 'flag' | 'hold';

async function open(w: World, sid = 's1', thread = 'A', extra: Record<string, unknown> = {}, target = 'T1') {
  return w.api('jobOpen', { workflow: WF, target, thread, ...extra }, sid);
}
async function settle(w: World, afterSweep = false) {
  const bad = await checkState(w, afterSweep);
  assert.deepEqual(bad, [], 'invariants');
}
async function view(w: World, args: any, sid = 's1') {
  const a = await w.api('jobView', args, sid);
  return (a.jobs as any[])[0];
}

const cases: Array<[string, (mode: Mode) => Promise<void>]> = [
  ['twin runs', async (mode) => {
    const w = new World(mode);
    await open(w);
    w.clock.advanceMinutes(45); // s1 goes quiet; its run times out
    const a = await w.wake(J, 'timer');
    const b = await w.wake(J, 'twin timer');
    assert.equal(a.status, 'woke');
    assert.equal(b.status, 'run_active', 'second wake must not start a second run');
    assert.equal(w.wakes.length, 1);
    // the mention starts a session that binds the pending run; a third session is then a second active worker
    await w.api('jobView', { job: J }, 's2');
    const r = await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 's3');
    if (mode === 'hold') {
      assert.equal(r.status, 'hold');
      assert.match(r.say_to_tony, /superseded_run/);
    } else {
      assert.equal(r.status, 'clear');
      assert.ok(((r.flags as string[]) ?? []).some((f) => f.startsWith('superseded_run')));
    }
    const run2 = await w.peek<any>('run', `${J}:2`);
    assert.equal(run2.session_id, 's2');
    assert.equal(await w.peek('run', `${J}:3`), null, 'still exactly one active run');
    const own = await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr2' }, 's2');
    assert.equal(own.status, 'clear');
    await settle(w);
  }],

  ['stale go', async (mode) => {
    const w = new World(mode);
    await open(w);
    const sy = await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 's1');
    assert.equal(sy.status, 'go');
    assert.match(sy.say_to_tony, /build abc/);
    w.post(J, 'A', 'qa_go_requested');
    await w.ingest(w.ownPostEvent(w.posts[0], { ts: w.posts[0].ts }));
    // the owner said go for build abc; then the build changes
    w.builds[QA_GATE] = 'def';
    const r = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pipeline-1' }, 's1');
    if (mode === 'hold') {
      assert.equal(r.status, 'hold');
      assert.match(r.say_to_tony, /build_changed/);
      assert.match(r.say_to_tony, /Ask the responders again for build def/);
      assert.equal((r.operation as any).outcome, 'held');
      assert.equal((r.operation as any).lease_taken, false);
    } else {
      assert.equal(r.status, 'clear');
      assert.match(r.say_to_tony, /build_changed/);
    }
    const v = await view(w, { job: J });
    assert.ok(v.flags.some((f: any) => f.check === 'build_changed'), 'build_changed fired in both modes');
    await settle(w);
  }],

  ['cancel mid-publish', async (mode) => {
    const w = new World(mode);
    await open(w);
    const r = await w.api('intend', { job: J, action: 'publish_prod_alpha', ref: 'b1' }, 's1');
    assert.equal(r.status, 'clear');
    assert.equal((r.operation as any).lease_taken, true);
    const c = await w.api('checkpoint', { job: J, status: 'cancelled' }, 's1');
    assert.equal(c.job_status, 'cancel_requested');
    assert.match(c.say_to_tony, /Cancel requested/);
    await settle(w);
    const late = await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'x' }, 's1');
    assert.match(late.say_to_tony, /job_cancelled/);
    assert.equal(late.status, mode === 'hold' ? 'hold' : 'clear');
    // the publish is reported finished; the job may now close
    const o = await w.api('checkpoint', { job: J, status: 'working', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'done' }, ...(mode === 'flag' ? [{ ref: 'x', action: 'open_bump_pr', outcome: 'failed' as const }] : [])] }, 's1');
    assert.equal(o.job_status, 'cancelled');
    const lease = await w.peek<any>('lease', 'alpha');
    assert.equal(lease?.holder_job ?? null, null, 'alpha lease released');
    await settle(w);
  }],

  ['private evidence', async (mode) => {
    const w = new World(mode);
    await open(w, 's1', 'A');
    await open(w, 's1', 'B', { role: 'side' });
    await open(w, 's1', PRIVATE_THREAD, { role: 'side', private: true });
    await w.ingest({ source: 'slack', delivery_id: 'evid_C_1', kind: 'message', thread: PRIVATE_THREAD, sender_id: OWNER, sender_kind: 'human' });
    const inB = await w.api('jobView', { thread: 'B' }, 's1');
    const ev = ((inB.jobs as any[])[0].events as any[]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].held, true);
    assert.equal(ev[0].summary, 'held: evidence from another thread');
    assert.ok(!JSON.stringify(inB).includes('evid_C_1'));
    assert.match(inB.say_to_tony, /held: evidence from another thread/);
    const inC = await w.api('jobView', { thread: PRIVATE_THREAD }, 's1');
    assert.equal(((inC.jobs as any[])[0].events as any[])[0].held, false, 'the private thread itself sees it');
    await settle(w);
  }],

  ['crash after post', async (mode) => {
    const w = new World(mode);
    await open(w);
    const g = await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's1');
    assert.equal(g.status, 'go');
    const p = w.post(J, 'A', 'merged'); // s1 posts, then dies before checkpoint and before the connector delivers
    const again = await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's2');
    assert.equal(again.status, 'already_claimed', 'post not seen yet: claim still open');
    await w.ingest(w.ownPostEvent(p, { ts: p.ts }));
    const d = await w.peek<any>('delivery', `${J}:A:merged`);
    assert.equal(d.state, 'sent');
    assert.equal(d.sent_count, 1);
    const next = await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's3');
    assert.equal(next.status, 'already_sent');
    assert.equal(w.posts.length, 1, 'no double post');
    await settle(w);
  }],

  ['missed bot post', async (mode) => {
    const w = new World(mode);
    await open(w);
    await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's1');
    w.post(J, 'A', 'merged'); // the connector never delivers this
    w.clock.advanceMinutes(6);
    const s = await w.sweep();
    assert.equal(s.claims_reconciled, 1, 'sweep found the post through the Slack reader');
    const d = await w.peek<any>('delivery', `${J}:A:merged`);
    assert.equal(d.state, 'sent');
    assert.equal(d.seen_via, 'sweep');
    assert.equal((await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's2')).status, 'already_sent');
    // second variant: the reader cannot find it either
    await w.api('say', { job: J, thread: 'B', milestone: 'pr_approved' }, 's2');
    w.slackBlind = true;
    w.clock.advanceMinutes(6);
    const s2 = await w.sweep();
    assert.equal(s2.claims_reconciled, 0);
    const v = await view(w, { job: J }, 's2');
    assert.ok(v.claims.some((c: any) => c.milestone === 'pr_approved' && c.thread === 'B'));
    const va = await w.api('jobView', { job: J }, 's2');
    assert.match(va.say_to_tony, /claimed, not seen yet/);
    const re = await w.api('say', { job: J, thread: 'B', milestone: 'pr_approved' }, 's3');
    assert.equal(re.status, 'already_claimed');
    assert.notEqual(re.status, 'go');
    assert.equal(w.posts.length, 1, 'the sim did not post again');
    await settle(w);
  }],

  ['engine downtime', async (mode) => {
    const w = new World(mode);
    await open(w);
    await w.api('intend', { job: J, action: 'merge_pr', ref: 'pr1' }, 's1');
    await w.api('promiseAdd', { job: J, thread: 'A', about: 'live', fallback_time: 60 }, 's1');
    await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's1');
    const p = w.post(J, 'A', 'merged');
    void p; // the connector was down: the post is never ingested
    await w.api('checkpoint', { job: J, status: 'waiting', waiting_for: 'ci' }, 's1');
    w.clock.advanceMinutes(75); // no ingest, no sweep
    assert.equal(w.wakes.length, 0);
    const s = await w.sweep();
    assert.equal((s.woke as string[]).length, 1, 'catch-up sweep wakes the due job');
    assert.equal(w.wakes.length, 1);
    assert.equal(s.operations_unknown, 1);
    assert.equal(s.promises_due, 1);
    assert.equal(s.claims_reconciled, 1);
    const v = await view(w, { job: J }, 's2');
    assert.equal(v.operations[0].outcome, 'unknown');
    assert.equal(v.promises[0].state, 'due');
    assert.ok(v.next_wake_at > w.now(), 'the job has a future wake again');
    await settle(w, true);
  }],

  ['queue: lease release promotes the queued job', async (mode) => {
    const w = new World(mode);
    await open(w, 's1', 'A');
    const q = await open(w, 's2', 'B', { intent: 'queue' });
    assert.equal(q.status, 'queued');
    const Q = q.job as string;
    assert.equal(Q, `${J}#2`);
    // queued job cannot take over: its own intend is not what wakes it
    const r = await w.api('intend', { job: J, action: 'merge_pr', ref: 'pr1' }, 's1');
    assert.equal(r.status, 'clear');
    assert.equal((await w.peek<any>('lease', 'main')).holder_job, J);
    const sw0 = await w.sweep();
    assert.ok(!(sw0.woke as string[]).includes(Q), 'queued job is not woken while the first is running');
    assert.equal((await w.peek<any>('job', Q)).status, 'queued');
    // first job reports its outcome and finishes: the lease frees and the queued job opens
    const c = await w.api('checkpoint', { job: J, status: 'done', operations: [{ ref: 'pr1', action: 'merge_pr', outcome: 'done' }] }, 's1');
    assert.equal(c.job_status, 'done');
    assert.equal((await w.peek<any>('lease', 'main')).holder_job, null);
    const promoted = await w.peek<any>('job', Q);
    assert.equal(promoted.status, 'open');
    assert.ok(promoted.next_wake_at <= w.now());
    const sw = await w.sweep();
    assert.ok((sw.woke as string[]).includes(Q), 'the promoted job is woken');
    assert.ok(w.wakes.some((x) => x.job === Q));
    const take = await w.api('intend', { job: Q, action: 'merge_pr', ref: 'pr2' }, 's2');
    assert.equal(take.status, 'clear');
    assert.equal((await w.peek<any>('lease', 'main')).holder_job, Q);
    await settle(w, true);
  }],
];

let failed = 0;
for (const mode of ['flag', 'hold'] as const) {
  for (const [name, fn] of cases) {
    try {
      await fn(mode);
      console.log(`ok   [${mode}] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL [${mode}] ${name}\n${(e as Error).stack}`);
    }
  }
}
console.log(failed === 0 ? `OK ${cases.length * 2} named cases` : `${failed} named cases FAILED`);
void MIN;
if (failed) process.exit(1);
