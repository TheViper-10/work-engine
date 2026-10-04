// PlatformWaker: lazy creation of the hidden job-home DM, the wake post through a clone of workflow 16 with the
// owner keyring token, a stale-version check, and an exactly-once guard around the post.
//
// Exactly-once by the engine's key: postWake(dm, text, key) gets key = the run id (or run id plus a notice sequence).
// The adapter keeps a create-if-absent `wake_attempt:<sha(dm|key)>` row before any trigger. An existing attempt means
// "possibly sent": read the DM timeline back for the FIRST text sent under that key, and resend only when it is absent AND
// a grace period has passed. The text does not matter to identity, so a retry whose text differs (the engine's wake text
// embeds a timestamp) sends once.
import { makeKey, type Store } from '../../src/store.ts';
import { WakeConfigError, type Clock, type Waker } from '../../src/types.ts';
import { ApiError, sha, type DevRevApi } from './platform.ts';
import { dmmapKey, dmrevKey, type DmMapRow } from './directory.ts';

// A wake is answered about 100 s after its comment and can take about 3 minutes: never resend, or call a wake failed, before 5.
export const WAKE_GRACE_MS = 5 * 60_000;

export interface WakeAttempt { state: 'intent' | 'triggered' | 'confirmed'; dm: string; text: string; receipt_key: string; run: string | null; at: number; tries: number }

export interface WakerOptions {
  store: Store;
  clock: Clock;
  env: string;
  bot: string;
  /** Identity for ai-agents.get and timeline reads (service account, else caller). */
  chat: DevRevApi;
  /**
   * The owner keyring token. It triggers the wake workflow, and it also creates and hides the home DM: the workflow's
   * add_comment step runs as the user who triggered it and errors with 403 unless that user is a member of the DM,
   * so the DM's user must be the owner token's own user. chats.create was only proven with a user token.
   */
  owner: DevRevApi;
  tonyAgent: string;
  /** Cross-check only: the DM's user is resolved from the owner token; a mismatch with this input is a config error. */
  wakeUser: string;
  wakeWorkflow: string;
}

/** A definite refusal of the owner identity (no credential, forbidden): retrying cannot help until the configuration changes. */
const refused = (e: unknown): boolean => e instanceof ApiError && (e.status === 401 || e.status === 403);
/** Ids come as full DONs or short forms (devu/1); equal when one ends with the other at a ':' boundary. */
const sameId = (a: string, b: string): boolean => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);

export class PlatformWaker implements Waker {
  private ownerUser: string | null = null;
  constructor(private readonly o: WakerOptions) {}

  /** The user behind the owner token, resolved once per instance through dev-users.self. */
  private async resolveOwnerUser(): Promise<string> {
    if (this.ownerUser) return this.ownerUser;
    let res: any;
    try { res = await this.o.owner.call('dev-users.self', {}); } catch (e) {
      if (refused(e)) throw new WakeConfigError(`the owner_identity token was refused by dev-users.self (${(e as ApiError).status})`);
      throw e;
    }
    const id = res?.dev_user?.id ?? res?.id;
    if (typeof id !== 'string' || !id) throw new WakeConfigError('dev-users.self returned no user for the owner_identity token');
    if (this.o.wakeUser && !sameId(id, this.o.wakeUser)) {
      throw new WakeConfigError(`the owner_identity token belongs to ${id}, but the wake_user input is ${this.o.wakeUser}; they must be the same user`);
    }
    this.ownerUser = id;
    return id;
  }

  private k(kind: string, id: string): string { return makeKey(this.o.env, this.o.bot, kind, id); }

  private async defaultVersion(): Promise<string | null> {
    const res = await this.o.chat.call('ai-agents.get', { id: this.o.tonyAgent });
    const v = res?.ai_agent?.default_version_id;
    return typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null;
  }

  /** R41: no I/O. Without a wake user, a wake workflow or an agent every post must fail, so the engine records it once and waits for a config change. */
  preflight(): string | null {
    const missing = [['wake_user', this.o.wakeUser], ['wake_workflow', this.o.wakeWorkflow], ['tony_agent', this.o.tonyAgent]].filter(([, v]) => !v).map(([n]) => n);
    return missing.length ? `snap-in input ${missing.join(' and ')} is empty` : null;
  }

  /**
   * Real DM for a logical home, creating it on first use. Idempotent per logical id. */
  async ensureHome(logical: string): Promise<DmMapRow & { dm: string }> {
    const mapKey = dmmapKey(this.o.env, this.o.bot, logical);
    // A ready home needs no identity work. Checked first so a config error never leaves a "creating" row behind.
    const have = await this.o.store.get<DmMapRow>(mapKey);
    if (have?.state === 'ready' && have.dm) return have as DmMapRow & { dm: string };
    const user = await this.resolveOwnerUser();
    const first = await this.o.store.putIfAbsent<DmMapRow>(mapKey, { state: 'creating', dm: null, agent_version: null, created_at: this.o.clock.now() });
    if (first.value.state === 'ready' && first.value.dm) return first.value as DmMapRow & { dm: string };
    // R41: "creating" is recoverable, never a dead end. Every real wake attempt that finds it in this state creates the DM
    // again. State "creating": create the DM. A crash after chats.create and before the ready write leaves one orphan hidden
    // DM on the next pass; the dmmap row stays create-if-absent, so a job never gets two mapped homes.
    const version = await this.defaultVersion();
    let dm: string | undefined;
    try {
      const created = await this.o.owner.call('chats.create', {
        agent_members: [{ agent: this.o.tonyAgent }], users: [user], type: 'dm', is_default: false, display_state: 'global',
      });
      dm = created?.chat?.id;
      if (!dm) throw new Error('chats.create returned no id');
      await this.o.owner.call('chats.update', { id: dm, display_state: 'hidden' });
    } catch (e) {
      if (refused(e)) throw new WakeConfigError(`the owner_identity token was refused when creating the job home (${(e as ApiError).status})`);
      throw e;
    }
    const ready: DmMapRow = { state: 'ready', dm, agent_version: version, created_at: this.o.clock.now() };
    await this.o.store.put(mapKey, ready);
    await this.o.store.putIfAbsent(dmrevKey(this.o.env, this.o.bot, dm), { logical });
    return ready as DmMapRow & { dm: string };
  }

  private async timelineHas(dm: string, text: string): Promise<boolean> {
    const res = await this.o.chat.call('timeline-entries.list', { object: dm, limit: 100 });
    const entries: any[] = res?.timeline_entries ?? res?.result ?? [];
    return entries.some((e) => typeof e?.id === 'string' && e.id.includes(':comment/') && typeof e.body === 'string' && e.body.includes(text));
  }

  async postWake(logical: string, text: string, wakeKey: string): Promise<void | { stale_version?: boolean }> {
    const home = await this.ensureHome(logical);
    const current = await this.defaultVersion();
    if (home.agent_version && current && home.agent_version !== current) {
      // A3: the home session is pinned to an old agent version. Do not post into it; the engine replaces the home.
      return { stale_version: true };
    }
    const key = sha(`${home.dm}|${wakeKey}`);
    const now = this.o.clock.now();

    const attemptKey = this.k('wake_attempt', key);
    const mine: WakeAttempt = { state: 'intent', dm: home.dm, text, receipt_key: key, run: null, at: now, tries: 1 };
    const made = await this.o.store.putIfAbsent<WakeAttempt>(attemptKey, mine);
    let attempt = made.value;
    if (!made.created) {
      if (attempt.state === 'confirmed') return;
      if (await this.timelineHas(home.dm, attempt.text)) { await this.o.store.put(attemptKey, { ...attempt, state: 'confirmed' }); return; }
      if (now - attempt.at < WAKE_GRACE_MS) throw new Error('wake already attempted and not yet visible in the home; waiting before any resend');
      attempt = { ...attempt, state: 'intent', at: now, tries: attempt.tries + 1 };
      await this.o.store.put(attemptKey, attempt);
    }

    let run: string | undefined;
    try {
      const res = await this.o.owner.call('workflows.trigger', {
        id: this.o.wakeWorkflow, step_reference_key: 'start',
        payload: { value: { dm_id: home.dm, continuation_note: attempt.text, receipt_key: `${key}.${attempt.tries}` } },
      });
      run = res?.workflow_run_id ?? res?.workflow_run?.id;
    } catch (e) {
      // A refusal of the owner token (401/403) cannot be fixed by retrying: it is a config error for the engine.
      if (refused(e)) {
        await this.o.store.put(attemptKey, { ...attempt, at: 0 }).catch(() => undefined);
        throw new WakeConfigError(`the wake workflow refused the owner_identity token (${(e as ApiError).status}); the token's user must be a member of the job home`);
      }
      // A failure before anything could have been sent (no credential) or a definite refusal (4xx) created nothing,
      // so the grace period does not apply to the retry. Only a timeout or 5xx leaves the send in doubt.
      if (!(e instanceof ApiError) || !e.ambiguous) await this.o.store.put(attemptKey, { ...attempt, at: 0 }).catch(() => undefined);
      throw e;
    }
    // R42: one write after the trigger, not two. Read back once; a miss is normal (the clone runs asynchronously) and the
    // next call settles it. A crash before this write leaves state "intent", which the retry path already handles by reading the timeline.
    const seen = await this.timelineHas(home.dm, attempt.text).catch(() => false);
    await this.o.store.put(attemptKey, { ...attempt, state: seen ? 'confirmed' : 'triggered', run: run ?? null });
  }
}
