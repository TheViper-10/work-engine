// Invariants checked from outside the engine. engine.checkInvariants covers the inside;
// these add the simulator-level ones (what the sim really did in Slack, what answers may say).
import { CHECK_NAMES } from '../src/config.ts';
import type { Answer } from '../src/types.ts';
import type { World } from './world.ts';
import { MIN } from './world.ts';

export const THREADS = ['A', 'B', 'D', 'E', 'Q', 'C', 'Z'];
const OK_FALSE = new Set(['no_job', 'no_such_job', 'bad_input', 'unknown_workflow', 'job_ended', 'bad_event']);

/** Checks on one answer: no protocol refusal, holds only from the five checks, privacy. */
export function checkAnswer(w: World, call: string, args: any, ans: Answer): string[] {
  const bad: string[] = [];
  if (!ans || typeof ans !== 'object') return [`${call}: answer is not an object`];
  if (typeof ans.say_to_tony !== 'string' || ans.say_to_tony.length === 0) bad.push(`${call}: empty say_to_tony`);
  if ((ans as any).kind === 'refused' || /refus|denied|forbidden|rejected|not allowed/i.test(ans.status)) bad.push(`${call}: protocol refusal (${ans.status})`);
  if (!ans.ok && !OK_FALSE.has(ans.status) && !(ans.status === 'wake_failed' && w.wakerFail)) bad.push(`${call}: ok=false with unexpected status ${ans.status}`);
  if (ans.status === 'hold') {
    if (call !== 'intend') bad.push(`${call}: hold answer from a call that has no checks`);
    const holds = (ans.holds as string[] | undefined) ?? [];
    if (w.mode !== 'hold') bad.push(`intend: hold under flag config`);
    if (holds.length === 0) bad.push('intend: hold without a reason');
    for (const h of holds) if (!CHECK_NAMES.some((n) => h.startsWith(`${n}:`))) bad.push(`intend: hold "${h}" is not one of the five checks`);
    if (!/Next:/.test(ans.say_to_tony)) bad.push('intend: hold without a next move in words');
    const op = ans.operation as any;
    if (!op || op.outcome !== 'held' || op.lease_taken) bad.push('intend: hold left an operation in flight or took a lease');
  }
  if (call === 'intend' && ans.status === 'clear') {
    const op = ans.operation as any;
    if (!op || op.outcome !== 'in_flight') bad.push('intend: clear without an in-flight operation');
    if (w.mode === 'hold' && ((ans.holds as string[]) ?? []).length) bad.push('intend: clear with holds');
  }
  if (call === 'say' && ans.status === 'go' && w.mode === 'hold') { /* go is fine in both modes */ }
  // privacy: evidence from a private link must not appear in plain text in another thread's view
  if (call === 'jobView' || call === 'jobOpen') {
    const viewer: string | null = call === 'jobOpen' ? args.thread ?? null : args.job ? null : args.thread ?? null;
    const text = ans.say_to_tony + JSON.stringify(ans);
    for (const p of w.privateThreadsSeen) {
      if (viewer !== p && text.includes(`evid_${p}_`)) bad.push(`${call}: private evidence of ${p} leaked into view for ${viewer ?? 'job view'}`);
    }
  }
  return bad;
}

/** State checks run after every step. afterSweep adds the time-based ones. */
export async function checkState(w: World, afterSweep: boolean): Promise<string[]> {
  const bad: string[] = [];
  const ids = [...w.jobs];
  bad.push(...(await w.engine.checkInvariants(ids)));
  const now = w.now();
  const unknownMs = (w.spec.defaults?.operation_unknown_minutes ?? 30) * MIN;
  const jobs = (await Promise.all(ids.map((id) => w.peek<any>('job', id)))).filter(Boolean) as any[];
  const openPerTarget = new Map<string, string[]>();
  for (const job of jobs) {
    const terminal = job.status === 'done' || job.status === 'cancelled';
    const proms = (await Promise.all(job.promise_keys.map((k: string) => w.peek<any>('promise', k)))).filter(Boolean);
    const dels = (await Promise.all(job.delivery_keys.map((k: string) => w.peek<any>('delivery', k)))).filter(Boolean);
    const ops = (await Promise.all(job.op_keys.map((k: string) => w.peek<any>('operation', k)))).filter(Boolean);
    if (terminal) {
      for (const p of proms) if (p.state === 'open' || p.state === 'due') bad.push(`${job.id}: ${job.status} job still has ${p.state} promise ${p.key}`);
      if (Object.keys(job.claims).length) bad.push(`${job.id}: ${job.status} job still has claims ${JSON.stringify(job.claims)}`);
      if (job.next_wake_at !== null) bad.push(`${job.id}: ${job.status} job has next_wake_at`);
    } else if (job.status === 'open' || job.status === 'closing') {
      const l = openPerTarget.get(`${job.workflow}:${job.target}`) ?? [];
      l.push(job.id);
      openPerTarget.set(`${job.workflow}:${job.target}`, l);
    }
    for (const d of dels) {
      if (d.state === 'sent' && !w.hasPost(job.id, d.thread, d.milestone)) bad.push(`${job.id}: delivery ${d.key} is sent but the sim never posted it`);
    }
    if (afterSweep && !terminal) {
      for (const o of ops) if (o.outcome === 'in_flight' && o.intent_at + unknownMs <= now) bad.push(`${job.id}: operation ${o.key} in flight past the timeout after a sweep`);
      for (const p of proms) if (p.state === 'open' && p.fallback_at <= now) bad.push(`${job.id}: promise ${p.key} past its fallback still open after a sweep`);
      if (job.status !== 'queued' && !w.wakerFail) {
        if (job.next_wake_at === null) bad.push(`${job.id}: open job without next_wake_at`);
        else if (job.next_wake_at <= now) {
          const run = job.current_run ? await w.peek<any>('run', `${job.id}:${job.current_run}`) : null;
          const active = run && run.state === 'active' && now - run.last_activity_at < w.engine.config.runTimeoutMinutes * MIN;
          if (!active) bad.push(`${job.id}: wake overdue (${Math.round((now - job.next_wake_at) / MIN)} min) with no active run after a sweep`);
        }
      }
      if (job.status === 'queued') {
        const bl = (await Promise.all(job.blocked_by_jobs.map((k: string) => w.peek<any>('job', k)))).filter(Boolean);
        const others = jobs.filter((j) => j.id !== job.id && j.workflow === job.workflow && j.target === job.target && ['open', 'closing', 'cancel_requested'].includes(j.status));
        if (others.length === 0 && bl.length && bl.every((b: any) => b.status === 'done' || b.status === 'cancelled')) bad.push(`${job.id}: still queued although what it waited for has ended`);
      }
    }
  }
  for (const [t, list] of openPerTarget) if (list.length > 1) bad.push(`target ${t}: ${list.length} jobs open at once (${list.join(', ')})`);
  for (const th of THREADS) {
    const ti = await w.peek<any>('thread_index', th);
    if (ti?.claim) {
      const cj = await w.peek<any>('job', ti.claim.job);
      if (!cj || cj.status === 'done' || cj.status === 'cancelled') bad.push(`thread ${th}: open claim points at ended job ${ti.claim.job}`);
      const d = await w.peek<any>('delivery', `${ti.claim.job}:${th}:${ti.claim.milestone}`);
      if (!d || d.state !== 'claimed') bad.push(`thread ${th}: claim ${ti.claim.milestone} has no claimed delivery (${d?.state})`);
    }
  }
  for (const res of w.spec.resources ?? []) {
    const lease = await w.peek<any>('lease', res);
    if (!lease) continue;
    if (lease.holder_job) {
      const lops = (await Promise.all(lease.ops.map((k: string) => w.peek<any>('operation', k)))).filter(Boolean);
      const live = lops.filter((o: any) => o.job === lease.holder_job && o.lease_taken && (o.outcome === 'in_flight' || o.outcome === 'unknown'));
      if (live.length === 0) bad.push(`lease ${res}: held by ${lease.holder_job} without an in-flight operation`);
      const h = jobs.find((j) => j.id === lease.holder_job);
      if (h && (h.status === 'done' || h.status === 'cancelled')) bad.push(`lease ${res}: held by ended job ${h.id}`);
    } else if (lease.ops.length) bad.push(`lease ${res}: free but lists operations ${lease.ops.join(',')}`);
  }
  return bad;
}
