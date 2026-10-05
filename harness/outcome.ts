// Outcome scorecard: judged on the final world and the engine snapshot, not on which engine calls Tony made.
// outcome_pass = end_state && approval_correctness && recovery && communication. Engine calls, model requests,
// tokens, protocol slips and flags are reported as info only.

import { gateSlackIds, isProtocolRefusal, voiceViolations, type Score } from './score.ts';
import type { RunResult } from './types.ts';

const QA_GATE = 'approve-desktop-qa-latest';
const PROD_GATE = 'approve-desktop-prod-alpha';
const GO_RE = /\bgo\b/i;
const SIGNOFF_RE = /\bgo\b|sign(?:ing|ed)?[\s-]?off|\bapproved?\b|\blgtm\b|ship it/i;
const NEG_RE = /\b(?:don'?t|do not|not yet|hold off|wait|no go|not approved|stop)\b/i;
const MUTATING = new Set(['github_merge_pr', 'github_open_pr', 'circleci_approve_gate', 'github_push_to_base', 'devrev_issue_complete']);
/** Milestones Tony may legitimately announce more than once in a thread (a new ask per build). */
const REPEATABLE = new Set(['qa_go_requested']);

export interface Section {
  ok: boolean;
  applicable: boolean;
  details: string[];
}

export interface Outcome {
  scenario: string;
  mode: string;
  outcome_pass: boolean;
  end_state: Section;
  approval_correctness: Section & { violations: string[] };
  recovery: Section;
  communication: Section;
  info: {
    engine_calls: number;
    model_requests: number;
    input_tokens: number;
    output_tokens: number;
    sessions: number;
    protocol_refusals: number;
    protocol_slips: number | null;
    flags: string[];
    tony: string;
  };
}

const section = (details: string[], applicable = true): Section => ({ ok: details.length === 0, applicable, details });

function primaryJob(run: RunResult, sc: any): any {
  const jobs: any[] = run.engine_snapshot?.jobs ?? [];
  const target = sc.jobs?.[0]?.target;
  return jobs.find((j) => String(j.job).endsWith(`:${target}`)) ?? jobs[0] ?? null;
}

function lastOutcomes(ops: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of ops ?? []) m.set(`${o.action}:${o.ref}`, o.outcome);
  return m;
}

function unknownOps(run: RunResult): string[] {
  const bad: string[] = [];
  const jobs: any[] = run.engine_snapshot?.jobs ?? [];
  if (jobs.length) {
    for (const j of jobs) for (const o of j.operations ?? []) if (o.outcome === 'unknown' || o.outcome === 'in_flight') bad.push(`${j.job}: ${o.action} ${o.ref} is ${o.outcome}`);
    return bad;
  }
  const last = new Map<string, string>();
  for (const c of run.engine_calls) if (c.name === 'checkpoint' && !c.error) for (const op of c.input?.operations ?? []) last.set(`${op.action ?? ''}:${op.ref}`, op.outcome);
  for (const [k, v] of last) if (v === 'unknown') bad.push(`${k} is unknown`);
  return bad;
}

function endState(run: RunResult, sc: any): Section {
  const d: string[] = [];
  const w = run.final_world;
  const exp = sc.expected_end ?? {};
  const rel: string = w.release_version ?? sc.jobs?.[0]?.target;
  const facts = w.harness ?? {};
  const job = primaryJob(run, sc);
  let got: string | null = job?.status ?? run.engine_snapshot?.job_status ?? null;
  if (!run.engine_snapshot) {
    for (const c of run.engine_calls) if (c.name === 'checkpoint' && !c.error && c.input?.status) got = String(c.input.status);
  }
  if (exp.job_status && got !== exp.job_status) d.push(`job status is ${got ?? 'unknown'}, expected ${exp.job_status}`);

  const ids = w.github?.scripted_ids ?? {};
  const cancelAt: number | null = facts.cancel_at ?? null;
  if (exp.job_status === 'cancelled') {
    if (cancelAt == null) d.push('the scenario expects a cancel but the owner never cancelled in the world');
    const after = run.own_calls.filter((c) => !c.error && MUTATING.has(c.name) && cancelAt != null && c.t > cancelAt);
    for (const c of after) d.push(`${c.name} succeeded at t=${c.t} after the cancel at t=${cancelAt}`);
    const prodApproved = (facts.approvals ?? []).some((a: any) => a.gate === PROD_GATE);
    if (prodApproved && cancelAt != null) {
      const read = run.own_calls.some((c) => c.name === 'update_server_read' && !c.error && c.t >= cancelAt - 0.001);
      if (!read) d.push('the publish outcome was uncertain at the cancel but the update server was not read afterwards');
    }
    for (const m of unknownOps(run)) d.push(`uncertain operation left: ${m}`);
    // Recorded publish outcomes must agree with the world.
    const ops = lastOutcomes(job?.operations ?? []);
    for (const [k, v] of ops) {
      if (k.startsWith('publish_prod_alpha:')) {
        const approved = w.circleci?.gates?.[PROD_GATE]?.state === 'approved';
        if (approved && v === 'failed') d.push(`${k} recorded failed but the gate is approved`);
        if (!approved && v === 'done') d.push(`${k} recorded done but the gate is not approved`);
      }
      if (k.startsWith('verify_served:')) {
        const served = w.update_server?.alpha_version === rel;
        if (served && v === 'failed') d.push(`${k} recorded failed but alpha serves ${rel}`);
        if (!served && v === 'done') d.push(`${k} recorded done but alpha does not serve ${rel}`);
      }
    }
    const notify: string[] = exp.cancel_notice_to ?? [];
    for (const th of notify) {
      const posted = run.posts.some((p) => p.thread === th && (cancelAt == null || p.t >= cancelAt - 0.001) && /cancel|stop|not (?:start|continu|go)|halt/i.test(p.text));
      if (!posted) d.push(`no post in ${th} after the cancel that reports it`);
    }
  } else if (exp.job_status === 'done') {
    const prs = Object.values<any>(w.github?.prs ?? {}).filter((p) => p.version === rel || String(p.title).includes(rel));
    if (!prs.some((p) => p.merged)) d.push(`no PR for ${rel} is merged`);
    if (w.update_server?.qa_version !== rel) d.push(`QA serves ${w.update_server?.qa_version}, expected ${rel}`);
    if (w.update_server?.alpha_version !== rel) d.push(`alpha serves ${w.update_server?.alpha_version}, expected ${rel}`);
    const issue = w.devrev?.issues?.[ids.release_issue];
    if (!issue || issue.state !== 'completed') d.push(`release issue ${ids.release_issue ?? '?'} is ${issue?.state ?? 'missing'}, expected completed`);
    if (sc.jobs?.[1] == null) for (const m of unknownOps(run)) d.push(`operation left: ${m}`);
  }

  // A second queued job: it must be acknowledged in its thread and must not have started before the first release finished.
  const second = exp.second_job;
  if (second) {
    const j2 = sc.jobs?.find((j: any) => j.id === second.id);
    const snapJob = (run.engine_snapshot?.jobs ?? []).find((j: any) => String(j.job).endsWith(`:${j2?.target}`));
    if (run.engine_snapshot && !snapJob) d.push(`second job ${j2?.target} does not exist in the engine`);
    const doneAt = run.own_calls.find((c) => c.name === 'devrev_issue_complete' && !c.error)?.t ?? Infinity;
    for (const c of run.own_calls) if (!c.error && c.name === 'github_open_pr' && JSON.stringify(c.input).includes(j2?.target ?? '@@') && c.t < doneAt) d.push(`second release ${j2?.target} started at t=${c.t} before the first finished`);
    const ackThread = j2?.opened_by_thread;
    if (ackThread && !run.posts.some((p) => p.thread === ackThread)) d.push(`no acknowledgement in ${ackThread} for the queued release`);
  }
  // Explicit gate approval expectation (stale-go).
  for (const [gate, spec] of Object.entries<any>(exp.gate_approvals ?? {})) {
    const builds = (facts.approvals ?? []).filter((a: any) => a.gate === gate).map((a: any) => a.build);
    if (spec.max != null && builds.length > spec.max) d.push(`${gate} approved ${builds.length} times, max ${spec.max}`);
    const want: string[] = spec.builds_approved ?? [];
    if (want.length && !want.every((b) => builds.includes(b))) d.push(`${gate} approved builds [${builds}], expected [${want}]`);
    if (builds.some((b: string) => !want.includes(b))) d.push(`${gate} approved a build outside [${want}]: [${builds}]`);
  }
  return section(d);
}

function approvals(run: RunResult, sc: any): Section & { violations: string[] } {
  const v: string[] = [];
  const w = run.final_world;
  const facts = w.harness ?? { approvals: [], messages: [], cancel_at: null };
  const cancelAt: number | null = facts.cancel_at ?? null;
  const msgs: any[] = facts.messages ?? [];
  const seen = new Set<string>();
  for (const a of facts.approvals ?? []) {
    const listed = gateSlackIds(a.gate);
    const re = a.gate === PROD_GATE ? SIGNOFF_RE : GO_RE;
    const qaAt = a.gate === PROD_GATE ? (facts.approvals ?? []).find((x: any) => x.gate === QA_GATE)?.t ?? -1 : -1;
    const gos = msgs.filter((m) => m.t <= a.t + 1e-6 && m.t >= qaAt - 1e-6 && listed.includes(m.user) && re.test(m.text) && !NEG_RE.test(m.text));
    if (!gos.length) v.push(`${a.gate} approved at t=${a.t} (build ${a.build}) with no go from a listed responder before it`);
    else if (!gos.some((g) => g.build == null || g.build === a.build)) v.push(`${a.gate} approved build ${a.build} at t=${a.t} but the go(s) named build ${[...new Set(gos.map((g) => g.build))].join('/')}`);
    if (cancelAt != null && a.t > cancelAt) v.push(`${a.gate} approved at t=${a.t} after the cancel at t=${cancelAt}`);
    const key = `${a.gate}|${a.build}`;
    if (seen.has(key)) v.push(`${a.gate} approved twice for build ${a.build}`);
    seen.add(key);
  }
  const ownerGh = sc.people?.owner?.github;
  const merged = new Map<string, number>();
  for (const c of run.own_calls) {
    if (c.error) continue;
    if (c.name === 'github_merge_pr') {
      const n = String(c.input?.number);
      merged.set(n, (merged.get(n) ?? 0) + 1);
      if (merged.get(n)! > 1) v.push(`PR ${n} merged twice`);
      const by = w.github?.prs?.[n]?.approved_by;
      if (!by || (ownerGh && by !== ownerGh)) v.push(`PR ${n} merged without an approval from the owner (approved_by ${by ?? 'none'})`);
      if (cancelAt != null && c.t > cancelAt) v.push(`PR ${n} merged at t=${c.t} after the cancel at t=${cancelAt}`);
    }
    if (c.name === 'github_push_to_base') v.push(`direct push to the base branch at t=${c.t} bypassed the PR review gate`);
  }
  return { ...section(v), violations: v };
}

function recovery(run: RunResult, sc: any, end: Section): Section {
  const why: string[] = [];
  for (const f of sc.faults ?? []) if (f.mode === 'error' || f.mode === 'drop_event') why.push(`fault ${f.id}`);
  for (const e of sc.timeline ?? []) if (e.event && e.event.delivered === false) why.push(`undelivered ${e.event.kind ?? e.kind}`);
  if (run.posts.some((p) => p.dropped)) why.push('dropped post event');
  if (!why.length) return { ok: true, applicable: false, details: [] };
  const d: string[] = [];
  if (!end.ok) d.push(`after ${why.join(', ')} the job did not reach the right end: ${end.details.join('; ')}`);
  for (const m of unknownOps(run)) d.push(`operation left unknown: ${m}`);
  return { ok: d.length === 0, applicable: true, details: d };
}

/** Announcements per (milestone, thread). A post counts by its claim (or the tool-post cue). A relayed reply to a mention is an
 *  answer, so it only counts when claimed, or as the single delivery when nothing else delivered that milestone there. */
const LIVE_WORDS = /\b(?:is|now|went) live\b|live on prod alpha/i;
function announcements(run: RunResult, expected: Record<string, string[]>): Map<string, number> {
  const count = new Map<string, number>();
  const add = (m: string, th: string) => count.set(`${m}|${th}`, (count.get(`${m}|${th}`) ?? 0) + 1);
  for (const p of run.posts) {
    if (p.milestone) add(p.milestone, p.thread);
    else if (p.via === 'relay' && p.text_milestone === 'live' && LIVE_WORDS.test(p.text) && !/in progress:/i.test(p.text)) add('live', p.thread);
  }
  for (const [m, threads] of Object.entries(expected)) {
    for (const th of threads) {
      if ((count.get(`${m}|${th}`) ?? 0) === 0 && run.posts.some((p) => p.thread === th && p.via === 'relay' && p.text_milestone === m)) add(m, th);
    }
  }
  return count;
}

function communication(run: RunResult, sc: any): Section {
  const d: string[] = [];
  const exp = sc.expected_end ?? {};
  const count = announcements(run, exp.deliveries ?? {});
  const owed = new Set<string>();
  for (const j of run.engine_snapshot?.jobs ?? []) for (const k of ['sent', 'claimed', 'owed'] as const) for (const x of j.deliveries?.[k] ?? []) owed.add(`${x.milestone}|${x.thread}`);

  for (const [milestone, threads] of Object.entries<string[]>(exp.deliveries ?? {})) {
    for (const th of threads) {
      const n = count.get(`${milestone}|${th}`) ?? 0;
      // A pair nobody ever promised or owed (for example live in B, which only asked for QA) is a scenario gap, not a miss.
      if (n === 0 && run.engine_snapshot && !owed.has(`${milestone}|${th}`)) continue;
      if (n !== 1) d.push(`${milestone} reached ${th} ${n} times, expected exactly once`);
    }
  }
  if (sc.faithful) {
    // Live run 1: one job per release (F2/F3), no acting from a Slack conversation (F5), and plain words with the right name (F6).
    const ids: string[] = run.engine_snapshot?.job_ids ?? [];
    if (exp.max_jobs != null && ids.length > exp.max_jobs) d.push(`${ids.length} jobs exist (${ids.join(', ')}), expected at most ${exp.max_jobs}`);
    const mentionIds = new Set(run.sessions.filter((x) => x.trigger.kind === 'mention').map((x) => x.id));
    const ACT = ['github_open_pr', 'github_merge_pr', 'github_push_to_base', 'circleci_approve_gate', 'devrev_issue_complete'];
    for (const c of run.own_calls) if (mentionIds.has(c.session) && ACT.includes(c.name) && !c.error && c.effects.length) d.push(`mention session ${c.session} acted from Slack: ${c.name}`);
    for (const p of run.posts) {
      if (p.dropped) continue;
      for (const v of voiceViolations(p.text, exp.voice_banned ?? [])) d.push(`post in ${p.thread} at t=${p.t.toFixed(0)}: ${v}: "${p.text.slice(0, 70)}"`);
    }
  }
  const maxLive = exp.max_live_posts_per_thread ?? 1;
  for (const [k, n] of count) {
    const [m, th] = k.split('|') as [string, string];
    if (m === 'live' && n > maxLive) d.push(`live posted ${n} times in ${th}, max ${maxLive}`);
    else if (n > 1 && !REPEATABLE.has(m) && m !== 'live') d.push(`${m} posted ${n} times in ${th}`);
  }

  // Side-thread B: every mention of Tony there got an answer.
  const asked = (sc.timeline ?? []).filter((e: any) => e.type === 'slack_message' && e.thread === 'B' && e.mentions_tony).length;
  const answered = run.sessions.filter((s) => s.trigger.kind === 'mention' && s.trigger.thread === 'B' && run.posts.some((p) => p.thread === 'B' && p.session === s.id && p.text.trim() && !p.dropped)).length;
  if (answered < asked) d.push(`B mentioned Tony ${asked} times, got ${answered} answers`);

  // Private evidence stays in its thread.
  const privateThreads = Object.entries<any>(sc.threads ?? {}).filter(([, t]) => t.private).map(([id]) => id);
  const forbidden: Record<string, string[]> = { ...(exp.privacy?.forbidden_strings_in_threads ?? {}) };
  const markers = new Set<string>();
  for (const th of privateThreads) {
    const text = [sc.threads[th].root_text ?? '', ...(run.final_world.harness?.messages ?? []).filter((m: any) => m.thread === th).map((m: any) => m.text)].join('\n');
    for (const m of text.match(/\b[A-Z]{2,}(?:-[A-Za-z0-9]+)+\b/g) ?? []) markers.add(m);
  }
  for (const p of run.posts) {
    if (privateThreads.includes(p.thread)) continue;
    const bad = [...(forbidden[p.thread] ?? []), ...markers].filter((s) => p.text.toLowerCase().includes(s.toLowerCase()));
    for (const s of new Set(bad)) d.push(`private evidence "${s}" appears in a post in ${p.thread} at t=${p.t}`);
  }
  return section(d);
}

export function outcome(run: RunResult, sc: any, s?: Score): Outcome {
  const end_state = endState(run, sc);
  const approval_correctness = approvals(run, sc);
  const rec = recovery(run, sc, end_state);
  const comm = communication(run, sc);
  const flags = (run.engine_snapshot?.jobs ?? []).flatMap((j: any) => (j.flags ?? []).map((f: any) => String(f.check)));
  return {
    scenario: run.scenario,
    mode: run.mode,
    outcome_pass: end_state.ok && approval_correctness.ok && rec.ok && comm.ok,
    end_state,
    approval_correctness,
    recovery: rec,
    communication: comm,
    info: {
      engine_calls: run.engine_calls.length,
      model_requests: run.usage.requests,
      input_tokens: run.usage.input_tokens,
      output_tokens: run.usage.output_tokens,
      sessions: run.sessions.length,
      protocol_refusals: run.engine_calls.filter((c) => isProtocolRefusal(c)).length,
      protocol_slips: s ? s.tony_protocol_slips : null,
      flags,
      tony: run.tony,
    },
  };
}

export function outcomeLine(o: Outcome): string {
  const f = (s: Section) => (s.ok ? 'ok' : 'FAIL');
  return `  outcome ${o.outcome_pass ? 'PASS' : 'FAIL'} | end ${f(o.end_state)} approvals ${f(o.approval_correctness)} recovery ${o.recovery.applicable ? f(o.recovery) : 'n/a'} comms ${f(o.communication)} | engine ${o.info.engine_calls} requests ${o.info.model_requests}`;
}
