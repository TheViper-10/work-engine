// A deterministic Tony that plays the desktop-release playbook correctly, with no model (D14 fallback and a harness self-check).
// It reads the engine briefing and the live sources on every pass, keeps no memory between sessions, and decides from
// what it reads, like the real Tony must. Each session is a generator: it yields a batch of tool calls and gets their
// parsed results back. One batch is one driver turn (one virtual minute).

import type { Block, TonyModel, TonyRequest, TonyResponse } from './model.ts';

type Call = { name: string; input: any };
type G<T> = AsyncGenerator<Call[], T, any[]>;

const QA_GATE = 'approve-desktop-qa-latest';
const PROD_GATE = 'approve-desktop-prod-alpha';
const ORDER = ['bump_pr_open', 'pr_approved', 'merged', 'qa_go_requested', 'qa_ready', 'signoff_requested', 'prod_alpha_approved', 'live'];
const PHRASE: Record<string, RegExp> = {
  bump_pr_open: /pull request for .* is open/i,
  pr_approved: /approval of the pull request is recorded/i,
  merged: /pull request is merged/i,
  qa_go_requested: /go to publish build/i,
  qa_ready: /is in QA now/i,
  signoff_requested: /sign off/i,
  prod_alpha_approved: /prod alpha approval is recorded/i,
  live: /is live on prod alpha/i,
};
const ASK_RE = /(?:go to publish|publishing) build (\w+)/i;
const ts = (m: any) => parseFloat(String(m?.ts ?? '0'));

const parse = (c: any): any => {
  if (typeof c !== 'string') return c;
  try { return JSON.parse(c); } catch { return { ok: false, raw: c }; }
};

class Play {
  private owner = 'U042GEDM4BB';
  private harry = 'U0C4YRX93PS';
  private tony = 'U0C4FFYJGE6';
  private issue = 'ISS-1';
  private labels: string[] = [];
  private privateLabels = new Set<string>();
  private jobId = '';
  private target = '';
  private reqThread = 'A';
  private qaThread = 'Q';
  private standin = false;
  private told = new Set<string>();
  private reserved = new Set<string>();
  private lastF: any = null;
  private retrySoon = false;
  used = 0; // tool calls spent so far this session (set by ScriptedTony)

  private canonOf: Record<string, string> = {};
  private labelOf: Record<string, string> = {};

  constructor(private sys: string, private trigger: string, private slips = false, private threadSlips: readonly string[] = []) {
    for (const m of sys.matchAll(/^- (\w+) = ([A-Z0-9]+:\d+\.\d+)/gm)) { this.canonOf[m[1]!] = m[2]!; this.labelOf[m[2]!] = m[1]!; }
    this.owner = /\(owner\): <@(\w+)>/.exec(sys)?.[1] ?? this.owner;
    this.harry = /Harry[^\n]*?: <@(\w+)>/.exec(sys)?.[1] ?? this.harry;
    this.tony = /Tony's own Slack id is (\w+)/.exec(sys)?.[1] ?? this.tony;
    this.issue = /release tracking issue is ([A-Z]+-\d+)/.exec(sys)?.[1] ?? this.issue;
    for (const m of sys.matchAll(/^- (\w+)(?::| =) (?:channel |[A-Z0-9]+:\d)[^\n]*$/gm)) {
      this.labels.push(m[1]!);
      if (/PRIVATE/.test(m[0])) this.privateLabels.add(m[1]!);
    }
    if (this.labels.includes('Q')) this.qaThread = 'Q';
  }

  // ------------------------------------------------------------ entry
  async *main(): G<string> {
    const fm = /\(external_ref: slack:([A-Z0-9]+:\d+\.\d+)\)/.exec(this.trigger);
    if (fm) {
      const dm = /conversation (\S+) from/.exec(this.trigger)?.[1] ?? '';
      const text = (/Request:\n@Tony ([\s\S]*?)(?:\n\nThread history|$)/.exec(this.trigger)?.[1] ?? '').trim();
      return yield* this.mentionSession(this.labelOf[fm[1]!] ?? fm[1]!, text, dm);
    }
    const mention = /^\[[^\]]+\] Slack message in thread (\w+) from/.exec(this.trigger);
    if (mention) return yield* this.mentionSession(mention[1]!, this.trigger.split(':\n\n').slice(1).join(':\n\n'));
    const w = /for job (desktop-release:\S+?)(?: \(home generation \d+\))?: /.exec(this.trigger);
    if (!w) return 'Nothing to do.';
    this.jobId = w[1]!;
    const [v] = yield [{ name: 'job_view', input: { job: this.jobId } }];
    const d = v?.jobs?.[0];
    if (!d) return 'No such job.';
    this.target = d.target;
    // R17 (M2): a read never binds a run. 'none' means nobody holds the job, so a woken session goes on and its first write binds it.
    if (d.work_run === 'other') return 'Another session is the work run; nothing for me to do.';
    return yield* this.pass(null, '');
  }

  private roleOf(label: string): string {
    return label === 'Q' ? 'qa' : label === 'A' || label === 'D' ? 'request' : 'side';
  }

  /** A mention session runs outside the job home (A1): it answers from job_view, links its thread, records promises. It never acts. */
  private async *mentionSession(label: string, text: string, dm = ''): G<string> {
    // Live run 1 slips, on purpose (scenario.scripted_slips): the DM id as the thread, and the placeholder target "next".
    const slip = this.slips && !!dm;
    const thread = slip ? dm : label;
    const [v0] = yield [{ name: 'job_view', input: { thread } }];
    // R62: the requester is named only from the engine's evidence (asked_by), never from the comment author.
    const askedBy: string | undefined = v0?.asked_by?.user;
    let queuedBehind = '';
    let view: any = v0?.jobs?.[0];
    const explicit = /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1];
    const after = /after this one|also do/i.test(text);
    if (v0?.status === 'no_job_here') {
      const open: string[] = v0.open_jobs ?? [];
      let target = explicit ?? '';
      let intent = 'join';
      if (!target && open.length) target = open[0]!.split(':')[1]!.split('#')[0]!;
      if (!target) {
        const [is] = yield [{ name: 'devrev_issue_read', input: { id: this.issue } }];
        target = /\d+\.\d+\.\d+/.exec(String(is?.title ?? ''))?.[0] ?? '0.0.0';
      }
      if (after && open.length) { intent = 'queue'; queuedBehind = open[0]!; }
      if (this.threadSlips.includes('fabricated_thread') && open.length) {
        // Live run 2: a timestamp made up to look like a thread. The engine must refuse it (bad_thread) and record nothing.
        yield [{ name: 'job_open', input: { workflow: 'desktop-release', target: open[0]!.split(':')[1]!.split('#')[0]!, thread: `${(this.canonOf[label] ?? '').split(':')[0] || 'C0C4K4EGZT6'}:1759651539.000000`, role: 'request', intent: 'join' } }];
      }
      let [o] = yield [{ name: 'job_open', input: { workflow: 'desktop-release', target: slip && !open.length ? 'next' : target, thread, role: this.roleOf(label), private: this.privateLabels.has(label) || undefined, intent } }];
      if (o?.status === 'bad_target') {
        // The engine refused the placeholder. Read the release issue for the exact version and open with it.
        const [is] = yield [{ name: 'devrev_issue_read', input: { id: this.issue } }];
        target = /\d+\.\d+\.\d+/.exec(String(is?.title ?? ''))?.[0] ?? '0.0.0';
        [o] = yield [{ name: 'job_open', input: { workflow: 'desktop-release', target, thread, role: this.roleOf(label), private: this.privateLabels.has(label) || undefined, intent } }];
      }
      this.target = o?.view?.target ?? target;
      // route: the request needs the job owner. Nothing was started; say so.
      if (o?.status === 'route') return 'The job owner has been told and will follow up here.';
      this.jobId = o?.job ?? '';
      view = o?.view;
    } else {
      if (!view) return 'I could not find that release.';
      this.jobId = view.job;
      this.target = view.target;
    }
    if (queuedBehind) return `${this.target} is queued behind ${queuedBehind.split(':')[1]}. I will start it once that release is live.`;
    const wantsPromise = /tell me when|let me know when|ping me when/i.test(text);
    if (wantsPromise && this.jobId) {
      const about = /\blive|alpha done|on alpha\b/i.test(text) && !/QA/i.test(text) ? 'live' : 'qa_ready';
      yield [{ name: 'promise_add', input: { job: this.jobId, thread: slip ? dm : this.threadSlips.includes('promise_request_thread') ? this.canonOf['A'] ?? label : label, about, fallback_time: '4h' } }];
    }
    if (/\bcancel/i.test(text) && view?.status !== 'cancelled') return 'Understood. The job owner has been told and will handle the cancel.';
    const reply = this.answer({ view: view ?? {} }, text, null);
    return askedBy ? `<@${askedBy}> ${reply}` : reply;
  }

  // ------------------------------------------------------------ reads
  private async *read(): G<any> {
    // Lazy reads: each later source is only read once the earlier one shows the release has got that far.
    const [v, prs] = yield [
      { name: 'job_view', input: { job: this.jobId } },
      { name: 'github_list_prs', input: { state: 'all' } },
    ];
    const view = v?.jobs?.[0] ?? {};
    for (const t of view.threads ?? []) {
      if (t.role === 'request' && this.reqThread === 'A' && !this.labels.includes('A')) this.reqThread = t.thread;
      if (t.role === 'qa') this.qaThread = t.thread;
    }
    const pr = (prs?.prs ?? []).find((p: any) => String(p.title).includes(this.target));
    let p: any = null;
    let us: any = null;
    let msgsA: any[] = [];
    let msgsQ: any[] = [];
    if (pr) {
      const more: Call[] = [{ name: 'slack_read_thread', input: { thread: this.reqThread } }];
      if (pr.merged) more.push({ name: 'circleci_read_pipeline', input: {} }, { name: 'update_server_read', input: {} });
      const got: any[] = yield more;
      msgsA = got[0]?.messages ?? [];
      if (pr.merged) {
        p = got[1]?.ok === false ? null : got[1];
        us = got[2];
        if (p && (p.commit === pr.merge_sha || p.commit === prs?.head_sha) && p.jobs?.[QA_GATE] === 'approved') {
          const [rq] = yield [{ name: 'slack_read_thread', input: { thread: this.qaThread } }];
          msgsQ = rq?.messages ?? [];
        }
      }
    }
    // The newest pipeline belongs to this release when it builds the merge commit or whatever the base head moved to since.
    const mine = !!pr?.merge_sha && !!p && (p.commit === pr.merge_sha || p.commit === prs?.head_sha);
    const F: any = {
      view, pr, pipe: mine ? p : null, mine, us, msgsA, msgsQ, prs,
      qaPost: msgsQ.some((m) => m.user === this.harry && /released in QA/i.test(m.text)),
      qaServed: us?.qa?.version === this.target,
      alphaServed: us?.alpha?.version === this.target,
      prodApproved: mine && p?.jobs?.[PROD_GATE] === 'approved',
      qaApproved: mine && p?.jobs?.[QA_GATE] === 'approved',
    };
    F.qaReady = F.qaServed && F.qaPost && F.qaApproved;
    return F;
  }

  private cp(status: string, waiting: string, wake: string, operations?: any[], reached?: string[]): Call {
    const input: any = { job: this.jobId, status, waiting_for: waiting, next_wake_in: wake };
    if (operations?.length) input.operations = operations;
    if (reached?.length) input.reached = reached;
    // Acknowledge the inbox items the last read showed (structured ids from job_view, never text).
    const seen: string[] = (this.lastF?.view?.inbox ?? []).map((i: any) => i.id).filter((x: unknown) => typeof x === 'string');
    if (seen.length) input.processed = seen;
    return { name: 'checkpoint', input };
  }

  private eventId(F: any, sender: string, thread: string): string | undefined {
    const evs: any[] = (F.view.events ?? []).filter((e: any) => !e.held && e.sender === sender && (e.thread === thread || e.thread === this.canonOf[thread]) && e.kind === 'message');
    return evs[evs.length - 1]?.id;
  }

  // ------------------------------------------------------------ one working pass
  private async *pass(replyThread: string | null, question: string): G<string> {
    let replyPart: string | null = null;
    let doneTries = 0;
    for (let iter = 0; iter < 16; iter++) {
      if (this.used >= 26) { yield [this.cp('in progress', 'the next step', '1m')]; break; }
      const F: any = yield* this.read();
      this.lastF = F;
      const st = F.view.status;
      if (st === 'done' || st === 'cancelled') break;
      // Structured first: an inbox item of kind cancel from the owner. The text match stays as a fallback for an undelivered event.
      const inboxCancel = (F.view.inbox ?? []).some((i: any) => !i.held && i.kind === 'cancel' && i.sender === this.owner);
      const ownerCancel = inboxCancel || F.msgsA.some((m: any) => m.user === this.owner && /\bcancel/i.test(m.text));
      if (ownerCancel || st === 'cancel_requested') { yield* this.cancel(F); break; }
      if (!F.pr) {
        // Another release of the same base branch that is not yet live on prod alpha goes first: wait behind it.
        const ahead = (F.prs?.prs ?? []).map((p: any) => /\d+\.\d+\.\d+/.exec(String(p.title))?.[0]).find((ver: string | undefined) => ver && ver !== this.target && F.us?.alpha?.version !== ver);
        if (ahead) { yield [this.cp(`queued behind ${ahead}`, `release ${ahead} to go live`, '30m')]; break; }
      }
      if (F.pr && !(F.view.threads ?? []).some((t: any) => t.thread === this.qaThread) && this.labels.includes(this.qaThread)) {
        yield [{ name: 'job_open', input: { workflow: 'desktop-release', target: this.target, thread: this.qaThread, role: 'qa', intent: 'join' } }];
      }
      const rec = yield* this.reconcile(F);
      if (rec) continue;
      const dr = yield* this.deliver(replyThread);
      if (dr.reply) replyPart = dr.reply;
      if (dr.progressed) continue;
      const step: string = yield* this.advance(F, doneTries);
      if (step === 'done') doneTries++;
      if (step === 'wait' || doneTries > 3) break;
    }
    return this.answer(this.lastF, question, replyPart);
  }

  // ------------------------------------------------------------ record outcomes read from the sources
  private async *reconcile(F: any): G<boolean> {
    const ops: any[] = (F.view.operations ?? []).filter((o: any) => o.outcome === 'in_flight' || o.outcome === 'unknown');
    const out: any[] = [];
    for (const o of ops) {
      let ok: boolean | null = null;
      if (o.action === 'open_bump_pr') ok = !!F.pr;
      else if (o.action === 'merge_pr') ok = !!F.pr?.merged;
      else if (o.action === 'approve_qa_gate') ok = F.qaApproved;
      else if (o.action === 'publish_prod_alpha') ok = F.prodApproved;
      else if (o.action === 'verify_qa') ok = F.qaReady || null;
      else if (o.action === 'verify_served') ok = F.alphaServed || null;
      if (ok) out.push({ ref: o.ref, action: o.action, outcome: 'done', note: 'read the source: it happened' });
    }
    if (!out.length) return false;
    const reached = out.some((x) => x.action === 'publish_prod_alpha') ? ['prod_alpha_approved'] : out.some((x) => x.action === 'verify_served') ? ['live'] : undefined;
    yield [this.cp('recorded outcomes', 'the next step', '5m', out, reached)];
    return true;
  }

  // ------------------------------------------------------------ cancel
  private async *cancel(F: any): G<void> {
    const ops: any[] = (F.view.operations ?? []).filter((o: any) => o.outcome === 'in_flight' || o.outcome === 'unknown');
    const resolved = ops.map((o) => {
      let done = false;
      if (o.action === 'publish_prod_alpha') done = F.prodApproved;
      else if (o.action === 'approve_qa_gate') done = F.qaApproved;
      else if (o.action === 'merge_pr') done = !!F.pr?.merged;
      else if (o.action === 'verify_served') done = F.alphaServed;
      else if (o.action === 'verify_qa') done = F.qaReady;
      return { ref: o.ref, action: o.action, outcome: done ? 'done' : 'failed', note: done ? 'read the source: it happened' : 'read the source: it did not happen' };
    });
    yield [this.cp('cancelled', '', '30m', resolved)];
  }

  // ------------------------------------------------------------ deliveries
  private text(m: string, F: any): string {
    const v = this.target;
    const pr = F?.pr?.number;
    switch (m) {
      case 'bump_pr_open': return `The version bump pull request for ${v} is open as #${pr} and waits for your review.`;
      case 'pr_approved': return 'Your approval of the pull request is recorded. I am merging it next.';
      case 'merged': return 'The pull request is merged and the build pipeline has started.';
      case 'qa_go_requested': return this.askText(F, false);
      case 'qa_ready': return `${v} is in QA now. The test sign-off is next.`;
      case 'signoff_requested': return `<@${this.harry}> ${v} is in QA. Could you sign off so I can go on to prod alpha?`;
      case 'prod_alpha_approved': return `The sign-off is in${this.standin ? ` (given by <@${this.owner}> as stand-in)` : ''} and the prod alpha approval is recorded. The release is publishing.`;
      case 'live': return `${v} is live on prod alpha.`;
      default: return `Update on ${v}.`;
    }
  }

  private askText(F: any, selfGo: boolean): string {
    const B = F?.pipe?.commit ?? '';
    const pw = Object.entries<any>(F?.pipe?.playwright ?? {}).map(([s, r]) => (r.job_state === 'success' ? `${s} passed` : `${s} failed (${String(r.failures?.[0]?.name ?? 'see the run').slice(0, 70)})`));
    const flake = (F?.pipe?.earlier_pipelines_with_same_failures ?? []).length ? ' The same failure is on earlier runs, so it looks like a flake.' : '';
    const tail = selfGo ? `I have your go, so I am publishing build ${B} to QA now.` : `Can I have your go to publish build ${B} to QA?`;
    return `Playwright finished on build ${B}: ${pw.join('; ') || 'no results yet'}.${flake} ${tail}`;
  }

  private async *tell(m: string, thread: string, viaReply: boolean, F: any, textOverride?: string): G<{ sent: boolean; reply?: string }> {
    const [s] = yield [{ name: 'say', input: { job: this.jobId, thread, milestone: m } }];
    const body = textOverride ?? this.text(m, F);
    if (s?.status === 'go') {
      this.told.add(`${m}|${thread}`);
      if (viaReply) return { sent: true, reply: body };
      if (this.threadSlips.includes('top_level_progress')) yield [{ name: 'slack_post', input: { text: body } }]; // negative control: the run 2 double post
      // The post target comes from the engine's answer: the exact channel and thread_ts to reply in.
      const to = s?.post_to;
      const [p] = yield [{ name: 'slack_post', input: to?.channel && to?.thread_ts ? { channel: to.channel, thread_ts: to.thread_ts, text: body } : { thread, text: body } }];
      if (p?.ok === false) { this.retrySoon = true; return { sent: false }; }
      return { sent: true };
    }
    if (s?.status === 'already_claimed') {
      const [r] = yield [{ name: 'slack_read_thread', input: { thread } }];
      const there = (r?.messages ?? []).some((x: any) => x.user === this.tony && PHRASE[m]?.test(x.text));
      this.told.add(`${m}|${thread}`);
      if (there) return { sent: false };
      if (viaReply) return { sent: true, reply: body };
      const [p] = yield [{ name: 'slack_post', input: { thread, text: body } }];
      if (p?.ok === false) { this.retrySoon = true; return { sent: false }; }
      return { sent: true };
    }
    if (s?.status === 'already_sent' && m === 'qa_go_requested' && textOverride && !viaReply) {
      // A new build needs a new ask. Until a repeated say opens one (R17), post it unclaimed rather than leave the owner waiting.
      const [p] = yield [{ name: 'slack_post', input: { thread, text: body } }];
      return { sent: p?.ok !== false };
    }
    // busy (another claim open, or another session is posting) and already_sent: post nothing, try again later.
    return { sent: false };
  }

  private async *deliver(replyThread: string | null): G<{ reply: string | null; progressed: boolean }> {
    let reply: string | null = null;
    let progressed = false;
    const F = this.lastF;
    for (let round = 0; round < 10; round++) {
      let d: any = round === 0 ? F?.view : null;
      if (!d) {
        const [v] = yield [{ name: 'job_view', input: { job: this.jobId } }];
        d = v?.jobs?.[0];
      }
      if (!d) break;
      const all: { m: string; t: string }[] = [...(d.owed ?? []), ...(d.claims ?? [])].map((o: any) => ({ m: o.milestone, t: o.thread }));
      const pend = all.filter((x) => !this.told.has(`${x.m}|${x.t}`) && !this.reserved.has(x.t)).sort((a, b) => ORDER.indexOf(a.m) - ORDER.indexOf(b.m));
      if (!pend.length) break;
      const first = new Map<string, string>();
      for (const x of pend) if (!first.has(x.t)) first.set(x.t, x.m);
      let any = false;
      for (const [t, m] of first) {
        const forThread = all.filter((x) => x.t === t && !this.told.has(`${x.m}|${x.t}`));
        const viaReply = t === replyThread && forThread.length === 1;
        const r = yield* this.tell(m, t, viaReply, F);
        if (viaReply && r.reply) { reply = r.reply; this.reserved.add(t); }
        if (r.sent) { any = true; progressed = true; }
      }
      if (!any) break;
    }
    return { reply, progressed };
  }

  // ------------------------------------------------------------ the release
  private async *advance(F: any, doneTries: number): G<string> {
    const v = F.view;
    const ms = v.milestones ?? {};
    const ops: any[] = v.operations ?? [];
    const op = (a: string) => ops.find((o) => o.action === a);
    const pr = F.pr;
    const pipe = F.pipe;
    const wait = async function* (self: Play, status: string, waiting: string, wake = '5m'): G<string> {
      yield [self.cp(status, waiting, self.retrySoon ? '5m' : wake)];
      return 'wait';
    };

    // reached milestones seen in the live sources
    const want: string[] = [];
    if (pr && !ms.bump_pr_open) want.push('bump_pr_open');
    if (pr?.approved_by?.length && !ms.pr_approved) want.push('pr_approved');
    if (pr?.merged && !ms.merged) want.push('merged');
    if (F.qaReady && !ms.qa_ready) want.push('qa_ready');
    if (F.prodApproved && !ms.prod_alpha_approved) want.push('prod_alpha_approved');
    if (want.length) {
      yield [this.cp('in progress', 'next step', '5m', undefined, want)];
      return 'again';
    }

    // 1. open the bump PR
    if (!pr) {
      const [i] = yield [{ name: 'intend', input: { job: this.jobId, action: 'open_bump_pr', ref: this.target } }];
      if (i?.status === 'hold') return yield* wait(this, 'hold on opening the PR', 'the engine hold to clear');
      const [r] = yield [{ name: 'github_open_pr', input: { title: `Bump desktop version to ${this.target}`, version: this.target, body: `Version bump for desktop release ${this.target} (${this.issue}).` } }];
      if (r?.ok === false) { yield [this.cp('could not open the PR', 'a retry', '5m', [{ ref: this.target, action: 'open_bump_pr', outcome: 'failed', note: String(r.error ?? '') }])]; return 'wait'; }
      yield [this.cp(`bump PR #${r.number} open`, 'owner review of the PR', '5m', [{ ref: this.target, action: 'open_bump_pr', outcome: 'done', note: `PR ${r.number} opened` }], ['bump_pr_open'])];
      return 'again';
    }
    // 2. owner review
    if (!pr.approved_by?.length) return yield* wait(this, `PR #${pr.number} open`, 'owner review of the PR', '20m');
    // 3. merge
    if (!pr.merged) {
      const [i] = yield [{ name: 'intend', input: { job: this.jobId, action: 'merge_pr', ref: String(pr.number) } }];
      if (i?.status === 'hold') return yield* wait(this, 'hold on the merge', 'the engine hold to clear');
      const [r] = yield [{ name: 'github_merge_pr', input: { number: pr.number } }];
      if (r?.ok === false) { yield [this.cp('merge failed', 'a retry', '5m', [{ ref: String(pr.number), action: 'merge_pr', outcome: 'failed', note: String(r.error ?? '') }])]; return 'wait'; }
      yield [this.cp(`PR #${pr.number} merged`, 'the build pipeline', '5m', [{ ref: String(pr.number), action: 'merge_pr', outcome: 'done', note: `merged as ${r.merge_sha}` }], ['merged'])];
      return 'again';
    }
    // 4. pipeline and Playwright
    if (!pipe) return yield* wait(this, 'waiting for the pipeline', 'the build pipeline');
    const pj = pipe.jobs ?? {};
    const pwJobs = Object.keys(pj).filter((k) => k.includes('pw-e2e'));
    if (pj['build-product-desktop-app'] !== 'success' || !pwJobs.every((k) => pj[k] === 'success' || pj[k] === 'failed')) {
      return yield* wait(this, 'pipeline running', 'the build and Playwright');
    }
    const B: string = pipe.commit;
    // 5. QA go
    if (pj[QA_GATE] === 'hold') {
      const asks = F.msgsA.map((m: any, idx: number) => ({ m, idx, b: ASK_RE.exec(String(m.text))?.[1] })).filter((x: any) => x.m.user === this.tony && x.b);
      const goMsgs = F.msgsA.map((m: any, idx: number) => ({ m, idx })).filter((x: any) => x.m.user === this.owner && /\bgo\b/i.test(x.m.text) && !/sentinel|alpha/i.test(x.m.text));
      const asksB = asks.filter((a: any) => a.b === B);
      let valid: boolean;
      if (asksB.length) valid = asksB.some((a: any) => /I have your go, so I am publishing/i.test(a.m.text)) || goMsgs.some((g: any) => g.idx > asksB[0].idx || !asks.some((a: any) => a.b !== B)); // a go before the ask counts unless an ask for another build exists (stale go)
      else if (asks.length) valid = false;
      else valid = goMsgs.length > 0 && B === pr.merge_sha;
      if (!asksB.length) {
        const r = yield* this.tell('qa_go_requested', this.reqThread, false, F, this.askText(F, valid));
        if (!r.sent) return yield* wait(this, 'could not post the QA ask yet', 'a retry', '5m');
        if (!valid) return yield* wait(this, `asked the owner for the QA go on build ${B}`, "the owner's go");
      } else if (!valid) {
        return yield* wait(this, `waiting for the QA go on build ${B}`, "the owner's go", '5m');
      }
      const because = this.eventId(F, this.owner, this.reqThread);
      const [i] = yield [{ name: 'intend', input: { job: this.jobId, action: 'approve_qa_gate', ref: pipe.id, because } }];
      if (i?.status === 'hold') return yield* wait(this, `hold on the QA approval (${String(i.holds?.[0] ?? '').slice(0, 60)})`, 'the engine hold to clear');
      let [a] = yield [{ name: 'circleci_approve_gate', input: { gate: QA_GATE, pipeline_id: pipe.id } }];
      if (a?.ok === false) [a] = yield [{ name: 'circleci_approve_gate', input: { gate: QA_GATE, pipeline_id: pipe.id } }];
      if (a?.ok === false) { yield [this.cp('QA approval failed', 'a retry', '5m', [{ ref: pipe.id, action: 'approve_qa_gate', outcome: 'failed', note: String(a.error ?? '') }])]; return 'wait'; }
      yield [this.cp('QA gate approved', 'the QA publish', '5m', [{ ref: pipe.id, action: 'approve_qa_gate', outcome: 'done', note: 'the hold reads approved' }])];
      return 'again';
    }
    if (pj[QA_GATE] !== 'approved') return yield* wait(this, 'waiting for the QA hold', 'the pipeline');
    // 6. QA publish
    if (!op('verify_qa')) {
      yield [{ name: 'intend', input: { job: this.jobId, action: 'verify_qa', ref: pipe.id } }];
    }
    if (!F.qaReady) return yield* wait(this, 'QA publish running', 'the QA build and the QA post');
    if (op('verify_qa')?.outcome !== 'done') {
      yield [this.cp('in QA', 'sign-off', '5m', [{ ref: pipe.id, action: 'verify_qa', outcome: 'done', note: 'update server QA serves the version' }])];
      return 'again';
    }
    // 7. sign-off
    if (!F.prodApproved) {
      if (!ms.signoff_requested) {
        const r = yield* this.tell('signoff_requested', this.qaThread, false, F);
        if (!r.sent) return yield* wait(this, 'could not ask Harry yet', 'a retry', '5m');
        return 'again';
      }
      // A sign-off counts when it came after the build was in QA, even if it arrived before the ask: a mention session can no
      // longer post the ask, so the home may post it after the person already answered. Order is message order (a ts may be synthetic).
      const qaIdx = F.msgsQ.findIndex((m: any) => m.user === this.harry && /released in QA/i.test(m.text));
      const askIdx = F.msgsQ.map((m: any, i: number) => (m.user === this.tony && PHRASE.signoff_requested.test(m.text) ? i : -1)).filter((i: number) => i >= 0).pop() ?? -1;
      const sinceIdx = qaIdx >= 0 ? qaIdx : askIdx;
      const askTs = ts(F.msgsQ[askIdx]);
      const harryMsg = F.msgsQ.filter((m: any, i: number) => m.user === this.harry && /sign(ing)? off|approved/i.test(m.text) && i > sinceIdx).pop();
      const ownerMsg = F.msgsA.filter((m: any) => m.user === this.owner && /go ahead|you have the go|is approved/i.test(m.text) && ts(m) > (askTs || 0)).pop();
      if (!harryMsg && !ownerMsg) return yield* wait(this, 'waiting for the test sign-off', "Harry's sign-off");
      this.standin = !harryMsg;
      const because = harryMsg ? this.eventId(F, this.harry, this.qaThread) : this.eventId(F, this.owner, this.reqThread);
      if (pj[PROD_GATE] !== 'hold') return yield* wait(this, 'prod alpha hold not ready', 'the pipeline');
      const [i] = yield [{ name: 'intend', input: { job: this.jobId, action: 'publish_prod_alpha', ref: pipe.id, because } }];
      if (i?.status === 'hold') return yield* wait(this, `hold on prod alpha (${String(i.holds?.[0] ?? '').slice(0, 60)})`, 'the engine hold to clear');
      const [a] = yield [{ name: 'circleci_approve_gate', input: { gate: PROD_GATE, pipeline_id: pipe.id } }];
      if (a?.ok === false) { yield [this.cp('prod alpha approval failed', 'a retry', '5m', [{ ref: pipe.id, action: 'publish_prod_alpha', outcome: 'failed', note: String(a.error ?? '') }])]; return 'wait'; }
      yield [this.cp('prod alpha approved', 'the publish', '5m', [{ ref: pipe.id, action: 'publish_prod_alpha', outcome: 'done', note: 'the hold reads approved' }], ['prod_alpha_approved'])];
      return 'again';
    }
    // 8. live
    if (!op('verify_served')) yield [{ name: 'intend', input: { job: this.jobId, action: 'verify_served', ref: this.target } }];
    if (!F.alphaServed) return yield* wait(this, 'prod alpha publishing', 'the update server');
    if (op('verify_served')?.outcome !== 'done' || !ms.live) {
      yield [this.cp('live on prod alpha', 'telling the threads', '5m', [{ ref: this.target, action: 'verify_served', outcome: 'done', note: 'update server prod alpha serves the version' }], ['live'])];
      return 'again';
    }
    // 9. close
    if ((v.owed ?? []).length || (v.claims ?? []).length) return yield* wait(this, 'closing', 'the last messages', '5m');
    const extra: any[] = [];
    if (!op('complete_release_issue')) {
      yield [{ name: 'intend', input: { job: this.jobId, action: 'complete_release_issue', ref: this.issue } }];
      const [c] = yield [{ name: 'devrev_issue_complete', input: { id: this.issue } }];
      extra.push({ ref: this.issue, action: 'complete_release_issue', outcome: c?.ok === false ? 'failed' : 'done', note: 'issue read back completed' });
    }
    yield [this.cp('done', '', '30m', extra, ['live'])];
    return doneTries >= 2 ? 'wait' : 'done';
  }

  // ------------------------------------------------------------ words
  private answer(F: any, question: string, told: string | null): string {
    const v = F?.view ?? {};
    const bits: string[] = [];
    if (told) bits.push(told);
    const status = v.status === 'done' ? `${this.target} is live on prod alpha.` : v.status === 'cancelled' ? `${this.target} is cancelled.` : `${this.target} is in progress: ${v.reported_status ?? 'starting'}.`;
    if (!told || question) bits.push(status);
    if (/\bpr\b|pull request/i.test(question) && F?.pr) bits.push(`The pull request is #${F.pr.number}: https://github.com/devrev/devrev-web/pull/${F.pr.number}`);
    if (/serving|channel/i.test(question) && F?.us) bits.push(`dev and QA serve ${F.us.qa?.version}, prod alpha serves ${F.us.alpha?.version}.`);
    if (/eta|when/i.test(question) && v.status !== 'done') bits.push('I will post here as each step finishes.');
    return bits.join(' ');
  }
}

/** One Play per session, keyed by the session's first message object (the driver keeps it for the whole session). */
const THREAD_TOOLS = new Set(['job_open', 'job_view', 'say', 'promise_add']);

export class ScriptedTony implements TonyModel {
  constructor(private slips = false, private threadSlips: readonly string[] = []) {}
  readonly name = 'scripted';
  readonly usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
  private plays = new WeakMap<object, { gen: G<string>; n: number; play: Play }>();

  async send(req: TonyRequest): Promise<TonyResponse> {
    this.usage.requests++;
    const key = req.messages[0]!;
    let s = this.plays.get(key);
    let step: IteratorResult<Call[], string>;
    if (!s) {
      const trigger = typeof key.content === 'string' ? key.content : '';
      const play = new Play(req.system, trigger, this.slips, this.threadSlips);
      s = { gen: play.main(), n: 0, play };
      this.plays.set(key, s);
      step = await s.gen.next();
    } else {
      const last = req.messages[req.messages.length - 1]!;
      const blocks = Array.isArray(last.content) ? (last.content as Block[]) : [];
      const results = blocks.filter((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result').map((b) => parse(b.content));
      step = await s.gen.next(results);
    }
    if (!step.done) s.play.used = s.n + (step.value as Call[]).length;
    if (step.done) return { stop_reason: 'end_turn', content: [{ type: 'text', text: step.value }] };
    const canon = (s.play as any).canonOf as Record<string, string>;
    // A faithful scenario names threads <channel>:<ts>; the scripted play thinks in labels, so this is its only translation.
    const content: Block[] = (step.value as Call[]).map((c) => ({ type: 'tool_use', id: `toolu_s${++s!.n}`, name: c.name, input: THREAD_TOOLS.has(c.name) && canon[c.input?.thread] ? { ...c.input, thread: canon[c.input.thread] } : c.input }));
    return { stop_reason: 'tool_use', content };
  }
}
