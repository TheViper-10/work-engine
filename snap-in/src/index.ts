// Snap-in entry: the dispatcher for operation calls (caller token) and timer ticks (service-account token).
// Every call builds the engine on a PlatformStore and runs exactly one engine entry point. There is no queue:
// the engine's own compare-and-set is the only ordering it relies on.
import { Engine } from '../../src/engine.ts';
import { SystemClock } from '../../src/clock.ts';
import type { Answer, Ctx } from '../../src/types.ts';
import { PlatformSessionDirectory } from './directory.ts';
import { ApiError, httpDeps, scoped, type Deps, type DevRevApi, type Identity } from './platform.ts';
import { PlatformSlackReader, SlackPoller, normThread } from './slack.ts';
import { GithubSourceReader } from './source.ts';
import { BodyTooLargeError, PlatformStore } from './store-platform.ts';
import { engineConfig, readInputs, SPECS, type Inputs } from './specs.ts';
import { PlatformWaker } from './waker.ts';

export const CALLS = ['job_open', 'job_view', 'intend', 'say', 'promise_add', 'checkpoint'] as const;
export type CallName = (typeof CALLS)[number];
/** Authority is never caller-supplied: the DM comes from the looked-up session (D1). */
export const FORBIDDEN_AUTHORITY = new Set(['caller_id', 'actor_id', 'grant', 'approval', 'state', 'capabilities', 'slack', 'dm', 'dm_id', 'session_object', 'scheduled', 'scheduled_actor', 'session_id', 'generation']);
export const PR_GATES = ['pr_review'] as const;
export const TICK_BUDGET_MS = 100_000;

export interface Runtime {
  engine: Engine;
  poller: SlackPoller;
  inputs: Inputs;
  store: PlatformStore;
  directory: PlatformSessionDirectory;
  waker: PlatformWaker;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Build the engine for one invocation. `as` is the identity whose token performs store and chat calls. */
export async function buildRuntime(event: any, deps: Deps, as: Identity, snapInId?: string): Promise<Runtime> {
  const api: DevRevApi = deps.devrev(event);
  const id = event?.context?.snap_in_id || snapInId;
  if (!id) throw new Error('missing installation context');
  const snap = await api.call('snap-ins.get', { id }, as);
  const inputs = readInputs(snap?.snap_in?.inputs_values ?? {});
  const store = new PlatformStore({ api: scoped(api, as), sleep: deps.sleep });
  const directory = new PlatformSessionDirectory({ api: scoped(api, as), store, env: inputs.env, bot: inputs.bot });
  const waker = new PlatformWaker({
    store, clock: deps.clock, env: inputs.env, bot: inputs.bot, chat: scoped(api, as), owner: scoped(api, 'owner'),
    tonyAgent: inputs.tony_agent, wakeUser: inputs.wake_user, wakeWorkflow: inputs.wake_workflow,
  });
  const slackApi = deps.slack(event);
  const engine = new Engine({
    store, clock: deps.clock, config: engineConfig(inputs), specs: SPECS, sessionDirectory: directory, waker,
    sourceReader: new GithubSourceReader({ api: deps.github(event), repo: inputs.github_repo, branch: inputs.mock_branch, statePath: inputs.state_path, prGates: PR_GATES }),
    slackReader: new PlatformSlackReader({ api: slackApi, allow: inputs.slack_channel_allowlist, ownBotUserId: inputs.own_bot_user }),
    guidanceVersion: inputs.guidance_version || undefined,
  });
  const poller = new SlackPoller({
    api: slackApi, store, clock: deps.clock, env: inputs.env, bot: inputs.bot, allow: inputs.slack_channel_allowlist,
    ownBotUserId: inputs.own_bot_user, ingest: (ev) => engine.ingest(ev),
  });
  return { engine, poller, inputs, store, directory, waker };
}

// ---------------------------------------------------------------- argument shaping

/** Arrays arrive typed from the workflow, but accept a JSON string or comma list too (one bad field must not drop a call). */
function list(v: unknown): unknown[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v;
  if (isObj(v) && Array.isArray(v.items)) return v.items;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch { /* fall through */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : typeof v === 'string' ? v : String(v));
const strs = (v: unknown): string[] | undefined => list(v)?.map(String);
const num = (v: unknown): number | string | undefined => (typeof v === 'number' ? v : str(v));
const thr = (v: unknown): string | undefined => { const s = str(v); return s === undefined ? undefined : normThread(s); };

export function shapeArgs(call: CallName, d: Record<string, any>): Record<string, any> {
  const a: Record<string, any> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined) a[k] = v; };
  switch (call) {
    case 'job_open':
      put('workflow', str(d.workflow)); put('target', str(d.target)); put('thread', thr(d.thread));
      put('role', str(d.role)); put('private', typeof d.private === 'boolean' ? d.private : undefined); put('intent', str(d.intent)); put('requester', str(d.requester));
      break;
    case 'job_view':
      put('job', str(d.job)); put('thread', thr(d.thread));
      break;
    case 'intend':
      put('job', str(d.job)); put('action', str(d.action)); put('ref', str(d.ref)); put('because', str(d.because));
      break;
    case 'say':
      put('job', str(d.job)); put('thread', thr(d.thread)); put('milestone', str(d.milestone)); put('posted_link', str(d.posted_link));
      break;
    case 'promise_add':
      put('job', str(d.job)); put('thread', thr(d.thread)); put('about', str(d.about)); put('fallback_time', num(d.fallback_time));
      break;
    case 'checkpoint':
      put('job', str(d.job)); put('status', str(d.status)); put('waiting_for', str(d.waiting_for)); put('next_wake_in', num(d.next_wake_in));
      put('operations', list(d.operations)?.map((o) => { if (typeof o !== 'string') return o; try { return JSON.parse(o); } catch { return o; } })); put('reached', strs(d.reached)); put('processed', strs(d.processed));
      break;
  }
  return a;
}

// ---------------------------------------------------------------- operation path

function failure(status: string, say: string): Answer { return { ok: false, status, say_to_tony: say }; }

export async function runOperation(event: any, deps: Deps): Promise<Answer> {
  const data: Record<string, any> = event?.payload?.data ?? {};
  const bad = Object.keys(data).filter((k) => FORBIDDEN_AUTHORITY.has(k));
  if (bad.length) return failure('rejected', `The call carried fields the platform owns (${bad.join(', ')}); nothing was recorded.`);
  const call = data.call as CallName;
  if (!CALLS.includes(call)) return failure('bad_call', `Unknown call "${String(data.call)}". Use one of: ${CALLS.join(', ')}.`);
  try {
    const rt = await buildRuntime(event, deps, 'caller', data.snap_in_id);
    const ctx: Ctx = { session_id: typeof data.agent_session_id === 'string' && data.agent_session_id ? data.agent_session_id : undefined };
    const args = shapeArgs(call, data);
    let answer: Answer;
    switch (call) {
      case 'job_open': answer = await rt.engine.jobOpen(args as any, ctx); break;
      case 'job_view': answer = await rt.engine.jobView(args as any, ctx); break;
      case 'intend': answer = await rt.engine.intend(args as any, ctx); break;
      case 'say': answer = await rt.engine.say(args as any, ctx); break;
      case 'promise_add': answer = await rt.engine.promiseAdd(args as any, ctx); break;
      case 'checkpoint': answer = await rt.engine.checkpoint(args as any, ctx); break;
    }
    // A linked Slack thread becomes a watched thread for the poller (the allowlist is enforced inside watch()).
    if (call === 'job_open' && answer.ok && typeof answer.job === 'string' && typeof args.thread === 'string') {
      await rt.poller.watch(args.thread, answer.job).catch(() => undefined);
    }
    return answer;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return failure('record_too_large', e.message);
    const why = e instanceof ApiError ? `platform ${e.status}` : (e as Error).message;
    return failure('engine_unavailable', `The work engine could not finish this call (${why}). Try the same call again.`);
  }
}

// ---------------------------------------------------------------- timer path

export interface TickResult { poll: Awaited<ReturnType<SlackPoller['poll']>> | null; sweep: Answer | null; errors: string[] }

export async function runTick(event: any, deps: Deps): Promise<TickResult> {
  const out: TickResult = { poll: null, sweep: null, errors: [] };
  const started = deps.clock.now();
  const rt = await buildRuntime(event, deps, 'service');
  try { out.poll = await rt.poller.poll(); out.errors.push(...out.poll.errors); } catch (e) { out.errors.push(`poll: ${(e as Error).message}`); }
  if (deps.clock.now() - started > TICK_BUDGET_MS) { out.errors.push('tick budget spent after the poll; sweep left for the next tick'); return out; }
  try { out.sweep = await rt.engine.sweep(); } catch (e) { out.errors.push(`sweep: ${(e as Error).message}`); }
  return out;
}

// ---------------------------------------------------------------- function entry

function wrapOutput(result: unknown): unknown {
  const shaped = { output: { values: [{ result }] } };
  try {
    const sdk = typeof require === 'function' ? require('@devrev/typescript-sdk/dist/snap-ins') : null;
    if (sdk?.OperationOutput?.fromJSON) return sdk.OperationOutput.fromJSON(shaped);
  } catch { /* the SDK is provided by the platform at runtime */ }
  return shaped;
}

export function createWorkEngine(deps: Deps) {
  return async function work_engine(events: any[]): Promise<unknown> {
    if (!Array.isArray(events) || events.length === 0) throw new Error('at least one event is required');
    const callerOnly = events.every((e) => e?.context?.secrets?.access_token && !e?.context?.secrets?.service_account_token && !e?.context?.snap_in_id);
    if (callerOnly) {
      if (events.length !== 1) throw new Error('exactly one operation event is required');
      return wrapOutput(await runOperation(events[0], deps));
    }
    for (const e of events) {
      if (!e?.context?.secrets?.service_account_token || !e?.context?.snap_in_id) throw new Error('authenticated snap-in runtime context required');
      if (e?.execution_metadata?.event_type === 'timer.tick') await runTick(e, deps);
      else throw new Error('unsupported runtime event type');
    }
    return {};
  };
}

export const work_engine = createWorkEngine({ ...httpDeps, clock: new SystemClock() });
export const functionFactory = { work_engine };
