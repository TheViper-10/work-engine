// Fake world: GitHub, CircleCI, Slack, update server and DevRev issues, driven by a scenario.
// Tony's own tools read and mutate it. The driver applies timeline changes to it.

import type { EngineEvent, OwnCall, OwnPost, ToolSchema } from './types.ts';

export const EPOCH_MS = Date.parse('2026-10-02T02:16:22Z'); // v2.18 A root; virtual minute 0

export type Json = any;

export interface ToolResult {
  output: Json;
  error: boolean;
  effects: string[];
  events: EngineEvent[];
}

export interface ToolCtx {
  session: string;
  t: number; // virtual minutes
}

const QA_GATE = 'approve-desktop-qa-latest';
const PROD_GATE = 'approve-desktop-prod-alpha';

export function getPath(obj: Json, path: string): Json {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setPath(obj: Json, path: string, value: Json): void {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]!] = value;
}

function looseEq(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export function sha(n: number): string {
  return 'm' + n.toString(16).padStart(7, '0');
}

export class World {
  data: Json;
  calls: OwnCall[] = [];
  posts: OwnPost[] = [];
  private claims: { thread: string; milestone: string; consumed: boolean }[] = [];
  private faultCounts = new Map<string, number>();
  private seq = 0;
  private tsSeq = 0;
  readonly release: string;
  readonly people: Record<string, Json>;
  readonly tonySlack: string;
  readonly channel: string;

  constructor(readonly sc: Json) {
    this.data = JSON.parse(JSON.stringify(sc.initial_world));
    this.data.github.prs ??= {};
    this.data.circleci.pipelines ??= {};
    this.data.circleci.gates ??= {};
    this.data.slack.threads = {};
    for (const id of Object.keys(sc.threads ?? {})) {
      this.data.slack.threads[id] = {
        messages: [],
        has_post_from_tony: false,
        tony_posts: 0,
        has_owner_go_for_build: null,
        tony_asked_qa_go: false,
        tony_asked_qa_go_for_build: null,
      };
    }
    const ids = this.data.github.scripted_ids ?? {};
    const rel = this.data.release_version ?? sc.jobs?.[0]?.target ?? '0.0.0';
    this.release = rel;
    this.data.devrev = {
      issues: {
        [ids.release_issue ?? 'ISS-1']: {
          id: ids.release_issue ?? 'ISS-1',
          title: `Desktop release ${rel}`,
          state: 'in_progress',
          parent: ids.parent_issue ?? null,
        },
        ...(ids.parent_issue
          ? { [ids.parent_issue]: { id: ids.parent_issue, title: 'Desktop releases', state: 'in_progress', parent: null } }
          : {}),
      },
    };
    this.people = sc.people ?? {};
    this.tonySlack = this.data.slack.tony_user ?? this.people.tony?.slack ?? 'U0C4FFYJGE6';
    this.channel = this.data.slack.channel ?? 'C0';
  }

  nextSeq(): number {
    return ++this.seq;
  }

  // ---- path access, used by the driver for `when` and `change` ----
  get(path: string): Json {
    return getPath(this.data, path);
  }
  applyChange(change: Record<string, Json> | null | undefined): string[] {
    const out: string[] = [];
    for (const [p, v] of Object.entries(change ?? {})) {
      setPath(this.data, p, v);
      out.push(`${p}=${JSON.stringify(v)}`);
    }
    return out;
  }
  matches(when: Record<string, Json> | null | undefined): boolean {
    return Object.entries(when ?? {}).every(([p, v]) => looseEq(this.get(p), v));
  }

  // ---- helpers ----
  private currentBuild(): string | null {
    const ps = Object.values<Json>(this.data.circleci.pipelines);
    const last = ps[ps.length - 1];
    return last?.build ?? this.data.github.base_head_sha ?? null;
  }
  private knownBuilds(): string[] {
    const s = new Set<string>();
    for (const p of Object.values<Json>(this.data.circleci.pipelines)) if (p.build) s.add(p.build);
    if (this.data.github.base_head_sha) s.add(this.data.github.base_head_sha);
    return [...s];
  }
  private newTs(tMin: number): string {
    this.tsSeq++;
    return `${Math.floor(EPOCH_MS / 1000 + tMin * 60)}.${String(this.tsSeq).padStart(6, '0')}`;
  }
  resolveThread(x: unknown): string | null {
    if (typeof x !== 'string') return null;
    const threads = this.sc.threads ?? {};
    if (threads[x]) return x;
    for (const [id, th] of Object.entries<Json>(threads)) if (th.root_ts && x.endsWith(th.root_ts)) return id;
    return null;
  }
  noteClaim(thread: string, milestone: string): void {
    if (this.claims.some((c) => !c.consumed && c.thread === thread && c.milestone === milestone)) return;
    this.claims.push({ thread, milestone, consumed: false });
  }
  openClaims(thread: string): string[] {
    return this.claims.filter((c) => c.thread === thread && !c.consumed).map((c) => c.milestone);
  }

  /** Append a Slack message by anyone (timeline messages, bot posts, Tony's posts). */
  addMessage(thread: string, m: { user: string; name?: string; text: string; ts?: string; bot?: boolean; tMin: number }): string {
    const th = this.data.slack.threads[thread];
    const ts = m.ts ?? this.newTs(m.tMin);
    th.messages.push({ ts, user: m.user, name: m.name, text: m.text, bot: !!m.bot });
    return ts;
  }

  /** A human message landed: derive the slack.* world paths scenarios use in `when`. */
  noteHumanMessage(thread: string, senderKey: string, text: string, tMin = 0): void {
    const th = this.data.slack.threads[thread];
    if (senderKey === 'owner' && /^\s*go\b|\bgo ahead\b|have the go|is approved/i.test(text)) {
      th.has_owner_go_for_build = this.currentBuild();
      this.lastGoBuild = this.currentBuild();
    }
    if (senderKey === 'owner' && /\bcancel/i.test(text)) this.facts().cancel_at ??= tMin;
  }
  private lastGoBuild: string | null = null;
  /** Scoring facts kept in the world data (harness only; Tony's tools never read this). */
  private facts(): Json {
    return (this.data.harness ??= { approvals: [], cancel_at: null });
  }

  private classifyPost(thread: string, text: string): string | null {
    const i = this.claims.findIndex((c) => c.thread === thread && !c.consumed);
    if (i >= 0) {
      this.claims[i]!.consumed = true;
      return this.claims[i]!.milestone;
    }
    return null;
  }
  private heuristicMilestone(text: string): string | null {
    if (this.data.update_server.alpha_version === this.release && /\blive\b|prod alpha/i.test(text)) return 'live';
    if (this.data.update_server.qa_version === this.release && /\bQA\b/.test(text)) return 'qa_ready';
    return null;
  }

  /** Tony (or the connector relaying his final answer) posts in a thread. */
  tonyPost(thread: string, text: string, via: 'tool' | 'relay', ctx: ToolCtx): { ts: string; event: EngineEvent | null } {
    const th = this.data.slack.threads[thread];
    const ts = this.addMessage(thread, { user: this.tonySlack, name: 'Tony', text, bot: true, tMin: ctx.t });
    th.has_post_from_tony = true;
    th.tony_posts++;
    // derived paths for scenario predicates
    for (const b of this.knownBuilds()) {
      if (b.length >= 3 && new RegExp(`\\b${b}\\b`).test(text)) th.tony_asked_qa_go_for_build = b;
    }
    const pw = Object.values<Json>(this.data.circleci.pipelines).some((p) =>
      Object.entries<Json>(p.jobs ?? {}).some(([k, j]) => k.includes('pw-e2e') && (j.state === 'failed' || j.state === 'success')),
    );
    if (pw && /\bgo\b|\bQA\b|approve/i.test(text)) th.tony_asked_qa_go = true;

    // The connector matches any own post (tool or relayed final answer) to the thread's open claim, as the engine does.
    const claimedMs = this.classifyPost(thread, text);
    const milestone = via === 'tool' ? (claimedMs ?? this.heuristicMilestone(text)) : claimedMs;
    const dropped = this.dropFault(thread, milestone);
    this.posts.push({ thread, ts, text, via, session: ctx.session, t: ctx.t, milestone, text_milestone: this.heuristicMilestone(text), claimed: claimedMs != null, dropped });
    const event: EngineEvent | null = dropped
      ? null
      : {
          source: 'slack',
          delivery_id: `slack:${ts}`,
          kind: 'message',
          thread,
          sender_id: this.tonySlack,
          sender_kind: 'own_bot',
          ref: `slack:${this.channel}:${ts}`,
          attrs: { mentions_tony: false, via },
          at: EPOCH_MS + ctx.t * 60000,
        };
    return { ts, event };
  }

  private dropFault(thread: string, milestone: string | null): boolean {
    for (const f of this.sc.faults ?? []) {
      if (f.mode !== 'drop_event' || f.target !== 'slack.connector') continue;
      if (f.threads && !f.threads.includes(thread)) continue;
      if (f.milestone && f.milestone !== milestone) continue;
      return true;
    }
    return false;
  }

  /** For the engine binding's SlackReader: first own post in the thread at or after the given virtual ms. */
  findOwnPostAfter(thread: string, afterMs: number): { ts: string; text: string } | null {
    const p = this.posts.find((x) => x.thread === thread && EPOCH_MS + x.t * 60000 >= afterMs);
    return p ? { ts: p.ts, text: p.text } : null;
  }

  // ---- faults ----
  private faultError(tool: string, input: Json): string | null {
    const alias: Record<string, string[]> = {
      github_read_pr: ['github.read_pr'],
      github_list_prs: ['github.list_prs'],
      github_merge_pr: ['github.merge', 'github.merge_pr'],
      github_open_pr: ['github.open_pr'],
      github_push_to_base: ['github.push_to_base'],
      circleci_read_pipeline: ['circleci.read_pipeline', 'circleci.read'],
      circleci_read_gate: ['circleci.read_gate', 'circleci.read'],
      circleci_approve_gate: ['circleci.approve', 'circleci.approve_gate'],
      slack_post: ['slack.post'],
      slack_read_thread: ['slack.read_thread', 'slack.read'],
      update_server_read: ['update_server.read'],
      devrev_issue_read: ['devrev.issue_read'],
      devrev_issue_complete: ['devrev.issue_complete'],
    };
    for (const f of this.sc.faults ?? []) {
      if (f.mode !== 'error') continue;
      if (f.target !== tool && !(alias[tool] ?? []).includes(f.target)) continue;
      if (f.gate && input?.gate !== f.gate) continue;
      if (f.thread && this.resolveThread(input?.thread) !== f.thread) continue;
      const n = (this.faultCounts.get(f.id) ?? 0) + 1;
      this.faultCounts.set(f.id, n);
      if (f.nth == null || f.nth === n) return f.message ?? 'injected failure';
    }
    return null;
  }

  // ---- tool schemas ----
  toolSchemas(): ToolSchema[] {
    const str = { type: 'string' };
    const tools: ToolSchema[] = [
      { name: 'github_read_pr', description: 'Read a pull request: state, merged, head and merge commit, approvals.', input_schema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] } },
      { name: 'github_list_prs', description: 'List pull requests on the release base branch, newest first.', input_schema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'merged', 'all'] } } } },
      { name: 'github_merge_pr', description: 'Merge a pull request into the base branch.', input_schema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] } },
      { name: 'github_open_pr', description: 'Open the version bump pull request into the release base branch.', input_schema: { type: 'object', properties: { title: str, body: str, version: str }, required: ['title'] } },
      { name: 'circleci_read_pipeline', description: 'Read a CircleCI pipeline (newest on the base branch if no id): commit, workflow status, every job state, Playwright results.', input_schema: { type: 'object', properties: { pipeline_id: str } } },
      { name: 'circleci_read_gate', description: 'Read a CircleCI approval hold by job name.', input_schema: { type: 'object', properties: { gate: str, pipeline_id: str }, required: ['gate'] } },
      { name: 'circleci_approve_gate', description: 'Approve a CircleCI approval hold by job name.', input_schema: { type: 'object', properties: { gate: str, pipeline_id: str }, required: ['gate'] } },
      { name: 'slack_post', description: 'Post a message in a Slack thread (reply in the thread).', input_schema: { type: 'object', properties: { thread: str, text: str }, required: ['thread', 'text'] } },
      { name: 'slack_read_thread', description: 'Read all messages in a Slack thread.', input_schema: { type: 'object', properties: { thread: str }, required: ['thread'] } },
      { name: 'update_server_read', description: 'Read what the update server serves per channel.', input_schema: { type: 'object', properties: { channel: str } } },
      { name: 'devrev_issue_read', description: 'Read a DevRev issue.', input_schema: { type: 'object', properties: { id: str }, required: ['id'] } },
      { name: 'devrev_issue_complete', description: 'Mark a DevRev issue completed.', input_schema: { type: 'object', properties: { id: str }, required: ['id'] } },
    ];
    if ((this.sc.faults ?? []).some((f: Json) => f.target === 'github.push_to_base' && f.mode === 'allowed')) {
      tools.push({ name: 'github_push_to_base', description: 'Push a commit straight to the base branch.', input_schema: { type: 'object', properties: { sha: str, message: str } } });
    }
    return tools;
  }
  get ownToolNames(): string[] {
    return this.toolSchemas().map((t) => t.name);
  }

  // ---- tool dispatch ----
  callTool(name: string, input: Json, ctx: ToolCtx): ToolResult {
    const effects: string[] = [];
    const events: EngineEvent[] = [];
    let output: Json;
    let error = false;
    const fail = (message: string, extra: Json = {}) => {
      error = true;
      return { ok: false, error: message, ...extra };
    };
    try {
      const injected = this.faultError(name, input ?? {});
      if (injected) {
        output = name === 'slack_post' ? fail('internal_error', { message: injected }) : fail(injected);
      } else {
        output = this.dispatch(name, input ?? {}, ctx, effects, events, fail);
      }
    } catch (e) {
      output = fail(`tool crashed: ${(e as Error).message}`);
    }
    this.calls.push({ seq: this.nextSeq(), t: ctx.t, session: ctx.session, name, input, output, error, effects });
    return { output, error, effects, events };
  }

  private dispatch(name: string, input: Json, ctx: ToolCtx, effects: string[], events: EngineEvent[], fail: (m: string, x?: Json) => Json): Json {
    const gh = this.data.github;
    const ids = gh.scripted_ids ?? {};
    const prView = (n: string) => {
      const p = gh.prs[n];
      return {
        number: Number(n),
        title: p.title,
        state: p.state,
        merged: !!p.merged,
        base: gh.base_branch,
        head_sha: p.head_sha,
        merge_sha: p.merged ? p.merge_sha : null,
        approved_by: p.approved_by ? [p.approved_by] : [],
        reviews: p.approved_by ? [{ user: p.approved_by, state: 'APPROVED' }] : [],
        url: `https://github.com/${gh.repo}/pull/${n}`,
      };
    };
    switch (name) {
      case 'github_read_pr': {
        const n = String(input.number);
        return gh.prs[n] ? prView(n) : fail('Not Found');
      }
      case 'github_list_prs': {
        const want = input.state ?? 'all';
        const list = Object.keys(gh.prs)
          .sort((a, b) => Number(b) - Number(a))
          .map(prView)
          .filter((p) => want === 'all' || (want === 'merged' ? p.merged : p.state === want));
        return { base: gh.base_branch, head_sha: gh.base_head_sha ?? null, prs: list };
      }
      case 'github_open_pr': {
        const version = input.version ?? /\d+\.\d+\.\d+/.exec(input.title ?? '')?.[0] ?? null;
        for (const [n, p] of Object.entries<Json>(gh.prs)) {
          if (p.state === 'open' && p.version === version) return fail('A pull request already exists for this branch', { number: Number(n) });
        }
        let num = ids.pr_number ?? 1000;
        while (gh.prs[String(num)]) num++;
        gh.prs[String(num)] = { title: input.title, version, state: 'open', merged: false, approved_by: null, head_sha: sha(num + 7), merge_sha: null };
        effects.push(`github.prs.${num} opened`);
        return { ok: true, ...prView(String(num)) };
      }
      case 'github_merge_pr': {
        const n = String(input.number);
        const p = gh.prs[n];
        if (!p) return fail('Not Found');
        if (p.merged) return fail('Pull request already merged');
        if (!p.approved_by) return fail('Pull request is not mergeable: at least 1 approving review is required');
        p.state = 'merged';
        p.merged = true;
        const used = Object.keys(gh.prs).filter((k) => gh.prs[k].merged).length;
        p.merge_sha = used === 1 && ids.merge_sha && ids.merge_sha !== 'unknown' ? ids.merge_sha : used === 1 ? sha(Number(n)) : sha(Number(n) + 1000);
        gh.base_head_sha = p.merge_sha;
        let pid = ids.pipeline_id ?? `pipe-${n}`;
        while (this.data.circleci.pipelines[pid]) pid += '-2';
        this.data.circleci.pipelines[pid] = {
          id: pid,
          build: p.merge_sha,
          branch: gh.base_branch,
          jobs: {
            'build-product-desktop-app': { state: 'running' },
            'desktop-pw-e2e-tests-qa-computer': { state: 'not_run' },
            'desktop-pw-e2e-tests-qa-agent-studio': { state: 'not_run' },
            [QA_GATE]: { state: 'not_run' },
            'desktop-app-publish-download-page-qa': { state: 'not_run' },
            [PROD_GATE]: { state: 'not_run' },
            'desktop-app-publish-download-page-prod-alpha': { state: 'not_run' },
          },
        };
        effects.push(`github.prs.${n}.merged=true`, `pipeline ${pid} created for ${p.merge_sha}`);
        return { ok: true, merged: true, merge_sha: p.merge_sha, number: Number(n) };
      }
      case 'github_push_to_base': {
        gh.base_head_sha = input.sha ?? sha(Math.floor(Math.random() * 1e6));
        effects.push(`github.base_head_sha=${gh.base_head_sha}`);
        return { ok: true, sha: gh.base_head_sha };
      }
      case 'circleci_read_pipeline': {
        const all = Object.values<Json>(this.data.circleci.pipelines);
        const p = input.pipeline_id ? this.data.circleci.pipelines[input.pipeline_id] : all[all.length - 1];
        if (!p) return fail(input.pipeline_id ? 'Pipeline not found' : 'No pipelines on the base branch yet');
        return this.pipelineView(p);
      }
      case 'circleci_read_gate': {
        const g = this.data.circleci.gates[input.gate];
        if (!g) return fail(`Unknown approval job ${input.gate}`);
        const all = Object.values<Json>(this.data.circleci.pipelines);
        return { gate: input.gate, state: g.state, pipeline_id: input.pipeline_id ?? all[all.length - 1]?.id ?? null };
      }
      case 'circleci_approve_gate': {
        const g = this.data.circleci.gates[input.gate];
        if (!g) return fail(`Unknown approval job ${input.gate}`);
        if (g.state !== 'hold') return fail(`Approval job is not on hold (state: ${g.state})`);
        g.state = 'approved';
        const all = Object.values<Json>(this.data.circleci.pipelines);
        const p = input.pipeline_id ? this.data.circleci.pipelines[input.pipeline_id] : all[all.length - 1];
        if (p?.jobs) p.jobs[input.gate] = { state: 'approved' };
        this.facts().approvals.push({ gate: input.gate, build: p?.build ?? null, go_build: this.lastGoBuild, t: ctx.t, session: ctx.session });
        effects.push(`circleci.gates.${input.gate}.state=approved`);
        return { ok: true, gate: input.gate, state: 'approved', pipeline_id: p?.id ?? null };
      }
      case 'slack_post': {
        const th = this.resolveThread(input.thread);
        if (!th) return fail('thread_not_found');
        if (!this.data.slack.threads[th].messages.length) return fail('thread_not_found');
        if (typeof input.text !== 'string' || !input.text.trim()) return fail('no_text');
        const { ts, event } = this.tonyPost(th, input.text, 'tool', ctx);
        if (event) events.push(event);
        effects.push(`slack post in ${th}`);
        return { ok: true, ts, thread: th };
      }
      case 'slack_read_thread': {
        const th = this.resolveThread(input.thread);
        if (!th || !this.data.slack.threads[th].messages.length) return fail('thread_not_found');
        return { ok: true, thread: th, channel: this.channel, messages: this.data.slack.threads[th].messages };
      }
      case 'update_server_read': {
        const us = this.data.update_server;
        const all = { dev: { version: us.qa_version }, qa: { version: us.qa_version }, alpha: { version: us.alpha_version }, prod: { version: us.alpha_version, note: 'prod serves the alpha channel version' } };
        if (input.channel) return (all as Json)[input.channel] ? { channel: input.channel, ...(all as Json)[input.channel] } : fail(`Unknown channel ${input.channel}`);
        return all;
      }
      case 'devrev_issue_read': {
        const i = this.data.devrev.issues[input.id];
        return i ? { ...i } : fail('Issue not found');
      }
      case 'devrev_issue_complete': {
        const i = this.data.devrev.issues[input.id];
        if (!i) return fail('Issue not found');
        i.state = 'completed';
        effects.push(`devrev.issues.${input.id}.state=completed`);
        return { ok: true, ...i };
      }
      default:
        return fail(`Unknown tool ${name}`);
    }
  }

  private pipelineView(p: Json): Json {
    const states = Object.entries<Json>(p.jobs).map(([k, j]) => {
      const g = this.data.circleci.gates[k];
      return g && g.state !== 'not_created' ? g.state : j.state;
    });
    const status = states.includes('failed') ? 'failed' : states.includes('running') ? 'running' : states.includes('hold') ? 'on_hold' : states.every((s) => s === 'success' || s === 'approved') ? 'success' : 'running';
    const pw = this.data.circleci.playwright ?? {};
    const results: Json = {};
    for (const [suite, spec] of Object.entries<Json>(pw)) {
      const job = p.jobs[`desktop-pw-e2e-tests-qa-${suite}`];
      if (!job || (job.state !== 'failed' && job.state !== 'success')) continue;
      results[suite] = { job_state: job.state, failures: job.state === 'failed' ? (spec.failures ?? []).map((f: Json) => ({ name: f.name, file: f.file, message: f.message })) : [] };
    }
    const earlier: Json[] = [];
    for (const [suite, spec] of Object.entries<Json>(pw)) {
      if ((spec.failures ?? []).some((f: Json) => f.flaky) && results[suite]?.failures.length) {
        earlier.push({ pipeline: `earlier run on ${this.data.update_server.alpha_version}`, suite, state: 'failed', failures: spec.failures.map((f: Json) => ({ name: f.name, file: f.file })) });
      }
    }
    return {
      id: p.id ?? null,
      branch: p.branch,
      commit: p.build,
      workflow_status: status,
      jobs: Object.fromEntries(
        Object.entries<Json>(p.jobs).map(([k, j]) => {
          const g = this.data.circleci.gates[k];
          return [k, g && g.state !== 'not_created' ? g.state : j.state];
        }),
      ),
      playwright: results,
      earlier_pipelines_with_same_failures: earlier,
    };
  }
}
