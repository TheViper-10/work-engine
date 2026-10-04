// EngineBinding over the real Engine (src/), with a MemoryStore and a ManualClock synced to the harness virtual clock.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManualClock } from '../src/clock.ts';
import { DEPLOY_CHECKS, defineConfig } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { FakeSessionDirectory } from '../src/session-directory.ts';
import { makeKey, MemoryStore } from '../src/store.ts';
import type { IngestEvent, Job, Spec } from '../src/types.ts';
import type { EngineBinding, EngineCtx, EngineEvent, Mode, ToolSchema, WakeMsg } from './types.ts';
import { EPOCH_MS, type World } from './world.ts';

const S = { type: 'string' };
const STR_OR_NUM = { type: ['string', 'number'] };

/** The six calls, mirroring the argument shapes of Engine.jobOpen, jobView, intend, say, promiseAdd, checkpoint. */
export const REAL_ENGINE_TOOLS: ToolSchema[] = [
  {
    name: 'job_open',
    description: 'Start a release job or join one. Workflow is desktop-release. Target is the version being released. Intent is join, replace or queue. Role is request, side or qa.',
    input_schema: {
      type: 'object',
      properties: {
        workflow: S, target: S, thread: S,
        role: { type: 'string', description: 'request, side or qa' },
        private: { type: 'boolean' },
        intent: { type: 'string', enum: ['join', 'replace', 'queue'] },
      },
      required: ['workflow', 'target', 'thread'],
    },
  },
  {
    name: 'job_view',
    description: 'Read-only briefing for a job or a thread. Give job or thread.',
    input_schema: { type: 'object', properties: { job: S, thread: S } },
  },
  {
    name: 'intend',
    description: 'Say what you are about to do, before you do it. Actions: open_bump_pr, merge_pr, approve_qa_gate, verify_qa, publish_prod_alpha, verify_served, complete_release_issue. because is the event id (or #n inbox id) of the human go. Only the session in the job home can act; others get route.',
    input_schema: {
      type: 'object',
      properties: { job: S, action: S, ref: S, because: S },
      required: ['job', 'action', 'ref'],
    },
  },
  {
    name: 'say',
    description: 'Claim a message before you post it yourself with slack_post.',
    input_schema: { type: 'object', properties: { job: S, thread: S, milestone: S }, required: ['job', 'thread', 'milestone'] },
  },
  {
    name: 'promise_add',
    description: 'Remember a "tell me when" for a milestone (about). fallback_time is an ISO time or a duration such as 4h.',
    input_schema: {
      type: 'object',
      properties: { job: S, thread: S, about: S, fallback_time: STR_OR_NUM },
      required: ['job', 'thread', 'about'],
    },
  },
  {
    name: 'checkpoint',
    description: 'Commit your state and set the next wake. operations: [{ref, action, outcome: done|failed|unknown, note}]. reached: milestone ids you saw happen. next_wake_in: for example 5m or 2h.',
    input_schema: {
      type: 'object',
      properties: {
        job: S, status: S, waiting_for: S, next_wake_in: STR_OR_NUM,
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref: S, action: S, outcome: { type: 'string', enum: ['done', 'failed', 'unknown'] }, note: S },
            required: ['ref', 'outcome'],
          },
        },
        reached: { type: 'array', items: S },
        processed: { type: 'array', items: S, description: 'Inbox items you handled: #n from job_view, event ids or inbox keys. Items in your last job_view are acknowledged anyway.' },
      },
      required: ['job', 'status'],
    },
  },
];

const METHOD: Record<string, 'jobOpen' | 'jobView' | 'intend' | 'say' | 'promiseAdd' | 'checkpoint'> = {
  job_open: 'jobOpen', job_view: 'jobView', intend: 'intend', say: 'say', promise_add: 'promiseAdd', checkpoint: 'checkpoint',
};

export class RealEngineBinding implements EngineBinding {
  readonly name = 'engine';
  private spec: Spec;
  private clock = new ManualClock(EPOCH_MS);
  private store = new MemoryStore();
  private engine!: Engine;
  private mode: Mode = 'flag';
  private world: World | null = null;
  private ownBot = 'U0C4FFYJGE6';
  private wakeCb: (w: WakeMsg) => void = () => {};
  private jobs: string[] = [];
  private seenDeliveries = new Set<string>();
  private directory = new FakeSessionDirectory();
  private registered = new Map<string, string>();

  constructor(root: string, private guidanceVersion?: string) {
    this.spec = JSON.parse(readFileSync(join(root, 'workflows/desktop-release/spec.json'), 'utf8')) as Spec;
    this.build();
  }

  private build(): void {
    this.store = new MemoryStore();
    this.clock = new ManualClock(EPOCH_MS);
    this.jobs = [];
    this.seenDeliveries = new Set();
    // A1: a real directory, not the homeForAllSessions default. The driver registers each session's DM when it starts.
    this.directory = new FakeSessionDirectory();
    for (const [sid, dm] of this.registered) this.directory.set(sid, dm);
    const checks = this.mode === 'deploy' ? { ...DEPLOY_CHECKS } : Object.fromEntries(['superseded_run', 'job_cancelled', 'lease_held', 'build_changed', 'sender_not_listed'].map((c) => [c, this.mode]));
    this.engine = new Engine({
      store: this.store,
      clock: this.clock,
      sourceReader: { currentBuild: async (_job, gate) => this.currentBuild(gate) },
      slackReader: {
        findOwnPostAfter: async (thread, ts) => {
          const p = this.world?.findOwnPostAfter(thread, ts);
          return p ? { link: `slack:${this.world!.channel}:${p.ts}` } : null;
        },
      },
      waker: {
        postWake: async (dm, text) => {
          // Home ids are dm:<job> for generation 1 and dm:<job>:g<n> after a replacement.
          this.wakeCb({ dm, text, job: dm.startsWith('dm:') ? dm.slice(3).replace(/:g\d+$/, '') : undefined });
        },
      },
      config: defineConfig({ env: 'replay', bot: 'tony', ownBotUserId: this.ownBot, checks }),
      specs: [this.spec],
      sessionDirectory: this.directory,
      guidanceVersion: this.guidanceVersion,
    });
  }

  registerSession(sessionId: string, dm: string): void {
    this.registered.set(sessionId, dm);
    this.directory.set(sessionId, dm);
  }

  async homeOf(job: string): Promise<string | undefined> {
    const j = await this.store.get<Job>(makeKey('replay', 'tony', 'job', job));
    return j?.dm_id;
  }

  /** Which build a gate's ask is about: the newest pipeline build for CircleCI gates, else the base head. */
  private currentBuild(gate: string): string | null {
    const d = this.world?.data;
    if (!d) return null;
    if (gate.startsWith('approve-')) {
      const ps = Object.values<any>(d.circleci.pipelines ?? {});
      return ps[ps.length - 1]?.build ?? d.github.base_head_sha ?? null;
    }
    return d.github.base_head_sha ?? null;
  }

  attach(world: World, scenario: any): void {
    this.world = world;
    this.ownBot = scenario.people?.tony?.slack ?? world.tonySlack ?? this.ownBot;
    this.build();
  }
  setMode(mode: Mode): void {
    this.mode = mode;
    this.build();
  }
  onWake(cb: (w: WakeMsg) => void): void {
    this.wakeCb = cb;
  }
  toolsForModel(): ToolSchema[] {
    return REAL_ENGINE_TOOLS;
  }

  private sync(ms: number): void {
    this.clock.set(Math.max(this.clock.now(), ms));
  }

  async ingest(e: EngineEvent): Promise<void> {
    if (e.at != null) this.sync(e.at);
    const attrs: Record<string, unknown> = { ...(e.attrs ?? {}) };
    if (attrs.via === 'relay') attrs.relay = true;
    // Connector-side ref translation: scenario events carry provider refs ("github:pr:57998", "circleci:pipeline:2edf1c28")
    // while Tony's intend refs are the bare PR number or pipeline id (playbook). Without this no event can match an operation.
    const ref = e.ref?.replace(/^github:pr:(\d+)(:review)?$/, '$1').replace(/^circleci:pipeline:/, '');
    // Make the engine's event id equal the ref Tony reads in the briefing (slack:<channel>:<ts>), so `because` can name it.
    let deliveryId = e.delivery_id;
    if (e.source === 'slack' && e.ref?.startsWith('slack:') && e.delivery_id.startsWith(`${e.ref}#`)) {
      const bare = e.ref.slice('slack:'.length);
      if (!this.seenDeliveries.has(bare)) deliveryId = bare;
    }
    this.seenDeliveries.add(deliveryId);
    const ev: IngestEvent = {
      source: e.source,
      delivery_id: deliveryId,
      kind: e.kind,
      thread: e.thread,
      sender_id: e.sender_id,
      sender_kind: e.sender_kind === 'own_bot' ? undefined : e.sender_kind,
      ref,
      attrs,
    };
    await this.engine.ingest(ev);
  }

  async sweep(nowMs: number): Promise<void> {
    this.sync(nowMs);
    await this.engine.sweep();
  }

  async timer(kind: string, nowMs: number, entry: any): Promise<void> {
    this.sync(nowMs);
    if (kind === 'wake_twin') for (const j of this.jobs) await this.engine.wake(j, entry?.wake_reason ?? 'twin wake');
  }

  async callTool(name: string, input: any, ctx: EngineCtx): Promise<any> {
    this.sync(ctx.now);
    const m = METHOD[name];
    if (!m) throw new Error(`unknown engine tool ${name}`);
    const out = await (this.engine[m] as (a: any, c: any) => Promise<any>).call(this.engine, input ?? {}, { session_id: ctx.session_id });
    if (name === 'job_open' && out?.job && !this.jobs.includes(out.job)) this.jobs.push(out.job);
    return out;
  }

  async snapshot(): Promise<any> {
    const jobs: any[] = [];
    for (const id of this.jobs) {
      const v: any = await this.engine.jobView({ job: id }, {});
      const d = v?.jobs?.[0];
      if (!d) continue;
      jobs.push({
        job: id,
        status: d.status,
        reported_status: d.reported_status,
        milestones: Object.keys(d.milestones ?? {}),
        milestone_sources: d.milestones,
        deliveries: { owed: d.owed, claimed: d.claims, sent: d.sent },
        flags: d.flags,
        operations: d.operations,
        promises: d.promises,
        generation: d.generation,
        home: d.home,
        inbox_unprocessed: d.inbox_unprocessed,
        cleanup_pending: d.cleanup_pending,
        guidance_version: d.guidance_version,
      });
    }
    const invariants = await this.engine.checkInvariants(this.jobs);
    const first = jobs[0];
    return {
      jobs,
      job_ids: [...this.jobs],
      job_status: first?.status ?? null,
      milestones: first?.milestones ?? [],
      invariants,
      mode: this.mode,
    };
  }
}
