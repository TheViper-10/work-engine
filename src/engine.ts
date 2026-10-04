// Generic work-engine core. Reads workflow data (Spec) only through the fields in types.ts.
// It never decides steps, order or meaning, and never refuses for protocol reasons.

import { CHECK_NAMES, type EngineConfig } from './config.ts';
import { makeKey, MAX_BATCH, type Store } from './store.ts';
import type {
  Answer, Ask, CheckName, Claim, Clock, Ctx, Delivery, EventRecord, FlagKind, FlagRecord, IngestEvent,
  Job, JobStatus, Lease, Operation, Promise_, Run, SlackReader, SourceReader, Spec, Waker,
} from './types.ts';
import { chunk, fmtAge, MIN, parseDuration, parseTime, uniq } from './util.ts';

export interface EngineDeps {
  store: Store;
  clock: Clock;
  sourceReader: SourceReader;
  slackReader: SlackReader;
  waker: Waker;
  config: EngineConfig;
  specs: Spec[] | Record<string, Spec>;
}

interface JobIndex { seq: number; primary: string | null; queued: string[]; winding: string[] }
interface ThreadIndex { jobs: string[] }
interface IdList { ids: string[] }
type Loaded = { job: Job } | { answer: Answer };

const MAX_BUCKETS_PER_SWEEP = 4032;
const MAX_EVENTS_KEPT = 200;
const MAX_REASONS = 20;
const MAX_NOTES = 20;
const MAX_TRIES = 8;

/** Thrown when a compare-and-set write lost a race. The whole call is then re-run from a fresh read. */
class Conflict extends Error {}
/** Version of each record object as last read or written, so save() can compare-and-set. */
const versions = new WeakMap<object, number>();

function ans(ok: boolean, status: string, say_to_tony: string, extra: Record<string, unknown> = {}): Answer {
  return { ok, status, say_to_tony, ...extra };
}

export class Engine {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly sourceReader: SourceReader;
  private readonly slackReader: SlackReader;
  private readonly waker: Waker;
  readonly config: EngineConfig;
  private readonly specs: Record<string, Spec>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.sourceReader = deps.sourceReader;
    this.slackReader = deps.slackReader;
    this.waker = deps.waker;
    this.config = deps.config;
    this.specs = Array.isArray(deps.specs)
      ? Object.fromEntries(deps.specs.map((s) => [s.workflow, s]))
      : deps.specs;
  }

  // ---------------------------------------------------------------- public calls

  jobOpen(
    args: { workflow: string; target: string; thread: string; role?: string; private?: boolean;
      intent?: 'join' | 'replace' | 'queue'; requester?: string },
    ctx: Ctx = {},
  ): Promise<Answer> {
    return this.serial(() => this.doJobOpen(args, ctx));
  }
  jobView(args: { job?: string; thread?: string }, ctx: Ctx = {}): Promise<Answer> {
    return this.serial(() => this.doJobView(args, ctx));
  }
  intend(args: { job: string; action: string; ref: string; because?: string }, ctx: Ctx = {}): Promise<Answer> {
    return this.serial(() => this.doIntend(args, ctx));
  }
  say(args: { job: string; thread: string; milestone: string; posted_link?: string }, ctx: Ctx = {}): Promise<Answer> {
    return this.serial(() => this.doSay(args, ctx));
  }
  promiseAdd(
    args: { job: string; thread: string; about: string; fallback_time?: number | string },
    ctx: Ctx = {},
  ): Promise<Answer> {
    return this.serial(() => this.doPromiseAdd(args, ctx));
  }
  checkpoint(
    args: { job: string; status: string; waiting_for?: string; next_wake_in?: number | string;
      operations?: Array<{ ref: string; action?: string; outcome: 'done' | 'failed' | 'unknown'; note?: string }>;
      reached?: string[] },
    ctx: Ctx = {},
  ): Promise<Answer> {
    return this.serial(() => this.doCheckpoint(args, ctx));
  }

  // ---------------------------------------------------------------- engine-side processes

  ingest(event: IngestEvent): Promise<Answer> {
    return this.serial(() => this.doIngest(event));
  }
  sweep(): Promise<Answer> {
    return this.serial(() => this.doSweep());
  }
  wake(job: string, reason: string): Promise<Answer> {
    // Serialised in-process; across processes a twin wake loses the compare-and-set on the job.
    return this.serial(() => this.doWake(job, reason));
  }

  /** Returns a list of violations (empty when all invariants hold) for the given job ids. */
  async checkInvariants(jobIds: Iterable<string>): Promise<string[]> {
    return this.serial(() => this.doCheckInvariants([...jobIds]));
  }

  // ---------------------------------------------------------------- plumbing

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const attempt = async (): Promise<T> => {
      for (let i = 0; i < MAX_TRIES; i++) {
        try { return await fn(); } catch (e) { if (!(e instanceof Conflict)) throw e; }
      }
      throw new Error('work-engine: too many write conflicts on the store');
    };
    const next = this.chain.then(attempt, attempt);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private now(): number { return this.clock.now(); }
  private k(kind: string, id: string): string { return makeKey(this.config.env, this.config.bot, kind, id); }
  /** Reads a record and remembers its version, so save() can compare-and-set. */
  private async get<T>(kind: string, id: string): Promise<T | null> {
    const r = await this.store.getVersioned<T>(this.k(kind, id));
    if (r.value !== null && typeof r.value === 'object') versions.set(r.value as object, r.version);
    return r.value;
  }
  /** Plain write, for records only one writer ever touches (flags, events, links, cursor). */
  private async put<T>(kind: string, id: string, v: T): Promise<void> { await this.store.put(this.k(kind, id), v); }
  /** Compare-and-set write: fails with Conflict when the record changed since it was read (absent = version 0). */
  private async save<T extends object>(kind: string, id: string, v: T): Promise<void> {
    const r = await this.store.putIfVersion(this.k(kind, id), v, versions.get(v) ?? 0);
    if (!r.ok) throw new Conflict(`${kind}:${id}`);
    versions.set(v, r.version);
  }
  /** Create-if-absent; the returned value is versioned so it can be saved later. */
  private async create<T extends object>(kind: string, id: string, v: T): Promise<{ created: boolean; value: T }> {
    const r = await this.store.putIfAbsent(this.k(kind, id), v);
    if (r.created) { versions.set(v, 1); return { created: true, value: v }; }
    const cur = await this.get<T>(kind, id);
    return { created: false, value: cur ?? r.value };
  }
  /** Read-modify-write one record with its own bounded retry. fn returns false to skip the write. */
  private async update<T extends object>(kind: string, id: string, init: (() => T) | null, fn: (x: T) => boolean | void): Promise<T> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const got = await this.get<T>(kind, id);
      if (got === null && init === null) return null as unknown as T;
      const x = got ?? init!();
      if (fn(x) === false) return x;
      try { await this.save(kind, id, x); return x; } catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    throw new Conflict(`${kind}:${id}`);
  }
  private async updateJob(id: string, fn: (j: Job) => boolean | void): Promise<Job | null> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const j = await this.get<Job>('job', id);
      if (!j) return null;
      if (fn(j) === false) return j;
      try { await this.save('job', id, j); return j; } catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    throw new Conflict(`job:${id}`);
  }
  private async many<T>(kind: string, ids: string[]): Promise<Array<T | null>> {
    const out: Array<T | null> = [];
    for (const c of chunk(ids, MAX_BATCH)) {
      for (const r of await this.store.getManyVersioned<T>(c.map((i) => this.k(kind, i)))) {
        if (r.value !== null && typeof r.value === 'object') versions.set(r.value as object, r.version);
        out.push(r.value);
      }
    }
    return out;
  }
  private async manyPresent<T>(kind: string, ids: string[]): Promise<T[]> {
    return (await this.many<T>(kind, ids)).filter((x): x is T => x !== null);
  }
  private saveJob(job: Job): Promise<void> { return this.save('job', job.id, job); }
  private spec(job: Job): Spec | undefined { return this.specs[job.workflow]; }
  private unknownMs(spec: Spec | undefined): number { return (spec?.defaults?.operation_unknown_minutes ?? 30) * MIN; }
  private nextWakeMs(spec: Spec | undefined): number { return (spec?.defaults?.next_wake_minutes ?? 30) * MIN; }
  private staleMs(spec: Spec | undefined): number { return (spec?.defaults?.claim_stale_minutes ?? 10) * MIN; }
  private bucketOf(t: number): number { return Math.floor(t / (this.config.sweepMinutes * MIN)); }
  private runActive(run: Run | null): boolean {
    return !!run && run.state === 'active' && this.now() - run.last_activity_at < this.config.runTimeoutMinutes * MIN;
  }
  private addReason(job: Job, reason: string): void {
    if (!job.wake_reasons.includes(reason)) job.wake_reasons.push(reason);
    if (job.wake_reasons.length > MAX_REASONS) job.wake_reasons.splice(0, job.wake_reasons.length - MAX_REASONS);
  }

  private async loadJob(id: string | undefined, call: string): Promise<Loaded> {
    if (!id) return { answer: ans(false, 'no_job', `${call}: no job id was given, so nothing was recorded. Call job_view with your thread to find the job.`) };
    const job = await this.get<Job>('job', id);
    if (!job) {
      return { answer: ans(false, 'no_such_job', `${call}: there is no job "${id}", so nothing was recorded. Call job_view with your thread to see open jobs, or job_open to start one.`) };
    }
    return { job };
  }

  // schedule(): register a job in the due-index bucket for a time. Stale entries are harmless;
  // sweep re-reads the job and re-registers whatever is still pending.
  private async schedule(jobId: string, at: number): Promise<void> {
    const now = this.now();
    const b = at <= now ? this.bucketOf(now) : this.bucketOf(at);
    await this.store.putIfAbsent(this.k('sweep_cursor', 'main'), { bucket: this.bucketOf(now) });
    await this.update<IdList>('due_index', String(b), () => ({ ids: [] }), (cur) => {
      if (cur.ids.includes(jobId)) return false;
      cur.ids.push(jobId);
    });
  }

  private async addFlag(job: Job, check: FlagKind, detail: string, call: string, mode: FlagRecord['mode'] = 'flag_only'): Promise<void> {
    job.flag_seq += 1;
    const id = `${job.id}:${job.flag_seq}`;
    const rec: FlagRecord = { key: this.k('flag', id), job: job.id, check, mode, detail, call, at: this.now() };
    await this.put('flag', id, rec);
    job.flag_keys.push(id);
  }

  // ---------------------------------------------------------------- run handling (D1, D10)

  /**
   * Work out the caller's relation to the job's work run and record activity.
   * mayAdopt: a write call may become the work run when none is active.
   * bindPending: a pending wake run binds to this caller (writes do; reads never do, M2).
   */
  private async touchRun(job: Job, ctx: Ctx, origin: Run['origin'], mayAdopt: boolean, bindPending = true): Promise<'you' | 'other' | 'none' | 'unknown'> {
    const sid = ctx.session_id;
    const now = this.now();
    const cr = job.current_run ? await this.get<Run>('run', `${job.id}:${job.current_run}`) : null;
    if (!sid) return 'unknown';
    if (cr && cr.session_id === sid) {
      cr.state = 'active';
      cr.last_activity_at = now;
      await this.save('run', cr.id, cr);
      return 'you';
    }
    if (cr && cr.session_id === null && cr.state === 'active') {
      if (!bindPending) return 'none';
      cr.session_id = sid;
      cr.last_activity_at = now;
      await this.save('run', cr.id, cr);
      return 'you';
    }
    if (cr && this.runActive(cr)) return 'other';
    if (!mayAdopt) return 'none';
    if (cr && cr.state === 'active') { cr.state = 'superseded'; await this.save('run', cr.id, cr); }
    const n = job.run_seq + 1;
    const run: Run = { id: `${job.id}:${n}`, job: job.id, n, session_id: sid, origin, started_at: now, last_activity_at: now, state: 'active' };
    const r = await this.create('run', run.id, run);
    job.run_seq = n;
    job.current_run = n;
    return r.created || r.value.session_id === sid ? 'you' : 'other';
  }

  private async sessionFlags(job: Job, ctx: Ctx, call: string, rel: 'you' | 'other' | 'none' | 'unknown', flagOther: boolean): Promise<void> {
    if (!ctx.session_id) {
      await this.addFlag(job, 'missing_session', `${call} arrived without a session id`, call);
    } else if (rel === 'other' && flagOther) {
      await this.addFlag(job, 'not_work_run', `${call} came from session ${ctx.session_id}, which is not the work run`, call);
    }
  }

  // ---------------------------------------------------------------- indexes

  private async linkThread(job: Job, thread: string, role: string, priv: boolean): Promise<boolean> {
    if (job.threads.includes(thread)) {
      if (priv && !job.private_threads.includes(thread)) {
        job.private_threads.push(thread);
        await this.put('link', `${job.id}:${thread}`, { job: job.id, thread, role: job.roles[thread], private: true, created_at: this.now() });
      }
      return false;
    }
    job.threads.push(thread);
    job.roles[thread] = role;
    if (priv) job.private_threads.push(thread);
    await this.store.putIfAbsent(this.k('link', `${job.id}:${thread}`), { job: job.id, thread, role, private: priv, created_at: this.now() });
    await this.update<ThreadIndex>('thread_index', thread, () => ({ jobs: [] }), (ti) => {
      if (ti.jobs.includes(job.id)) return false;
      ti.jobs.push(job.id);
    });
    return true;
  }

  private async openJobsIndex(fn: (ids: string[]) => string[]): Promise<void> {
    await this.update<IdList>('open_jobs', 'all', () => ({ ids: [] }), (cur) => { cur.ids = fn(cur.ids); });
  }

  private emptyJob(spec: Spec, target: string, seq: number, now: number): Job {
    const id = seq === 1 ? `${spec.workflow}:${target}` : `${spec.workflow}:${target}#${seq}`;
    return {
      id, workflow: spec.workflow, target, spec_version: spec.version, status: 'open', reported_status: 'opened',
      waiting_for: '', next_wake_at: now + this.nextWakeMs(spec), requester: null, cancel_reason: null,
      milestones: {}, run_seq: 0, current_run: null, dm_id: `dm:${id}`, threads: [], private_threads: [], roles: {},
      op_keys: [], ask_keys: [], latest_ask: {}, delivery_keys: [], promise_keys: [], flag_keys: [], event_ids: [],
      flag_seq: 0, wake_reasons: [], claims: {}, notes: [], sched_bucket: 0, blocked_by_jobs: [], replaced_by: null,
      opened_at: now, closed_at: null,
    };
  }

  // ---------------------------------------------------------------- 1. job_open

  private async doJobOpen(
    a: { workflow: string; target: string; thread: string; role?: string; private?: boolean; intent?: 'join' | 'replace' | 'queue'; requester?: string },
    ctx: Ctx,
  ): Promise<Answer> {
    const spec = this.specs[a.workflow];
    if (!spec) {
      return ans(false, 'unknown_workflow', `job_open: no workflow called "${a.workflow}" is loaded, so nothing was recorded. Loaded: ${Object.keys(this.specs).join(', ') || 'none'}.`);
    }
    if (!a.target || !a.thread) {
      return ans(false, 'bad_input', `job_open: ${!a.target ? 'target' : 'thread'} is missing, so nothing was recorded. Give both a target and the thread you are in.`);
    }
    const now = this.now();
    const intent = a.intent ?? 'join';
    const role = a.role ?? spec.link_roles[0] ?? 'request';
    const notes: string[] = [];
    if (!spec.link_roles.includes(role)) notes.push(`Role "${role}" is not in the workflow's link roles (${spec.link_roles.join(', ')}); recorded anyway.`);
    const idxId = `${a.workflow}:${a.target}`;
    let idx = (await this.get<JobIndex>('job_index', idxId)) ?? { seq: 0, primary: null, queued: [], winding: [] };
    const primary = idx.primary ? await this.get<Job>('job', idx.primary) : null;

    let job: Job;
    let opened = false;
    let joined = false;
    if (primary && intent === 'join') {
      job = primary;
      joined = true;
    } else {
      job = this.emptyJob(spec, a.target, idx.seq + 1, now);
      idx.seq += 1;
      opened = true;
      job.requester = a.requester ?? null;
      if (primary && intent === 'replace') {
        // Make the new job the primary first, so ending the old one cannot promote a queued job over it.
        idx.primary = job.id;
        await this.save('job_index', idxId, idx);
        await this.requestCancel(primary, `replaced by ${job.id}`);
        idx = (await this.get<JobIndex>('job_index', idxId)) ?? idx;
        for (const qid of idx.queued) {
          const q = await this.get<Job>('job', qid);
          if (q && q.status === 'queued') { q.blocked_by_jobs = [job.id]; await this.saveJob(q); }
        }
        primary.replaced_by = job.id;
        await this.saveJob(primary);
        notes.push(`The earlier job ${primary.id} is ${(primary.status as JobStatus) === 'cancelled' ? 'cancelled' : 'cancel requested (operations still in flight)'}.`);
      } else if (primary && intent === 'queue') {
        job.status = 'queued';
        job.blocked_by_jobs = [primary.id];
        idx.queued.push(job.id);
        notes.push(`Queued behind ${primary.id}; it opens when that job ends.`);
      } else {
        idx.primary = job.id;
      }
      await this.openJobsIndex((ids) => uniq([...ids, job.id]));
    }
    if (idx.primary === null && !opened) idx.primary = job.id;
    const linked = await this.linkThread(job, a.thread, role, !!a.private);
    const rel = await this.touchRun(job, ctx, 'job_open', job.status !== 'queued');
    await this.sessionFlags(job, ctx, 'job_open', rel, false);
    await this.saveJob(job);
    await this.save('job_index', idxId, idx);
    if (opened) await this.schedule(job.id, job.next_wake_at ?? now);

    const workRun = rel === 'you' ? 'you' : rel === 'other' ? 'other' : 'none';
    const view = await this.buildView(job, a.thread);
    const head = joined
      ? `Already running as ${job.id}. ${linked ? 'Linked this thread.' : 'This thread was already linked.'}`
      : job.status === 'queued' ? `Queued ${job.id}.` : `Opened ${job.id}; this thread is linked as ${role}.`;
    const runText = workRun === 'you' ? 'You are the work run.'
      : workRun === 'other' ? 'Another session is the work run right now; read freely, your writes are recorded as "not the work run".'
      : rel === 'unknown' ? 'No session id arrived, so no work run was assigned (flagged).' : 'No one is the work run yet.';
    return ans(true, joined ? 'joined' : job.status === 'queued' ? 'queued' : 'opened',
      [head, runText, ...notes, view.text].join('\n'),
      { job: job.id, work_run: workRun, view: view.data });
  }

  // ---------------------------------------------------------------- cancel / finish

  /** Operations whose outcome is not known. Unknown ones count only when `withUnknown` (a job that wants to close as done). */
  private async unresolvedOps(job: Job, withUnknown = true): Promise<Operation[]> {
    const ops = await this.manyPresent<Operation>('operation', job.op_keys);
    return ops.filter((o) => o.outcome === 'in_flight' || (withUnknown && o.outcome === 'unknown'));
  }
  private async owedDeliveries(job: Job): Promise<Delivery[]> {
    const ds = await this.manyPresent<Delivery>('delivery', job.delivery_keys);
    return ds.filter((d) => d.state === 'owed' || d.state === 'claimed');
  }
  private async openPromises(job: Job): Promise<Promise_[]> {
    const ps = await this.manyPresent<Promise_>('promise', job.promise_keys);
    return ps.filter((p) => p.state === 'open' || p.state === 'due');
  }

  private async requestCancel(job: Job, reason: string): Promise<void> {
    if (job.status === 'done' || job.status === 'cancelled') return;
    job.cancel_reason = reason;
    // An unknown outcome cannot be waited on forever: a cancel finishes with it kept on the record (H5).
    if ((await this.unresolvedOps(job, false)).length > 0) {
      job.status = 'cancel_requested';
      await this.moveToWinding(job);
    } else {
      await this.finishJob(job, 'cancelled');
    }
  }

  private async moveToWinding(job: Job): Promise<void> {
    const idxId = `${job.workflow}:${job.target}`;
    await this.update<JobIndex>('job_index', idxId, null, (idx) => {
      if (idx.primary === job.id) idx.primary = null;
      idx.queued = idx.queued.filter((x) => x !== job.id);
      if (!idx.winding.includes(job.id)) idx.winding.push(job.id);
    });
  }

  private async closeClaim(thread: string, jobId: string, milestone: string): Promise<void> {
    await this.update<Claim>('claim', thread, null, (c) => {
      if (c.state !== 'open' || c.job !== jobId || c.milestone !== milestone) return false;
      c.state = 'closed';
    });
  }

  private async finishJob(job: Job, terminal: 'done' | 'cancelled'): Promise<void> {
    const now = this.now();
    job.status = terminal;
    job.closed_at = now;
    job.next_wake_at = null;
    job.wake_reasons = [];
    if (terminal === 'cancelled') {
      const promises = await this.manyPresent<Promise_>('promise', job.promise_keys);
      for (const p of promises) if (p.state === 'open' || p.state === 'due') { p.state = 'void'; await this.save('promise', p.key, p); }
      const ds = await this.manyPresent<Delivery>('delivery', job.delivery_keys);
      for (const d of ds) if (d.state === 'owed' || d.state === 'claimed') { d.state = 'void'; await this.save('delivery', d.key, d); }
      for (const [thread, m] of Object.entries(job.claims)) await this.closeClaim(thread, job.id, m);
      job.claims = {};
      for (const o of await this.manyPresent<Operation>('operation', job.op_keys)) {
        if (o.outcome !== 'unknown') continue;
        await this.releaseLease(o);
        await this.save('operation', o.key, o);
        await this.addFlag(job, 'unknown_outcome', `${o.action} on ${o.ref} ended the job with an unknown outcome; its lease was released and the operation stays on the record`, 'cancel');
      }
    }
    const idxId = `${job.workflow}:${job.target}`;
    let promote: string[] = [];
    await this.update<JobIndex>('job_index', idxId, null, (idx) => {
      promote = [];
      if (idx.primary === job.id) idx.primary = null;
      idx.winding = idx.winding.filter((x) => x !== job.id);
      idx.queued = idx.queued.filter((x) => x !== job.id);
      if (idx.primary === null && idx.queued.length > 0) {
        const nextId = idx.queued.shift()!;
        idx.primary = nextId;
        promote = [nextId];
      }
    });
    await this.openJobsIndex((ids) => ids.filter((x) => x !== job.id));
    // ended jobs leave the thread index, so hot paths stay bounded (M9)
    for (const t of job.threads) {
      await this.update<ThreadIndex>('thread_index', t, null, (ti) => {
        if (!ti.jobs.includes(job.id)) return false;
        ti.jobs = ti.jobs.filter((x) => x !== job.id);
      });
    }
    await this.saveJob(job);
    for (const id of promote) {
      await this.updateJob(id, (q) => {
        if (q.status !== 'queued') return false;
        q.status = 'open';
        q.blocked_by_jobs = [];
        q.next_wake_at = now;
        this.addReason(q, `${job.id} ended; this queued job is now open`);
      });
      await this.schedule(id, now);
    }
  }

  /** Close a closing job once nothing is owed; finish a cancel_requested job once ops are resolved. */
  private async maybeClose(job: Job): Promise<boolean> {
    if (job.status === 'closing') {
      if ((await this.owedDeliveries(job)).length === 0 && (await this.openPromises(job)).length === 0 && (await this.unresolvedOps(job)).length === 0) {
        await this.finishJob(job, 'done');
        return true;
      }
    } else if (job.status === 'cancel_requested') {
      if ((await this.unresolvedOps(job, false)).length === 0) {
        await this.finishJob(job, 'cancelled');
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- milestones, deliveries, asks

  private async markReached(job: Job, spec: Spec | undefined, milestone: string): Promise<boolean> {
    if (job.milestones[milestone]) return false;
    job.milestones[milestone] = { at: this.now(), source: 'tony_reported' };
    const entry = spec?.milestones?.[milestone];
    if (!entry) return true;
    const promises = await this.manyPresent<Promise_>('promise', job.promise_keys);
    const holders = entry.audience.promise_holders ? promises.filter((p) => p.milestone === milestone && p.state !== 'void').map((p) => p.thread) : [];
    const roleThreads = job.threads.filter((t) => entry.audience.roles.includes(job.roles[t]));
    for (const thread of uniq([...roleThreads, ...holders])) await this.ensureDelivery(job, thread, milestone, 'owed');
    return true;
  }

  private async ensureDelivery(job: Job, thread: string, milestone: string, state: 'owed' | 'claimed'): Promise<Delivery> {
    const id = `${job.id}:${thread}:${milestone}`;
    const d: Delivery = {
      key: id, job: job.id, thread, milestone, state, owed_at: this.now(), claimed_at: null, next_check_at: null,
      sent_at: null, sent_count: 0, message_link: null, seen_via: null, round: 1,
    };
    const r = await this.create('delivery', id, d);
    if (r.created && !job.delivery_keys.includes(id)) job.delivery_keys.push(id);
    if (!r.created && !job.delivery_keys.includes(id)) job.delivery_keys.push(id);
    return r.value;
  }

  private async markSent(job: Job, d: Delivery, via: NonNullable<Delivery['seen_via']>, link: string | null): Promise<void> {
    if (d.state !== 'sent') {
      d.state = 'sent';
      d.sent_count += 1;
      d.sent_at = this.now();
      d.message_link = link;
      d.seen_via = via;
      d.next_check_at = null;
      d.prior_claim_at = null;
      await this.save('delivery', d.key, d);
    }
    const p = await this.get<Promise_>('promise', d.key);
    if (p && (p.state === 'open' || p.state === 'due')) { p.state = 'fulfilled'; await this.save('promise', p.key, p); }
    if (job.claims[d.thread] === d.milestone) delete job.claims[d.thread];
    await this.closeClaim(d.thread, job.id, d.milestone);
  }

  private async readBuild(job: Job, gate: string): Promise<string | null> {
    try { return (await this.sourceReader.currentBuild({ id: job.id, workflow: job.workflow, target: job.target }, gate)) ?? null; } catch { return null; }
  }

  /** Opens the ask for the gate on the job's current build. A failed source read never records a build (H7). */
  private async openAsk(job: Job, spec: Spec, gate: string, thread: string): Promise<Ask | null> {
    const g = spec.gates?.[gate];
    if (!g) return null;
    const fresh = await this.readBuild(job, gate);
    if (fresh === null) await this.addFlag(job, 'source_unreadable', `could not read the current build for ${gate}; the ask names no build and no build_changed check can fire for it`, 'say');
    const build = fresh ?? 'unknown';
    const responders = uniq([...g.responders.primary, ...(g.responders.stand_ins ?? [])]);
    const id = `${job.id}:${gate}:${build}`;
    const ask: Ask = {
      key: id, job: job.id, gate, build, responders,
      responder_slack: responders.map((p) => spec.people?.[p]?.slack).filter((x): x is string => !!x),
      thread, state: 'open', opened_at: this.now(), answered_at: null, answered_by: null,
    };
    const r = await this.create('ask', id, ask);
    let cur = r.value;
    if (!r.created && cur.state !== 'open' && job.latest_ask[gate] !== id) {
      cur.state = 'open'; cur.opened_at = this.now(); cur.answered_at = null; cur.answered_by = null; cur.thread = thread;
      await this.save('ask', cur.key, cur);
    }
    if (!job.ask_keys.includes(id)) job.ask_keys.push(id);
    const prevKey = job.latest_ask[gate];
    if (prevKey && prevKey !== id) {
      const prev = await this.get<Ask>('ask', prevKey);
      if (prev && prev.state !== 'stale') { prev.state = 'stale'; await this.save('ask', prev.key, prev); }
    }
    job.latest_ask[gate] = id;
    cur = r.value;
    return cur;
  }

  // ---------------------------------------------------------------- 3. intend

  private async takeLease(job: Job, resource: string, opId: string): Promise<boolean> {
    let taken = false;
    await this.update<Lease>('lease', resource, () => ({ resource, holder_job: null, ops: [], since: null }), (lease) => {
      if (lease.holder_job && lease.holder_job !== job.id) { taken = false; return false; }
      taken = true;
      lease.holder_job = job.id;
      if (!lease.ops.includes(opId)) lease.ops.push(opId);
      lease.since = lease.since ?? this.now();
      if (lease.waiters) lease.waiters = lease.waiters.filter((w) => w !== job.id);
    });
    return taken;
  }

  private async addWaiter(resource: string, jobId: string): Promise<void> {
    await this.update<Lease>('lease', resource, () => ({ resource, holder_job: null, ops: [], since: null }), (lease) => {
      lease.waiters = lease.waiters ?? [];
      if (lease.waiters.includes(jobId)) return false;
      lease.waiters.push(jobId);
      if (lease.waiters.length > 20) lease.waiters.shift();
    });
  }

  private async doIntend(a: { job: string; action: string; ref: string; because?: string }, ctx: Ctx): Promise<Answer> {
    const L = await this.loadJob(a.job, 'intend');
    if ('answer' in L) return L.answer;
    const job = L.job;
    if (!a.action || !a.ref) {
      return ans(false, 'bad_input', `intend: ${!a.action ? 'action' : 'ref'} is missing, so no operation was recorded. Give the action and a ref (for example the PR or build).`, { job: job.id });
    }
    const spec = this.spec(job);
    const act = spec?.actions?.[a.action];
    const opId = `${job.id}:${a.action}:${a.ref}`;
    const existing = await this.get<Operation>('operation', opId);
    const sameOp = !!existing && existing.outcome !== 'held' && existing.outcome !== 'failed';

    // The session checks always run, also on a retry of the same ref (H4).
    const rel = await this.touchRun(job, ctx, 'adopted', true);
    await this.sessionFlags(job, ctx, 'intend', rel, false);

    const findings: Array<{ check: CheckName; detail: string; next: string }> = [];
    if (ctx.session_id && rel === 'other') {
      findings.push({ check: 'superseded_run', detail: 'another session is the work run for this job', next: 'Read with job_view and hand the work to the work run, or wait until it checkpoints.' });
    }
    if (job.status === 'cancelled' || job.status === 'cancel_requested') {
      findings.push({ check: 'job_cancelled', detail: `the job is ${job.status}${job.cancel_reason ? ` (${job.cancel_reason})` : ''}`, next: 'Do not start this. Report any in-flight outcome with checkpoint.' });
    }
    if (act?.resource) {
      const lease = await this.get<Lease>('lease', act.resource);
      if (lease?.holder_job && lease.holder_job !== job.id) {
        findings.push({ check: 'lease_held', detail: `${act.resource} is leased by ${lease.holder_job}`, next: `Wait for ${lease.holder_job} to report its outcome (you will be woken when ${act.resource} is free), or open this job with intent queue.` });
        await this.addWaiter(act.resource, job.id);
      }
    }
    if (act?.gate) {
      const askKey = job.latest_ask[act.gate];
      const ask = askKey ? await this.get<Ask>('ask', askKey) : null;
      if (ask && ask.state !== 'stale' && ask.build !== 'unknown') {
        const fresh = await this.readBuild(job, act.gate);
        if (fresh === null) {
          await this.addFlag(job, 'source_unreadable', `could not read the current build for ${act.gate} at intend time; build_changed was not checked`, 'intend');
        } else if (fresh !== ask.build) {
          findings.push({ check: 'build_changed', detail: `the ask for ${act.gate} was about build ${ask.build}, the source now shows ${fresh}`, next: `Ask the responders again for build ${fresh} (call say for the milestone that asks), then call intend again.` });
        }
      }
      if (a.because) {
        const ev = await this.get<EventRecord>('event', a.because);
        if (ev) {
          const ok = ask ? ask.responder_slack : this.gateSlack(spec, act.gate);
          if (!ev.sender_id || !ok.includes(ev.sender_id)) {
            const priv = ev.private_origin || (!!ev.thread && job.private_threads.includes(ev.thread));
            findings.push({ check: 'sender_not_listed', detail: priv ? `the evidence named in because (held: evidence from another thread) came from someone who is not on the ${act.gate} responder list` : `event ${a.because} came from ${ev.sender_id ?? 'an unknown sender'}, who is not on the ${act.gate} responder list`, next: `Ask someone on the ${act.gate} list (${ok.join(', ') || 'none listed'}), then call intend again.` });
          }
        }
      }
    }

    const holds: string[] = [];
    const flags: string[] = [];
    const nexts: string[] = [];
    for (const f of findings) {
      const mode = this.config.checks[f.check];
      const text = `${f.check}: ${f.detail}`;
      if (mode === 'hold') { holds.push(text); nexts.push(f.next); } else { flags.push(text); }
      await this.addFlag(job, f.check, f.detail, 'intend', mode);
    }
    if (!act && spec) flags.push(`action "${a.action}" is not in the workflow spec: no lease and no gate checks`);

    if (existing && sameOp) {
      // Same job, action and ref: the same operation back. Nothing new starts.
      await this.saveJob(job);
      if (holds.length > 0) {
        return ans(true, 'hold', `Hold on ${a.action} ${a.ref}. ${holds.join('; ')}. Next: ${nexts.join(' ')} The earlier operation (${existing.outcome}) was left as it was.${flags.length ? ` Also flagged: ${flags.join('; ')}.` : ''}`, { job: job.id, operation: existing, holds, flags, existing: true });
      }
      return ans(true, 'already_recorded',
        `Already recorded: ${a.action} on ${a.ref} is ${existing.outcome} (intent ${fmtAge(this.now() - existing.intent_at)} ago). Nothing new was started; this is the same operation.${flags.length ? ` Flagged: ${flags.join('; ')}.` : ''}`,
        { job: job.id, operation: existing, flags, holds: [] });
    }

    const op: Operation = existing ?? {
      key: opId, job: job.id, action: a.action, ref: a.ref, because: a.because ?? null, intent_at: this.now(),
      session: ctx.session_id ?? null, outcome: 'held', source: 'tony_reported', flags: [], holds: [], note: '',
      resource: act?.resource ?? null, lease_taken: false, outcome_at: null,
    };
    if (existing?.outcome === 'failed') { op.note = ''; op.outcome_at = null; op.source = 'tony_reported'; } // a retry after failed is a new attempt
    op.because = a.because ?? op.because;
    op.session = ctx.session_id ?? op.session;
    if (!existing && !job.op_keys.includes(opId)) job.op_keys.push(opId);

    // A lost lease race turns into a lease_held finding.
    let leaseTaken = false;
    if (holds.length === 0 && act?.resource && job.status !== 'done') {
      leaseTaken = await this.takeLease(job, act.resource, opId);
      if (!leaseTaken) {
        const detail = `${act.resource} was taken by another job while this intend ran`;
        await this.addFlag(job, 'lease_held', detail, 'intend', this.config.checks.lease_held);
        if (this.config.checks.lease_held === 'hold') { holds.push(`lease_held: ${detail}`); nexts.push(`Wait until ${act.resource} is free (you will be woken).`); } else flags.push(`lease_held: ${detail}`);
      }
    }
    op.flags = flags;
    op.holds = holds;

    if (holds.length > 0) {
      op.outcome = 'held';
      await this.save('operation', opId, op);
      await this.saveJob(job);
      return ans(true, 'hold',
        `Hold on ${a.action} ${a.ref}. ${holds.join('; ')}. Next: ${nexts.join(' ')} No lease was taken and nothing is in flight.${flags.length ? ` Also flagged: ${flags.join('; ')}.` : ''}`,
        { job: job.id, operation: op, holds, flags });
    }

    if (job.status === 'done') {
      // L2: an ended job stays ended. The call is recorded and flagged, and nothing is tracked.
      op.outcome = 'held';
      op.note = 'recorded after the job was done; not tracked';
      await this.addFlag(job, 'job_ended', `${a.action} on ${a.ref} was announced after the job was done; recorded, no lease, nothing in flight`, 'intend');
      await this.save('operation', opId, op);
      await this.saveJob(job);
      return ans(true, 'recorded', `Recorded: ${job.id} is already done, so ${a.action} on ${a.ref} is noted and flagged (job_ended) but not tracked: no lease, nothing in flight. Reopen the release with job_open (replace) if more work is needed.`, { job: job.id, operation: op, flags, holds: [] });
    }

    op.outcome = 'in_flight';
    op.intent_at = this.now();
    op.lease_taken = leaseTaken;
    if (job.status === 'cancelled') {
      // flagged work went ahead on a cancelled job: keep the job visible until the outcome is reported
      job.status = 'cancel_requested';
      job.closed_at = null;
      job.next_wake_at = this.now() + this.nextWakeMs(spec);
      await this.openJobsIndex((ids) => uniq([...ids, job.id]));
      for (const t of job.threads) await this.update<ThreadIndex>('thread_index', t, () => ({ jobs: [] }), (ti) => { if (ti.jobs.includes(job.id)) return false; ti.jobs.push(job.id); });
      await this.moveToWinding(job);
      await this.schedule(job.id, job.next_wake_at);
    }
    if (act?.gate) {
      const askKey = job.latest_ask[act.gate];
      const ask = askKey ? await this.get<Ask>('ask', askKey) : null;
      if (ask && ask.state === 'open') {
        ask.state = 'answered';
        ask.answered_at = this.now();
        const ev = a.because ? await this.get<EventRecord>('event', a.because) : null;
        ask.answered_by = ev?.sender_id ?? null;
        await this.save('ask', ask.key, ask);
      }
    }
    await this.save('operation', opId, op);
    await this.update<IdList>('ref_index', a.ref, () => ({ ids: [] }), (r) => { if (r.ids.includes(job.id)) return false; r.ids.push(job.id); });
    await this.saveJob(job);
    await this.schedule(job.id, op.intent_at + this.unknownMs(spec));
    return ans(true, 'clear',
      `Clear: ${a.action} on ${a.ref} is recorded as in flight${op.lease_taken ? ` and the ${act?.resource} lease is yours` : ''}.${flags.length ? ` Flagged (not blocking): ${flags.join('; ')}.` : ''} Report the outcome with checkpoint.`,
      { job: job.id, operation: op, flags, holds: [] });
  }

  private gateSlack(spec: Spec | undefined, gate: string): string[] {
    const g = spec?.gates?.[gate];
    if (!g) return [];
    return uniq([...g.responders.primary, ...(g.responders.stand_ins ?? [])]).map((p) => spec?.people?.[p]?.slack).filter((x): x is string => !!x);
  }

  // ---------------------------------------------------------------- 4. say

  /** Match an open claim to a post the Slack reader can see. Returns true when the claim was closed as sent. */
  private async reconcileClaim(c: Claim, cur: Job | null): Promise<boolean> {
    let found: { link?: string; relay?: boolean } | null = null;
    try { found = await this.slackReader.findOwnPostAfter(c.thread, c.at); } catch { found = null; }
    if (!found || found.relay) return false;
    const job = cur && cur.id === c.job ? cur : await this.get<Job>('job', c.job);
    const d = await this.get<Delivery>('delivery', `${c.job}:${c.thread}:${c.milestone}`);
    if (!job || !d || d.state !== 'claimed') { await this.closeClaim(c.thread, c.job, c.milestone); return false; }
    await this.markSent(job, d, 'sweep', found.link ?? null);
    if (!cur || cur.id !== job.id) await this.saveJob(job);
    return true;
  }

  private async doSay(a: { job: string; thread: string; milestone: string; posted_link?: string }, ctx: Ctx): Promise<Answer> {
    const L = await this.loadJob(a.job, 'say');
    if ('answer' in L) return L.answer;
    const job = L.job;
    if (!a.thread || !a.milestone) {
      return ans(false, 'bad_input', `say: ${!a.thread ? 'thread' : 'milestone'} is missing, so no claim was recorded.`, { job: job.id });
    }
    if (job.status === 'done' || job.status === 'cancelled') {
      await this.addFlag(job, 'job_ended', `say ${a.milestone} in ${a.thread} arrived after the job was ${job.status}; recorded, no claim`, 'say');
      await this.saveJob(job);
      return ans(true, 'job_ended', `Recorded: ${job.id} is ${job.status}, so no claim was made and nothing is owed. Post only if a person asked you to.`, { job: job.id });
    }
    const spec = this.spec(job);
    const sid = ctx.session_id ?? null;
    const rel = await this.touchRun(job, ctx, 'adopted', true);
    await this.sessionFlags(job, ctx, 'say', rel, true);
    const now = this.now();
    const dKey = `${job.id}:${a.thread}:${a.milestone}`;
    const gate = spec?.milestones?.[a.milestone]?.opens_ask;
    const notes: string[] = [];
    if (!job.threads.includes(a.thread)) notes.push(`Note: ${a.thread} is not linked to this job; the claim is recorded, but link it with job_open if events from it should reach the job.`);
    if (spec && !spec.milestones?.[a.milestone]) notes.push(`Note: "${a.milestone}" is not a milestone in the workflow spec; claim recorded as given.`);

    // Confirm route: Tony posted and tells the engine where. Reported by Tony (L3); clears the claim.
    if (a.posted_link) {
      await this.markReached(job, spec, a.milestone);
      const d = await this.ensureDelivery(job, a.thread, a.milestone, 'claimed');
      if (d.state === 'sent') {
        await this.saveJob(job);
        return ans(true, 'already_sent', `Already sent: ${a.milestone} was delivered to ${a.thread}${d.message_link ? ` (${d.message_link})` : ''}. Nothing more to do.`, { job: job.id, delivery: d, link: d.message_link });
      }
      d.claimed_at = d.claimed_at ?? now;
      await this.markSent(job, d, 'tony', a.posted_link);
      if (gate && spec && !job.latest_ask[gate]) await this.openAsk(job, spec, gate, a.thread);
      const closed = await this.maybeClose(job);
      if (!closed) await this.saveJob(job);
      return ans(true, 'confirmed', `Recorded: ${a.milestone} was posted in ${a.thread} (${a.posted_link}), reported by you. The claim is cleared.${closed ? ' Nothing else is owed, so the job is closed.' : ''}`, { job: job.id, link: a.posted_link, round: d.round });
    }

    let d = await this.get<Delivery>('delivery', dKey);
    let reask = false;
    if (d?.state === 'sent') {
      // A new build needs a new ask and a new post, even if the milestone went out for the old build (H7).
      if (gate && spec) {
        const latest = job.latest_ask[gate] ? await this.get<Ask>('ask', job.latest_ask[gate]) : null;
        const fresh = latest && latest.build !== 'unknown' ? await this.readBuild(job, gate) : null;
        if (latest && fresh !== null && fresh !== latest.build) reask = true;
      }
      if (!reask) {
        await this.saveJob(job);
        return ans(true, 'already_sent', `Already sent: ${a.milestone} was delivered to ${a.thread}${d.message_link ? ` (${d.message_link})` : ''}. Do not post it again.`, { job: job.id, delivery: d, link: d.message_link });
      }
    }

    // A stale claim that the reader can now see is simply sent.
    const c0 = await this.get<Claim>('claim', a.thread);
    if (c0 && c0.state === 'open' && now - c0.touched >= this.staleMs(spec) && !(c0.job === job.id && c0.milestone === a.milestone && c0.session === sid)) {
      if (await this.reconcileClaim(c0, job)) {
        d = await this.get<Delivery>('delivery', dKey);
        if (d?.state === 'sent' && !reask) {
          await this.saveJob(job);
          return ans(true, 'already_sent', `Already sent: ${a.milestone} was delivered to ${a.thread}${d.message_link ? ` (${d.message_link})` : ''}. Do not post it again.`, { job: job.id, delivery: d, link: d.message_link });
        }
      }
    }
    const round = reask && d ? d.round + 1 : d?.round ?? 1;
    let kind = 'go' as 'go' | 'own' | 'busy' | 'handoff';
    let released: Claim | null = null;
    let seen: Claim | null = null;
    const claim = await this.update<Claim>('claim', a.thread, () => ({ thread: a.thread, job: '', milestone: '', session: null, at: 0, touched: 0, state: 'closed', round: 0 }), (c) => {
      released = null;
      seen = c.state === 'open' ? { ...c } : null;
      const mine = c.job === job.id && c.milestone === a.milestone;
      if (c.state === 'open' && mine && c.session === sid) { kind = 'own'; c.touched = now; return; }
      if (c.state === 'open') {
        if (now - c.touched < this.staleMs(spec)) { kind = 'busy'; return false; }
        if (mine) { kind = 'handoff'; c.session = sid; c.touched = now; return; }
        released = { ...c };
      }
      kind = 'go';
      Object.assign(c, { job: job.id, milestone: a.milestone, session: sid, at: now, touched: now, state: 'open', round });
    });
    if (kind === 'busy') {
      await this.saveJob(job);
      const other = seen as Claim | null;
      const sameMs = other && other.job === job.id && other.milestone === a.milestone;
      const ago = other ? fmtAge(now - other.touched) : '';
      return ans(true, 'busy', sameMs
        ? `busy: another session is posting ${a.milestone} in ${a.thread} (claimed ${ago} ago). Do not post. Check again after ${Math.round(this.staleMs(spec) / MIN)} minutes; if it is still not there, say again.`
        : `busy: a claim for ${other?.milestone} is open in ${a.thread}${other && other.job !== job.id ? ` (job ${other.job})` : ''} (${ago} ago). Do not post ${a.milestone} now. Wait for it to be seen, or until it goes stale after ${Math.round(this.staleMs(spec) / MIN)} minutes, then say again.`,
      { job: job.id, open_claim: other });
    }
    if (released) {
      const rc = released as Claim;
      const od = await this.get<Delivery>('delivery', `${rc.job}:${rc.thread}:${rc.milestone}`);
      if (od && od.state === 'claimed') { od.state = 'owed'; od.prior_claim_at = rc.at; od.claimed_at = null; od.next_check_at = null; await this.save('delivery', od.key, od); }
      if (rc.job === job.id) delete job.claims[rc.thread];
      else await this.updateJob(rc.job, (oj) => { delete oj.claims[rc.thread]; });
      notes.push(`The earlier claim for ${rc.milestone} in this thread was never seen and went stale; it is owed again. Read the thread: if that message is missing, post it (say for it first).`);
    }
    await this.markReached(job, spec, a.milestone);
    const cur = d && d.state !== 'sent' ? d : await this.ensureDelivery(job, a.thread, a.milestone, 'claimed');
    if (cur.state === 'sent') { cur.state = 'claimed'; cur.sent_count = 0; cur.sent_at = null; cur.message_link = null; cur.seen_via = null; cur.round = round; }
    const priorUnseen = kind === 'go' && typeof cur.prior_claim_at === 'number';
    if (priorUnseen) kind = 'handoff'; // the earlier post may exist: Tony reads the thread first; the sweep still matches only from this claim
    if (kind !== 'handoff' || cur.claimed_at === null) cur.claimed_at = claim.at;
    cur.state = 'claimed';
    cur.next_check_at = now + this.config.sweepMinutes * MIN;
    await this.save('delivery', cur.key, cur);
    job.claims[a.thread] = a.milestone;
    let askText = '';
    if (gate && spec && (kind === 'go' || !job.latest_ask[gate] || priorUnseen)) {
      const ask = await this.openAsk(job, spec, gate, a.thread);
      if (ask) askText = ` An ask for ${gate} on build ${ask.build} is open with ${ask.responders.join(', ')}.`;
    }
    await this.saveJob(job);
    await this.schedule(job.id, cur.next_check_at);
    const tail = `${askText}${notes.length ? ' ' + notes.join(' ') : ''}`;
    const extra = { job: job.id, claimed_at: claim.at, round: cur.round, repeat: kind === 'own' };
    if (kind === 'handoff') {
      return ans(true, 'already_claimed', `Already claimed: another session claimed ${a.milestone} for ${a.thread} ${fmtAge(now - claim.at)} ago and the post was never seen. The claim is yours now. Read the thread with slack_read_thread; post only if the message is absent. If it is there, call say again with posted_link.${tail}`, extra);
    }
    return ans(true, 'go', kind === 'own'
      ? `Go: you already hold this claim. Post ${a.milestone} in ${a.thread} yourself now unless it is already there (if it is, call say again with posted_link). The engine will match your post to this claim.${tail}`
      : `Go: post ${a.milestone} in ${a.thread} yourself now. The engine will match your post to this claim. This go is good for ${Math.round(this.staleMs(spec) / MIN)} minutes; after that, say again before posting.${tail}`, extra);
  }

  // ---------------------------------------------------------------- 5. promise_add

  private async doPromiseAdd(a: { job: string; thread: string; about: string; fallback_time?: number | string }, ctx: Ctx): Promise<Answer> {
    const L = await this.loadJob(a.job, 'promise_add');
    if ('answer' in L) return L.answer;
    const job = L.job;
    if (!a.thread || !a.about) {
      return ans(false, 'bad_input', `promise_add: ${!a.thread ? 'thread' : 'about (a milestone id)'} is missing, so no promise was recorded.`, { job: job.id });
    }
    if (job.status === 'done' || job.status === 'cancelled') {
      await this.addFlag(job, 'job_ended', `promise_add for ${a.about} in ${a.thread} arrived after the job was ${job.status}; recorded, no promise`, 'promise_add');
      await this.saveJob(job);
      return ans(true, 'job_ended', `Recorded: ${job.id} is ${job.status}, so no promise was made. Tell the person yourself if they still need an answer.`, { job: job.id });
    }
    const spec = this.spec(job);
    const now = this.now();
    const rel = await this.touchRun(job, ctx, 'adopted', true);
    await this.sessionFlags(job, ctx, 'promise_add', rel, false); // a promise from any session is a valid record (D10)
    const notes: string[] = [];
    let fallback: number | null = null;
    if (typeof a.fallback_time === 'number' && a.fallback_time > 1e11) fallback = a.fallback_time;
    else if (typeof a.fallback_time === 'string') fallback = parseDuration(a.fallback_time) !== null && /^\s*\d+(\.\d+)?\s*[smhd]?\s*$/i.test(a.fallback_time) ? now + parseDuration(a.fallback_time)! : parseTime(a.fallback_time);
    else if (typeof a.fallback_time === 'number') fallback = now + a.fallback_time * MIN;
    if (fallback === null) {
      const mins = spec?.defaults?.promise_fallback_minutes ?? 240;
      fallback = now + mins * MIN;
      notes.push(`No usable fallback time was given, so the default of ${mins} minutes was set.`);
    }
    if (spec && !spec.milestones?.[a.about]) notes.push(`Note: "${a.about}" is not a milestone in the workflow spec; promise recorded as given.`);
    if (!job.threads.includes(a.thread)) notes.push(`Note: ${a.thread} is not linked to this job; link it with job_open (join) so its events reach the job.`);
    const id = `${job.id}:${a.thread}:${a.about}`;
    const p: Promise_ = { key: id, job: job.id, thread: a.thread, milestone: a.about, fallback_at: fallback, state: 'open', created_at: now };
    const r = await this.create('promise', id, p);
    if (!r.created) {
      await this.saveJob(job);
      return ans(true, 'already_promised', `Already promised: ${a.thread} is waiting for ${a.about} (state ${r.value.state}, fallback ${new Date(r.value.fallback_at).toISOString()}).`, { job: job.id, promise: r.value });
    }
    job.promise_keys.push(id);
    const entry = spec?.milestones?.[a.about];
    if (job.milestones[a.about] && entry?.audience.promise_holders) {
      const d = await this.ensureDelivery(job, a.thread, a.about, 'owed');
      if (d.state === 'sent') { p.state = 'fulfilled'; await this.save('promise', id, p); }
      else notes.push(`${a.about} was already reached, so it is owed to ${a.thread} now.`);
    }
    await this.saveJob(job);
    await this.schedule(job.id, fallback);
    return ans(true, 'promised', `Promise recorded: ${a.thread} will be told when ${a.about} happens. If it has not happened by ${new Date(fallback).toISOString()}, the engine wakes you. ${notes.join(' ')}`.trim(), { job: job.id, promise: p });
  }

  // ---------------------------------------------------------------- 6. checkpoint

  private async doCheckpoint(
    a: { job: string; status: string; waiting_for?: string; next_wake_in?: number | string;
      operations?: Array<{ ref: string; action?: string; outcome: 'done' | 'failed' | 'unknown'; note?: string }>; reached?: string[] },
    ctx: Ctx,
  ): Promise<Answer> {
    const L = await this.loadJob(a.job, 'checkpoint');
    if ('answer' in L) return L.answer;
    const job = L.job;
    const spec = this.spec(job);
    const now = this.now();
    const notes: string[] = [];
    // A checkpoint never takes over a run; only a session that is the work run (or arrives with no run yet) commits (H8).
    const rel = await this.touchRun(job, ctx, 'adopted', !job.current_run);
    await this.sessionFlags(job, ctx, 'checkpoint', rel, false);
    const convo = !!ctx.session_id && rel !== 'you';
    if (convo) await this.addFlag(job, 'not_work_run', `checkpoint came from session ${ctx.session_id}, which is not the work run; recorded as a note, status and wake unchanged`, 'checkpoint');

    // operation outcomes (D5)
    if (a.operations?.length) {
      const ops = await this.manyPresent<Operation>('operation', job.op_keys);
      for (const o of a.operations) {
        if (!['done', 'failed', 'unknown'].includes(o.outcome)) {
          notes.push(`Outcome "${o.outcome}" for ${o.ref} is not done, failed or unknown; skipped.`);
          continue;
        }
        if (o.outcome === 'unknown' && (job.status === 'done' || job.status === 'cancelled')) {
          notes.push(`The job has ended, so an "unknown" outcome for ${o.ref} was not recorded (it would leave an ended job with an unresolved operation).`);
          continue;
        }
        const matches = ops.filter((x) => x.ref === o.ref && (!o.action || x.action === o.action));
        if (matches.length === 0) {
          const act = o.action ?? 'unspecified';
          const op: Operation = {
            key: `${job.id}:${act}:${o.ref}`, job: job.id, action: act, ref: o.ref, because: null, intent_at: now,
            session: ctx.session_id ?? null, outcome: o.outcome, source: 'tony_reported', flags: [], holds: [], note: o.note ?? '',
            resource: null, lease_taken: false, outcome_at: now,
          };
          const r = await this.create('operation', op.key, op);
          if (r.created && !job.op_keys.includes(op.key)) job.op_keys.push(op.key);
          notes.push(`No intend was recorded for ${o.ref}; recorded your reported outcome (${o.outcome}) anyway.`);
          continue;
        }
        if (matches.length > 1) {
          // Several operations share this ref and no action was named: do not guess which one it was (M5).
          await this.addFlag(job, 'ambiguous_outcome', `outcome ${o.outcome} for ref ${o.ref} named no action and ${matches.length} operations use that ref (${matches.map((m) => m.action).join(', ')}); none was changed`, 'checkpoint');
          notes.push(`Outcome for ${o.ref} named no action and ${matches.length} operations use that ref; none was changed. Report it again with the action.`);
          continue;
        }
        const m = matches[0];
        m.outcome = o.outcome;
        m.note = o.note ?? m.note;
        m.outcome_at = now;
        if (o.outcome !== 'unknown') await this.releaseLease(m);
        await this.save('operation', m.key, m);
      }
    }
    const ended = job.status === 'done' || job.status === 'cancelled';
    if (ended && a.reached?.length) notes.push('The job has ended, so the reached milestones were not recorded (nothing can be owed on an ended job).');
    for (const m of ended ? [] : a.reached ?? []) {
      if (await this.markReached(job, spec, m)) notes.push(`Milestone ${m} marked reached (reported by you).`);
    }

    const wantNext = a.next_wake_in !== undefined ? parseDuration(a.next_wake_in) : null;
    if (a.next_wake_in !== undefined && wantNext === null) notes.push(`next_wake_in "${a.next_wake_in}" could not be read; the default of ${(spec?.defaults?.next_wake_minutes ?? 30)} minutes is used.`);
    let wakeAt = now + (wantNext ?? this.nextWakeMs(spec));

    let statusText: string;
    if (convo) {
      job.notes.push({ at: now, session: ctx.session_id ?? null, status: a.status, waiting_for: a.waiting_for ?? '' });
      if (job.notes.length > MAX_NOTES) job.notes.splice(0, job.notes.length - MAX_NOTES);
      statusText = 'Recorded as a note: you are not the work run, so the job\'s status and wake are unchanged.';
      if (a.status === 'cancelled' && !ended) {
        this.addReason(job, `cancel asked (session ${ctx.session_id} noted a cancel${a.waiting_for ? `: ${a.waiting_for}` : ''}); the work run decides`);
        wakeAt = now;
        statusText += ' The work run is woken with "cancel asked"; a conversation session cannot cancel.';
      } else if (!ended && a.next_wake_in !== undefined && wantNext !== null && job.next_wake_at !== null) {
        wakeAt = Math.min(job.next_wake_at, wakeAt);
      } else wakeAt = job.next_wake_at ?? wakeAt;
    } else {
      job.reported_status = a.status;
      if (a.waiting_for !== undefined) job.waiting_for = a.waiting_for;
      if (a.status === 'cancelled') {
        await this.requestCancel(job, 'cancelled by checkpoint');
        statusText = (job.status as JobStatus) === 'cancelled' ? 'The job is cancelled.' : 'Cancel requested: operations are still in flight, so the job stays cancel_requested until they have outcomes.';
      } else if (job.status === 'done' || job.status === 'cancelled') {
        // An ended job stays ended: a late checkpoint records what it reports and changes nothing else.
        statusText = `The job is already ${job.status}; your report was recorded and nothing else changed.`;
      } else if (job.status === 'queued') {
        statusText = 'The job is queued behind another job; your report was recorded, and it opens when that job ends.';
      } else if (a.status === 'done') {
        if (job.status === 'cancel_requested') {
          statusText = 'The job is cancel_requested; it ends when its in-flight operations have outcomes.';
        } else {
          const owed = await this.owedDeliveries(job);
          const proms = await this.openPromises(job);
          const unresolved = await this.unresolvedOps(job);
          if (owed.length === 0 && proms.length === 0 && unresolved.length === 0) {
            await this.finishJob(job, 'done');
            statusText = 'The job is done and closed.';
          } else {
            job.status = 'closing';
            const parts = uniq([
              ...owed.map((d) => `still owed: ${d.milestone} to ${d.thread}`),
              ...proms.map((p) => `still owed: ${p.milestone} to ${p.thread}`),
              ...unresolved.map((o) => `still in flight: ${o.action} on ${o.ref}${o.outcome === 'unknown' ? ' (unknown: verify it and report done or failed)' : ''}`),
            ]);
            statusText = `Not closed yet, status is closing: ${parts.join('; ')}. You will be woken; the job closes when nothing is owed.`;
          }
        }
      } else {
        if (job.status === 'closing') job.status = 'open';
        if (job.status === 'cancel_requested') {
          await this.maybeClose(job);
          statusText = (job.status as JobStatus) === 'cancelled' ? 'The job is cancelled.' : 'The job is still cancel_requested.';
        } else {
          statusText = `Status committed: ${a.status}${a.waiting_for ? `, waiting for ${a.waiting_for}` : ''}.`;
        }
      }
      if (job.status === 'cancel_requested') await this.maybeClose(job);
    }

    // Outcomes reported by any session can be what a cancel was waiting for.
    if (convo && job.status === 'cancel_requested') await this.maybeClose(job);
    if (job.closed_at === null) {
      // A pending unblock reason survives: a checkpoint can only bring the wake earlier (H8, M3).
      if (job.wake_reasons.length > 0) {
        wakeAt = Math.min(wakeAt, now);
        notes.push(`New events arrived since you last looked (${job.wake_reasons.join('; ')}); the engine will wake you right away.`);
      }
      if (!convo) job.next_wake_at = wakeAt;
      else job.next_wake_at = Math.min(job.next_wake_at ?? wakeAt, wakeAt);
      await this.schedule(job.id, job.next_wake_at);
    }
    if (!convo && ctx.session_id && job.current_run) {
      const run = await this.get<Run>('run', `${job.id}:${job.current_run}`);
      if (run && run.session_id === ctx.session_id && run.state === 'active') { run.state = 'idle'; run.last_activity_at = now; await this.save('run', run.id, run); }
    }
    await this.saveJob(job);
    return ans(true, job.status === 'closing' ? 'closing' : job.status, `${statusText}${job.next_wake_at ? ` Next wake at ${new Date(job.next_wake_at).toISOString()}.` : ''}${notes.length ? ' ' + notes.join(' ') : ''}`, {
      job: job.id, job_status: job.status, next_wake_at: job.next_wake_at,
    });
  }

  /** Frees the operation's lease and wakes every job that was held waiting for it (M4). */
  private async releaseLease(op: Operation): Promise<void> {
    if (!op.lease_taken || !op.resource) return;
    let waiters: string[] = [];
    await this.update<Lease>('lease', op.resource, null, (lease) => {
      waiters = [];
      lease.ops = lease.ops.filter((x) => x !== op.key);
      if (lease.ops.length === 0) { lease.holder_job = null; lease.since = null; waiters = lease.waiters ?? []; lease.waiters = []; }
    });
    op.lease_taken = false;
    const now = this.now();
    for (const w of waiters) {
      if (w === op.job) continue;
      const j = await this.updateJob(w, (x) => {
        if (x.status === 'done' || x.status === 'cancelled' || x.status === 'queued') return false;
        this.addReason(x, `${op.resource} is free now; retry what was held`);
        x.next_wake_at = Math.min(x.next_wake_at ?? now, now);
      });
      if (j && j.closed_at === null) await this.schedule(w, now);
    }
  }

  // ---------------------------------------------------------------- 2. job_view

  private async doJobView(a: { job?: string; thread?: string }, ctx: Ctx): Promise<Answer> {
    let jobs: Job[] = [];
    let viewer: string | null = null;
    if (a.job) {
      const L = await this.loadJob(a.job, 'job_view');
      if ('answer' in L) return L.answer;
      jobs = [L.job];
    } else if (a.thread) {
      viewer = a.thread;
      const ti = await this.get<ThreadIndex>('thread_index', a.thread);
      jobs = await this.manyPresent<Job>('job', ti?.jobs ?? []);
    } else {
      return ans(false, 'bad_input', 'job_view: give a job id or a thread. Nothing changed.');
    }
    if (jobs.length === 0) {
      const open = await this.get<IdList>('open_jobs', 'all');
      const list = await this.manyPresent<Job>('job', (open?.ids ?? []).slice(0, MAX_BATCH));
      const line = list.length ? `Open jobs: ${list.map((j) => `${j.id} (${j.status}, ${j.reported_status})`).join('; ')}.` : 'There are no open jobs.';
      return ans(true, 'no_job_here', `No job is linked to this thread. ${line} Judge which one fits (or ask), then call job_open with intent join.`, { jobs: [], open_jobs: list.map((j) => j.id) });
    }
    const views = [];
    const texts = [];
    for (const job of jobs) {
      // A pure read never binds a run and never clears anything (M2, M3).
      const rel = await this.touchRun(job, ctx, 'adopted', false, false);
      const v = await this.buildView(job, viewer, rel === 'other' ? 'other' : rel === 'you' ? 'you' : 'none');
      views.push(v.data);
      texts.push(v.text);
    }
    const head = jobs.length > 1 ? `This thread is linked to ${jobs.length} jobs; you judge which one a message is about.\n` : '';
    return ans(true, 'view', head + texts.join('\n\n'), { jobs: views });
  }

  private async buildView(job: Job, viewerThread: string | null, workRunOverride?: 'you' | 'other' | 'none'): Promise<{ text: string; data: Record<string, unknown> }> {
    const now = this.now();
    const spec = this.spec(job);
    const unknownMs = this.unknownMs(spec);
    const [ops, asks, dels, proms, flags, evs] = await Promise.all([
      this.manyPresent<Operation>('operation', job.op_keys),
      this.manyPresent<Ask>('ask', job.ask_keys),
      this.manyPresent<Delivery>('delivery', job.delivery_keys),
      this.manyPresent<Promise_>('promise', job.promise_keys),
      this.manyPresent<FlagRecord>('flag', job.flag_keys.slice(-50)),
      this.manyPresent<EventRecord>('event', job.event_ids.slice(-15)),
    ]);
    const run = job.current_run ? await this.get<Run>('run', `${job.id}:${job.current_run}`) : null;
    const runBusy = this.runActive(run);
    const opsView = ops.map((o) => {
      const eff = o.outcome === 'in_flight' && now - o.intent_at > unknownMs ? 'unknown' : o.outcome;
      return { action: o.action, ref: o.ref, outcome: eff, age: fmtAge(now - o.intent_at), source: o.source, note: o.note };
    });
    const evView = evs.map((e) => {
      const held = !!e.thread && (e.private_origin || job.private_threads.includes(e.thread)) && e.thread !== viewerThread;
      return held
        ? { held: true, age: fmtAge(now - e.received_at), summary: 'held: evidence from another thread' }
        : { held: false, id: e.id, source: e.source, kind: e.kind, thread: e.thread, sender: e.sender_id, sender_kind: e.sender_kind, ref: e.ref, age: fmtAge(now - e.received_at) };
    });
    const owed = dels.filter((d) => d.state === 'owed').map((d) => ({ milestone: d.milestone, thread: d.thread }));
    const claimed = dels.filter((d) => d.state === 'claimed').map((d) => ({ milestone: d.milestone, thread: d.thread, age: fmtAge(now - (d.claimed_at ?? now)) }));
    const sent = dels.filter((d) => d.state === 'sent').map((d) => ({ milestone: d.milestone, thread: d.thread, link: d.message_link }));
    const openAsks = asks.filter((x) => x.state === 'open').map((x) => ({ gate: x.gate, build: x.build, responders: x.responders, thread: x.thread }));
    const workRun = workRunOverride ?? (runBusy ? 'other' : 'none');

    const L: string[] = [];
    L.push(`Job ${job.id}: status ${job.status} (you reported "${job.reported_status}")${job.waiting_for ? `, waiting for ${job.waiting_for}` : ''}.`);
    L.push(`Next wake: ${job.next_wake_at ? `${new Date(job.next_wake_at).toISOString()} (in ${fmtAge(Math.abs(job.next_wake_at - now))}${job.next_wake_at < now ? ' ago, overdue' : ''})` : 'none (closed)'}. Work run: ${workRun === 'you' ? 'you' : workRun === 'other' ? 'another session is working on it' : 'nobody'}${run ? `, ${runBusy ? 'busy' : 'idle'}` : ''}.`);
    L.push(`Linked threads: ${job.threads.map((t) => `${t} (${job.roles[t]}${job.private_threads.includes(t) ? ', private' : ''})`).join(', ') || 'none'}.`);
    const ms = Object.entries(job.milestones);
    if (ms.length) L.push(`Milestones reached: ${ms.map(([m, v]) => `${m} (${v.source})`).join(', ')}.`);
    if (evView.length) L.push(`Events: ${evView.map((e) => (e.held ? `${e.age} ago, ${e.summary}` : `${e.age} ago, ${e.source}/${e.kind} from ${e.sender ?? 'n/a'}${e.thread ? ` in ${e.thread}` : ''}${e.ref ? ` ref ${e.ref}` : ''}`)).join('; ')}.`);
    if (openAsks.length) L.push(`Open asks: ${openAsks.map((x) => `${x.gate} for build ${x.build} (responders ${x.responders.join(', ')})`).join('; ')}.`);
    if (opsView.length) L.push(`Operations: ${opsView.map((o) => `${o.action} ${o.ref} ${o.outcome === 'unknown' ? 'unknown (no outcome reported in time)' : o.outcome} (${o.age} ago)`).join('; ')}.`);
    if (owed.length) L.push(`Owed messages: ${owed.map((d) => `${d.milestone} to ${d.thread}`).join('; ')}.`);
    if (claimed.length) L.push(`Open claims: ${claimed.map((d) => `${d.milestone} in ${d.thread}: claimed, not seen yet (${d.age} ago)`).join('; ')}.`);
    if (sent.length) L.push(`Sent: ${sent.map((d) => `${d.milestone} to ${d.thread}`).join('; ')}.`);
    const openProms = proms.filter((p) => p.state === 'open' || p.state === 'due');
    if (openProms.length) L.push(`Promises: ${openProms.map((p) => `${p.milestone} to ${p.thread} (fallback ${new Date(p.fallback_at).toISOString()}${p.state === 'due' ? ', due' : ''})`).join('; ')}.`);
    if (flags.length) L.push(`Flags: ${flags.map((f) => `${f.check}: ${f.detail}`).join('; ')}.`);
    if (job.wake_reasons.length) L.push(`Since last look: ${job.wake_reasons.join('; ')}.`);

    return {
      text: L.join('\n'),
      data: {
        job: job.id, workflow: job.workflow, target: job.target, status: job.status, reported_status: job.reported_status,
        waiting_for: job.waiting_for, next_wake_at: job.next_wake_at, work_run: workRun, work_run_busy: runBusy,
        threads: job.threads.map((t) => ({ thread: t, role: job.roles[t], private: job.private_threads.includes(t) })),
        milestones: job.milestones, events: evView, open_asks: openAsks, operations: opsView,
        owed, claims: claimed, sent, promises: proms.map((p) => ({ milestone: p.milestone, thread: p.thread, state: p.state, fallback_at: p.fallback_at })),
        flags: flags.map((f) => ({ check: f.check, mode: f.mode, detail: f.detail, call: f.call })),
      },
    };
  }


  // ---------------------------------------------------------------- ingest

  private eventGate(ev: IngestEvent): string[] {
    return [ev.attrs?.gate, ev.attrs?.job, ev.attrs?.name].filter((x): x is string => typeof x === 'string' && x !== '');
  }

  private async doIngest(ev: IngestEvent): Promise<Answer> {
    if (!ev || !ev.source || !ev.delivery_id || !ev.kind) {
      return ans(false, 'bad_event', 'ingest: source, delivery_id and kind are required; the event was not recorded.');
    }
    const now = this.now();
    const id = `${ev.source}:${ev.delivery_id}`;
    const senderKind = ev.sender_id && ev.sender_id === this.config.ownBotUserId ? 'own_bot' : (ev.sender_kind ?? (ev.sender_id ? 'human' : 'system'));
    const fresh: EventRecord = {
      key: id, id, source: ev.source, delivery_id: ev.delivery_id, kind: ev.kind, thread: ev.thread ?? null,
      sender_id: ev.sender_id ?? null, sender_kind: senderKind, ref: ev.ref ?? null, attrs: ev.attrs ?? {},
      received_at: now, matched_jobs: [], state: 'received',
    };
    // Written as received, processed, then marked done: a retry of a received-but-not-done event reprocesses it (M8).
    const r = await this.create('event', id, fresh);
    const rec = r.value;
    if (!r.created && rec.state !== 'received') return ans(true, 'duplicate', `Event ${id} was already recorded; ignored.`, { event: id, duplicate: true });

    const ti = ev.thread ? await this.get<ThreadIndex>('thread_index', ev.thread) : null;
    const claim = ev.thread ? await this.get<Claim>('claim', ev.thread) : null;
    const openClaim = claim && claim.state === 'open' ? claim : null;
    const refIdx = ev.ref ? await this.get<IdList>('ref_index', ev.ref) : null;
    const jobIds = uniq([...(ti?.jobs ?? []), ...(openClaim ? [openClaim.job] : []), ...(refIdx?.ids ?? [])]);
    const jobs = await this.manyPresent<Job>('job', jobIds);
    const woken: string[] = [];
    const actions: string[] = [];
    // An event from a private link stays private in every job it reaches (also by ref), not only the job that linked it.
    if (ev.thread && jobs.some((j) => j.private_threads.includes(ev.thread!))) rec.private_origin = true;
    const matched = new Set<string>(rec.matched_jobs);
    for (const job of jobs) {
      if (job.status === 'done' || job.status === 'cancelled') continue;
      const spec = this.spec(job);
      matched.add(job.id);
      if (!job.event_ids.includes(id)) job.event_ids.push(id);
      if (job.event_ids.length > MAX_EVENTS_KEPT) job.event_ids.splice(0, job.event_ids.length - MAX_EVENTS_KEPT);
      let wakeReason: string | null = null;

      if (senderKind === 'own_bot' && ev.thread) {
        const mine = openClaim && openClaim.job === job.id ? openClaim : null;
        const d = mine ? await this.get<Delivery>('delivery', `${job.id}:${ev.thread}:${mine.milestone}`) : null;
        const relay = !!ev.attrs?.relay;
        const postedAt = typeof ev.attrs?.ts === 'number' ? ev.attrs.ts : null;
        const link = typeof ev.attrs?.link === 'string' ? ev.attrs.link : null;
        if (mine && d && d.state === 'claimed') {
          if (relay) {
            // A mention reply counts only when the connector says which session wrote it and that is the claim owner.
            const sess = typeof ev.attrs?.session === 'string' ? ev.attrs.session : null;
            if (sess !== null && mine.session !== null && sess === mine.session) {
              await this.markSent(job, d, 'relay', link);
              actions.push(`relayed reply in ${ev.thread} from the claim owner matched the ${mine.milestone} claim of ${job.id}`);
              await this.maybeClose(job);
            } else {
              actions.push(`relayed reply in ${ev.thread} did not come from the owner of the open ${mine.milestone} claim; not matched`);
            }
          } else if (postedAt === null) {
            actions.push(`own post in ${ev.thread} carried no timestamp; not matched to the open ${mine.milestone} claim (the sweep or posted_link will settle it)`);
          } else if (postedAt < mine.at) {
            // A late delivery of a post made before the claim belongs to an earlier post, not to this claim.
            actions.push(`own post in ${ev.thread} predates the open ${mine.milestone} claim of ${job.id}; not matched to it`);
          } else {
            await this.markSent(job, d, 'connector', link);
            actions.push(`own post in ${ev.thread} matched the ${mine.milestone} claim of ${job.id}`);
            await this.maybeClose(job);
          }
        } else if (job.threads.includes(ev.thread) && !relay && !openClaim) {
          await this.addFlag(job, 'unclaimed_post', `your bot posted in ${ev.thread} with no open claim (event ${id})`, 'ingest');
          actions.push(`unclaimed own post in ${ev.thread} flagged on ${job.id}`);
        }
      } else if (ev.thread && job.threads.includes(ev.thread)) {
        if (senderKind === 'other_bot') {
          wakeReason = `another bot posted in ${job.private_threads.includes(ev.thread) ? 'a linked thread' : ev.thread}`;
        } else if (ev.sender_id) {
          const asks = await this.manyPresent<Ask>('ask', job.ask_keys);
          if (asks.some((x) => x.state === 'open' && x.responder_slack.includes(ev.sender_id!))) {
            wakeReason = `${ev.sender_id} (a responder of an open ask) posted in ${job.private_threads.includes(ev.thread) ? 'a linked thread' : ev.thread}`;
          }
        }
      }
      if (ev.ref && refIdx?.ids.includes(job.id)) {
        const ops = await this.manyPresent<Operation>('operation', job.op_keys);
        const evGates = this.eventGate(ev);
        for (const op of ops) {
          if (op.ref !== ev.ref) continue;
          const act = spec?.actions?.[op.action];
          // Kind, ref and (when the action names a gate) the event's gate must all match (M5).
          if (act?.proved_by && act.proved_by === ev.kind && (!act.gate || evGates.includes(act.gate))) {
            op.source = 'webhook_verified';
            if (op.outcome === 'in_flight' || op.outcome === 'unknown') { op.outcome = 'done'; op.outcome_at = now; await this.releaseLease(op); }
            await this.save('operation', op.key, op);
            actions.push(`${op.action} ${op.ref} verified by ${ev.kind}`);
          }
        }
        wakeReason = wakeReason ?? `external event ${ev.source}/${ev.kind} for ${ev.ref}`;
        await this.maybeClose(job); // a verified outcome may be what a cancel or a closing job was waiting for
      }
      if (wakeReason && job.closed_at === null) {
        this.addReason(job, wakeReason);
        job.next_wake_at = now;
        await this.schedule(job.id, now);
        woken.push(job.id);
      }
      await this.saveJob(job);
    }
    rec.matched_jobs = [...matched];
    rec.state = 'done';
    await this.put('event', id, rec);
    return ans(true, 'recorded', `Event ${id} recorded; matched ${rec.matched_jobs.length} job(s).${actions.length ? ' ' + actions.join('; ') + '.' : ''}`, { event: id, matched_jobs: rec.matched_jobs, woken, actions });
  }

  // ---------------------------------------------------------------- sweep

  private async doSweep(): Promise<Answer> {
    const now = this.now();
    const nowB = this.bucketOf(now);
    const cur = (await this.get<{ bucket: number }>('sweep_cursor', 'main')) ?? { bucket: nowB };
    const from = Math.max(cur.bucket, nowB - MAX_BUCKETS_PER_SWEEP);
    const ids = new Set<string>();
    const buckets: string[] = [];
    for (let b = from; b <= nowB; b++) buckets.push(String(b));
    for (const r of await this.manyPresent<IdList>('due_index', buckets)) for (const j of r.ids) ids.add(j);
    const summary = { jobs_checked: 0, woke: [] as string[], operations_unknown: 0, promises_due: 0, claims_reconciled: 0, claims_not_seen: 0, closed: [] as string[], wakes_skipped: [] as string[] };
    for (const id of ids) {
      const job = await this.get<Job>('job', id);
      if (!job || job.status === 'done' || job.status === 'cancelled') continue;
      summary.jobs_checked += 1;
      await this.processJob(job, summary);
    }
    await this.put('sweep_cursor', 'main', { bucket: nowB });
    return ans(true, 'swept', `Sweep checked ${summary.jobs_checked} job(s): woke ${summary.woke.length}, ${summary.operations_unknown} operation(s) turned unknown, ${summary.promises_due} promise(s) due, ${summary.claims_reconciled} claim(s) reconciled.`, summary);
  }

  private async processJob(job: Job, sum: { woke: string[]; operations_unknown: number; promises_due: number; claims_reconciled: number; claims_not_seen: number; closed: string[]; wakes_skipped: string[] }): Promise<void> {
    const now = this.now();
    const spec = this.spec(job);
    const reasons: string[] = [];
    let stillQueued = false;

    if (job.status === 'queued') {
      const blockers = await this.manyPresent<Job>('job', job.blocked_by_jobs);
      const idxId = `${job.workflow}:${job.target}`;
      const idx = await this.get<JobIndex>('job_index', idxId);
      const taken = !!idx?.primary && idx.primary !== job.id;
      if ((blockers.every((b) => b.status === 'done' || b.status === 'cancelled') || blockers.length === 0) && !taken) {
        job.status = 'open';
        job.blocked_by_jobs = [];
        job.next_wake_at = now;
        reasons.push('the job it was queued behind has ended');
        if (idx) { idx.queued = idx.queued.filter((x) => x !== job.id); idx.primary = job.id; await this.save('job_index', idxId, idx); }
      } else {
        if (taken) job.blocked_by_jobs = [idx!.primary!];
        stillQueued = true;
      }
    }

    // operations past the timeout become unknown
    const ops = await this.manyPresent<Operation>('operation', job.op_keys);
    for (const o of ops) {
      if (o.outcome !== 'in_flight') continue;
      const due = o.intent_at + this.unknownMs(spec);
      if (due <= now) {
        o.outcome = 'unknown';
        o.note = o.note || 'no outcome reported before the timeout';
        await this.save('operation', o.key, o);
        reasons.push(`operation ${o.action} ${o.ref} has no outcome after ${fmtAge(now - o.intent_at)}: unknown. Verify it and report done or failed`);
        sum.operations_unknown += 1;
      } else await this.schedule(job.id, due);
    }
    // promises past their fallback
    const proms = await this.manyPresent<Promise_>('promise', job.promise_keys);
    for (const p of proms) {
      if (p.state === 'open' && p.fallback_at <= now) {
        p.state = 'due';
        await this.save('promise', p.key, p);
        reasons.push(`promise due: ${p.milestone} to ${p.thread}`);
        sum.promises_due += 1;
      } else if (p.state === 'open') await this.schedule(job.id, p.fallback_at);
    }
    // claims not yet seen: reconcile through the Slack reader; a reply to a mention never counts
    const dels = await this.manyPresent<Delivery>('delivery', job.delivery_keys);
    for (const d of dels) {
      if (d.state !== 'claimed' || d.next_check_at === null) continue;
      if (d.next_check_at > now) { await this.schedule(job.id, d.next_check_at); continue; }
      const c = await this.get<Claim>('claim', d.thread);
      const claimAt = c && c.state === 'open' && c.job === job.id && c.milestone === d.milestone ? c.at : (d.claimed_at ?? d.owed_at);
      let found: { link?: string; ts?: number; relay?: boolean } | null = null;
      try { found = await this.slackReader.findOwnPostAfter(d.thread, claimAt); } catch { found = null; }
      if (found && !found.relay && (found.ts === undefined || found.ts >= claimAt)) {
        await this.markSent(job, d, 'sweep', found.link ?? null);
        sum.claims_reconciled += 1;
      } else {
        d.next_check_at = now + this.config.sweepMinutes * MIN;
        await this.save('delivery', d.key, d);
        await this.schedule(job.id, d.next_check_at);
        sum.claims_not_seen += 1;
      }
    }
    if (stillQueued) {
      // A queued job is not woken, but anything already recorded on it (a stray intend) still times out.
      job.next_wake_at = now + this.nextWakeMs(spec);
      await this.saveJob(job);
      await this.schedule(job.id, job.next_wake_at);
      return;
    }
    if (await this.maybeClose(job)) { sum.closed.push(job.id); return; }

    for (const r of reasons) this.addReason(job, r);
    if (reasons.length) job.next_wake_at = Math.min(job.next_wake_at ?? now, now);
    const wakeDue = job.next_wake_at !== null && job.next_wake_at <= now;
    // Standing things Tony must look at are added to the wake text when a wake is due, not stored.
    const extra: string[] = [];
    if (wakeDue) {
      if (job.status === 'closing') for (const d of await this.owedDeliveries(job)) extra.push(`still owed: ${d.milestone} to ${d.thread}`);
      for (const d of dels) {
        if (d.state !== 'claimed') continue;
        const c = await this.get<Claim>('claim', d.thread);
        if (c && c.state === 'open' && c.job === job.id && now - c.touched >= this.staleMs(spec)) extra.push(`claim for ${d.milestone} in ${d.thread} was never seen: read the thread; if it is posted call say with posted_link, if not post it`);
      }
      for (const o of await this.manyPresent<Operation>('operation', job.op_keys)) if (o.outcome === 'unknown') extra.push(`operation ${o.action} ${o.ref} is unknown: verify it and report done or failed`);
    }
    await this.saveJob(job);
    if (wakeDue) {
      const r = await this.wakeInner(job.id, uniq([...job.wake_reasons, ...extra]).join('; ') || 'next wake time reached');
      if (r.woke) sum.woke.push(job.id); else sum.wakes_skipped.push(job.id);
    } else if (job.next_wake_at !== null) {
      await this.schedule(job.id, job.next_wake_at);
    }
  }

  // ---------------------------------------------------------------- wake

  private doWake(jobId: string, reason: string): Promise<Answer> {
    return this.wakeInner(jobId, reason);
  }

  private async wakeInner(jobId: string, reason: string): Promise<Answer & { woke: boolean }> {
    const now = this.now();
    const job = await this.get<Job>('job', jobId);
    const no = (status: string, say: string): Answer & { woke: boolean } => ({ ...ans(true, status, say, { job: jobId }), woke: false });
    if (!job) return { ...ans(false, 'no_such_job', `wake: no job "${jobId}".`), woke: false };
    if (job.status === 'done' || job.status === 'cancelled') return no('job_ended', `${jobId} has ended; no wake.`);
    const cr = job.current_run ? await this.get<Run>('run', `${job.id}:${job.current_run}`) : null;
    if (this.runActive(cr)) {
      // A run is working: do not steer twice; recover if that run is lost. Pending reasons stay.
      job.next_wake_at = cr!.last_activity_at + this.config.runTimeoutMinutes * MIN;
      await this.saveJob(job);
      await this.schedule(job.id, job.next_wake_at);
      return no('run_active', `A run is already active for ${jobId}; no new wake.`);
    }
    const n = job.run_seq + 1;
    const run: Run = { id: `${job.id}:${n}`, job: job.id, n, session_id: null, origin: 'wake', started_at: now, last_activity_at: now, state: 'active' };
    const r = await this.create('run', run.id, run);
    if (!r.created) return no('twin_wake', `Another wake already created run ${run.id}; this one does nothing.`);
    if (cr && cr.state === 'active') { cr.state = 'superseded'; await this.save('run', cr.id, cr); }
    const posting = [...job.wake_reasons];
    job.run_seq = n;
    job.current_run = n;
    job.next_wake_at = now + this.nextWakeMs(this.spec(job));
    await this.saveJob(job);
    await this.schedule(job.id, job.next_wake_at);
    const text = `Work engine wake for job ${job.id}: ${reason}. Call job_view first, then carry on. If you do nothing, the engine wakes you again at ${new Date(job.next_wake_at).toISOString()}.`;
    try {
      await this.waker.postWake(job.dm_id, text);
    } catch (e) {
      // The reasons were kept, so the retry wake still says why.
      const bad = await this.get<Run>('run', run.id);
      if (bad && bad.session_id === null) { bad.state = 'idle'; await this.save('run', bad.id, bad); }
      await this.updateJob(job.id, (j) => { j.next_wake_at = Math.min(j.next_wake_at ?? now + MIN, now + MIN); });
      await this.schedule(job.id, now + MIN);
      return { ...ans(false, 'wake_failed', `Posting the wake failed (${(e as Error).message}); retrying in 1 minute.`, { job: jobId }), woke: false };
    }
    // A pending reason is cleared only after a wake was posted that carried it (M3).
    await this.updateJob(job.id, (j) => { j.wake_reasons = j.wake_reasons.filter((x) => !posting.includes(x)); });
    return { ...ans(true, 'woke', `Woke ${jobId} as run ${run.id}: ${reason}.`, { job: jobId, run: run.id }), woke: true };
  }

  // ---------------------------------------------------------------- invariants

  private async doCheckInvariants(jobIds: string[]): Promise<string[]> {
    const bad: string[] = [];
    const jobs = await this.manyPresent<Job>('job', jobIds);
    const resources = new Set<string>();
    const claimedByThread = new Map<string, number>();
    for (const job of jobs) {
      const spec = this.spec(job);
      for (const r of spec?.resources ?? []) resources.add(r);
      for (const a of Object.values(spec?.actions ?? {})) if (a.resource) resources.add(a.resource);
      const terminal = job.status === 'done' || job.status === 'cancelled';
      if (!terminal && (job.next_wake_at === null || !Number.isFinite(job.next_wake_at))) bad.push(`${job.id}: open job without next_wake_at`);
      const proms = await this.manyPresent<Promise_>('promise', job.promise_keys);
      for (const p of proms) if (p.state === 'open' && !Number.isFinite(p.fallback_at)) bad.push(`${job.id}: open promise ${p.key} without fallback_at`);
      const runs = await this.manyPresent<Run>('run', Array.from({ length: job.run_seq }, (_, i) => `${job.id}:${i + 1}`));
      const active = runs.filter((r) => r.state === 'active');
      if (active.length > 1) bad.push(`${job.id}: ${active.length} active runs`);
      const dels = await this.manyPresent<Delivery>('delivery', job.delivery_keys);
      for (const d of dels) {
        if (d.sent_count > 1) bad.push(`${job.id}: delivery ${d.key} sent ${d.sent_count} times`);
        if (d.state === 'sent' && d.sent_count !== 1) bad.push(`${job.id}: delivery ${d.key} is sent with sent_count ${d.sent_count}`);
        if (d.state === 'claimed') claimedByThread.set(d.thread, (claimedByThread.get(d.thread) ?? 0) + 1);
        if (terminal && (d.state === 'owed' || d.state === 'claimed')) bad.push(`${job.id}: ${job.status} job with delivery ${d.key} still ${d.state}`);
      }
      if (job.status === 'done') for (const p of proms) if (p.state === 'void') bad.push(`${job.id}: done job has a void promise ${p.key}`);
      const ops = await this.manyPresent<Operation>('operation', job.op_keys);
      if (new Set(job.op_keys).size !== job.op_keys.length) bad.push(`${job.id}: duplicate operation keys`);
      for (const o of ops) {
        if (o.key !== `${job.id}:${o.action}:${o.ref}`) bad.push(`${job.id}: operation ${o.key} does not match its action and ref`);
        if (terminal && o.outcome === 'in_flight') bad.push(`${job.id}: ${job.status} job with in-flight operation ${o.key}`);
        if (job.status === 'done' && o.outcome === 'unknown') bad.push(`${job.id}: done job with unresolved operation ${o.key}`);
        if (terminal && o.lease_taken) bad.push(`${job.id}: ${job.status} job still marks a lease taken for ${o.key}`);
        if (o.lease_taken && o.outcome !== 'in_flight' && o.outcome !== 'unknown') bad.push(`${job.id}: operation ${o.key} is ${o.outcome} but still marks a lease taken`);
        if (o.lease_taken && o.resource) {
          const lease = await this.get<Lease>('lease', o.resource);
          if (!lease || lease.holder_job !== job.id || !lease.ops.includes(o.key)) bad.push(`${job.id}: operation ${o.key} says it holds ${o.resource} but the lease disagrees`);
        }
      }
      for (const [thread, m] of Object.entries(job.claims)) {
        const c = await this.get<Claim>('claim', thread);
        if (!c || c.state !== 'open' || c.job !== job.id || c.milestone !== m) bad.push(`${job.id}: claim ${m} in ${thread} not reflected in the claim record`);
      }
    }
    for (const [thread, n] of claimedByThread) if (n > 1) bad.push(`thread ${thread}: ${n} open claims`);
    for (const res of resources) {
      const lease = await this.get<Lease>('lease', res);
      if (!lease || !lease.holder_job) continue;
      const holder = jobs.find((j) => j.id === lease.holder_job);
      if (!holder) continue; // holder outside the given set
      const ops = await this.manyPresent<Operation>('operation', lease.ops);
      const live = ops.filter((o) => o.job === holder.id && o.resource === res && o.lease_taken && (o.outcome === 'in_flight' || o.outcome === 'unknown'));
      if (live.length === 0) bad.push(`lease ${res}: held by ${holder.id} without an in-flight operation for it`);
    }
    return bad;
  }
}

export { CHECK_NAMES };
