// Simulated actors: Tony sessions (live, stale, crashing), humans, another bot, the connector,
// external systems, timers. Each step is one random action from a weighted menu.
import type { IngestEvent } from '../src/types.ts';
import { Rng } from './random.ts';
import { World, WF, MIN, OWNER, HARRY, OUTSIDER, PRIVATE_THREAD, type Post } from './world.ts';
import { checkState } from './invariants.ts';

const TARGETS = ['T1', 'T2'] as const;
const POOL: Record<string, string[]> = { T1: ['A', 'B', 'Q', PRIVATE_THREAD], T2: ['D', 'E'] };
const REFS = ['pr1', 'pr2', 'b-abc', 'b-def', 'issue1'];
const BUILDS = ['abc', 'def', 'ghi'];

interface Session {
  id: string;
  alive: boolean;
  /** claimed (got go) but has not posted yet */
  pendingPost: { job: string; thread: string; milestone: string; at: number; round: number } | null;
  /** intended but no checkpoint yet */
  openOps: Array<{ job: string; action: string; ref: string }>;
  /** last job this session has looked at or acted on */
  job: string | null;
}

export class Sim {
  readonly w: World;
  readonly rng: Rng;
  sessions: Session[] = [];
  pending: IngestEvent[] = [];
  /** operations a session reported failed: candidates for a retry with the same ref (playbook: same ref on retry) */
  failedOps: Array<{ job: string; action: string; ref: string }> = [];
  seenEventIds: string[] = [];
  evSeq = 0;
  sessSeq = 0;
  steps = 0;
  afterSweep = false;

  constructor(w: World, rng: Rng) {
    this.w = w;
    this.rng = rng;
  }

  // ------------------------------------------------------------ helpers
  liveSession(): Session {
    const live = this.sessions.filter((s) => s.alive);
    if (live.length === 0 || (live.length < 4 && this.rng.chance(0.08))) return this.spawn();
    return this.rng.pick(live);
  }
  spawn(): Session {
    const s: Session = { id: `s${++this.sessSeq}`, alive: true, pendingPost: null, openOps: [], job: null };
    // About a quarter of the sessions are mention sessions in a non-home DM (A1); the rest are home sessions.
    if (this.rng.chance(0.25)) this.w.dir.mention.add(s.id);
    this.sessions.push(s);
    return s;
  }
  sid(s: Session): string | null { return this.rng.chance(0.03) ? null : s.id; }
  pickJob(s?: Session): string {
    const jobs = [...this.w.jobs];
    if (jobs.length === 0 || this.rng.chance(0.04)) return this.rng.chance(0.5) ? 'nope:none' : '';
    if (s?.job && this.rng.chance(0.6) && this.w.jobs.has(s.job)) return s.job;
    return this.rng.pick(jobs);
  }
  threadFor(job: string): string {
    const target = /:(T\d)/.exec(job)?.[1] ?? 'T1';
    if (this.rng.chance(0.05)) return 'Z';
    if (this.rng.chance(0.03)) return '';
    return this.rng.pick(POOL[target] ?? ['A']);
  }
  milestone(): string {
    if (this.rng.chance(0.05)) return 'not_a_milestone';
    return this.rng.pick(Object.keys(this.w.spec.milestones!));
  }
  evId(): string | undefined {
    if (this.seenEventIds.length === 0 || this.rng.chance(0.5)) return undefined;
    return this.rng.pick(this.seenEventIds);
  }
  queue(ev: IngestEvent): void { this.pending.push(ev); }
  mkEvent(p: Partial<IngestEvent> & { kind: string }): IngestEvent {
    return { source: 'slack', delivery_id: `e${++this.evSeq}`, ...p };
  }

  // ------------------------------------------------------------ the menu
  async step(): Promise<void> {
    this.steps += 1;
    this.afterSweep = false;
    const a = this.rng.weighted<() => Promise<void>>([
      [8, () => this.open()],
      [10, () => this.view()],
      [14, () => this.intend()],
      [14, () => this.say()],
      [8, () => this.promise()],
      [12, () => this.checkpoint()],
      [5, () => this.postPending()],
      [8, () => this.human()],
      [6, () => this.external()],
      [3, () => this.otherBot()],
      [2, () => this.ownStray()],
      [3, () => this.privateEvidence()],
      [10, () => this.deliver()],
      [3, () => this.dupEvent()],
      [3, () => this.dropEvent()],
      [12, () => this.tick()],
      [3, () => this.bigTick()],
      [8, () => this.sweep()],
      [3, () => this.plainWake()],
      [6, () => this.handleWake()],
      [3, () => this.crash()],
      [1.5, () => this.downtime()],
      [3, () => this.changeBuild()],
      [2, () => this.toggle()],
      [2, () => this.lookupFault()],
      [1.5, () => this.replace()],
      [1.5, () => this.staleWakeNext()],
    ]);
    await a();
    const bad = await checkState(this.w, this.afterSweep);
    if (bad.length) throw new (await import('./world.ts')).Violation(bad.join('; '));
  }

  // --- Tony calls
  async open(): Promise<void> {
    const s = this.liveSession();
    const target = this.rng.chance(0.03) ? '' : this.rng.pick(TARGETS);
    const thread = target ? this.rng.pick(POOL[target]) : 'A';
    const intent = this.rng.weighted<'join' | 'replace' | 'queue' | undefined>([[7, 'join'], [1, 'replace'], [2, 'queue'], [1, undefined]]);
    const role = this.rng.weighted<string | undefined>([[6, undefined], [2, 'side'], [2, 'qa'], [1, 'bogus']]);
    const a = await this.w.api('jobOpen', { workflow: this.rng.chance(0.02) ? 'nope' : WF, target, thread, intent, role, private: thread === PRIVATE_THREAD || this.rng.chance(0.03) }, this.sid(s));
    if (typeof a.job === 'string') s.job = a.job;
  }
  async view(): Promise<void> {
    const s = this.liveSession();
    const byJob = this.rng.chance(0.5);
    const job = this.pickJob(s);
    const args = byJob ? { job } : this.rng.chance(0.05) ? {} : { thread: this.rng.pick(['A', 'B', 'D', 'Q', PRIVATE_THREAD, 'Z']) };
    const a = await this.w.api('jobView', args, this.sid(s));
    if (typeof (a.jobs as any)?.[0]?.job === 'string') s.job = (a.jobs as any)[0].job;
  }
  async intend(): Promise<void> {
    const s = this.liveSession();
    const job = this.pickJob(s);
    const action = this.rng.chance(0.05) ? (this.rng.chance(0.5) ? '' : 'bogus_action') : this.rng.pick(Object.keys(this.w.spec.actions!));
    const ref = this.rng.chance(0.03) ? '' : this.rng.pick(REFS);
    const because = this.rng.chance(0.3) ? this.evId() : undefined;
    const a = await this.w.api('intend', { job, action, ref, because }, this.sid(s));
    if (a.status === 'clear') {
      s.openOps.push({ job, action, ref });
      if (this.rng.chance(0.12)) this.crashSession(s, 'after intend, before checkpoint');
    }
  }
  async say(): Promise<void> {
    const s = this.liveSession();
    const job = this.pickJob(s);
    const thread = this.threadFor(job);
    const milestone = this.milestone();
    const a = await this.w.api('say', { job, thread, milestone }, this.sid(s));
    s.job = job || s.job;
    await this.actOnSay(s, job, thread, milestone, a);
  }
  /**
   * Tony follows the playbook literally.
   *  go: post now.  busy: do not post.  already_sent: nothing.
   *  already_claimed: read the thread; post only if the message is absent, else confirm with posted_link.
   */
  async actOnSay(s: Session, job: string, thread: string, milestone: string, a: { status: string; round?: unknown; repeat?: unknown }, relay = false): Promise<void> {
    const round = typeof a.round === 'number' ? a.round : 1;
    const post = async (): Promise<void> => {
      // one post intent per claim: posting now cancels any older pending post of this session for the same message
      for (const o of this.sessions) if (o.pendingPost && o.pendingPost.job === job && o.pendingPost.thread === thread && o.pendingPost.milestone === milestone) o.pendingPost = null;
      const p = this.w.post(job, thread, milestone, relay, round);
      await this.afterPost(s, p);
    };
    if (a.status === 'go' && a.repeat === true) {
      // the answer says: you already hold this claim; post unless it is already there (then confirm with posted_link)
      const found = this.w.findPost(job, thread, milestone, round);
      if (found) await this.w.api('say', { job, thread, milestone, posted_link: found.link }, s.id);
      else await post();
    } else if (a.status === 'go') {
      const r = this.rng.next();
      if (relay || r < 0.55) await post();
      else if (r < 0.7) this.crashSession(s, 'after claim, before post');
      else s.pendingPost = { job, thread, milestone, at: this.w.now(), round };
    } else if (a.status === 'already_claimed') {
      const found = this.w.findPost(job, thread, milestone, round);
      if (found) {
        if (this.rng.chance(0.7)) await this.w.api('say', { job, thread, milestone, posted_link: found.link }, s.id);
      } else if (this.rng.chance(0.85)) {
        await post();
      }
    }
    // busy, already_sent, job_ended, confirmed: nothing to post
  }
  async promise(): Promise<void> {
    const s = this.liveSession();
    const job = this.pickJob(s);
    const ft = this.rng.weighted<number | string | undefined>([[3, undefined], [3, this.rng.range(1, 400)], [2, `${this.rng.range(1, 300)}m`], [1, 'garbage'], [1, this.w.now() + this.rng.range(1, 300) * MIN]]);
    await this.w.api('promiseAdd', { job, thread: this.threadFor(job), about: this.milestone(), fallback_time: ft }, this.sid(s));
  }
  async checkpoint(): Promise<void> {
    const s = this.liveSession();
    const job = this.pickJob(s);
    const status = this.rng.weighted<string>([[10, 'working'], [3, 'waiting'], [3, 'done'], [1.2, 'cancelled']]);
    const operations: any[] = [];
    const takeN = status === 'cancelled' ? s.openOps.length : this.rng.int(3);
    for (const o of s.openOps.splice(0, takeN)) {
      // playbook: on cancel, an operation still in flight is reported unknown when Tony cannot tell
      const outcome = status === 'cancelled' && this.rng.chance(0.7) ? 'unknown' : this.rng.pick(['done', 'done', 'failed', 'unknown']);
      if (outcome === 'failed') this.failedOps.push(o);
      operations.push({ ref: o.ref, action: this.rng.chance(0.8) ? o.action : undefined, outcome, note: 'n' });
    }
    if (this.rng.chance(0.08)) operations.push({ ref: this.rng.pick(REFS), outcome: this.rng.pick(['done', 'failed', 'bogus']) });
    const reached = this.rng.chance(0.15) ? [this.milestone()] : undefined;
    const nwi = this.rng.weighted<number | string | undefined>([[4, undefined], [3, this.rng.range(1, 90)], [1, '2h'], [1, 'soon']]);
    await this.w.api('checkpoint', { job, status, waiting_for: this.rng.chance(0.5) ? 'something' : undefined, next_wake_in: nwi, operations: operations.length ? operations : undefined, reached }, this.sid(s));
  }
  async postPending(): Promise<void> {
    const s = this.sessions.find((x) => x.alive && x.pendingPost);
    if (!s) return;
    const { job, thread, milestone, at, round } = s.pendingPost!;
    s.pendingPost = null;
    // Playbook: a go is for a job. If that job was ended or replaced since, the go is void (say would now answer job_ended); do not post.
    const pj = await this.w.peek<any>('job', job);
    if (!pj || pj.status === 'done' || pj.status === 'cancelled') return;
    // Playbook: a go is good for the stale window (10 minutes); after that, say again before posting.
    if (this.w.now() - at < 10 * MIN) {
      await this.afterPost(s, this.w.post(job, thread, milestone, false, round));
      return;
    }
    const a = await this.w.api('say', { job, thread, milestone }, s.id);
    await this.actOnSay(s, job, thread, milestone, a);
  }
  async afterPost(s: Session, p: Post): Promise<void> {
    const r = this.rng.next();
    const ev = this.w.ownPostEvent(p, { ts: p.ts, ...(p.relay ? { relay: true, session: s.id } : {}) });
    if (!p.relay && p.milestone && p.job && this.rng.chance(0.15)) {
      // Tony tells the engine where he posted (covers a connector that filters bot posts)
      await this.w.api('say', { job: p.job, thread: p.thread, milestone: p.milestone, posted_link: p.link }, s.id);
    }
    if (r < 0.5) await this.w.ingest(ev);
    else if (r < 0.65) { this.crashSession(s, 'after post, before ingest'); this.queue(ev); }
    else if (r < 0.85) this.queue(ev);
    else this.log('connector missed the post'); // dropped
  }

  // --- events
  async human(): Promise<void> {
    const sender = this.rng.weighted<string>([[4, OWNER], [2, HARRY], [2, OUTSIDER]]);
    const thread = this.rng.pick(['A', 'B', 'D', 'Q', 'E', 'Z']);
    const ev = this.mkEvent({ kind: 'message', thread, sender_id: sender, sender_kind: 'human' });
    this.seenEventIds.push(`slack:${ev.delivery_id}`);
    this.queue(ev);
  }
  async external(): Promise<void> {
    const kinds = Object.values(this.w.spec.actions!).map((x) => x.proved_by).filter(Boolean) as string[];
    const ev = this.mkEvent({ source: 'ext', kind: this.rng.chance(0.15) ? 'noise' : this.rng.pick(kinds), ref: this.rng.pick(REFS), sender_kind: 'system' });
    this.seenEventIds.push(`ext:${ev.delivery_id}`);
    this.queue(ev);
  }
  async otherBot(): Promise<void> {
    const ev = this.mkEvent({ kind: 'message', thread: this.rng.pick(['A', 'B', 'Q', 'D']), sender_id: 'UOTHERBOT', sender_kind: 'other_bot' });
    this.seenEventIds.push(`slack:${ev.delivery_id}`);
    this.queue(ev);
  }
  /**
   * A late or unrelated own-bot event: no timestamp (or one older than the claim). It must never satisfy a claim,
   * also when a claim is open in that thread (H3).
   */
  async ownStray(): Promise<void> {
    const thread = this.rng.pick(['A', 'B', 'D', 'Q', 'Z']);
    const claim = await this.w.peek<any>('claim', thread);
    const attrs = claim?.state === 'open' && this.rng.chance(0.5) ? { ts: claim.at - 1000 } : undefined;
    await this.w.ingest(this.mkEvent({ kind: 'message', thread, sender_id: 'UBOT', attrs }));
  }
  /** A reply to a mention, relayed by the connector. It tells a milestone only after a say; otherwise it is a plain answer. */
  async mentionReply(): Promise<void> {
    const s = this.liveSession();
    const job = this.pickJob(s);
    if (!job || !this.w.jobs.has(job)) return;
    const thread = this.threadFor(job);
    if (!thread) return;
    if (this.rng.chance(0.5)) {
      const p = this.w.post(null, thread, null, true);
      const ev = this.w.ownPostEvent(p, { ts: p.ts, relay: true, session: s.id });
      if (this.rng.chance(0.5)) await this.w.ingest(ev); else this.queue(ev);
      return;
    }
    const milestone = this.milestone();
    const a = await this.w.api('say', { job, thread, milestone }, s.id);
    await this.actOnSay(s, job, thread, milestone, a, true);
  }
  /** Playbook: retry a failed action with the same ref. */
  async retryIntend(): Promise<void> {
    if (this.failedOps.length === 0) return;
    const o = this.rng.pick(this.failedOps);
    const s = this.liveSession();
    const a = await this.w.api('intend', { job: o.job, action: o.action, ref: o.ref }, s.id);
    if (a.status === 'clear') s.openOps.push(o);
  }
  /**
   * Two engine instances on one store, calls interleaved. Each case has a property that must survive the race.
   */
  async race(): Promise<void> {
    const jobs = [...this.w.jobs];
    if (jobs.length === 0) return;
    const [e0, e1] = this.w.engines;
    const kind = this.rng.int(4);
    const job = this.rng.pick(jobs);
    if (kind === 0) {
      const thread = this.threadFor(job) || 'A';
      const milestone = this.rng.pick(Object.keys(this.w.spec.milestones!));
      const s1 = this.liveSession();
      const s2 = this.spawn();
      const [a1, a2] = await Promise.all([
        this.w.api('say', { job, thread, milestone }, s1.id, e0),
        this.w.api('say', { job, thread, milestone }, s2.id, e1),
      ]);
      if (a1.status === 'go' && a2.status === 'go') throw new (await import('./world.ts')).Violation(`two sessions both got go for ${milestone} in ${thread} on ${job}`);
      await this.actOnSay(s1, job, thread, milestone, a1);
      await this.actOnSay(s2, job, thread, milestone, a2);
    } else if (kind === 1) {
      const s = this.liveSession();
      const thread = this.rng.pick(['A', 'B', 'D', 'Q']);
      const ev = this.mkEvent({ kind: 'message', thread, sender_id: 'UOTHERBOT', sender_kind: 'other_bot' });
      await Promise.all([
        this.w.api('checkpoint', { job, status: 'waiting', waiting_for: 'raced', next_wake_in: 240 }, s.id, e0),
        this.w.ingest(ev, e1),
      ]);
    } else if (kind === 2) {
      const [j1, j2] = [`${WF}:T1`, `${WF}:T2`];
      if (!this.w.jobs.has(j1) || !this.w.jobs.has(j2)) return;
      const s1 = this.liveSession();
      const s2 = this.spawn();
      const [a1, a2] = await Promise.all([
        this.w.api('intend', { job: j1, action: 'publish_prod_alpha', ref: 'race-1' }, s1.id, e0),
        this.w.api('intend', { job: j2, action: 'publish_prod_alpha', ref: 'race-2' }, s2.id, e1),
      ]);
      if (a1.status === 'clear') s1.openOps.push({ job: j1, action: 'publish_prod_alpha', ref: 'race-1' });
      if (a2.status === 'clear') s2.openOps.push({ job: j2, action: 'publish_prod_alpha', ref: 'race-2' });
    } else {
      const other = this.rng.pick(jobs);
      const s1 = this.liveSession();
      const s2 = this.spawn();
      await Promise.all([
        this.w.api('checkpoint', { job, status: 'waiting', next_wake_in: 7 }, s1.id, e0),
        this.w.api('checkpoint', { job: other, status: 'waiting', next_wake_in: 7 }, s2.id, e1),
      ]);
    }
  }
  async privateEvidence(): Promise<void> {
    // Only evidence that arrives while the private link exists is private; before that it is a plain unlinked event.
    const ti = await this.w.peek<any>('thread_index', PRIVATE_THREAD);
    const linked = (ti?.jobs?.length ?? 0) > 0;
    const ev: IngestEvent = { source: 'slack', delivery_id: `${linked ? 'evid' : 'early'}_${PRIVATE_THREAD}_${++this.evSeq}`, kind: 'message', thread: PRIVATE_THREAD, sender_id: this.rng.pick([OWNER, HARRY, OUTSIDER]), sender_kind: 'human', ref: this.rng.chance(0.3) ? this.rng.pick(REFS) : undefined };
    this.seenEventIds.push(`slack:${ev.delivery_id}`);
    this.queue(ev);
  }
  /** Connector delivers one queued event, out of order with respect to the queue. */
  async deliver(): Promise<void> {
    if (this.pending.length === 0) return;
    const i = this.rng.int(this.pending.length);
    const [ev] = this.pending.splice(i, 1);
    await this.w.ingest(ev);
    if (this.rng.chance(0.15)) await this.w.ingest(ev); // duplicate delivery
  }
  async dupEvent(): Promise<void> {
    if (this.pending.length) await this.w.ingest(this.rng.pick(this.pending));
  }
  async dropEvent(): Promise<void> {
    if (this.pending.length) { this.pending.splice(this.rng.int(this.pending.length), 1); this.log('connector dropped an event'); }
  }

  // --- time, sweeps, wakes
  async tick(): Promise<void> { this.w.clock.advanceMinutes(this.rng.range(1, 12)); }
  async bigTick(): Promise<void> { this.w.clock.advanceMinutes(this.rng.range(20, 200)); }
  async sweep(): Promise<void> { await this.w.sweep(); this.afterSweep = true; }
  async plainWake(): Promise<void> {
    const job = this.pickJob();
    await this.w.wake(job, 'random timer');
    if (this.rng.chance(0.4)) await this.w.wake(job, 'twin wake');
  }
  /** A session answers a wake: binds the run with job_view, often checkpoints. */
  async handleWake(): Promise<void> {
    const wk = this.w.wakes.find((x) => !x.handled);
    if (!wk) return;
    wk.handled = true;
    if (this.rng.chance(0.2)) return; // the wake post was lost in a dead session
    const s = this.liveSession();
    s.job = wk.job;
    await this.w.api('jobView', { job: wk.job }, s.id);
    if (this.rng.chance(0.7)) await this.w.api('checkpoint', { job: wk.job, status: 'working', waiting_for: 'x' }, s.id);
  }
  async crash(): Promise<void> {
    const live = this.sessions.filter((s) => s.alive);
    if (live.length) this.crashSession(this.rng.pick(live), 'random crash');
  }
  crashSession(s: Session, why: string): void {
    s.alive = false;
    this.log(`session ${s.id} crashed (${why})`);
  }
  /** Engine down for an hour or more: nothing is ingested, nothing swept; then a catch-up sweep. */
  async downtime(): Promise<void> {
    const mins = this.rng.range(60, 300);
    this.log(`engine downtime ${mins} min`);
    this.w.clock.advanceMinutes(mins);
    this.pending = this.pending.filter(() => this.rng.chance(0.5));
    const before = this.w.wakes.length;
    await this.w.sweep();
    this.afterSweep = true;
    void before;
  }
  async changeBuild(): Promise<void> {
    const gate = this.rng.pick(Object.keys(this.w.spec.gates!));
    this.w.builds[gate] = this.rng.chance(0.1) ? null : this.rng.pick(BUILDS);
    this.log(`build of ${gate} is now ${this.w.builds[gate]}`);
  }
  /** Session lookup starts or stops failing, for one session or for all (A2). */
  async lookupFault(): Promise<void> {
    const d = this.w.dir;
    if (this.rng.chance(0.4)) { d.failAll = !d.failAll; this.log(`session lookup failing for all: ${d.failAll}`); return; }
    const s = this.rng.pick(this.sessions.length ? this.sessions : [this.spawn()]);
    if (d.failing.has(s.id)) d.failing.delete(s.id); else d.failing.add(s.id);
    this.log(`session lookup for ${s.id} failing: ${d.failing.has(s.id)}`);
  }
  /** Controlled replacement of a job's home (A3); the old sessions are fenced from then on. */
  async replace(): Promise<void> {
    const jobs = [...this.w.jobs];
    if (jobs.length === 0) return;
    await this.w.replaceHome(this.rng.pick(jobs), 'sim: operator replacement');
    this.afterSweep = false;
  }
  async staleWakeNext(): Promise<void> { this.w.staleWake = true; this.log('next wake reports a stale version'); }
  async toggle(): Promise<void> {
    const w = this.w;
    const which = this.rng.int(3);
    if (which === 0) w.slackBlind = !w.slackBlind;
    else if (which === 1) w.sourceFail = !w.sourceFail;
    else w.wakerFail = !w.wakerFail;
    this.log(`toggle blind=${w.slackBlind} sourceFail=${w.sourceFail} wakerFail=${w.wakerFail}`);
  }
  log(s: string): void { this.w.log(s); }
}
