// Per-run scoring against expected_end, expected_checks and the D7 pass bars.

import type { EngineCall, Mode, OwnCall, RunResult } from './types.ts';

const REFUSAL_TEXT = /must call|out of order|invalid (state|order)/i;

export interface CheckHit {
  seq: number;
  t: number;
  action: string;
  ref: string;
  check: string;
  kind: 'hold' | 'flag';
  session: string;
}

export interface Score {
  scenario: string;
  mode: Mode;
  pass: boolean;
  bars: Record<string, boolean>;
  protocol_refusals: { seq: number; name: string; why: string }[];
  false_findings: CheckHit[];
  missed_findings: { action: string; check: string; why: string }[];
  holds_worked_past: { hold: CheckHit; tool_call: string; t: number }[];
  findings: CheckHit[];
  engine_calls: number;
  engine_calls_by_name: Record<string, number>;
  live_posts_per_thread: Record<string, number>;
  posts_per_thread: Record<string, number>;
  deliveries: { milestone: string; expected: string[]; got: Record<string, number>; ok: boolean }[];
  milestones: { expected: string[]; reached: string[]; missing: string[]; source: string };
  job_status: { expected: string | null; got: string | null; ok: boolean | null };
  checks: Record<string, boolean | null>;
  sessions: number;
  sessions_truncated: number;
  session_errors: string[];
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

function checkName(x: any): string | null {
  if (typeof x === 'string') return x;
  return x?.check ?? x?.name ?? x?.kind ?? null;
}

/** Pull hold and flag findings out of an intend answer. Tolerant of the engine's final field names. */
export function findingsOf(c: EngineCall): CheckHit[] {
  if (c.name !== 'intend' || !c.output || typeof c.output !== 'object') return [];
  const o = c.output;
  const base = { seq: c.seq, t: c.t, action: String(c.input?.action ?? ''), ref: String(c.input?.ref ?? ''), session: c.session };
  const hits: CheckHit[] = [];
  const isHold = o.status === 'hold' || o.kind === 'hold' || o.decision === 'hold';
  if (isHold) {
    const list = o.checks ?? o.holds ?? (o.check ? [o.check] : []);
    for (const x of list) hits.push({ ...base, check: checkName(x) ?? 'unknown', kind: 'hold' });
    if (!list.length) hits.push({ ...base, check: 'unknown', kind: 'hold' });
  }
  for (const x of o.flags ?? []) {
    const n = checkName(x);
    if (n && !['missing_session', 'unclaimed_post', 'not_work_run'].includes(n)) hits.push({ ...base, check: n, kind: 'flag' });
  }
  return hits;
}

export function isProtocolRefusal(c: EngineCall): string | null {
  const o = c.output;
  if (!o || typeof o !== 'object') return c.error ? `call failed: ${c.error}` : null;
  if (o.kind === 'refused') return 'kind refused';
  const say = typeof o.say_to_tony === 'string' ? o.say_to_tony : '';
  if (REFUSAL_TEXT.test(say)) return say.slice(0, 120);
  return null;
}

export function score(run: RunResult, sc: any): Score {
  const calls = run.engine_calls;
  const findings = calls.flatMap(findingsOf);

  const expChecks: any[] = sc.expected_checks ?? [];
  const engineChecks = expChecks.filter((x) => !x.custom);
  const firesKey = new Set(engineChecks.filter((x) => x.expected === 'fires').map((x) => `${x.at_action}|${x.check}`));
  const conditional = new Set(engineChecks.filter((x) => x.expected === 'fires' && x.condition).map((x) => `${x.at_action}|${x.check}`));

  const false_findings = findings.filter((f) => !firesKey.has(`${f.action}|${f.check}`));
  const seen = new Set(findings.map((f) => `${f.action}|${f.check}`));
  const missed_findings = [...firesKey]
    .filter((k) => !seen.has(k) && !conditional.has(k))
    .map((k) => {
      const [action, check] = k.split('|') as [string, string];
      return { action, check, why: engineChecks.find((x) => x.at_action === action && x.check === check)?.why ?? '' };
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

  const protocol_refusals = calls
    .map((c) => ({ seq: c.seq, name: c.name, why: isProtocolRefusal(c) }))
    .filter((x): x is { seq: number; name: string; why: string } => !!x.why);

  const by: Record<string, number> = {};
  for (const c of calls) by[c.name] = (by[c.name] ?? 0) + 1;

  const live_posts_per_thread: Record<string, number> = {};
  const posts_per_thread: Record<string, number> = {};
  const msPosts: Record<string, Record<string, number>> = {};
  for (const p of run.posts) {
    posts_per_thread[p.thread] = (posts_per_thread[p.thread] ?? 0) + 1;
    if (p.milestone === 'live') live_posts_per_thread[p.thread] = (live_posts_per_thread[p.thread] ?? 0) + 1;
    if (p.milestone) (msPosts[p.milestone] ??= {})[p.thread] = ((msPosts[p.milestone] ??= {})[p.thread] ?? 0) + 1;
  }

  const expEnd = sc.expected_end ?? {};
  const deliveries = Object.entries<string[]>(expEnd.deliveries ?? {}).map(([milestone, threads]) => {
    const got = msPosts[milestone] ?? {};
    const ok = threads.every((t) => got[t] === 1) && Object.keys(got).every((t) => threads.includes(t));
    return { milestone, expected: threads, got, ok };
  });

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
  const snap = run.engine_snapshot;
  let source = 'world+checkpoints';
  if (snap?.milestones) {
    for (const m of snap.milestones) reached.add(m);
    source = 'engine snapshot + world';
  }
  const expM: string[] = expEnd.milestones ?? [];
  const missing = expM.filter((m) => !reached.has(m));
  const gotStatus: string | null = snap?.job_status ?? lastStatus;
  const expStatus: string | null = expEnd.job_status ?? null;
  const statusOk = expStatus == null ? null : gotStatus == null ? null : gotStatus === expStatus;

  const checks: Record<string, boolean | null> = {
    max_live_posts_per_thread: Object.values(live_posts_per_thread).every((n) => n <= (expEnd.max_live_posts_per_thread ?? 1)),
    release_issue_completed: expEnd.job_status === 'done' ? Object.values<any>(w.devrev.issues).some((i) => i.state === 'completed' && i.parent) : null,
    no_unknown_operations: expEnd.no_unknown_operations ? noUnknownOps(calls) : null,
  };

  const session_errors = run.sessions.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`);
  const bars = {
    zero_protocol_refusals: protocol_refusals.length === 0,
    zero_false_findings: false_findings.length === 0,
    no_missed_findings: missed_findings.length === 0,
    zero_holds_worked_past: holds_worked_past.length === 0,
    end_milestones: missing.length === 0,
    end_job_status: statusOk !== false,
    deliveries_once: deliveries.every((d) => d.ok),
    live_once_per_thread: checks.max_live_posts_per_thread === true,
    no_session_errors: session_errors.length === 0,
  };
  return {
    scenario: run.scenario,
    mode: run.mode,
    pass: Object.values(bars).every(Boolean),
    bars,
    protocol_refusals,
    false_findings,
    missed_findings,
    holds_worked_past,
    findings,
    engine_calls: calls.length,
    engine_calls_by_name: by,
    live_posts_per_thread,
    posts_per_thread,
    deliveries,
    milestones: { expected: expM, reached: [...reached], missing, source },
    job_status: { expected: expStatus, got: gotStatus, ok: statusOk },
    checks,
    sessions: run.sessions.length,
    sessions_truncated: run.sessions.filter((s) => s.truncated).length,
    session_errors,
    timeline_reached: run.timeline.unfired.length === 0,
    usage: run.usage,
  };
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
    `refusals ${s.protocol_refusals.length} false ${s.false_findings.length} missed ${s.missed_findings.length} worked_past ${s.holds_worked_past.length} | ` +
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
