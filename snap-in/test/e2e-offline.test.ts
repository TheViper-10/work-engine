// One end-to-end offline flow, driven only through the real snap-in dispatcher (function entry) on the fake platform.
// The interruption-boundary journey: request in thread A, job_open, a wake creates the home DM and the trigger comment
// appears, Tony's calls from the home session land in the home, a mention session in another DM is routed, a Slack poll
// ingests the owner's go and Tony's own post, then checkpoint, then done.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED, FakePlatform, OWN_BOT, PROTECTED, TONY } from './fake-platform.ts';
import { dispatcher, HARRY, OWNER_SLACK } from './helpers.ts';
import { dmmapKey } from '../src/directory.ts';
import { storeFor } from './helpers.ts';
import { createWorkEngine } from '../src/index.ts';
import { readFileSync } from 'node:fs';

const WF = 'desktop-release';
/** Rows created by the interruption-boundary journey. Lower it when a change removes writes; never raise it without a decision-log entry. */
const ROW_BUDGET = 66; // R42: was 77 before the unchanged-write skip and the single post-trigger write

test('interruption-boundary journey through the dispatcher', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);

  // 1. The owner asks in thread A; Tony's mention session (in a connector DM, not the home) opens the job.
  const rootA = f.root(ALLOWED, OWNER_SLACK, 'please release 5.2.11');
  const threadA = `${ALLOWED}:${rootA}`;
  const mention = f.newMentionDm();
  const opened = await d.call({ call: 'job_open', workflow: WF, target: '5.2.11', thread: `slack:${threadA}`, role: 'request', intent: 'join', agent_session_id: mention.session });
  assert.equal(opened.ok, true); assert.equal(opened.status, 'opened');
  const job = opened.job as string;
  assert.equal(f.rowCount('work_record') > 0, true);
  assert.equal(f.chats.size, 1, 'no home DM yet: it is created lazily by the first wake');

  // 2. The timer tick wakes the job: the home DM is created hidden and the trigger comment appears.
  f.clock.advanceMinutes(1);
  await d.tick();
  const homes = [...f.chats.values()].filter((c) => c.id !== mention.dm);
  assert.equal(homes.length, 1); const home = homes[0];
  assert.equal(home.display_state, 'hidden'); assert.deepEqual(home.members, [TONY]);
  assert.equal(f.comments(home.id).length, 1);
  assert.match(f.comments(home.id)[0].body, new RegExp(`Work engine wake for job ${job}`));
  assert.deepEqual(f.triggers.map((t) => t.by), ['owner']);

  // 3. More ticks never post a second wake comment for the same run.
  await d.tick(); await d.tick();
  assert.equal(f.comments(home.id).length, 1, 'exactly one wake comment for the run');

  // 4. Tony's session in the home DM resolves to the home and is the owner.
  const homeSession = f.sessionIn(home.id);
  const view = await d.call({ call: 'job_view', job, agent_session_id: homeSession });
  assert.equal(view.ok, true);
  const cp1 = await d.call({ call: 'checkpoint', job, status: 'working', waiting_for: 'bump PR review', next_wake_in: '10m', agent_session_id: homeSession });
  assert.equal(cp1.ok, true); assert.equal(cp1.job_status, 'open');
  const said = await d.call({ call: 'say', job, thread: threadA, milestone: 'bump_pr_open', agent_session_id: homeSession });
  assert.equal(said.status, 'go');

  // 5. A mention session in another DM asks to intend: route, no lease, no operation.
  const routed = await d.call({ call: 'intend', job, action: 'open_bump_pr', ref: 'pr-1', agent_session_id: mention.session });
  assert.equal(routed.status, 'route');
  const sideSay = await d.call({ call: 'say', job, thread: threadA, milestone: 'merged', agent_session_id: mention.session });
  assert.equal(sideSay.status, 'route');

  // 6. Slack: Tony's own post, the owner's go and Harry's sign-off reach the engine by polling.
  f.clock.advance(2000);
  f.postSlack(ALLOWED, rootA, { user: OWN_BOT, bot_id: 'B1', text: 'The bump PR is open.' });
  f.clock.advance(2000);
  const goTs = f.postSlack(ALLOWED, rootA, { user: OWNER_SLACK, text: 'go' });
  f.postSlack(ALLOWED, rootA, { user: HARRY, bot_id: 'B2', text: 'QA signed off' });
  f.postSlack(PROTECTED, null, { user: OWNER_SLACK, text: 'protected channel chatter' });
  await d.tick();
  const view2: any = await d.call({ call: 'job_view', job, agent_session_id: homeSession });
  const events = view2.jobs[0].events as Array<{ source: string; kind: string; sender: string }>;
  assert.deepEqual(events.map((e) => e.sender).sort(), [HARRY, OWNER_SLACK, OWN_BOT].sort());
  assert.ok(view2.jobs[0].sent.length === 1, "Tony's own post settled the claim");
  assert.ok(view2.jobs[0].inbox.some((i: any) => i.kind === 'approval' && i.sender === OWNER_SLACK), "the owner's go is an approval in the inbox");
  const ownerGo = view2.jobs[0].inbox.find((i: any) => i.sender === OWNER_SLACK);
  assert.ok(goTs && ownerGo);

  // 7. Checkpoint acknowledges the inbox, then done closes the job.
  const cp2 = await d.call({ call: 'checkpoint', job, status: 'working', waiting_for: 'qa', next_wake_in: '10m', agent_session_id: homeSession });
  assert.equal(cp2.ok, true);
  const done = await d.call({ call: 'checkpoint', job, status: 'done', agent_session_id: homeSession });
  assert.equal(done.job_status, 'done');

  // ---- cross-cutting assertions
  // exactly one wake comment per run, and no stray comment anywhere else
  assert.equal(f.comments(home.id).length, f.triggers.length);
  assert.equal(f.comments(mention.dm).length, 0);
  assert.equal(new Set(f.comments(home.id).map((c) => c.body)).size, f.comments(home.id).length);
  // the allowlist was enforced: nothing ever read the protected channel
  assert.equal(f.slackReads.filter((r) => r.channel === PROTECTED).length, 0);
  assert.ok(f.slackReads.every((r) => r.channel === ALLOWED));
  // no write came from a non-home session: every run row belongs to the home session, and the mention session never bound a run
  const store = storeFor(f);
  const runKeys = [...f.rows.keys()].filter((k) => /:run:/.test(k) && k.endsWith('@v1')).map((k) => k.replace(/@v1$/, ''));
  for (const k of runKeys) {
    const run: any = await store.get(k);
    assert.ok(run.session_id === null || run.session_id === homeSession, `run ${k} belongs to ${run.session_id}`);
  }
  const jobRow: any = await store.get(`work-engine:qa:tony:job:${job}`);
  assert.equal(Object.keys(jobRow.session_gen).includes(mention.session), false, 'the mention session never held a generation');
  assert.ok(Object.keys(jobRow.session_gen).includes(homeSession));
  // mapping and ownership rows exist
  const map: any = await store.get(dmmapKey('qa', 'tony', jobRow.dm_id));
  assert.equal(map.dm, home.id);
  // nothing was written by an unexpected identity: the caller path never used the owner keyring
  // the owner token is used for exactly four things: who it is, creating and hiding the home DM, and the wake trigger
  assert.ok(f.log.filter((l) => l.as === 'owner').every((l) => ['workflows.trigger', 'dev-users.self', 'chats.create', 'chats.update'].includes(l.path)));
  assert.ok(f.log.filter((l) => l.path === 'chats.create' || l.path === 'chats.update').every((l) => l.as === 'owner'), 'the service account never creates the home DM');
  // the operation path has no owner keyring: a notice attempted there is refused before any send, so sent triggers match successful owner calls
  assert.equal(f.log.filter((l) => l.as === 'owner' && l.path === 'workflows.trigger' && l.status === 200).length, f.triggers.length);
  // R42 row budget: every created row is one immutable version; print the journey's total and its split by kind.
  const byKind: Record<string, number> = {};
  for (const k of f.rows.keys()) { const kind = k.split(':')[3] ?? '?'; byKind[kind] = (byKind[kind] ?? 0) + 1; }
  if (process.env.ROWS_DETAIL) { const per: Record<string, number> = {}; for (const k of f.rows.keys()) { const b = k.replace(/@v\d+$/, ''); per[b] = (per[b] ?? 0) + 1; } console.log(Object.entries(per).filter(([, n]) => n > 1).map(([k, n]) => `${n} ${k.split(':').slice(3).join(':')}`).join('\n')); }
  console.log(`ROWS interruption-boundary journey: ${f.rows.size} total ${JSON.stringify(byKind)}`);
  assert.ok(f.rows.size <= ROW_BUDGET, `journey created ${f.rows.size} rows, budget ${ROW_BUDGET}: ${JSON.stringify(byKind)}`);
});

test('dispatcher rejects authority fields, unknown calls and unsupported events', async () => {
  const f = new FakePlatform(); const d = dispatcher(f); const m = f.newMentionDm();
  for (const field of ['dm', 'dm_id', 'session_object', 'caller_id', 'session_id']) {
    const r = await d.call({ call: 'job_view', job: 'x', [field]: 'forged', agent_session_id: m.session });
    assert.equal(r.status, 'rejected', field);
  }
  assert.equal(f.rowCount(), 0);
  assert.equal((await d.call({ call: 'nope' })).status, 'bad_call');
  await assert.rejects(d.fn([{ context: { secrets: { service_account_token: 't' }, snap_in_id: 'x' }, execution_metadata: { event_type: 'custom:other' } }]), /unsupported/);
  await assert.rejects(d.fn([{ context: { secrets: {} } }]), /authenticated/);
  await assert.rejects(d.fn([]), /at least one/);
});

test('a call without a session id is answered without ownership, and writes nothing from a guessed home', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const rootA = f.root(ALLOWED, OWNER_SLACK, 'r'); const threadA = `${ALLOWED}:${rootA}`;
  const opened = await d.call({ call: 'job_open', workflow: WF, target: '5.2.12', thread: threadA, intent: 'join' });
  const r = await d.call({ call: 'intend', job: opened.job, action: 'open_bump_pr', ref: 'pr', agent_session_id: '' });
  assert.notEqual(r.status, 'go'); assert.notEqual(r.status, 'clear');
  assert.match(String(r.say_to_tony), /ownership unconfirmed|hold/i);
});

test('403 on sessions.get holds consequential calls; reads still work; recovery after the 403 clears', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const rootA = f.root(ALLOWED, OWNER_SLACK, 'r'); const threadA = `${ALLOWED}:${rootA}`;
  const opened = await d.call({ call: 'job_open', workflow: WF, target: '5.2.13', thread: threadA, intent: 'join' });
  f.clock.advanceMinutes(1); await d.tick();
  const home = [...f.chats.values()][0]; const s = f.sessionIn(home.id);
  f.inject('ai-agent.sessions.get', { status: 403, type: 'forbidden', times: 3 });
  const held = await d.call({ call: 'intend', job: opened.job, action: 'open_bump_pr', ref: 'pr', agent_session_id: s });
  assert.match(String(held.say_to_tony), /ownership unconfirmed/i);
  assert.equal((await d.call({ call: 'job_view', job: opened.job, agent_session_id: s })).ok, true);
  f.clearRules();
  const ok = await d.call({ call: 'intend', job: opened.job, action: 'open_bump_pr', ref: 'pr', agent_session_id: s });
  assert.equal(ok.ok, true); assert.notEqual(ok.status, 'route');
});

test('store failure mid-call returns an engine_unavailable answer, never a thrown error, and a retry succeeds', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  f.inject('custom-objects.create', { status: 403, type: 'forbidden', times: 10 });
  const a = await d.call({ call: 'job_open', workflow: WF, target: '5.2.14', thread: `${ALLOWED}:1800000000.000900`, intent: 'join' });
  assert.equal(a.ok, false); assert.equal(a.status, 'engine_unavailable');
  f.clearRules();
  const b = await d.call({ call: 'job_open', workflow: WF, target: '5.2.14', thread: `${ALLOWED}:1800000000.000900`, intent: 'join' });
  assert.equal(b.ok, true);
});

test('oversized record returns a clear record_too_large answer', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const a = await d.call({ call: 'job_open', workflow: WF, target: 'x'.repeat(140_000), thread: `${ALLOWED}:1800000000.000901`, intent: 'join' });
  assert.equal(a.status, 'record_too_large');
});

test('the timer path survives a Slack 429 and a GitHub outage, and still sweeps', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const rootA = f.root(ALLOWED, OWNER_SLACK, 'r');
  await d.call({ call: 'job_open', workflow: WF, target: '5.2.15', thread: `${ALLOWED}:${rootA}`, intent: 'join' });
  f.failSlack('ratelimited', 5); f.failGithub();
  f.clock.advanceMinutes(1);
  await d.tick();
  assert.equal([...f.chats.values()].length, 1, 'the sweep still woke the job');
});

test('the operation path with no owner keyring cannot wake, and the caller token is the only identity used', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  await d.call({ call: 'job_open', workflow: WF, target: '5.2.16', thread: `${ALLOWED}:1800000000.000902`, intent: 'join' });
  assert.ok(f.log.filter((l) => l.as === 'caller').length > 0);
  assert.equal(f.log.filter((l) => l.as === 'service').length, 0);
  assert.equal(f.log.filter((l) => l.as === 'owner').length, 0);
});

test('a factory built on the fake is independent of the real HTTP deps', () => {
  const f = new FakePlatform();
  assert.equal(typeof createWorkEngine(f.deps()), 'function');
});

// ---------------------------------------------------------------- R40 to R43: live QA defects, reproduced offline

async function openAndWake(f: FakePlatform, d: ReturnType<typeof dispatcher>, target: string) {
  const rootA = f.root(ALLOWED, OWNER_SLACK, 'r'); const threadA = `${ALLOWED}:${rootA}`;
  const opened = await d.call({ call: 'job_open', workflow: WF, target, thread: threadA, intent: 'join', requester: OWNER_SLACK });
  return { job: opened.job as string, threadA };
}

test('live defect 1: ten idle ticks create zero rows through the dispatcher', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const { job } = await openAndWake(f, d, '5.3.1');
  f.clock.advanceMinutes(1); await d.tick(); // wakes the job, creates the home
  const home = [...f.chats.values()][0]; const s = f.sessionIn(home.id);
  const cp = await d.call({ call: 'checkpoint', job, status: 'working', waiting_for: 'qa', next_wake_in: '60m', agent_session_id: s });
  assert.equal(cp.ok, true);
  await d.tick(); // settle anything the checkpoint left for the sweep
  const before = f.creates;
  for (let i = 0; i < 10; i++) { f.clock.advanceMinutes(1); await d.tick(); }
  assert.equal(f.creates - before, 0, `idle ticks created: ${f.createdKeys.slice(before).join(', ')}`);
});

test('live defect 1b: a bare install with no job also writes nothing per tick', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  for (let i = 0; i < 10; i++) { f.clock.advanceMinutes(1); await d.tick(); }
  assert.equal(f.creates, 0);
});

test('live defect 2: empty wake_user and wake_workflow are flagged once and cost no rows per tick afterwards', async () => {
  const f = new FakePlatform(); f.installInputs.wake_user = ''; f.installInputs.wake_workflow = ''; const d = dispatcher(f);
  const { job } = await openAndWake(f, d, '5.3.2');
  f.clock.advanceMinutes(1); await d.tick();
  const afterFirst = f.creates;
  for (let i = 0; i < 60; i++) { f.clock.advanceMinutes(1); await d.tick(); }
  assert.ok(f.creates - afterFirst <= 6, `60 ticks with no wake config created ${f.creates - afterFirst} rows (live: about 270)`);
  assert.equal(f.chats.size, 0, 'no home DM was created against a config that cannot wake it');
  assert.equal(f.triggers.length, 0);
  const dmmaps = [...f.rows.keys()].filter((k) => /:dmmap:/.test(k));
  assert.deepEqual(dmmaps, [], 'no dmmap row stuck at "creating"');
  const store = storeFor(f);
  const flags = [...f.rows.keys()].filter((k) => /:flag:/.test(k) && k.endsWith('@v1'));
  const bodies = await Promise.all(flags.map((k) => store.get<any>(k.replace(/@v1$/, ''))));
  assert.equal(bodies.filter((b) => b.check === 'escalate' && /cannot be woken/.test(b.detail)).length, 1, 'the wake failure escalates exactly once (the separate identity escalation is a different flag)');
  const view: any = await d.call({ call: 'job_view', job });
  assert.match(String(view.say_to_tony), /wake configuration is missing/);
  assert.match(String(view.say_to_tony), new RegExp(OWNER_SLACK));
});

test('live defect 2b: a wake that fails after the dmmap is written to "creating" backs off, then recovers on a real attempt', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const { job } = await openAndWake(f, d, '5.3.3');
  f.inject('chats.create', { status: 500, type: 'internal', message: 'boom', times: 3 });
  const perTick: number[] = [];
  for (let i = 0; i < 40; i++) { f.clock.advanceMinutes(1); const c = f.creates; await d.tick(); perTick.push(f.creates - c); }
  const total = perTick.reduce((a, b) => a + b, 0);
  assert.ok(total < 60, `40 failing ticks wrote ${total} rows: ${perTick.join(',')}`);
  const map = [...f.rows.keys()].filter((k) => /:dmmap:dm:/.test(k));
  assert.equal(map.length > 0, true);
  // chats.create stops failing; the next real wake attempt creates the DM and the map becomes ready
  for (let i = 0; i < 70; i++) { f.clock.advanceMinutes(1); await d.tick(); }
  const homes = [...f.chats.values()];
  assert.equal(homes.length, 1, 'the home was created once, after the failure cleared');
  assert.ok(f.triggers.length >= 1);
  const store = storeFor(f);
  const jobRow: any = await store.get(`work-engine:qa:tony:job:${job}`);
  const row: any = await store.get(dmmapKey('qa', 'tony', jobRow.dm_id));
  assert.equal(row.state, 'ready'); assert.equal(row.dm, homes[0].id);
});

test('live defect 3: a job whose home cannot be created is closed by the operator list, with no effect', async () => {
  const f = new FakePlatform(); f.installInputs.wake_user = ''; const d = dispatcher(f);
  const { job } = await openAndWake(f, d, '5.3.4');
  const mention = f.newMentionDm();
  // the conversation session cannot cancel (by design)
  const cancel = await d.call({ call: 'checkpoint', job, status: 'cancelled', agent_session_id: mention.session });
  assert.notEqual(cancel.job_status, 'cancelled');
  f.clock.advanceMinutes(1); await d.tick();
  // an operation input cannot reach the admin path
  const forged = await d.call({ call: 'job_view', job, admin_close: job } as any);
  assert.equal(forged.ok !== undefined, true);
  const jobKey = `work-engine:qa:tony:job:${job}`;
  const store = storeFor(f);
  assert.notEqual((await store.get<any>(jobKey))!.status, 'cancelled', 'no operation input closes a job');
  // the operator sets admin_close_jobs on the installation; the next timer tick closes it
  f.installInputs.admin_close_jobs = `${job}=home never created (wake config was empty)`;
  const posts = f.triggers.length; const chats = f.chats.size;
  f.clock.advanceMinutes(1); await d.tick();
  const closed = (await storeFor(f).get<any>(jobKey))!; // a fresh store: the earlier one caches the latest version
  assert.equal(closed.status, 'cancelled'); assert.match(closed.cancel_reason, /home never created/); assert.equal(closed.next_wake_at, null);
  assert.equal(f.triggers.length, posts); assert.equal(f.chats.size, chats, 'closing created no DM and posted nothing');
  // the list stays set: later ticks write nothing
  const c = f.creates;
  for (let i = 0; i < 5; i++) { f.clock.advanceMinutes(1); await d.tick(); }
  assert.equal(f.creates, c);
});

test('the admin close list is read only from the installation, never from an operation call', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const { job } = await openAndWake(f, d, '5.3.5');
  for (const field of ['admin_close_jobs', 'admin_close', 'admin_token', 'maintenance']) {
    await d.call({ call: 'job_view', job, [field]: job } as any);
  }
  f.clock.advanceMinutes(1); await d.tick();
  assert.notEqual((await storeFor(f).get<any>(`work-engine:qa:tony:job:${job}`))!.status, 'cancelled');
  const m = (await import('node:fs')).readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8');
  const opBlock = m.slice(m.indexOf('operations:'));
  assert.doesNotMatch(opBlock, /admin_close|admin_token|maintenance/);
});

const MANIFEST = readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8');

test('R47 regression: without ai_agent:read the timer path gets the live 403 before the DM exists; dmmap stays creating', async () => {
  const f = new FakePlatform().useManifest(MANIFEST.replace(/      - scope: ai_agent:read\n        optional: false\n        reason: [^\n]*\n/, ''));
  assert.ok(!f.scopes.service.has('ai_agent:read'), 'the edit removed the scope');
  const d = dispatcher(f);
  const mention = f.newMentionDm();
  const opened = await d.call({ call: 'job_open', workflow: WF, target: '5.2.11', thread: `${ALLOWED}:1.000001`, role: 'request', intent: 'join', requester: 'U1', agent_session_id: mention.session });
  assert.equal(opened.status, 'opened');
  await d.tick(); f.clock.advanceMinutes(2); await d.tick();
  const denied = f.log.filter((l) => l.path === 'ai-agents.get');
  assert.ok(denied.length > 0 && denied.every((l) => l.status === 403 && l.as === 'service'), 'ai-agents.get was refused with 403 as the service account');
  assert.equal(f.chats.size, 1, 'only the mention DM: no home was created');
  const maps = [...f.rows.values()].filter((r) => r.unique_key.includes(':dmmap:') && !r.unique_key.includes('dmrev'));
  assert.ok(maps.length > 0);
  assert.ok(maps.every((r) => JSON.parse(String(r.custom_fields.tnt__body)).state === 'creating'), 'dmmap stays creating');
});

test('R47: with the manifest as shipped the same journey creates the home (scope table comes from the parsed manifest)', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const mention = f.newMentionDm();
  await d.call({ call: 'job_open', workflow: WF, target: '5.2.11', thread: `${ALLOWED}:1.000001`, role: 'request', intent: 'join', requester: 'U1', agent_session_id: mention.session });
  await d.tick(); f.clock.advanceMinutes(2); await d.tick();
  assert.equal(f.chats.size, 2);
  assert.ok(f.log.filter((l) => l.path === 'ai-agents.get').every((l) => l.status === 200));
});
