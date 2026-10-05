// Per-run scoring against expected_end, expected_checks and the D7 pass bars.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineCall, Mode, OwnCall, RunResult } from './types.ts';

const SPEC = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows/desktop-release/spec.json'), 'utf8'));
const RUN_TIMEOUT_MIN = 20; // engine runTimeoutMinutes default

export interface CheckHit {
  seq: number;
  t: number;
  action: string;
  ref: string;
  check: string;
  kind: 'hold' | 'flag';
  session: string;
  /** The engine's words for this finding (after "<check>: "). */
  detail?: string;
}

/** R16: a finding is false when its stated fact is wrong per the engine's records and the final world. */
export interface Judged extends CheckHit {
  /** true, false, or null when the fact cannot be checked from the records. */
  fact: boolean | null;
  why: string;
}

export interface Score {
  scenario: string;
  mode: Mode;
  pass: boolean;
  bars: Record<string, boolean>;
  protocol_refusals: { seq: number; name: string; why: string }[];
  false_findings: Judged[];
  unexpected_true_findings: Judged[];
  unexpected_true_holds: number;
  tony_protocol_slips: number;
  missed_findings: { action: string; check: string; why: string; prevented_by_tony?: boolean }[];
  holds_worked_past: { hold: CheckHit; tool_call: string; t: number }[];
  findings: CheckHit[];
  engine_calls: number;
  engine_calls_by_name: Record<string, number>;
  live_posts_per_thread: Record<string, number>;
  posts_per_thread: Record<string, number>;
  deliveries: { milestone: string; expected: string[]; got: Record<string, number>; pairs: any[]; scenario_gap: string[]; doubles: string[]; bad: string[]; ok: boolean }[];
  still_owed: string[];
  milestones: { expected: string[]; reached: string[]; missing: string[]; source: string };
  job_status: { expected: string | null; got: string | null; ok: boolean | null };
  checks: Record<string, boolean | null>;
  sessions: number;
  sessions_truncated: number;
  session_errors: string[];
  invariant_violations: string[];
  action_owner_violations: string[];
  session_flags: { check: string; call: string; detail: string }[];
  world_reached: string[];
  timeline_reached: boolean;
  usage: RunResult['usage'];
}

const ACTION_TOOLS: Record<string, (c: OwnCall, ref: string) => boolean> = {
  merge_pr: (c, ref) => c.name === 'github_merge_pr' && (!/\d/.test(ref) || ref.includes(String(c.input?.number))),
  open_bump_pr: (c) => c.name === 'github_open_pr',
  approve_qa_gate: (c) => c.name === 'circleci_approve_gate' && c.input?.gate === 'approve-desktop-qa-latest',
  publish_prod_alpha: (c) => c.name === 'circleci_approve_gate' && c.input?.gate === 'approve-desktop-prod-alpha',
  complete_release_issue: (c) => c.name === 'devrev_issue_complete',
};

const INTEND_CHECKS = new Set(['superseded_run', 'job_cancelled', 'lease_held', 'build_changed', 'no_go_for_build', 'sender_not_listed']);
/** Engine flags that are not intend checks: counted from the engine's final flag records, not from an intend answer. */
const SESSION_FLAGS = new Set(['missing_session', 'unclaimed_post', 'not_work_run']);

/** Engine findings come as strings "<check>: <detail>" in answer.holds and answer.flags. */
function detailOf(x: unknown): string {
  return typeof x === 'object' && x ? String((x as any).detail ?? '') : String(x).replace(/^\w+:\s*/, '');
}

function parseFinding(x: unknown): string {
  if (typeof x === 'object' && x) return String((x as any).check ?? 'unknown');
  const m = /^(\w+):/.exec(String(x));
  if (m && (INTEND_CHECKS.has(m[1]!) || SESSION_FLAGS.has(m[1]!))) return m[1]!;
  return /not in the workflow spec/.test(String(x)) ? 'action_not_in_spec' : 'unknown';
}

/** Pull hold and flag findings out of an intend answer (status hold|clear, holds[], flags[]). */
export function findingsOf(c: EngineCall): CheckHit[] {
  if (c.name !== 'intend' || !c.output || typeof c.output !== 'object') return [];
  const o = c.output;
  const base = { seq: c.seq, t: c.t, action: String(c.input?.action ?? ''), ref: String(c.input?.ref ?? ''), session: c.session };
  const hits: CheckHit[] = [];
  for (const x of Array.isArray(o.holds) ? o.holds : []) hits.push({ ...base, check: parseFinding(x), kind: 'hold', detail: detailOf(x) });
  if (o.status === 'hold' && !hits.length) hits.push({ ...base, check: 'unknown', kind: 'hold' });
  for (const x of Array.isArray(o.flags) ? o.flags : []) hits.push({ ...base, check: parseFinding(x), kind: 'flag', detail: detailOf(x) });
  return hits;
}

/** The engine never refuses for protocol reasons: ok:false (nothing recorded) or a thrown error counts. */
export function isProtocolRefusal(c: EngineCall): string | null {
  if (c.error) return `call failed: ${c.error}`;
  const o = c.output;
  if (!o || typeof o !== 'object') return null;
  if (o.ok === false) return `${o.status ?? 'ok:false'}: ${String(o.say_to_tony ?? '').slice(0, 100)}`;
  return null;
}

export function score(run: RunResult, sc: any): Score {
  const calls = run.engine_calls;
  const findings = calls.flatMap(findingsOf);

  const expChecks: any[] = sc.expected_checks ?? [];
  const engineChecks = expChecks.filter((x) => !x.custom);
  const firesKey = new Set(engineChecks.filter((x) => x.expected === 'fires').map((x) => `${x.at_action}|${x.check}`));
  const conditional = new Set(engineChecks.filter((x) => x.expected === 'fires' && x.condition).map((x) => `${x.at_action}|${x.check}`));

  const snap = run.engine_snapshot;
  // Session-level flags (missing_session, unclaimed_post, not_work_run) come from the engine's final flag records.
  const expectedAnywhere = new Set(engineChecks.filter((x) => x.expected === 'fires').map((x) => x.check));
  const snapFlags: any[] = (snap?.jobs ?? []).flatMap((j: any) => j.flags ?? []);
  const session_flags = snapFlags.filter((f) => SESSION_FLAGS.has(f.check));
  const judge = makeJudge(run);

  const false_findings: Judged[] = [];
  const unexpected_true_findings: Judged[] = [];
  const sort = (j: Judged) => (j.fact === false ? false_findings : unexpected_true_findings).push(j);
  for (const f of findings) if (!firesKey.has(`${f.action}|${f.check}`)) sort(judge(f));
  const slipFlags = session_flags.filter((f) => !expectedAnywhere.has(f.check));
  for (const f of slipFlags) sort(judge({ seq: 0, t: 0, action: String(f.call ?? ''), ref: '', check: String(f.check), kind: 'flag', session: '', detail: String(f.detail ?? '') }, true));
  const unexpected_true_holds = unexpected_true_findings.filter((f) => f.kind === 'hold').length;
  const TONY_SLIPS = new Set(['not_work_run', 'superseded_run', 'unclaimed_post']);
  const tony_protocol_slips = unexpected_true_findings.filter((f) => TONY_SLIPS.has(f.check)).length;

  const seen = new Set(findings.map((f) => `${f.action}|${f.check}`));
  const missed_findings = [...firesKey]
    .filter((k) => !seen.has(k) && !conditional.has(k))
    .map((k) => {
      const [action, check] = k.split('|') as [string, string];
      const why = engineChecks.find((x) => x.at_action === action && x.check === check)?.why ?? '';
      return { action, check, why, prevented_by_tony: !tonyActed(run, action, check) };
    });

  // Holds worked past: Tony did the matching own-tool action after a hold, with no later clear intend for the same action+ref.
  const holds_worked_past: Score['holds_worked_past'] = [];
  for (const h of findings.filter((f) => f.kind === 'hold')) {
    const match = ACTION_TOOLS[h.action];
    if (!match) continue;
    const laterClear = calls.find((c) => c.seq > h.seq && c.name === 'intend' && c.input?.action === h.action && String(c.input?.ref) === h.ref && c.output?.status !== 'hold');
    const limit = laterClear?.seq ?? Infinity;
    const done = run.own_calls.find((c) => c.seq > h.seq && c.seq < limit && match(c, h.ref));
    if (done) holds_worked_past.push({ hold: h, tool_call: done.name, t: done.t });
  }

  // A scenario that scripts the live run 1 slips (scripted_slips) expects the engine to refuse them; those two answers are not Tony's slips.
  const expectedRefusal = (c: EngineCall) => !!sc.scripted_slips && ['bad_target', 'bad_thread'].includes(String(c.output?.status));
  const protocol_refusals = calls
    .filter((c) => !expectedRefusal(c))
    .map((c) => ({ seq: c.seq, name: c.name, why: isProtocolRefusal(c) }))
    .filter((x): x is { seq: number; name: string; why: string } => !!x.why);

  const by: Record<string, number> = {};
  for (const c of calls) by[c.name] = (by[c.name] ?? 0) + 1;

  const live_posts_per_thread: Record<string, number> = {};
  const posts_per_thread: Record<string, number> = {};
  const msPosts: Record<string, Record<string, number>> = {};
  for (const p of run.posts) {
    posts_per_thread[p.thread] = (posts_per_thread[p.thread] ?? 0) + 1;
    const effMilestone = p.milestone; // claimed milestone (or the tool-post heuristic); relay replies to a mention are answers, not announcements
    if (effMilestone === 'live') live_posts_per_thread[p.thread] = (live_posts_per_thread[p.thread] ?? 0) + 1;
    if (p.milestone) (msPosts[p.milestone] ??= {})[p.thread] = ((msPosts[p.milestone] ??= {})[p.thread] ?? 0) + 1;
  }

  const expEnd = sc.expected_end ?? {};
  // Delivery. Double-post bar: the world's actual slack_post calls per thread per claimed milestone must be at most 1.
  // Expected pairs: each (milestone, thread) the engine owed (any delivery record) must be sent exactly once. A pair
  // in expected_end that the engine never owed is a scenario_gap (the scenario text never created the audience, e.g. no
  // "tell me when" promise), reported but not failed.
  const engineDel = new Map<string, string>();
  for (const j of snap?.jobs ?? []) {
    for (const d of j.deliveries?.sent ?? []) engineDel.set(`${d.milestone}|${d.thread}`, 'sent');
    for (const d of j.deliveries?.claimed ?? []) engineDel.set(`${d.milestone}|${d.thread}`, 'claimed');
    for (const d of j.deliveries?.owed ?? []) engineDel.set(`${d.milestone}|${d.thread}`, 'owed');
  }
  const deliveries = Object.entries<string[]>(expEnd.deliveries ?? {}).map(([milestone, threads]) => {
    const got = msPosts[milestone] ?? {};
    const doubles = Object.entries(got).filter(([, n]) => n > 1).map(([t]) => t);
    const pairs = threads.map((t) => ({ thread: t, engine: engineDel.get(`${milestone}|${t}`) ?? 'never_owed', posts: got[t] ?? 0 }));
    const scenario_gap = pairs.filter((p) => p.engine === 'never_owed' && p.posts === 0).map((p) => p.thread);
    const bad = pairs.filter((p) => (p.engine !== 'never_owed' && (p.engine !== 'sent' || p.posts !== 1)) || (p.engine === 'never_owed' && p.posts > 1)).map((p) => p.thread);
    return { milestone, expected: threads, got, pairs, scenario_gap, doubles, bad, ok: doubles.length === 0 && bad.length === 0 && (!snap || true) };
  });
  const still_owed = [...engineDel.entries()].filter(([, v]) => v !== 'sent').map(([k]) => k);

  // End state. Prefer the engine snapshot, fall back to world facts and Tony's checkpoint reports.
  const w = run.final_world;
  const rel = w.release_version;
  const reached = new Set<string>();
  const prs = Object.values<any>(w.github.prs ?? {});
  if (prs.length) reached.add('bump_pr_open');
  if (prs.some((p) => p.approved_by)) reached.add('pr_approved');
  if (prs.some((p) => p.merged)) reached.add('merged');
  if (w.update_server.qa_version === rel) reached.add('qa_ready');
  if (w.circleci.gates['approve-desktop-prod-alpha']?.state === 'approved') reached.add('prod_alpha_approved');
  if (w.update_server.alpha_version === rel) reached.add('live');
  let lastStatus: string | null = null;
  for (const c of calls) {
    if (c.name === 'checkpoint' && !c.error) {
      for (const m of c.input?.reached ?? []) if (['qa_go_requested', 'signoff_requested'].includes(m)) reached.add(m);
      if (c.input?.status) lastStatus = String(c.input.status);
    }
    if (c.name === 'say' && ['qa_go_requested', 'signoff_requested'].includes(c.input?.milestone)) reached.add(c.input.milestone);
  }
  let source = 'world+checkpoints';
  const world_reached = [...reached];
  if (snap?.milestones) {
    reached.clear();
    for (const m of snap.milestones) reached.add(m);
    source = 'engine snapshot';
  }
  const expM: string[] = expEnd.milestones ?? [];
  const missing = expM.filter((m) => !reached.has(m));
  const gotStatus: string | null = snap ? (snap.job_status ?? null) : lastStatus;
  const expStatus: string | null = expEnd.job_status ?? null;
  const statusOk = expStatus == null ? null : gotStatus == null ? null : gotStatus === expStatus;

  const checks: Record<string, boolean | null> = {
    max_live_posts_per_thread: Object.values(live_posts_per_thread).every((n) => n <= (expEnd.max_live_posts_per_thread ?? 1)),
    release_issue_completed: expEnd.job_status === 'done' ? Object.values<any>(w.devrev.issues).some((i) => i.state === 'completed' && i.parent) : null,
    no_unknown_operations: expEnd.no_unknown_operations ? noUnknownOps(calls) : null,
  };

  const invariant_violations: string[] = snap?.invariants ?? [];
  const session_errors = run.sessions.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`);
  const actionOwnerViolations = notHomeActions(calls);
  const bars = {
    zero_protocol_refusals: protocol_refusals.length === 0,
    zero_false_findings: false_findings.length === 0,
    no_missed_findings: missed_findings.every((m) => m.prevented_by_tony),
    zero_holds_worked_past: holds_worked_past.length === 0,
    end_milestones: missing.length === 0,
    end_job_status: statusOk !== false,
    deliveries_once: deliveries.every((d) => d.ok) && still_owed.length === 0,
    live_once_per_thread: checks.max_live_posts_per_thread === true,
    no_session_errors: session_errors.length === 0,
    engine_invariants: invariant_violations.length === 0,
    one_action_owner: actionOwnerViolations.length === 0,
    ...(expEnd.interruption_boundary ? { interruption_boundary: boundaryHolds(run, expEnd.interruption_boundary) } : {}),
  };
  return {
    scenario: run.scenario,
    mode: run.mode,
    pass: Object.values(bars).every(Boolean),
    bars,
    protocol_refusals,
    false_findings,
    unexpected_true_findings,
    unexpected_true_holds,
    tony_protocol_slips,
    missed_findings,
    holds_worked_past,
    findings,
    engine_calls: calls.length,
    engine_calls_by_name: by,
    live_posts_per_thread,
    posts_per_thread,
    deliveries,
    still_owed,
    milestones: { expected: expM, reached: [...reached], missing, source },
    job_status: { expected: expStatus, got: gotStatus, ok: statusOk },
    checks,
    sessions: run.sessions.length,
    sessions_truncated: run.sessions.filter((s) => s.truncated).length,
    session_errors,
    invariant_violations,
    action_owner_violations: actionOwnerViolations,
    session_flags: session_flags.map((f) => ({ check: f.check, call: f.call, detail: f.detail })),
    world_reached,
    timeline_reached: run.timeline.unfired.length === 0,
    usage: run.usage,
  };
}


/**
 * one_action_owner (A1): every intend that got clear or a say that got go, and every committed checkpoint, came from a
 * session whose DM was the job's home at that moment. A checkpoint counts as committed when it carried operation outcomes
 * or reached milestones and the engine did not say they were not applied (a non-home checkpoint is only a note, R30).
 */
export function notHomeActions(calls: EngineCall[]): string[] {
  const bad: string[] = [];
  for (const c of calls) {
    if (c.error || !c.output || typeof c.output !== 'object' || c.home === undefined) continue;
    const st = String(c.output.status ?? '');
    const acted =
      (c.name === 'intend' && st === 'clear') ||
      (c.name === 'say' && st === 'go') ||
      (c.name === 'checkpoint' && c.output.ok !== false && !['route', 'superseded', 'hold'].includes(st) &&
        ((c.input?.operations?.length ?? 0) > 0 || (c.input?.reached?.length ?? 0) > 0) && !/not in the job home/i.test(String(c.output.say_to_tony ?? '')));
    if (acted && c.dm !== c.home) bad.push(`#${c.seq} ${c.name}${c.input?.action ? ' ' + c.input.action : ''} answered ${st} for session ${c.session} in ${c.dm}, but the home was ${c.home}`);
  }
  return bad;
}

/** interruption-boundary: the asker was answered in its own thread by a mention session that only read, and the home was never replaced. */
function boundaryHolds(run: RunResult, b: { answered_in: string; mention_session_actions: number }): boolean {
  const mention = new Set(run.sessions.filter((x) => x.trigger.kind === 'mention').map((x) => x.id));
  // The designed property is "no non-home write applied" (A1, R30). A non-home checkpoint is recorded as a note and a non-home
  // intend or say is routed; those are the boundary working. Only a write the engine applied counts (R32).
  const applied = (c: EngineCall) => {
    const st = String(c.output?.status ?? '');
    if (c.error || !c.output || typeof c.output !== 'object') return false;
    if (c.name === 'intend') return st === 'clear';
    if (c.name === 'say') return st === 'go';
    if (c.name === 'checkpoint') return c.output.ok !== false && !['route', 'superseded', 'hold'].includes(st) && !/Recorded as a note|not in the job home|not applied/i.test(String(c.output.say_to_tony ?? ''));
    return false;
  };
  const actions = run.engine_calls.filter((c) => mention.has(c.session) && ['intend', 'checkpoint', 'say'].includes(c.name) && applied(c)).length;
  const answered = run.posts.some((p) => p.thread === b.answered_in && mention.has(p.session) && p.text.trim() && !p.dropped);
  const jobs: any[] = run.engine_snapshot?.jobs ?? [];
  const replaced = jobs.some((j) => (j.generation ?? 1) > 1);
  return actions <= b.mention_session_actions && answered && !replaced;
}

// ---- R16 helpers ----

const WRITES = new Set(['intend', 'say', 'checkpoint', 'job_open']);
const RESOURCE_OF: Record<string, string> = { merge_pr: 'main', publish_prod_alpha: 'alpha', verify_served: 'alpha' };

/** Did another session really act on the job shortly before `t` (the fact behind superseded_run and not_work_run)? */
function otherSessionActed(run: RunResult, session: string, t: number): boolean {
  const own = (c: { session: string; t: number; name: string }) => c.session !== session && c.t <= t && t - c.t <= RUN_TIMEOUT_MIN && c.t >= 0;
  if (run.engine_calls.some((c) => own(c) && WRITES.has(c.name))) return true;
  return run.own_calls.some((c) => own(c) && !c.error && c.effects.length > 0);
}

export function gateSlackIds(gate: string): string[] {
  const g = SPEC.gates?.[gate];
  if (!g) return [];
  return [...g.responders.primary, ...(g.responders.stand_ins ?? [])].map((p: string) => SPEC.people?.[p]?.slack).filter(Boolean);
}

function worldBuilds(run: RunResult): string[] {
  const w = run.final_world;
  const b = new Set<string>();
  for (const p of Object.values<any>(w.circleci?.pipelines ?? {})) if (p.build) b.add(p.build);
  if (w.github?.base_head_sha) b.add(w.github.base_head_sha);
  return [...b];
}

function makeJudge(run: RunResult) {
  const cancelAt: number | null = run.final_world.harness?.cancel_at ?? null;
  const checkpointCancelled = (t: number) => run.engine_calls.some((c) => c.name === 'checkpoint' && c.input?.status === 'cancelled' && c.t <= t);
  return (f: CheckHit, sessionLevel = false): Judged => {
    const d = f.detail ?? '';
    const out = (fact: boolean | null, why: string): Judged => ({ ...f, fact, why });
    switch (f.check) {
      case 'superseded_run':
      case 'not_work_run': {
        if (sessionLevel) {
          // the flag record has no session or time; true when two different sessions wrote to the job at all
          const writers = new Set(run.engine_calls.filter((c) => WRITES.has(c.name)).map((c) => c.session));
          return out(writers.size > 1, writers.size > 1 ? `${writers.size} sessions wrote to the job` : 'only one session ever wrote');
        }
        const yes = otherSessionActed(run, f.session, f.t);
        return out(yes, yes ? 'another session acted within the run timeout' : 'no other session acted recently');
      }
      case 'unclaimed_post': {
        const yes = run.posts.some((p) => p.via === 'tool' && !p.claimed);
        return out(yes, yes ? 'Tony posted with no open claim' : 'every tool post matched a claim');
      }
      case 'job_cancelled': {
        const yes = (cancelAt != null && cancelAt <= f.t + 0.001) || checkpointCancelled(f.t);
        return out(yes, yes ? 'the owner cancelled before this call' : 'no cancel had happened');
      }
      case 'build_changed': {
        const m = /about build (\S+), the source now shows (\S+)/.exec(d);
        if (!m) return out(null, 'could not read the builds from the finding');
        const yes = m[1] !== m[2] && worldBuilds(run).includes(m[2]!);
        return out(yes, yes ? `ask was for ${m[1]}, the world shows ${m[2]}` : `ask ${m[1]} vs ${m[2]} does not match the world`);
      }
      case 'sender_not_listed': {
        const m = /came from (\S+), who is not on the (\S+) responder list/.exec(d);
        if (!m) return out(null, 'held evidence: sender not stated');
        const listed = gateSlackIds(m[2]!).includes(m[1]!);
        return out(!listed, listed ? `${m[1]} is on the ${m[2]} list` : `${m[1]} is not on the ${m[2]} list`);
      }
      case 'lease_held': {
        const m = /(\w+) is leased by (\S+)/.exec(d);
        if (!m) return out(null, 'lease holder not stated');
        const earlier = run.engine_calls.some((c) => c.name === 'intend' && c.seq < f.seq && c.input?.job === m[2] && RESOURCE_OF[String(c.input?.action)] === m[1] && c.output?.status === 'clear');
        const released = run.engine_calls.some((c) => c.name === 'checkpoint' && c.seq < f.seq && c.input?.job === m[2] && (c.input?.operations ?? []).some((o: any) => o.outcome !== 'unknown'));
        return out(earlier && !released, earlier && !released ? `${m[2]} holds ${m[1]}` : `${m[2]} did not hold ${m[1]}`);
      }
      case 'action_not_in_spec':
        return out(!SPEC.actions?.[f.action], SPEC.actions?.[f.action] ? 'the action is in the spec' : 'the action is not in the spec');
      default:
        return out(f.kind === 'hold' && f.check === 'unknown' ? false : null, 'unrecognised finding');
    }
  };
}

/** Did Tony really take the guarded action in the world where the expected check should have fired? */
function tonyActed(run: RunResult, action: string, check: string): boolean {
  const match = ACTION_TOOLS[action];
  const tools = match ? run.own_calls.filter((c) => !c.error && match(c, '')) : [];
  const intends = run.engine_calls.filter((c) => c.name === 'intend' && c.input?.action === action && !c.error);
  const w = run.final_world;
  const cancelAt: number | null = w.harness?.cancel_at ?? null;
  switch (check) {
    case 'build_changed': {
      // approved on a build the owner's go did not name
      const gate = action === 'publish_prod_alpha' ? 'approval-prod' : 'approve-desktop-qa-latest';
      return (w.harness?.approvals ?? []).some((a: any) => (gate === 'approval-prod' ? a.gate === 'approve-desktop-prod-alpha' : a.gate === gate) && a.go_build !== a.build);
    }
    case 'job_cancelled':
      return cancelAt != null && (tools.some((c) => c.t > cancelAt) || intends.some((c) => c.t > cancelAt));
    case 'superseded_run':
      return new Set(tools.map((c) => c.session)).size > 1;
    default:
      return tools.length > 0 || intends.length > 0;
  }
}

function noUnknownOps(calls: EngineCall[]): boolean {
  const last = new Map<string, string>();
  for (const c of calls) {
    if (c.name !== 'checkpoint' || c.error) continue;
    for (const op of c.input?.operations ?? []) last.set(`${op.action ?? ''}:${op.ref}`, op.outcome);
  }
  return ![...last.values()].includes('unknown');
}

export function summaryLine(s: Score, run: RunResult): string {
  const failed = Object.entries(s.bars).filter(([, v]) => !v).map(([k]) => k);
  const tc = run.sessions.reduce((n, x) => n + x.tool_calls, 0);
  return (
    `${s.scenario} ${s.mode} ${s.pass ? 'PASS' : 'FAIL'} | sessions ${s.sessions} tools ${tc} engine ${s.engine_calls} | ` +
    `refusals ${s.protocol_refusals.length} false ${s.false_findings.length} unexp_true ${s.unexpected_true_findings.length}(holds ${s.unexpected_true_holds}) slips ${s.tony_protocol_slips} missed ${s.missed_findings.filter((m) => !m.prevented_by_tony).length} prevented ${s.missed_findings.filter((m) => m.prevented_by_tony).length} worked_past ${s.holds_worked_past.length} | ` +
    `milestones ${s.milestones.expected.length - s.milestones.missing.length}/${s.milestones.expected.length} | ` +
    `timeline ${run.timeline.fired}/${run.timeline.total} | ` +
    (failed.length ? `failed: ${failed.join(',')}` : 'all bars met')
  );
}

export function aggregate(scores: Score[]) {
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : 0);
  const groups: Record<string, Score[]> = {};
  for (const s of scores) (groups[`${s.scenario}|${s.mode}`] ??= []).push(s);
  const out: Record<string, any> = {};
  for (const [k, g] of Object.entries(groups)) {
    const calls = g.map((x) => x.engine_calls);
    let streak = 0;
    for (const x of g) streak = x.pass ? streak + 1 : 0;
    out[k] = { runs: g.length, passed: g.filter((x) => x.pass).length, trailing_pass_streak: streak, engine_calls_median: med(calls), engine_calls_max: Math.max(...calls) };
  }
  return out;
}
