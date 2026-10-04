// The simulated outside world around one engine: store, clock, fake readers, fake waker,
// a fake Slack with the posts Tony really made, and a traced call wrapper.
// This is simulator code, not engine code, so workflow names are fine here.
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.ts';
import { MemoryStore, makeKey } from '../src/store.ts';
import { ManualClock } from '../src/clock.ts';
import { defineConfig, CHECK_NAMES } from '../src/config.ts';
import type { Answer, IngestEvent, Spec } from '../src/types.ts';
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

  constructor(mode: 'flag' | 'hold', instances = 2) {
    this.mode = mode;
    const checks = Object.fromEntries(CHECK_NAMES.map((n) => [n, mode]));
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
        waker: {
          postWake: async (dm, text) => {
            if (this.wakerFail) throw new Error('slack down');
            const job = dm.replace(/^dm:/, '');
            this.wakes.push({ dm, text, at: this.clock.now(), job, handled: false });
            this.pendingUnblock.delete(job);
          },
        },
        config: defineConfig({ env: 'sim', bot: 'bot', ownBotUserId: BOT, checks }),
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
    const errs = checkAnswer(this, name, args, ans);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  async ingest(ev: IngestEvent, inst?: Engine): Promise<Answer> {
    let ans: Answer;
    try { ans = await (inst ?? this.nextEngine()).ingest(ev); } catch (e) { throw new Violation(`engine.ingest threw: ${(e as Error).stack}`); }
    this.log(`ingest ${short(ev)} -> ${ans.status}`);
    this.noteUnblocks(ans);
    const errs = checkAnswer(this, 'ingest', ev, ans);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  async sweep(inst?: Engine): Promise<Answer> {
    let ans: Answer;
    try { ans = await (inst ?? this.nextEngine()).sweep(); } catch (e) { throw new Violation(`engine.sweep threw: ${(e as Error).stack}`); }
    this.log(`sweep -> ${ans.say_to_tony}`);
    const errs = checkAnswer(this, 'sweep', {}, ans);
    if (errs.length) throw new Violation(errs.join('; '));
    return ans;
  }

  async wake(job: string, reason: string): Promise<Answer> {
    let ans: Answer;
    try { ans = await this.nextEngine().wake(job, reason); } catch (e) { throw new Violation(`engine.wake threw: ${(e as Error).stack}`); }
    this.log(`wake ${job} -> ${ans.status}`);
    const errs = checkAnswer(this, 'wake', { job }, ans);
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
