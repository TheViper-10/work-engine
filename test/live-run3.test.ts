// Live run 3 repros (R69-R75): the shipped config enforces holds; a gate's go comes from that gate's listed responders for the named
// build; served state is not proof; a user-token post is a person; merges are settled on the operation path; links are verified.
// Written before the fixes and failing against the engine as of dc5a09f.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.ts';
import { MemoryStore } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import type { EngineConfig } from '../src/config.ts';
import type { SessionDirectory, Spec, SlackReader } from '../src/types.ts';
import { engineConfig, readInputs } from '../snap-in/src/specs.ts';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const CH = 'C0C4K4EGZT6';
const A = `${CH}:1791149910.562169`;
const QT = `${CH}:1791149999.000100`;
const SPEC: Spec = {
  workflow: 'wf', version: 1, link_roles: ['request', 'side', 'qa'], one_open_job: true, target_pattern: '^\\d+\\.\\d+\\.\\d+$',
  people: { owner: { slack: 'U1' }, harry: { slack: 'U2' } },
  gates: { qa_gate: { responders: { primary: ['owner'], stand_ins: [] } }, alpha_gate: { responders: { primary: ['harry'], stand_ins: ['owner'] } } },
  milestones: {
    qa_ask: { audience: { roles: ['request'], promise_holders: true }, opens_ask: 'qa_gate' },
    alpha_ask: { audience: { roles: ['request', 'qa'], promise_holders: true }, opens_ask: 'alpha_gate' },
    qa_ready: { audience: { roles: ['request'], promise_holders: true }, outcome: true },
  },
  actions: { approve_qa: { gate: 'qa_gate', proved_by: 'gate_approved' }, approve_alpha: { gate: 'alpha_gate', proved_by: 'gate_approved' }, merge: { resource: 'main', proved_by: 'github_pr_merged' } },
  resources: ['main'],
  defaults: { next_wake_minutes: 30, promise_fallback_minutes: 240, operation_unknown_minutes: 30 },
};
const H = { session_id: 'h1' };

/** The config the snap-in ships for a default install; tests must not build their own check modes. */
const shipped = (): EngineConfig => ({ ...engineConfig(readInputs({})), env: 't', bot: 'b', ownBotUserId: 'UBOT' });

export function env(o: { build?: string | null; slack?: Partial<SlackReader>; config?: EngineConfig; merged?: Set<string>; readable?: boolean; threads?: Record<string, string> } = {}) {
  const clock = new ManualClock(T0);
  const wakes: string[] = [];
  const dir: SessionDirectory = {
    cacheable: false,
    async dmOf(sid, job) { return sid.startsWith('m') ? { dm: `dm:mention:${sid}` } : { dm: job!.dm }; },
    async threadOf(sid) { return sid === 'mA' ? { thread: A, prompt_ts: '1791149910.562169' } : { error: 'no thread' }; },
  };
  const engine = new Engine({
    store: new MemoryStore(), clock,
    sourceReader: {
      currentBuild: async () => (o.build === null ? null : o.build ?? 'b1'),
      operationOutcome: async (kind, ref) => (kind === 'github_pr_merged' && o.merged?.has(ref) ? 'done' : null),
    },
    slackReader: { findOwnPostAfter: async () => null, ...(o.slack ?? {}) },
    waker: { postWake: async (_dm, text) => { wakes.push(text); } },
    config: o.config ?? shipped(),
    specs: [SPEC], sessionDirectory: dir, strictThreads: true,
  });
  return { engine, clock, wakes };
}
type E = ReturnType<typeof env>;
export async function open(e: E, thread = A): Promise<string> { return ((await e.engine.jobOpen({ workflow: 'wf', target: '5.2.11', thread }, H)) as any).job as string; }
export const view = async (e: E, j: string): Promise<any> => ((await e.engine.jobView({ job: j }, H)) as any).jobs[0];
export const human = (e: E, id: string, sender: string, thread = A, kind?: string) => e.engine.ingest({ source: 'slack', delivery_id: id, kind: 'message', thread, sender_id: sender, sender_kind: 'human', ref: `slack:${id}`, attrs: { ts: e.clock.now(), ...(kind ? { inbox_kind: kind } : {}) } } as any);

test('F2: the shipped config holds every hold-class check (a default install must not run them as flags)', () => {
  const c = shipped();
  for (const name of ['build_changed', 'job_cancelled', 'superseded_run', 'no_go_for_build', 'sender_not_listed'] as const) assert.equal(c.checks[name], 'hold', name);
  // the harness takes its deploy config from the snap-in, never from a copy
  const binding = readFileSync(new URL('../harness/engine-binding.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(binding, /DEPLOY_CHECKS/);
  assert.match(binding, /snap-in\/src\/specs\.ts/);
});

test('F2b: a go from the other gate\'s responder does not authorize this gate; the QA gate is not approved on the sign-off person\'s word', async () => {
  const e = env();
  const j = await open(e);
  await e.engine.say({ job: j, thread: A, milestone: 'qa_ask' }, H);
  await human(e, `${CH}:9.1`, 'U2'); // Harry: listed for alpha_gate only
  const r: any = await e.engine.intend({ job: j, action: 'approve_qa', ref: 'p1', because: `slack:${CH}:9.1` }, H);
  assert.equal(r.status, 'hold');
  assert.match(r.say_to_tony, /sender_not_listed/);
  assert.equal((await view(e, j)).operations.find((o: any) => o.action === 'approve_qa')?.outcome ?? 'held', 'held');
});

test('F2b variation: with no ask for the gate at all, that same event still cannot approve it; after the ask and the owner go it clears once', async () => {
  const e = env();
  const j = await open(e);
  await human(e, `${CH}:9.2`, 'U2');
  const r1: any = await e.engine.intend({ job: j, action: 'approve_qa', ref: 'p1', because: `slack:${CH}:9.2` }, H);
  assert.equal(r1.status, 'hold');
  await e.engine.say({ job: j, thread: A, milestone: 'qa_ask' }, H);
  e.clock.advance(MIN);
  await human(e, `${CH}:9.3`, 'U1');
  const r2: any = await e.engine.intend({ job: j, action: 'approve_qa', ref: 'p1', because: `slack:${CH}:9.3` }, H);
  assert.equal(r2.status, 'clear');
  const r3: any = await e.engine.intend({ job: j, action: 'approve_qa', ref: 'p1', because: `slack:${CH}:9.3` }, H);
  assert.equal(r3.status, 'already_recorded');
});
