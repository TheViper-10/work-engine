// Slack: the allowlist guard (with a compile-time hard deny), the SlackReader, and the poller over watched threads.
import { makeKey, type Store } from '../../src/store.ts';
import type { Clock, IngestEvent, SlackReader } from '../../src/types.ts';
import type { SlackApi } from './platform.ts';

/** Protected channel. Never read, never polled, whatever the install inputs say. A literal type makes any attempt to allow it a compile error. */
export const HARD_DENIED_CHANNEL = 'C08TJE6SDME' as const;
export type AllowedChannel<T extends string> = T extends typeof HARD_DENIED_CHANNEL ? never : T;
/** Compile-time proof: this line fails to type-check if the default allowlist contains the protected channel. */
export const DEFAULT_ALLOWLIST = ['C0C4K4EGZT6'] as const satisfies ReadonlyArray<AllowedChannel<string>>;
// @ts-expect-error the protected channel cannot be passed where an allowed channel is required
export const _denyIsEnforcedAtCompileTime: AllowedChannel<'C08TJE6SDME'> = 'C08TJE6SDME';

export function parseAllowlist(raw: string | undefined): string[] {
  const ids = (raw ?? DEFAULT_ALLOWLIST.join(',')).split(/[\s,]+/).filter(Boolean);
  return ids.filter((c) => /^C[A-Z0-9]{8,12}$/.test(c) && c !== HARD_DENIED_CHANNEL);
}

export class ChannelDeniedError extends Error {
  constructor(channel: string) { super(`channel ${channel} is not in the allowlist`); this.name = 'ChannelDeniedError'; }
}

/** `C0C4K4EGZT6:1700000000.000100` or `slack:C0C4K4EGZT6:1700000000.000100`. */
export function parseThread(thread: string): { channel: string; ts: string } | null {
  const m = /^(?:slack:)?([A-Z][A-Z0-9]{8,12}):(\d+\.\d+)$/.exec(thread.trim());
  return m ? { channel: m[1], ts: m[2] } : null;
}
export const normThread = (thread: string): string => { const t = parseThread(thread); return t ? `${t.channel}:${t.ts}` : thread; };

export function assertAllowed(allow: readonly string[], channel: string): void {
  if (channel === HARD_DENIED_CHANNEL || !allow.includes(channel)) throw new ChannelDeniedError(channel);
}

export interface SlackOptions { api: SlackApi; allow: readonly string[]; ownBotUserId: string }

export class PlatformSlackReader implements SlackReader {
  constructor(private readonly o: SlackOptions) {}

  async findOwnPostAfter(thread: string, ts: number): Promise<{ link?: string; ts?: number; relay?: boolean } | null> {
    const t = parseThread(thread);
    if (!t) return null;
    assertAllowed(this.o.allow, t.channel);
    const res = await this.o.api.get('conversations.replies', { channel: t.channel, ts: t.ts, limit: 200 });
    const msgs: any[] = res?.messages ?? [];
    for (const m of msgs) {
      const mts = Number(m.ts) * 1000;
      if (m.user !== this.o.ownBotUserId || !(mts >= ts) || m.ts === t.ts) continue;
      return { link: `slack:${t.channel}:${m.ts}`, ts: mts, relay: m.metadata?.event_type === 'slack_agent_chat' };
    }
    return null;
  }

  /** R54: the thread a message belongs to, `<channel>:<thread ts>`. null when Slack cannot say (the engine then takes the link as reported). */
  async threadOfLink(link: string): Promise<string | null> {
    const t = parseThread(link);
    if (!t) return null;
    assertAllowed(this.o.allow, t.channel);
    const res = await this.o.api.get('conversations.replies', { channel: t.channel, ts: t.ts, limit: 1 });
    const m = (res?.messages ?? [])[0];
    const root = typeof m?.thread_ts === 'string' && m.thread_ts ? m.thread_ts : typeof m?.ts === 'string' ? m.ts : null;
    return root ? `${t.channel}:${root}` : null;
  }
}

// ---------------------------------------------------------------- poller

export interface Watch { channel: string; thread_ts: string; job: string; last_ts: string }
interface WatchList { items: Watch[] }

export const MAX_THREADS_PER_TICK = 20;

export class SlackPoller {
  constructor(private readonly o: {
    api: SlackApi; store: Store; clock: Clock; env: string; bot: string; allow: readonly string[]; ownBotUserId: string;
    ingest: (ev: IngestEvent) => Promise<unknown>;
  }) {}

  private key(): string { return makeKey(this.o.env, this.o.bot, 'watch', 'all'); }

  /** Called after a job_open answer that links a thread. Refuses threads outside the allowlist. */
  async watch(thread: string, job: string): Promise<boolean> {
    const t = parseThread(thread);
    if (!t) return false;
    try { assertAllowed(this.o.allow, t.channel); } catch { return false; }
    for (let i = 0; i < 8; i += 1) {
      const cur = await this.o.store.getVersioned<WatchList>(this.key());
      const list = cur.value ?? { items: [] };
      if (list.items.some((w) => w.channel === t.channel && w.thread_ts === t.ts && w.job === job)) return true;
      list.items.push({ channel: t.channel, thread_ts: t.ts, job, last_ts: t.ts });
      if ((await this.o.store.putIfVersion(this.key(), list, cur.version)).ok) return true;
    }
    return false;
  }

  async watched(): Promise<Watch[]> { return (await this.o.store.get<WatchList>(this.key()))?.items ?? []; }

  /** One pass: at most MAX_THREADS_PER_TICK threads, cursor advanced only after ingest succeeded. */
  async poll(): Promise<{ polled: number; ingested: number; skipped: number; errors: string[] }> {
    const out = { polled: 0, ingested: 0, skipped: 0, errors: [] as string[] };
    const items = await this.watched();
    for (const w of items) {
      if (out.polled >= MAX_THREADS_PER_TICK) break;
      try { assertAllowed(this.o.allow, w.channel); } catch { out.skipped += 1; continue; }
      out.polled += 1;
      let msgs: any[];
      try {
        const res = await this.o.api.get('conversations.replies', { channel: w.channel, ts: w.thread_ts, oldest: w.last_ts, limit: 100 });
        msgs = (res?.messages ?? []).filter((m: any) => m.ts !== w.thread_ts && Number(m.ts) > Number(w.last_ts)).sort((a: any, b: any) => Number(a.ts) - Number(b.ts));
      } catch (e) { out.errors.push(`${w.channel}:${w.thread_ts}: ${(e as Error).message}`); continue; }
      let cursor = w.last_ts;
      for (const m of msgs) {
        const isOwn = m.user === this.o.ownBotUserId;
        const other = !!m.bot_id && !isOwn;
        const r: any = await this.o.ingest({
          source: 'slack', delivery_id: `${w.channel}:${m.ts}`, kind: 'message', thread: `${w.channel}:${w.thread_ts}`,
          sender_id: m.user ?? m.bot_id, sender_kind: other ? 'other_bot' : 'human', ref: `slack:${w.channel}:${m.ts}`,
          attrs: { ts: Number(m.ts) * 1000, text: typeof m.text === 'string' ? m.text : '', metadata_event_type: m.metadata?.event_type ?? null, relay: m.metadata?.event_type === 'slack_agent_chat' },
        });
        if (r && r.ok === false) { out.errors.push(`ingest ${w.channel}:${m.ts}: ${r.status}`); break; }
        cursor = m.ts;
        out.ingested += 1;
      }
      if (cursor !== w.last_ts) await this.advance(w, cursor);
    }
    return out;
  }

  private async advance(w: Watch, cursor: string): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
      const cur = await this.o.store.getVersioned<WatchList>(this.key());
      const list = cur.value;
      const item = list?.items.find((x) => x.channel === w.channel && x.thread_ts === w.thread_ts && x.job === w.job);
      if (!list || !item || Number(item.last_ts) >= Number(cursor)) return;
      item.last_ts = cursor;
      if ((await this.o.store.putIfVersion(this.key(), list, cur.version)).ok) return;
    }
  }
}

/** R51: the `<channel>:<ts>` of a thread given as a ref or permalink, else the text unchanged (the engine then refuses it as bad_thread). */
export { normalizeThread as slackThread } from '../../src/thread.ts';
