// In-memory fake of the DevRev, Slack and GitHub APIs, faithful to the platform behaviours the adapters rely on.
// No network, no sockets, no real tokens. Shared clock: everything that is time-based reads the ManualClock.
import { ManualClock } from '../../src/clock.ts';
import { ApiError, type Deps, type DevRevApi, type GithubApi, type Identity, type SlackApi } from '../src/platform.ts';

export const ORG = 'don:core:dvrv-us-1:devo/1lKlCUXYGG';
export const EPOCH = 1_800_000_000_000;
export const TONY = `${ORG}:ai_agent/2`;
export const OWNER_USER = 'don:identity:dvrv-us-1:devo/1lKlCUXYGG:devu/2';
export const SNAP_IN = `${ORG}:snap_in/900`;
export const WAKE_WORKFLOW = 'don:integration:dvrv-us-1:devo/1lKlCUXYGG:workflow/77';
export const OWN_BOT = 'U0C4FFYJGE6';
export const ALLOWED = 'C0C4K4EGZT6';
export const PROTECTED = 'C08TJE6SDME';
export const CHAN_FIELDS: Record<string, string[]> = {
  work_record: ['tnt__kind', 'tnt__job_key', 'tnt__state', 'tnt__version', 'tnt__body'],
  work_event: ['tnt__kind', 'tnt__job_key', 'tnt__state', 'tnt__version', 'tnt__body', 'tnt__source'],
};
export const BODY_LIMIT = 131072;

export class Crash extends Error { constructor() { super('process crashed'); this.name = 'Crash'; } }

interface Row { id: string; leaf_type: string; unique_key: string; title: string; custom_fields: Record<string, unknown>; created_at: number; created_by: string }
export interface TimelineEntry { id: string; object: string; body: string; created_by: { id: string }; created_at: number; visible_at: number }
interface Rule { path: string; status?: number; type?: string; message?: string; timeout?: 'before' | 'after'; times: number; skip: number; match?: (b: any) => boolean }
interface Session { id: string; parent: string; agent: string; user: string }
interface Chat { id: string; display_state: string; members: string[]; users: string[]; type: string }
export interface SlackMsg { ts: string; user?: string; bot_id?: string; text: string; thread_ts: string; metadata?: { event_type: string } }
interface Pr { number: number; head: { sha: string }; base: { ref: string } }

export class FakePlatform {
  readonly clock = new ManualClock(EPOCH);
  // ---- devrev state
  readonly rows = new Map<string, Row>();
  readonly chats = new Map<string, Chat>();
  readonly sessions = new Map<string, Session>();
  readonly timeline = new Map<string, TimelineEntry[]>();
  readonly triggers: Array<{ id: string; dm: string; note: string; receipt: string; by: Identity }> = [];
  /** The user behind the owner_identity keyring token. */
  ownerUser = OWNER_USER;
  tonyVersion = `${TONY}:version/1`;
  listLagMs = 5000;
  triggerDelayMs = 0;
  callerCanWrite = true;
  installInputs: Record<string, unknown> = {
    env: 'qa', bot: 'tony', own_bot_user: OWN_BOT, tony_agent: TONY, wake_user: OWNER_USER, wake_workflow: WAKE_WORKFLOW,
    slack_channel_allowlist: ALLOWED, github_repo: 'devrev/devrev-web', mock_branch: 'mock/tony-desktop-release', state_path: 'mock-release/state.json', guidance_version: 'g-test',
  };
  // ---- slack state
  readonly slack: Record<string, SlackMsg[]> = {};
  readonly slackReads: Array<{ method: string; channel: string }> = [];
  // ---- github state
  branchHead = '39f8a8c8aa11bb22cc33dd44ee55ff6600112233';
  prs: Pr[] = [];
  stateFile: unknown = { qa: { latest: '5.2.10' }, prod: { alpha: '5.2.10' } };
  readonly githubRequests: Array<{ method: string; path: string }> = [];
  // ---- failure injection
  private rules: Rule[] = [];
  private beforeCreate: Array<{ when: (uk: string) => boolean; run: () => void }> = [];
  private crashAfter: number | null = null;
  private seq = 100;
  /** Creates of one unique_key that land in the same tick are one race window (live QA: identical bodies collapse, distinct ones 409/500). */
  private inflight = new Map<string, { row: Row; body: string; losers: number }>();
  readonly log: Array<{ path: string; as: Identity | 'slack' | 'github'; status: number }> = [];
  createdKeys: string[] = [];
  private slackRules: Array<{ status: 'ratelimited' | 'timeout'; times: number; channel?: string }> = [];
  private githubFail = false;

  // ---------------------------------------------------------------- failure injection
  /** Fail the next `times` calls to `path` (after skipping `skip`). status 0 with timeout: 'before' | 'after' models a timeout. */
  inject(path: string, o: { status?: number; type?: string; message?: string; timeout?: 'before' | 'after'; times?: number; skip?: number; match?: (b: any) => boolean }): void {
    this.rules.push({ path, status: o.status, type: o.type, message: o.message, timeout: o.timeout, times: o.times ?? 1, skip: o.skip ?? 0, match: o.match });
  }
  /** The process dies right after the n-th successful create from now (the write is applied, the caller never sees it). */
  crashAfterCreates(n: number): void { this.crashAfter = n; }
  /** One-shot: before a create for a matching key is evaluated, a competing writer gets there first. */
  raceBeforeCreate(when: (uk: string) => boolean, run: () => void): void { this.beforeCreate.push({ when, run }); }
  failSlack(status: 'ratelimited' | 'timeout', times = 1, channel?: string): void { this.slackRules.push({ status, times, channel }); }
  failGithub(on = true): void { this.githubFail = on; }
  clearRules(): void { this.rules = []; this.slackRules = []; this.githubFail = false; }

  // ---------------------------------------------------------------- world setup
  newSession(parent: string, agent = TONY): string {
    const id = `${ORG}:ai_agent_session/${this.seq += 1}`;
    this.sessions.set(id, { id, parent, agent, user: OWNER_USER });
    return id;
  }
  /** A connector-style mention DM with Tony and a session in it (non-home). */
  newMentionDm(): { dm: string; session: string } {
    const dm = `${ORG}:dm/mention${this.seq += 1}`;
    this.chats.set(dm, { id: dm, display_state: 'global', members: [TONY], users: [OWNER_USER], type: 'dm' });
    return { dm, session: this.newSession(dm) };
  }
  sessionIn(dm: string): string { return this.newSession(dm); }
  comments(dm: string): TimelineEntry[] { return this.timeline.get(dm) ?? []; }
  /** Successful row creates so far (each is one new immutable version row). The row-budget counter. */
  get creates(): number { return this.createdKeys.length; }
  rowCount(leaf?: string): number { return [...this.rows.values()].filter((r) => !leaf || r.leaf_type === leaf).length; }
  insertRaw(leaf: string, uk: string, value: unknown): void {
    this.insert(leaf, uk, { tnt__kind: uk.split(':')[3] ?? '', tnt__job_key: '', tnt__state: '', tnt__version: Number(uk.split('@v')[1] ?? 1), tnt__body: JSON.stringify(value) }, 'raw');
  }
  postSlack(channel: string, thread_ts: string | null, o: { user?: string; bot_id?: string; text: string; metadata?: { event_type: string } }): string {
    const ts = (this.clock.now() / 1000 + (this.seq += 1) / 1e6).toFixed(6);
    const list = (this.slack[channel] ??= []);
    list.push({ ts, user: o.user, bot_id: o.bot_id, text: o.text, thread_ts: thread_ts ?? ts, metadata: o.metadata });
    return ts;
  }
  /** Root message of a thread. */
  root(channel: string, user: string, text: string): string { return this.postSlack(channel, null, { user, text }); }

  // ---------------------------------------------------------------- devrev
  private fire(path: string, body: any): Rule | null {
    for (const r of this.rules) {
      if (r.path !== path || r.times <= 0 || (r.match && !r.match(body))) continue;
      if (r.skip > 0) { r.skip -= 1; continue; }
      r.times -= 1;
      return r;
    }
    return null;
  }

  private authorize(path: string, as: Identity, event: any): string {
    const s = event?.context?.secrets ?? {};
    if (as === 'owner') {
      const k = event?.input_data?.resources?.keyrings?.owner_identity?.secret;
      if (!k) throw new Error('owner_identity keyring is unavailable');
      return `owner:${k}`;
    }
    const tok = as === 'caller' ? s.access_token : s.service_account_token;
    if (!tok) throw new Error(`${as} token is unavailable`);
    return `${as}:${tok}`;
  }

  private insert(leaf: string, uk: string, fields: Record<string, unknown>, by: string): Row {
    const row: Row = { id: `${ORG}:custom_object/${this.seq += 1}`, leaf_type: leaf, unique_key: uk, title: uk, custom_fields: fields, created_at: this.clock.now(), created_by: by };
    this.rows.set(uk, row);
    return row;
  }

  private rowView(r: Row): any { return { id: r.id, leaf_type: r.leaf_type, unique_key: r.unique_key, title: r.title, custom_fields: r.custom_fields, created_by: { id: r.created_by } }; }

  private async handle(path: string, body: any, as: Identity, event: any): Promise<any> {
    const principal = this.authorize(path, as, event);
    const rule = this.fire(path, body);
    if (rule?.timeout === 'before') throw new ApiError(0, `${path} unavailable`, 'timeout');
    if (rule?.status && !rule.timeout) throw new ApiError(rule.status, rule.message ?? `${path} failed (${rule.status})`, rule.type);
    let crashed = false;
    const out = await this.dispatch(path, body, as, principal, () => { crashed = true; });
    if (rule?.timeout === 'after') throw new ApiError(0, `${path} unavailable`, 'timeout');
    if (crashed) throw new Crash();
    return out;
  }

  private async dispatch(path: string, b: any, as: Identity, principal: string, markCrash: () => void): Promise<any> {
    switch (path) {
      case 'snap-ins.get':
        return { snap_in: { id: b.id, inputs_values: this.installInputs } };
      case 'custom-objects.create': {
        if (as === 'caller' && !this.callerCanWrite) throw new ApiError(403, 'forbidden', 'forbidden');
        const leaf: string = b.leaf_type;
        const allowed = CHAN_FIELDS[leaf];
        if (!allowed) throw new ApiError(400, `unknown leaf_type ${leaf}`, 'bad_request');
        for (const k of Object.keys(b.custom_fields ?? {})) if (!allowed.includes(k)) throw new ApiError(400, `unknown field ${k}`, 'bad_request');
        const body = b.custom_fields?.tnt__body;
        if (typeof body !== 'string') throw new ApiError(400, 'tnt__body is required', 'bad_request');
        if (Buffer.byteLength(body, 'utf8') > BODY_LIMIT) throw new ApiError(400, `field tnt__body is too long, max allowed length is ${BODY_LIMIT}`, 'bad_request');
        if (typeof b.unique_key !== 'string' || !b.unique_key) throw new ApiError(400, 'unique_key required', 'bad_request');
        for (const h of [...this.beforeCreate]) if (h.when(b.unique_key)) { this.beforeCreate.splice(this.beforeCreate.indexOf(h), 1); h.run(); }
        const racing = this.inflight.get(b.unique_key);
        if (racing && this.rows.get(b.unique_key) === racing.row) {
          // Byte-identical body: the server treats it as the same request, every caller gets 201 for the one row.
          if (racing.body === body) return { custom_object: this.rowView(racing.row) };
          // Distinct body: one winner; the rest are a mix of 409 and 500 "conflicted with an ongoing operation".
          racing.losers += 1;
          if (racing.losers % 2 === 0) throw new ApiError(500, 'The request conflicted with an ongoing operation, please retry', 'internal');
          throw new ApiError(409, 'Conflict', 'conflict', 'document exists');
        }
        if (this.rows.has(b.unique_key)) throw new ApiError(409, 'Conflict', 'conflict', 'document exists');
        const row = this.insert(leaf, b.unique_key, b.custom_fields, principal);
        this.createdKeys.push(b.unique_key);
        this.inflight.set(b.unique_key, { row, body, losers: 0 });
        setImmediate(() => { if (this.inflight.get(b.unique_key)?.row === row) this.inflight.delete(b.unique_key); });
        if (this.crashAfter !== null) { this.crashAfter -= 1; if (this.crashAfter <= 0) { this.crashAfter = null; markCrash(); } }
        return { custom_object: this.rowView(row) };
      }
      case 'custom-objects.get': {
        // Internal get-by-unique_key is immediate. The public endpoint accepts {id} only; a unique_key there is a 400.
        if (typeof b.unique_key !== 'string') throw new ApiError(400, 'unique_key required', 'bad_request');
        const r = this.rows.get(b.unique_key);
        if (!r) throw new ApiError(404, 'not_found', 'not_found');
        return { custom_object: this.rowView(r) };
      }
      case 'custom-objects.delete': {
        const r = [...this.rows.values()].find((x) => x.id === b.id);
        if (!r) throw new ApiError(404, 'not_found', 'not_found');
        this.rows.delete(r.unique_key);
        return {};
      }
      case 'objects.list': {
        // Eventually consistent: a new row is missing from the list for listLagMs.
        const ops: any[] = b?.dql_query?.filter?.operands ?? [];
        const leaf = ops.find((o) => String(o.field).endsWith('.leaf_type'))?.value?.[0];
        const keys: string[] | undefined = ops.find((o) => String(o.field).endsWith('.unique_key'))?.value;
        if (!leaf || !keys) throw new ApiError(400, 'leaf_type and unique_key filters are required', 'bad_request');
        if (keys.length > 100 || (b.dql_query.limit ?? 100) > 100) throw new ApiError(400, 'at most 100 keys', 'bad_request');
        const now = this.clock.now();
        const hit = keys.map((k) => this.rows.get(k)).filter((r): r is Row => !!r && r.leaf_type === leaf && now - r.created_at >= this.listLagMs);
        return { custom_objects: hit.map((r) => this.rowView(r)) };
      }
      case 'ai-agent.sessions.get': {
        const s = this.sessions.get(b.id);
        if (!s) throw new ApiError(404, 'not_found', 'not_found');
        return { agent_session: { id: s.id, agent: s.agent, parent: s.parent, session_object: `${s.parent}|${s.user}` } };
      }
      case 'dev-users.self':
        return { dev_user: { id: as === 'owner' ? this.ownerUser : OWNER_USER } };
      case 'ai-agents.get':
        return { ai_agent: { id: b.id, default_version_id: this.tonyVersion } };
      case 'chats.create': {
        const id = `${ORG}:dm/${(this.seq += 1).toString(36)}home`;
        this.chats.set(id, { id, display_state: b.display_state ?? 'global', members: (b.agent_members ?? []).map((m: any) => m.agent), users: b.users ?? [], type: b.type });
        return { chat: { id } };
      }
      case 'chats.update': {
        const c = this.chats.get(b.id);
        if (!c) throw new ApiError(404, 'not_found', 'not_found');
        if (b.display_state) c.display_state = b.display_state;
        return { chat: { id: c.id, display_state: c.display_state } };
      }
      case 'workflows.trigger': {
        if (as !== 'owner') throw new ApiError(403, 'forbidden', 'forbidden');
        if (b.id !== WAKE_WORKFLOW) throw new ApiError(404, 'workflow not found', 'not_found');
        const v = b.payload?.value ?? {};
        if (!this.chats.has(v.dm_id)) throw new ApiError(400, 'unknown dm', 'bad_request');
        // The clone's add_comment step runs as the triggering user: a non-member gets a 403 and nothing is posted.
        if (!this.chats.get(v.dm_id)!.users.includes(this.ownerUser)) throw new ApiError(403, 'add_comment: forbidden (not a member of the conversation)', 'forbidden');
        const run = `${WAKE_WORKFLOW}:workflow_run/${this.seq += 1}`;
        const list = this.timeline.get(v.dm_id) ?? [];
        list.push({ id: `${v.dm_id}:comment/${list.length + 1}`, object: v.dm_id, body: String(v.continuation_note), created_by: { id: OWNER_USER }, created_at: this.clock.now(), visible_at: this.clock.now() + this.triggerDelayMs });
        this.timeline.set(v.dm_id, list);
        this.triggers.push({ id: run, dm: v.dm_id, note: String(v.continuation_note), receipt: String(v.receipt_key), by: as });
        return { workflow_run_id: run };
      }
      case 'timeline-entries.list': {
        const now = this.clock.now();
        return { timeline_entries: (this.timeline.get(b.object) ?? []).filter((e) => e.visible_at <= now) };
      }
      default:
        throw new ApiError(404, `unknown endpoint ${path}`, 'not_found');
    }
  }

  // ---------------------------------------------------------------- slack / github
  private slackApi(event: any): SlackApi {
    return {
      get: async (method, params) => {
        if (!event?.input_data?.resources?.keyrings?.tony_slack_token?.secret) throw new ApiError(401, 'slack token unavailable', 'not_authed');
        const channel = String(params.channel ?? '');
        this.slackReads.push({ method, channel });
        const i = this.slackRules.findIndex((r) => r.times > 0 && (!r.channel || r.channel === channel));
        if (i >= 0) {
          const r = this.slackRules[i]; r.times -= 1;
          if (r.status === 'timeout') throw new ApiError(0, `slack ${method} unavailable`, 'timeout');
          throw new ApiError(429, `slack ${method} failed (ratelimited)`, 'ratelimited');
        }
        if (method !== 'conversations.replies') throw new ApiError(404, 'unknown method', 'unknown_method');
        const all = (this.slack[channel] ?? []).filter((m) => m.thread_ts === String(params.ts));
        const oldest = params.oldest !== undefined ? Number(params.oldest) : 0;
        return { ok: true, messages: all.filter((m) => Number(m.ts) >= oldest).map((m) => ({ ...m })) };
      },
    };
  }

  private githubApi(event: any): GithubApi {
    return {
      get: async (path) => {
        this.githubRequests.push({ method: 'GET', path });
        if (!event?.input_data?.resources?.keyrings?.github_read?.secret) throw new ApiError(401, 'github token unavailable', 'bad_credentials');
        if (this.githubFail) throw new ApiError(502, 'github unavailable', 'bad_gateway');
        const base = '/repos/devrev/devrev-web/';
        if (!path.startsWith(base)) throw new ApiError(404, 'Not Found', 'not_found');
        const rest = path.slice(base.length);
        if (rest.startsWith('commits/')) return { sha: this.branchHead };
        if (rest.startsWith('pulls')) return this.prs.filter((p) => path.includes(`base=${encodeURIComponent(p.base.ref)}`) && path.includes('state=open'));
        if (rest.startsWith('contents/')) return { encoding: 'base64', content: Buffer.from(JSON.stringify(this.stateFile)).toString('base64') };
        throw new ApiError(404, 'Not Found', 'not_found');
      },
    };
  }

  // ---------------------------------------------------------------- deps and events
  deps(): Deps {
    return {
      clock: this.clock,
      sleep: async (ms) => { this.clock.advance(ms); },
      devrev: (event): DevRevApi => ({
        call: async (path, body, as = 'caller') => {
          try {
            const out = await this.handle(path, body, as, event);
            this.log.push({ path, as, status: 200 });
            return out;
          } catch (e) {
            this.log.push({ path, as, status: e instanceof ApiError ? e.status : -1 });
            throw e;
          }
        },
      }),
      slack: (event) => this.slackApi(event),
      github: (event) => this.githubApi(event),
    };
  }

  /** A function-call event for the operation path: caller token only, no snap_in_id in context. */
  opEvent(data: Record<string, unknown>, o: { keyrings?: boolean } = {}): any {
    return {
      context: { secrets: { access_token: 'caller-token-fake' } },
      execution_metadata: { devrev_endpoint: 'https://api.qa.devrev-eng.ai', request_id: 'req-fake' },
      input_data: { resources: { keyrings: o.keyrings ? this.keyrings() : {} } },
      payload: { data: { snap_in_id: SNAP_IN, ...data } },
    };
  }
  /** A timer tick: service-account token and installation context. */
  timerEvent(): any {
    return {
      context: { secrets: { service_account_token: 'service-token-fake' }, snap_in_id: SNAP_IN, service_account_id: `${ORG}:svcacc/9` },
      execution_metadata: { event_type: 'timer.tick', devrev_endpoint: 'https://api.qa.devrev-eng.ai' },
      input_data: { resources: { keyrings: this.keyrings() } },
    };
  }
  keyrings(): Record<string, { secret: string }> {
    return { owner_identity: { secret: 'owner-token-fake' }, tony_slack_token: { secret: 'slack-token-fake' }, github_read: { secret: 'github-token-fake' } };
  }
}
