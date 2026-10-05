// Live run 2 repros (R62, R63): the reason for a consequential action is the go event; an approval answers the ask; the requester is shown
// from Slack evidence; a merge the source shows is settled. Written before the fixes and failing against the engine as of d5aa79f.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { MemoryStore } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import { defineConfig, DEPLOY_CHECKS } from '../src/config.ts';
import type { SessionDirectory, Spec } from '../src/types.ts';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const CH = 'C0C4K4EGZT6';
const A = `${CH}:1791149910.562169`;
const SPEC: Spec = {
  workflow: 'wf', version: 1, link_roles: ['request', 'side', 'qa'], one_open_job: true, target_pattern: '^\\d+\\.\\d+\\.\\d+$',
  people: { p: { slack: 'U1' }, s: { slack: 'U2' } },
  gates: { g: { responders: { primary: ['p'], stand_ins: ['s'] } } },
  milestones: { ask: { audience: { roles: ['request'], promise_holders: true }, opens_ask: 'g' } },
  actions: { approve: { gate: 'g', proved_by: 'gate_approved' }, merge: { resource: 'main', proved_by: 'pr_merged' } },
  resources: ['main'],
  defaults: { next_wake_minutes: 30, promise_fallback_minutes: 240, operation_unknown_minutes: 30 },
};
const H = { session_id: 'h1' };

function env(o: { merged?: Set<string>; author?: string | null; build?: string } = {}) {
  const clock = new ManualClock(T0);
  const dir: SessionDirectory = {
    cacheable: false,
    async dmOf(sid, job) { return sid.startsWith('m') ? { dm: `dm:mention:${sid}` } : { dm: job!.dm }; },
    async threadOf(sid) { return sid === 'mA' ? { thread: A, prompt_ts: '1791149910.562169' } : { error: 'no thread' }; },
  };
  const engine = new Engine({
    store: new MemoryStore(), clock,
    sourceReader: { currentBuild: async () => o.build ?? 'b1', operationOutcome: async (kind, ref) => (kind === 'pr_merged' && o.merged?.has(ref) ? 'done' : null) },
    slackReader: { findOwnPostAfter: async () => null, authorOf: async () => (o.author === undefined ? 'U042GEDM4BB' : o.author) },
    waker: { postWake: async () => {} },
    config: defineConfig({ env: 't', bot: 'b', ownBotUserId: 'UBOT', checks: { ...DEPLOY_CHECKS } }),
    specs: [SPEC], sessionDirectory: dir,
  });
  return { engine, clock };
}
async function asked(e: ReturnType<typeof env>) {
  const j = ((await e.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A }, H)) as any).job as string;
  await e.engine.say({ job: j, thread: A, milestone: 'ask' }, H);
  return j;
}
const view = async (e: ReturnType<typeof env>, j: string): Promise<any> => ((await e.engine.jobView({ job: j }, H)) as any).jobs[0];
const go = (e: ReturnType<typeof env>, id: string, sender = 'U1') => e.engine.ingest({ source: 'slack', delivery_id: id, kind: 'message', thread: A, sender_id: sender, ref: `slack:${id}`, attrs: { ts: T0 + 1 } });

test('R62: free text as the reason is resolved to the listed go event, and the approval answers the ask with that event', async () => {
  const e = env();
  const j = await asked(e);
  await go(e, `${CH}:1.1`);
  const r: any = await e.engine.intend({ job: j, action: 'approve', ref: 'p1', because: 'go given for build b1, the current build' }, H);
  assert.equal(r.status, 'clear');
  assert.equal(r.because_resolved_by_engine, true);
  assert.equal(r.go_event, `slack:${CH}:1.1`);
  assert.equal(r.operation.because, `slack:${CH}:1.1`);
  const v = await view(e, j);
  assert.deepEqual(v.answered_asks, [{ gate: 'g', build: 'b1', answered_by: 'U1', answered_event: `slack:${CH}:1.1` }]);
  assert.equal(v.open_asks.length, 0);
});

test('R62: the event id and the #n both work and are not flagged as resolved by the engine', async () => {
  for (const pick of ['id', 'n'] as const) {
    const e = env();
    const j = await asked(e);
    await go(e, `${CH}:2.2`);
    const because = pick === 'id' ? `slack:${CH}:2.2` : `#${(await view(e, j)).inbox[0].id.slice(1)}`;
    const r: any = await e.engine.intend({ job: j, action: 'approve', ref: 'p1', because }, H);
    assert.equal(r.status, 'clear');
    assert.equal(r.because_resolved_by_engine, false);
    assert.equal(r.go_event, `slack:${CH}:2.2`);
  }
});

test('R62: free text with no listed go on record is held; a go from someone not listed does not count; the hold is unchanged with no ask', async () => {
  const e = env();
  const j = await asked(e);
  const none: any = await e.engine.intend({ job: j, action: 'approve', ref: 'p1', because: 'the owner said so' }, H);
  assert.equal(none.status, 'hold');
  await go(e, `${CH}:3.3`, 'U9');
  const stranger: any = await e.engine.intend({ job: j, action: 'approve', ref: 'p1', because: 'the owner said so' }, H);
  assert.equal(stranger.status, 'hold', 'U9 is not a responder of the gate');
  // no ask at all: still no_go_for_build
  const e2 = env();
  const j2 = ((await e2.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A }, H)) as any).job as string;
  const r2: any = await e2.engine.intend({ job: j2, action: 'approve', ref: 'p1', because: 'go' }, H);
  assert.equal(r2.status, 'hold');
  assert.match(r2.say_to_tony, /no_go_for_build/);
});

test('R62: a duplicate go still yields one approval and answers the ask once', async () => {
  const e = env();
  const j = await asked(e);
  await go(e, `${CH}:4.4`); await go(e, `${CH}:4.5`);
  const a: any = await e.engine.intend({ job: j, action: 'approve', ref: 'p1', because: `slack:${CH}:4.4` }, H);
  const b: any = await e.engine.intend({ job: j, action: 'approve', ref: 'p1', because: `slack:${CH}:4.5` }, H);
  assert.equal(a.status, 'clear');
  assert.equal(b.status, 'already_recorded');
  assert.equal((await view(e, j)).operations.filter((o: any) => o.action === 'approve').length, 1);
});

test('R62: the requester shown to a mention session is the Slack author of the mentioning message', async () => {
  const e = env({ author: 'U042GEDM4BB' });
  const j = ((await e.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A }, H)) as any).job as string;
  const r: any = await e.engine.jobView({ job: j }, { session_id: 'mA' });
  assert.deepEqual(r.asked_by, { user: 'U042GEDM4BB', thread: A });
  assert.match(r.say_to_tony, /Asked by: <@U042GEDM4BB>/);
  assert.match(r.say_to_tony, /not the requester/);
  // unknown author: nothing is shown, so nothing can be addressed by guess
  const e2 = env({ author: null });
  const j2 = ((await e2.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A }, H)) as any).job as string;
  const r2: any = await e2.engine.jobView({ job: j2 }, { session_id: 'mA' });
  assert.equal(r2.asked_by, undefined);
  assert.doesNotMatch(r2.say_to_tony, /Asked by/);
  // a home session has no requester line
  assert.equal(((await e.engine.jobView({ job: j }, H)) as any).asked_by, undefined);
});

test('R63: a merge nobody reported is settled from the source after the timeout; an unmerged one stays unknown; a failure is never inferred', async () => {
  const e = env({ merged: new Set(['58061']) });
  const j = ((await e.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A }, H)) as any).job as string;
  await e.engine.intend({ job: j, action: 'merge', ref: '58061' }, H);
  await e.engine.intend({ job: j, action: 'merge', ref: '58062' }, H);
  e.clock.advance(31 * MIN);
  await e.engine.sweep();
  const ops = (await view(e, j)).operations;
  assert.equal(ops.find((o: any) => o.ref === '58061').outcome, 'done');
  assert.equal(ops.find((o: any) => o.ref === '58061').source, 'webhook_verified');
  assert.equal(ops.find((o: any) => o.ref === '58062').outcome, 'unknown');
  // already unknown when the source starts showing it: settled on the next sweep
  const e2 = env();
  const j2 = ((await e2.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread: A }, H)) as any).job as string;
  await e2.engine.intend({ job: j2, action: 'merge', ref: '7' }, H);
  e2.clock.advance(31 * MIN); await e2.engine.sweep();
  assert.equal((await view(e2, j2)).operations[0].outcome, 'unknown');
});
