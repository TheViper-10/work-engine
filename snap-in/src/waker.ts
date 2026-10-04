// PlatformWaker: lazy creation of the hidden job-home DM, the wake post through a clone of workflow 16 with the
// owner keyring token, a stale-version check, and an exactly-once guard around the post.
//
// Exactly-once without an engine key argument: postWake(dm, text) only has the text. The adapter derives
// key = sha(dm|text) and keeps a create-if-absent `wake_attempt:<key>` row before any trigger. An existing attempt
// means "possibly sent": read the DM timeline back for the text, and resend only when it is absent AND a grace
// period has passed since the attempt. A different text to a home with an unconfirmed earlier wake is also read back
// first, because the engine's wake text embeds a timestamp and so differs between retries.
import { makeKey, type Store } from '../../src/store.ts';
import type { Clock, Waker } from '../../src/types.ts';
import { ApiError, sha, type DevRevApi } from './platform.ts';
import { dmmapKey, dmrevKey, type DmMapRow } from './directory.ts';

export const WAKE_GRACE_MS = 3 * 60_000;
export const WAKE_PENDING_KIND = 'wake_pending';

export interface WakeAttempt { state: 'intent' | 'triggered' | 'confirmed'; dm: string; text: string; receipt_key: string; run: string | null; at: number; tries: number }
interface Pending { key: string; text: string }

export interface WakerOptions {
  store: Store;
  clock: Clock;
  env: string;
  bot: string;
  /** Identity for chats.create / chats.update / timeline reads (service account, else caller). */
  chat: DevRevApi;
  /** Identity for workflows.trigger: the owner keyring token. */
  owner: DevRevApi;
  tonyAgent: string;
  wakeUser: string;
  wakeWorkflow: string;
}

export class PlatformWaker implements Waker {
  constructor(private readonly o: WakerOptions) {}

  private k(kind: string, id: string): string { return makeKey(this.o.env, this.o.bot, kind, id); }

  private async defaultVersion(): Promise<string | null> {
    const res = await this.o.chat.call('ai-agents.get', { id: this.o.tonyAgent });
    const v = res?.ai_agent?.default_version_id;
    return typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null;
  }

  /** Real DM for a logical home, creating it on first use. Idempotent per logical id. */
  async ensureHome(logical: string): Promise<DmMapRow & { dm: string }> {
    const mapKey = dmmapKey(this.o.env, this.o.bot, logical);
    const first = await this.o.store.putIfAbsent<DmMapRow>(mapKey, { state: 'creating', dm: null, agent_version: null, created_at: this.o.clock.now() });
    if (first.value.state === 'ready' && first.value.dm) return first.value as DmMapRow & { dm: string };
    // State "creating": create the DM. A crash after chats.create and before the ready write leaves one orphan hidden
    // DM on the next pass; the dmmap row stays create-if-absent, so a job never gets two mapped homes.
    const version = await this.defaultVersion();
    const created = await this.o.chat.call('chats.create', {
      agent_members: [{ agent: this.o.tonyAgent }], users: [this.o.wakeUser], type: 'dm', is_default: false, display_state: 'global',
    });
    const dm: string | undefined = created?.chat?.id;
    if (!dm) throw new Error('chats.create returned no id');
    await this.o.chat.call('chats.update', { id: dm, display_state: 'hidden' });
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

  async postWake(logical: string, text: string): Promise<void | { stale_version?: boolean }> {
    const home = await this.ensureHome(logical);
    const current = await this.defaultVersion();
    if (home.agent_version && current && home.agent_version !== current) {
      // A3: the home session is pinned to an old agent version. Do not post into it; the engine replaces the home.
      return { stale_version: true };
    }
    const key = sha(`${home.dm}|${text}`);
    const now = this.o.clock.now();
    const pendKey = this.k(WAKE_PENDING_KIND, sha(home.dm));

    // A prior wake to this DM that is not yet confirmed: read the timeline before anything is sent.
    const pend = await this.o.store.get<Pending>(pendKey);
    if (pend && pend.key !== key) {
      const prior = await this.o.store.get<WakeAttempt>(this.k('wake_attempt', pend.key));
      if (prior && prior.state !== 'confirmed') {
        if (await this.timelineHas(home.dm, prior.text)) {
          await this.o.store.put(this.k('wake_attempt', pend.key), { ...prior, state: 'confirmed' });
          await this.o.store.put(pendKey, null);
          return; // the earlier wake reached the home and carries the same job; do not stack a second comment
        }
        if (now - prior.at < WAKE_GRACE_MS) throw new Error('an earlier wake to this home is unconfirmed; waiting before any resend');
      }
    }

    const attemptKey = this.k('wake_attempt', key);
    const mine: WakeAttempt = { state: 'intent', dm: home.dm, text, receipt_key: key, run: null, at: now, tries: 1 };
    const made = await this.o.store.putIfAbsent<WakeAttempt>(attemptKey, mine);
    let attempt = made.value;
    if (!made.created) {
      if (attempt.state === 'confirmed') return;
      if (await this.timelineHas(home.dm, text)) { await this.o.store.put(attemptKey, { ...attempt, state: 'confirmed' }); return; }
      if (now - attempt.at < WAKE_GRACE_MS) throw new Error('wake already attempted and not yet visible in the home; waiting before any resend');
      attempt = { ...attempt, state: 'intent', at: now, tries: attempt.tries + 1 };
      await this.o.store.put(attemptKey, attempt);
    }
    await this.o.store.put(pendKey, { key, text } satisfies Pending);

    let run: string | undefined;
    try {
      const res = await this.o.owner.call('workflows.trigger', {
        id: this.o.wakeWorkflow, step_reference_key: 'start',
        payload: { value: { dm_id: home.dm, continuation_note: text, receipt_key: `${key}.${attempt.tries}` } },
      });
      run = res?.workflow_run_id ?? res?.workflow_run?.id;
    } catch (e) {
      // A failure before anything could have been sent (no credential) or a definite refusal (4xx) created nothing,
      // so the grace period does not apply to the retry. Only a timeout or 5xx leaves the send in doubt.
      if (!(e instanceof ApiError) || !e.ambiguous) await this.o.store.put(attemptKey, { ...attempt, at: 0 }).catch(() => undefined);
      throw e;
    }
    await this.o.store.put(attemptKey, { ...attempt, state: 'triggered', run: run ?? null });
    // Read back once; a miss is normal (the clone runs asynchronously) and is settled by the next call.
    if (await this.timelineHas(home.dm, text).catch(() => false)) {
      await this.o.store.put(attemptKey, { ...attempt, state: 'confirmed', run: run ?? null });
      await this.o.store.put(pendKey, null);
    }
  }
}
