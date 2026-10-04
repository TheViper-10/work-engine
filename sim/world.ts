// The simulated outside world around one engine: store, clock, fake readers, fake waker,
// a fake Slack with the posts Tony really made, and a traced call wrapper.
// This is simulator code, not engine code, so workflow names are fine here.
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.ts';
import { MemoryStore, makeKey } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import { defineConfig, CHECK_NAMES } from '../src/config.ts';
import type { Answer, IngestEvent, SessionDirectory, Spec } from '../src/types.ts';
import { checkAnswer } from './invariants.ts';

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
export const MIN = 60_000;
export const BOT = 'UBOT';
export const WF = 'desktop-release';
export const OWNER = 'U042GEDM4BB';
export const HARRY = 'U0C4YRX93PS';
export const OUTSIDER = 'UOUTSIDER';
export const PRIVATE_THREAD = 'C';

export function loadSpec(): Spec {
  return JSON.parse(readFileSync(new URL('../workflows/desktop-release/spec.json', import.meta.url), 'utf8')) as Spec;
}

export class Violation extends Error {}

/** Simulated session directory: mention sessions live in their own DM; home sessions live in the home of the job they first touch. */
export class SimDirectory implements SessionDirectory {
  readonly cacheable = false;
  readonly mention = new Set<string>();
  readonly failing = new Set<string>();
  failAll = false;
  private readonly assigned = new Map<string, string>();
  async dmOf(sid: string, job?: { id: string; dm: string }): Promise<{ dm: string } | { error: string }> {
    if (this.failAll || this.failing.has(sid)) return { error: 'lookup failed' };
    if (this.mention.has(sid)) return { dm: `dm:mention:${sid}` };
    if (!job) return { error: 'no job' };
    const k = `${sid}|${job.id}`;
    if (!this.assigned.has(k)) this.assigned.set(k, job.dm);
    return { dm: this.assigned.get(k)! };
  }
  broken(sid: string): boolean { return this.failAll || this.failing.has(sid); }
}

export interface Post { thread: string; ts: number; link: string; job: string | null; milestone: string | null; relay?: boolean; round: number }
export interface Wake { dm: string; text: string; at: number; job: string; handled: boolean }
export type CallName = 'jobOpen' | 'jobView' | 'intend' | 'say' | 'promiseAdd' | 'checkpoint';

export class World {
  readonly store = new MemoryStore();
  readonly clock = new ManualClock(T0);
  readonly spec = loadSpec();
  readonly mode: 'flag' | 'hold';
  /** Two engine instances share one store: function invocations in phase 3 are not serialised across processes. */
  readonly engines: Engine[] = [];
  private rr = 0;
  builds: Record<string, string | null> = { 'approve-desktop-qa-latest': 'abc', 'approve-desktop-prod-alpha': 'abc', pr_review: 'abc' };
  readonly dir = new SimDirectory();
  staleWake = false;
  /** sessions that have answered clear/go for a job at a generation: job -> session -> generation */
  readonly acted = new Map<string, Map<string, number>>();
  sourceFail = false;
  slackBlind = false;
  wakerFail = false;
  posts: Post[] = [];
  wakes: Wake[] = [];
  jobs = new Set<string>();
  trace: string[] = [];
  postCount = new Map<string, number>();
  privateThreadsSeen = new Set<string>([PRIVATE_THREAD]);
  private linkSeq = 0;

  constructor(mode: 'flag' | 'hold', instances = 2, overrides: { inboxMaxUnprocessed?: number; noticeCoalesceMinutes?: number } = {}, noGo: 'flag' | 'hold' = 'flag') {
    this.mode = mode;
    // no_go_for_build stays a flag in the general sim: many cases intend a gated action with no ask on purpose. Its own named case sets it.
    const checks = Object.fromEntries(CHECK_NAMES.map((n) => [n, n === 'no_go_for_build' ? noGo : mode]));
    for (let k = 0; k < instances; k++) {
      this.engines.push(new Engine({
        store: this.store,
        clock: this.clock,
        sourceReader: {
          currentBuild: async (_j, gate) => {
            if (this.sourceFail) throw new Error('source down');
            return this.builds[gate] ?? null;
          },
        },
        slackReader: {
          findOwnPostAfter: async (thread, ts) => {
            if (this.slackBlind) return null;
            const p = this.posts.find((x) => x.thread === thread && x.ts >= ts);
            return p ? { link: p.link, ts: p.ts, relay: !!p.relay } : null;
          },
        },
        sessionDirectory: this.dir,
        waker: {
          postWake: async (dm, text, _key) => {
            if (this.wakerFail) throw new Error('slack down');
            const job = dm.replace(/^dm:/, '').replace(/:g\d+$/, '');
            this.wakes.push({ dm, text, at: this.clock.now(), job, handled: false });
            this.pendingUnblock.delete(job);
            if (this.staleWake && !text.includes('notice')) { this.staleWake = false; return { stale_version: true }; }
          },
        },
        config: defineConfig({ env: 'sim', bot: 'bot', ownBotUserId: BOT, checks, ...overrides }),
        specs: [this.spec],
      }));
    }
  }

  /** The engine instance for the next call: round robin, so consecutive calls hit different instances. */
  get engine(): Engine { return this.engines[0]; }
  nextEngine(): Engine { return this.engines[this.rr++ % this.engines.length]; }

  now(): number { return this.clock.now(); }
  log(line: string): void { this.trace.push(`t+${Math.round((this.now() - T0) / 1000)}s ${line}`); }

  key(kind: string, id: string): string { return makeKey('sim', 'bot', kind, id); }
  async peek<T = any>(kind: string, id: string): Promise<T | null> { return this.store.get<T>(this.key(kind, id)); }

  /** Every engine call goes through here: traced, answer-checked, never allowed to throw. */
  async api(name: CallName, args: any, sid?: string | null, inst?: Engine): Promise<Answer> {
    const ctx = sid ? { session_id: sid } : {};
    let ans: Answer;
    try {
      ans = await ((inst ?? this.nextEngine()) as any)[name](args, ctx);
    } catch (e) {
      this.log(`${name} ${short(args)} THREW`);
      throw new Violation(`engine.${name} threw: ${(e as Error).stack}`);
    }
    this.log(`${sid ?? 'nosession'} ${name} ${short(args)} -> ${ans.status}`);
    this.noteUnblocks(ans);
    if (ans.job && typeof ans.job === 'string' && name === 'jobOpen') this.jobs.add(ans.job);
    const errs = checkAnswer(this, name, args, ans, sid ?? null);
    errs.push(...(await this.checkOwnership(name, args, ans, sid ?? null)));
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  /**
   * Job-home invariants on an action answer: no clear intend (or go) without confirmed identity, and at most one
   * action-owning session per job generation at a time: the acting session must hold the active run of the current generation.
   */
  private async checkOwnership(name: CallName, args: any, ans: Answer, sid: string | null): Promise<string[]> {
    const action = (name === 'intend' && ans.status === 'clear') || (name === 'say' && (ans.status === 'go' || ans.status === 'already_claimed'));
    if (!action) return [];
    const bad: string[] = [];
    const jobId: string = args.job;
    if (!sid) bad.push(`${name}: ${ans.status} for a call with no session id`);
    else if (this.dir.broken(sid)) bad.push(`${name}: ${ans.status} while the session lookup was failing (no clear without confirmed identity)`);
    else if (this.dir.mention.has(sid)) bad.push(`${name}: ${ans.status} for mention session ${sid}, which is not in the job home`);
    const job = await this.peek<any>('job', jobId);
    if (job && sid) {
      const run = job.current_run ? await this.peek<any>('run', `${jobId}:${job.current_run}`) : null;
      if (name === 'intend' && this.mode === 'hold' && (!run || run.session_id !== sid || run.generation !== job.generation)) {
        bad.push(`${name}: clear for ${sid}, which does not hold the current run of generation ${job.generation} of ${jobId}`);
      }
      if (run && run.generation !== job.generation) bad.push(`${jobId}: current run belongs to generation ${run.generation}, job is at ${job.generation}`);
      const m = this.acted.get(jobId) ?? new Map<string, number>();
      for (const [other, g] of m) if (other !== sid && g > job.generation) bad.push(`${jobId}: generation went backwards`);
      const mine = m.get(sid);
      if (mine !== undefined && mine < job.generation) bad.push(`${name}: fenced session ${sid} (generation ${mine}) got ${ans.status} on ${jobId} at generation ${job.generation}`);
      m.set(sid, job.generation);
      this.acted.set(jobId, m);
    }
    return bad;
  }

  async ingest(ev: IngestEvent, inst?: Engine): Promise<Answer> {
    let ans: Answer;
    try { ans = await (inst ?? this.nextEngine()).ingest(ev); } catch (e) { throw new Violation(`engine.ingest threw: ${(e as Error).stack}`); }
    this.log(`ingest ${short(ev)} -> ${ans.status}`);
    this.noteUnblocks(ans);
    const errs = checkAnswer(this, 'ingest', ev, ans, null);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  async sweep(inst?: Engine): Promise<Answer> {
    let ans: Answer;
    try { ans = await (inst ?? this.nextEngine()).sweep(); } catch (e) { throw new Violation(`engine.sweep threw: ${(e as Error).stack}`); }
    this.log(`sweep -> ${ans.say_to_tony}`);
    const errs = checkAnswer(this, 'sweep', {}, ans, null);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  async replaceHome(job: string, reason: string): Promise<Answer> {
    let ans: Answer;
    try { ans = await this.nextEngine().replaceHome(job, reason); } catch (e) { throw new Violation(`engine.replaceHome threw: ${(e as Error).stack}`); }
    this.log(`replaceHome ${job} -> ${ans.status}`);
    const errs = checkAnswer(this, 'replaceHome', { job }, ans, null);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  async wake(job: string, reason: string): Promise<Answer> {
    let ans: Answer;
    try { ans = await this.nextEngine().wake(job, reason); } catch (e) { throw new Violation(`engine.wake threw: ${(e as Error).stack}`); }
    this.log(`wake ${job} -> ${ans.status}`);
    const errs = checkAnswer(this, 'wake', { job }, ans, null);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  /** Tony really posts in Slack. Counts per job+thread+milestone; a second one is a violation. */
  post(job: string | null, thread: string, milestone: string | null, relay = false, round = 1): Post {
    const p: Post = { thread, ts: this.now(), link: `https://slack.test/${thread}/${++this.linkSeq}`, job, milestone, relay, round };
    this.posts.push(p);
    this.log(`SLACK own ${relay ? 'reply' : 'post'} ${milestone ?? 'stray'} in ${thread} (${job ?? 'no job'})`);
    this.clock.advance(1000); // later claims are strictly after this post
    if (milestone && job) {
      const k = `${job}|${thread}|${milestone}|${round}`;
      const n = (this.postCount.get(k) ?? 0) + 1;
      this.postCount.set(k, n);
      if (n > 1) throw new Violation(`double post: ${milestone} posted ${n} times in ${thread} for ${job}`);
    }
    return p;
  }
  /** What a thread read shows: a post (or a claimed reply) carrying this milestone, for this round of asking. */
  findPost(job: string, thread: string, milestone: string, round = 1): Post | undefined {
    return this.posts.find((p) => p.job === job && p.thread === thread && p.milestone === milestone && p.round === round);
  }
  hasPost(job: string, thread: string, milestone: string, round = 1): boolean {
    return !!this.findPost(job, thread, milestone, round);
  }
  ownPostEvent(p: Post, extra: Record<string, unknown> = {}): IngestEvent {
    return { source: 'slack', delivery_id: `own-${p.thread}-${p.ts}-${p.link.split('/').pop()}`, kind: 'message', thread: p.thread, sender_id: BOT, attrs: { link: p.link, ...extra } };
  }
  /** Unblocks the engine told us about and has not yet woken for: job -> time of the unblock. */
  pendingUnblock = new Map<string, number>();
  noteUnblocks(ans: Answer): void {
    for (const j of ((ans.woken as string[] | undefined) ?? [])) if (!this.pendingUnblock.has(j)) this.pendingUnblock.set(j, this.now());
  }
}

export function short(x: unknown): string {
  const s = JSON.stringify(x) ?? 'undefined';
  return s.length > 110 ? s.slice(0, 107) + '...' : s;
}
