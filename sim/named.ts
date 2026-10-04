// Deterministic named cases. Each asserts specific outcomes and then the full invariant set.
import assert from 'node:assert/strict';
import { World, MIN, OWNER, OUTSIDER, PRIVATE_THREAD, WF } from './world.ts';
import { checkState } from './invariants.ts';

const J = `${WF}:T1`;
const QA_GATE = 'approve-desktop-qa-latest';
type Mode = 'flag' | 'hold';

/** A world with mention sessions m1..m3 (not in the job home); every other session id is a home session. */
function home(mode: Mode, overrides: { inboxMaxUnprocessed?: number; noticeCoalesceMinutes?: number } = {}): World {
  const w = new World(mode, 2, overrides);
  for (const m of ['m1', 'm2', 'm3']) w.dir.mention.add(m);
  return w;
}
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
    // the mention starts a session; reads never bind (R17 M2), so its first write binds the pending run.
    // A third session is then a second active worker.
    await w.api('jobView', { job: J }, 's2');
    await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr0' }, 's2');
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
    // R17: a claim younger than claim_stale_minutes belongs to its session: another session is told busy.
    const soon = await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's2');
    assert.equal(soon.status, 'busy', 'claim is young and owned by s1');
    // Once it is stale and the reader cannot see the post, the claim is handed over with a read-first warning.
    w.slackBlind = true;
    w.clock.advanceMinutes(11);
    const again = await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 's2');
    assert.equal(again.status, 'already_claimed', 'post not seen yet: stale claim is handed over');
    w.slackBlind = false;
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
    // R17: still inside claim_stale_minutes (10) the claim is s2's: busy, not a hand-over.
    assert.equal((await w.api('say', { job: J, thread: 'B', milestone: 'pr_approved' }, 's3')).status, 'busy');
    w.clock.advanceMinutes(6);
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

  // ------------------------------------------------------------ job-home cases (ib-*): docs/job-home-contract.md

  ['ib-base', async (mode) => {
    const w = home(mode);
    // a mention session in thread A opens the job; it never becomes the work run (A1)
    const o = await w.api('jobOpen', { workflow: WF, target: 'T1', thread: 'A' }, 'm1');
    assert.equal(o.work_run, 'none');
    assert.match(o.say_to_tony, /not in the job home/);
    await w.sweep();
    assert.equal(w.wakes.length, 1, 'the job home is woken');
    assert.equal(w.wakes[0].dm, `dm:${J}`);
    await w.api('jobView', { job: J }, 'h1');
    const c0 = await w.api('checkpoint', { job: J, status: 'working', waiting_for: 'pr' }, 'h1');
    assert.equal(c0.job_status, 'open');
    assert.equal((await w.peek<any>('run', `${J}:1`)).session_id, 'h1', 'the first home write binds the run');
    const i1 = await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 'h1');
    assert.equal(i1.status, 'clear');
    const sy = await w.api('say', { job: J, thread: 'A', milestone: 'bump_pr_open' }, 'h1');
    assert.equal(sy.status, 'go');
    const p = w.post(J, 'A', 'bump_pr_open');
    await w.ingest(w.ownPostEvent(p, { ts: p.ts }));
    // the go arrives in thread A: it goes to the inbox and the active home gets one notice
    const go = await w.ingest({ source: 'slack', delivery_id: 'go1', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    assert.ok(((go.actions as string[]) ?? []).some((x) => /inbox item/.test(x)));
    assert.equal(w.wakes.filter((x) => /notice/.test(x.text)).length, 1);
    const v = await view(w, { job: J }, 'h1');
    assert.equal(v.inbox_unprocessed, 1);
    assert.equal(v.inbox[0].kind, 'approval');
    const mg = await w.api('intend', { job: J, action: 'merge_pr', ref: 'pr1', because: 'slack:go1' }, 'h1');
    assert.equal(mg.status, 'clear');
    const ck = await w.api('checkpoint', { job: J, status: 'working', waiting_for: 'ci', operations: [{ ref: 'pr1', action: 'merge_pr', outcome: 'done' }], reached: ['merged'] }, 'h1');
    assert.match(ck.say_to_tony, /1 inbox item\(s\) marked processed/);
    assert.equal((await view(w, { job: J }, 'h1')).inbox_unprocessed, 0);
    const told = await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 'h1');
    assert.equal(told.status, 'go', 'the owner tells thread A, the requester');
    const p2 = w.post(J, 'A', 'merged');
    await w.ingest(w.ownPostEvent(p2, { ts: p2.ts }));
    assert.equal((await w.peek<any>('delivery', `${J}:A:merged`)).state, 'sent');
    await settle(w);
  }],

  ['ib-status-b', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 'h1');
    const before = await w.peek<any>('job', J);
    // a status question in thread B arrives through a mention session: reads and links only
    const j = await w.api('jobOpen', { workflow: WF, target: 'T1', thread: 'B', role: 'side' }, 'm2');
    assert.equal(j.work_run, 'other');
    const vb = await w.api('jobView', { thread: 'B' }, 'm2');
    assert.equal((vb.jobs as any[])[0].work_run, 'other');
    const ck = await w.api('checkpoint', { job: J, status: 'cancelled', waiting_for: 'nothing' }, 'm2');
    assert.notEqual(ck.job_status, 'cancelled');
    const it = await w.api('intend', { job: J, action: 'merge_pr', ref: 'pr1' }, 'm2');
    assert.equal(it.status, 'route');
    assert.ok(!(it as any).operation, 'no operation opened');
    const sy = await w.api('say', { job: J, thread: 'B', milestone: 'pr_approved' }, 'm2');
    assert.equal(sy.status, 'route');
    assert.match(sy.say_to_tony, /job owner will tell/);
    const after = await w.peek<any>('job', J);
    assert.equal(after.status, before.status);
    assert.equal(after.reported_status, before.reported_status);
    assert.equal(after.current_run, before.current_run);
    assert.equal((await w.peek<any>('run', `${J}:${after.current_run}`)).session_id, 'h1', 'run unchanged');
    assert.equal(await w.peek('lease', 'main'), null, 'no lease taken');
    const pr = await w.api('promiseAdd', { job: J, thread: 'B', about: 'qa_ready' }, 'm2');
    assert.equal(pr.status, 'promised', 'a mention session may promise for its own thread');
    assert.ok((await view(w, { job: J }, 'h1')).inbox_unprocessed >= 2, 'routed asks are inbox items');
    await settle(w);
  }],

  ['ib-go-active', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 'h1');
    w.post(J, 'A', 'qa_go_requested');
    await w.ingest(w.ownPostEvent(w.posts[0], { ts: w.posts[0].ts }));
    await w.ingest({ source: 'slack', delivery_id: 'g1', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    w.clock.advance(30_000);
    await w.ingest({ source: 'slack', delivery_id: 'g2', kind: 'message', thread: 'A', sender_id: OUTSIDER, sender_kind: 'human' });
    assert.equal(w.wakes.filter((x) => /notice/.test(x.text)).length, 1, 'two items within the coalesce window give one notice');
    w.clock.advanceMinutes(3);
    await w.ingest({ source: 'slack', delivery_id: 'g3', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    assert.equal(w.wakes.filter((x) => /notice/.test(x.text)).length, 2, 'a later item gets its own notice');
    const v = await view(w, { job: J }, 'h1');
    assert.equal(v.inbox.length, 3);
    assert.deepEqual(v.inbox.map((i: any) => i.id), ['#1', '#2', '#3'], 'oldest first');
    assert.equal((await view(w, { job: J }, 'h1')).inbox.length, 3, 'a read never consumes');
    const r = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pl1', because: 'slack:g1' }, 'h1');
    assert.equal(r.status, 'clear');
    const stranger = await w.api('intend', { job: J, action: 'verify_qa', ref: 'pl1', because: 'slack:g2' }, 'h1');
    assert.ok(/sender_not_listed/.test(stranger.say_to_tony), 'a go from a stranger is flagged or held');
    await settle(w);
  }],

  ['ib-go-after-done', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    const d = await w.api('checkpoint', { job: J, status: 'done' }, 'h1');
    assert.equal(d.job_status, 'done');
    const before = w.wakes.length;
    const late = await w.ingest({ source: 'slack', delivery_id: 'late1', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    assert.deepEqual(late.matched_jobs, [J]);
    assert.equal(w.wakes.length, before, 'a late go never wakes an ended job');
    const job = await w.peek<any>('job', J);
    assert.equal(job.status, 'done', 'never reopened (R12)');
    const v = await view(w, { job: J }, 'h1');
    assert.equal(v.late.length, 1);
    assert.match((await w.api('jobView', { job: J }, 'h1')).say_to_tony, /Late input after the job ended/);
    const i = await w.api('intend', { job: J, action: 'merge_pr', ref: 'x', because: 'slack:late1' }, 'h1');
    assert.equal(i.status, 'recorded', 'ended job: recorded, not tracked');
    await settle(w);
  }],

  ['ib-build-changed', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 'h1');
    w.post(J, 'A', 'qa_go_requested');
    await w.ingest(w.ownPostEvent(w.posts[0], { ts: w.posts[0].ts }));
    await w.ingest({ source: 'slack', delivery_id: 'gobuild', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    w.builds[QA_GATE] = 'def'; // the go was for abc
    const r = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pl1', because: 'slack:gobuild' }, 'h1');
    assert.match(r.say_to_tony, /build_changed/);
    assert.equal(r.status, mode === 'hold' ? 'hold' : 'clear');
    if (mode === 'hold') assert.equal((r.operation as any).lease_taken, false);
    // the owner answers the new ask for def; that go is valid
    await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 'h1');
    await settle(w);
  }],

  ['ib-cancel-unknown', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('intend', { job: J, action: 'publish_prod_alpha', ref: 'b1' }, 'h1');
    // a stranger cancels: recorded, flagged, routed; the job is not cancelled (R21)
    await w.ingest({ source: 'slack', delivery_id: 'cx0', kind: 'message', thread: 'A', sender_id: OUTSIDER, sender_kind: 'human', attrs: { inbox_kind: 'cancel' } });
    const vs = await view(w, { job: J }, 'h1');
    assert.ok(vs.flags.some((f: any) => f.check === 'sender_not_listed'));
    assert.notEqual(vs.status, 'cancelled');
    // the owner cancels
    await w.ingest({ source: 'slack', delivery_id: 'cx1', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human', attrs: { inbox_kind: 'cancel' } });
    const c = await w.api('checkpoint', { job: J, status: 'cancelled', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'unknown', note: 'cannot tell' }] }, 'h1');
    assert.equal(c.job_status, 'cancelled');
    const job = await w.peek<any>('job', J);
    assert.equal(job.cleanup_pending.length, 1, 'cleanup_pending lists the unknown publish (R22)');
    assert.equal((await w.peek<any>('lease', 'alpha')).holder_job, J, 'the lease stays held under uncertainty');
    await w.api('jobOpen', { workflow: WF, target: 'T2', thread: 'D' }, 'h2');
    const other = await w.api('intend', { job: `${WF}:T2`, action: 'publish_prod_alpha', ref: 'b9' }, 'h2');
    assert.match(other.say_to_tony, /lease_held/);
    // the cancelled job keeps a wake until readback, then escalates after 4 x the unknown window
    w.clock.advanceMinutes(40);
    await w.sweep();
    assert.ok(w.wakes.some((x) => x.job === J && /cleanup pending/.test(x.text)), 'cleanup wake');
    w.clock.advanceMinutes(90);
    await w.sweep();
    const esc = await w.peek<any>('job', J);
    assert.equal(esc.cleanup_escalated, true);
    assert.ok(w.wakes.some((x) => /escalate/.test(x.text)));
    // readback: the publish is done, the lease frees, the wake stops
    const rb = await w.api('checkpoint', { job: J, status: 'working', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'done' }] }, 'h1');
    assert.equal(rb.job_status, 'cancelled');
    const after = await w.peek<any>('job', J);
    assert.equal(after.cleanup_pending.length, 0);
    assert.equal(after.next_wake_at, null);
    assert.equal((await w.peek<any>('lease', 'alpha'))?.holder_job ?? null, null);
    await settle(w, true);
  }],

  ['ib-crash-after-approval', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 'h1');
    w.post(J, 'A', 'qa_go_requested');
    await w.ingest(w.ownPostEvent(w.posts[0], { ts: w.posts[0].ts }));
    await w.ingest({ source: 'slack', delivery_id: 'goc', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    const r = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pl1', because: 'slack:goc' }, 'h1');
    assert.equal(r.status, 'clear');
    // h1 dies before it checkpoints; the home is replaced and a new session settles it
    const rep = await w.replaceHome(J, 'session lost');
    assert.equal(rep.status, 'replaced');
    const job = await w.peek<any>('job', J);
    assert.equal(job.generation, 2);
    assert.equal(job.dm_id, `dm:${J}:g2`);
    assert.equal(job.homes.filter((h: any) => h.closed_at === null).length, 1);
    const wk = w.wakes[w.wakes.length - 1];
    assert.equal(wk.dm, `dm:${J}:g2`);
    assert.match(wk.text, /read back first: approve_qa_gate pl1 \(unknown\)/);
    const v = await view(w, { job: J }, 'h2');
    assert.equal(v.operations[0].outcome, 'unknown');
    const again = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pl1' }, 'h2');
    assert.equal(again.status, 'already_recorded', 'the approval is not repeated');
    const done = await w.api('checkpoint', { job: J, status: 'working', operations: [{ ref: 'pl1', action: 'approve_qa_gate', outcome: 'done' }] }, 'h2');
    assert.equal(done.ok, true);
    assert.equal((await view(w, { job: J }, 'h2')).operations[0].outcome, 'done');
    await settle(w);
  }],

  ['ib-duplicate', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    const ev = { source: 'slack', delivery_id: 'dup1', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' as const };
    await Promise.all([w.ingest(ev, w.engines[0]), w.ingest(ev, w.engines[1])]);
    await w.ingest(ev);
    const job = await w.peek<any>('job', J);
    assert.equal(job.inbox_keys.length, 1, 'one inbox item');
    assert.equal((await view(w, { job: J }, 'h1')).inbox_unprocessed, 1);
    assert.equal(w.wakes.filter((x) => /notice/.test(x.text)).length, 1, 'one notice');
    const run = await w.peek<any>('job', J);
    assert.equal(run.run_seq, 1, 'one worker');
    await settle(w);
  }],

  ['ib-private-c', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await open(w, 'h1', 'B', { role: 'side' });
    await open(w, 'h1', PRIVATE_THREAD, { role: 'side', private: true });
    await w.ingest({ source: 'slack', delivery_id: 'evid_C_77', kind: 'message', thread: PRIVATE_THREAD, sender_id: OWNER, sender_kind: 'human' });
    for (const t of ['A', 'B']) {
      const r = await w.api('jobView', { thread: t }, 'h1');
      assert.ok(!JSON.stringify(r).includes('evid_C_'), `C evidence stays out of ${t}`);
      assert.match(r.say_to_tony, /held: evidence from another thread/);
      assert.equal(((r.jobs as any[])[0].inbox as any[])[0].held, true);
    }
    const inC = await w.api('jobView', { thread: PRIVATE_THREAD }, 'h1');
    assert.equal(((inC.jobs as any[])[0].inbox as any[])[0].held, false);
    await settle(w);
  }],

  ['ib-lookup-fail', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    w.dir.failAll = true;
    const r = await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 'h1');
    assert.equal(r.status, 'hold', 'a fixed hold in flag mode too');
    assert.equal(r.reason, 'ownership_unconfirmed');
    const sy = await w.api('say', { job: J, thread: 'A', milestone: 'bump_pr_open' }, 'h1');
    assert.equal(sy.status, 'hold');
    const ck = await w.api('checkpoint', { job: J, status: 'done' }, 'h1');
    assert.equal(ck.status, 'hold');
    const job = await w.peek<any>('job', J);
    assert.equal(job.op_keys.length, 0, 'no operation in flight');
    assert.equal(job.status, 'open');
    // reads and promises still work; the flag is visible
    const v = await view(w, { job: J }, 'h1');
    assert.ok(v.flags.some((f: any) => f.check === 'identity_unconfirmed'));
    assert.equal((await w.api('promiseAdd', { job: J, thread: 'A', about: 'qa_ready' }, 'h1')).status, 'promised');
    // the home is woken ("identity unconfirmed ..."), and after 30 minutes it escalates
    w.clock.advanceMinutes(21);
    await w.sweep();
    assert.ok(w.wakes.some((x) => /identity unconfirmed for h1; resume from the job home/.test(x.text)));
    await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 'h1');
    w.clock.advanceMinutes(10);
    await w.sweep();
    assert.ok((await view(w, { job: J }, 'h1')).flags.some((f: any) => f.check === 'escalate'));
    // recovery: a confirmed owner call clears the episode
    w.dir.failAll = false;
    const ok = await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 'h1');
    assert.equal(ok.status, 'clear');
    assert.equal((await w.peek<any>('job', J)).identity, null);
    await settle(w);
  }],

  ['ib-stale-worker', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('intend', { job: J, action: 'open_bump_pr', ref: 'pr1' }, 'h1');
    // the wake finds the home pinned to a stale version: the engine replaces the home
    w.staleWake = true;
    w.clock.advanceMinutes(45);
    await w.sweep();
    const job = await w.peek<any>('job', J);
    assert.equal(job.generation, 2, 'a stale wake replaced the home');
    const old = await w.api('checkpoint', { job: J, status: 'done', operations: [{ ref: 'pr1', action: 'open_bump_pr', outcome: 'done' }] }, 'h1');
    assert.equal(old.status, 'superseded');
    assert.match(old.say_to_tony, /moved to a new home/);
    assert.equal((await w.api('intend', { job: J, action: 'merge_pr', ref: 'pr1' }, 'h1')).status, 'superseded');
    assert.equal((await w.api('say', { job: J, thread: 'A', milestone: 'merged' }, 'h1')).status, 'superseded');
    const after = await w.peek<any>('job', J);
    assert.notEqual(after.status, 'done', 'the fenced write changed nothing');
    const v = await view(w, { job: J }, 'h2');
    assert.ok(v.inbox.length >= 1, 'the attempt is an inbox note for the new home');
    assert.equal((await w.api('intend', { job: J, action: 'merge_pr', ref: 'pr1' }, 'h2')).status, 'clear');
    await settle(w);
  }],

  ['ib-overload', async (mode) => {
    const w = home(mode, { inboxMaxUnprocessed: 5 });
    await open(w, 'h1', 'A');
    await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 'h1');
    w.post(J, 'A', 'qa_go_requested');
    await w.ingest(w.ownPostEvent(w.posts[0], { ts: w.posts[0].ts }));
    for (let i = 0; i < 12; i++) await w.ingest({ source: 'slack', delivery_id: `chat${i}`, kind: 'message', thread: 'A', sender_id: OUTSIDER, sender_kind: 'human', attrs: { inbox_kind: 'message' } });
    await w.ingest({ source: 'slack', delivery_id: 'goo', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    await w.ingest({ source: 'slack', delivery_id: 'cxo', kind: 'message', thread: 'A', sender_id: OUTSIDER, sender_kind: 'human', attrs: { inbox_kind: 'cancel' } });
    const v = await view(w, { job: J }, 'h1');
    const kinds = (v.inbox as any[]).map((i) => i.kind);
    assert.ok(kinds.includes('approval'), 'the approval is kept');
    assert.ok(kinds.includes('cancel'), 'the cancel is kept');
    const overflow = (v.inbox as any[]).find((i) => i.count);
    assert.ok(overflow && overflow.count >= 7, 'plain messages folded into one overflow item with a count');
    assert.equal((v.inbox as any[]).filter((i) => i.count).length, 1);
    assert.ok(v.inbox_unprocessed <= 5 + 1 + 2 + 1, 'the queue stayed bounded');
    const r = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pl1', because: 'slack:goo' }, 'h1');
    assert.equal(r.status, 'clear', 'the approval still works after the overload');
    await settle(w);
  }],

  ['ib-late-decision', async (mode) => {
    const w = home(mode);
    await open(w, 'h1', 'A');
    await w.api('say', { job: J, thread: 'A', milestone: 'qa_go_requested' }, 'h1');
    w.post(J, 'A', 'qa_go_requested');
    await w.ingest(w.ownPostEvent(w.posts[0], { ts: w.posts[0].ts }));
    const c = await w.api('checkpoint', { job: J, status: 'cancelled' }, 'h1');
    assert.equal(c.job_status, 'cancelled');
    const wakes = w.wakes.length;
    await w.ingest({ source: 'slack', delivery_id: 'golate', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
    assert.equal(w.wakes.length, wakes, 'no wake for a decision after the cancel');
    assert.equal((await w.peek<any>('job', J)).status, 'cancelled', 'never reopened');
    const v = await view(w, { job: J }, 'h1');
    assert.equal(v.late.length, 1);
    const r = await w.api('intend', { job: J, action: 'approve_qa_gate', ref: 'pl1', because: 'slack:golate' }, 'h1');
    assert.match(r.say_to_tony, /job_cancelled/);
    if (mode === 'hold') assert.equal(r.status, 'hold');
    await w.api('checkpoint', { job: J, status: 'working', operations: [{ ref: 'pl1', action: 'approve_qa_gate', outcome: 'failed' }] }, 'h1');
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
