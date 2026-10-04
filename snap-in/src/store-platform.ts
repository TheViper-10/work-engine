// PlatformStore implements the engine Store on DevRev custom objects.
// Every logical version is its own immutable row `<key>@v<N>`; a write is create-if-absent of `@v<N+1>`,
// so atomicity comes from the unique_key 409 and there is no update path. Facts from live QA (S1):
//  - fields are tnt__kind, tnt__job_key, tnt__state, tnt__version (int), tnt__body (text, max 131072 bytes), event rows add tnt__source;
//  - internal custom-objects.get by unique_key is immediate; objects.list is eventually consistent (a fresh row can
//    be missing for several seconds), so a list miss is only ever a hint and the latest version is always confirmed by get;
//  - a key must not be reused across the two types;
//  - concurrent creates of one unique_key with byte-identical bodies collapse into one request and ALL get 201, so equal
//    bodies prove nothing. Every written body therefore carries a per-write nonce `_w` (stripped on read) and a create
//    is ours only if the row read back has our nonce. With distinct bodies one caller gets 201 and the rest get 409 or a
//    500 "conflicted with an ongoing operation": for that 500 the row is re-read (ours / theirs / absent -> retry, bounded);
//  - versioned rows are the only compare-and-set (object_version on update is unsupported).
import { randomBytes } from 'node:crypto';
import { MAX_BATCH, type Store } from '../../src/store.ts';
import { ApiError, realSleep, type DevRevApi } from './platform.ts';

export const MAX_BODY_BYTES = 131072;
export const PROBE_LIMIT = 256;

export class BodyTooLargeError extends Error {
  constructor(readonly key: string, readonly bytes: number) {
    super(`record ${key} is ${bytes} bytes, over the ${MAX_BODY_BYTES}-byte limit of tnt__body; not written`);
    this.name = 'BodyTooLargeError';
  }
}

export interface StoreOptions {
  api: DevRevApi;
  sleep?: (ms: number) => Promise<void>;
}

type Leaf = 'work_record' | 'work_event';
interface Row { value: unknown; body: string; nonce?: string }

const NONCE_KEY = '_w';
const PRIMITIVE_KEY = '_p';
const PRIMITIVE_FLAG = '_wp';
const CONFLICT_RE = /conflicted with an ongoing operation/i;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Body text for a write: the value with the nonce in front. Non-object values are wrapped so they stay reversible. */
function encode(value: unknown, nonce: string): string {
  if (isPlain(value)) {
    if (NONCE_KEY in value || PRIMITIVE_FLAG in value) throw new Error(`value uses the reserved key ${NONCE_KEY}/${PRIMITIVE_FLAG}`);
    return JSON.stringify({ [NONCE_KEY]: nonce, ...value });
  }
  return JSON.stringify({ [NONCE_KEY]: nonce, [PRIMITIVE_FLAG]: 1, [PRIMITIVE_KEY]: value ?? null });
}

/** Inverse of encode. Rows without a nonce (older rows) are returned unchanged. */
function decode(body: string): { value: unknown; nonce?: string } {
  const parsed = JSON.parse(body);
  if (!isPlain(parsed) || typeof parsed[NONCE_KEY] !== 'string') return { value: parsed };
  const { [NONCE_KEY]: nonce, [PRIMITIVE_FLAG]: flag, [PRIMITIVE_KEY]: prim, ...rest } = parsed as Record<string, unknown>;
  return { value: flag === 1 ? prim : rest, nonce: nonce as string };
}

const uk = (key: string, n: number): string => `${key}@v${n}`;
/** work-engine:<env>:<bot>:<kind>:<id>; events are their own type. */
export function leafOf(key: string): Leaf { return key.split(':')[3] === 'event' ? 'work_event' : 'work_record'; }

export class PlatformStore implements Store {
  private readonly api: DevRevApi;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Highest version this instance has seen for a key: a lower bound, never trusted as the latest. */
  private readonly latestSeen = new Map<string, number>();
  /** Latest version confirmed by get during this instance's life (write-through on own writes, dropped on a lost CAS). */
  private readonly latest = new Map<string, number>();
  /** Rows are immutable, so a fetched row is valid for the life of the instance. */
  private readonly rows = new Map<string, Row>();
  calls = { get: 0, list: 0, create: 0 };

  constructor(o: StoreOptions) { this.api = o.api; this.sleep = o.sleep ?? realSleep; }

  // ---------------------------------------------------------------- low level

  private async retried<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i += 1) {
      try { return await fn(); } catch (e) {
        if (!(e instanceof ApiError) || !(e.status === 429 || e.ambiguous) || i >= 3) throw e;
        await this.sleep(200 * 2 ** i);
      }
    }
  }

  private parse(ukey: string, raw: any): Row {
    const body = raw?.custom_fields?.tnt__body ?? raw?.description;
    if (typeof body !== 'string') throw new Error(`row ${ukey} has no tnt__body`);
    return { body, ...decode(body) };
  }

  private async getRow(ukey: string): Promise<Row | null> {
    const hit = this.rows.get(ukey);
    if (hit) return hit;
    this.calls.get += 1;
    let res: any;
    try { res = await this.retried(() => this.api.call('custom-objects.get', { unique_key: ukey })); } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
    const row = this.parse(ukey, res?.custom_object ?? res);
    this.rows.set(ukey, row);
    return row;
  }

  private async exists(key: string, n: number): Promise<boolean> { return (await this.getRow(uk(key, n))) !== null; }

  /** Rows for a set of unique keys in one or more objects.list calls. Misses are hints only. */
  private async listRows(leaf: Leaf, ukeys: string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const todo: string[] = [];
    for (const k of ukeys) { const hit = this.rows.get(k); if (hit) out.set(k, hit); else todo.push(k); }
    for (let i = 0; i < todo.length; i += MAX_BATCH) {
      const part = todo.slice(i, i + MAX_BATCH);
      this.calls.list += 1;
      const res = await this.retried(() => this.api.call('objects.list', {
        dql_query: { filter: { op: 'and', operands: [
          { field: `custom_object.${leaf}.leaf_type`, op: 'in', value: [leaf], value_type: 'json' },
          { field: `custom_object.${leaf}.unique_key`, op: 'in', value: part, value_type: 'json' },
        ] }, limit: MAX_BATCH },
      }));
      for (const raw of res?.custom_objects ?? res?.result ?? []) {
        if (typeof raw?.unique_key !== 'string') continue;
        const row = this.parse(raw.unique_key, raw);
        this.rows.set(raw.unique_key, row);
        out.set(raw.unique_key, row);
      }
    }
    return out;
  }

  /** Highest power of two the list shows (0 if none). A hint: lag can only make it too low. */
  private async listProbe(key: string): Promise<number> {
    const powers: number[] = [];
    for (let p = 2; p <= PROBE_LIMIT; p *= 2) powers.push(p);
    const found = await this.listRows(leafOf(key), powers.map((p) => uk(key, p)));
    let best = 0;
    for (const p of powers) if (found.has(uk(key, p))) best = p;
    return best;
  }

  /** Latest existing version, confirmed by get (never by a list miss). Versions are dense, so existence is monotone. */
  private async findLatest(key: string, hint = 0): Promise<number> {
    const n = await this.probeLatest(key, hint);
    if (n > 0) this.latest.set(key, n);
    return n;
  }

  private async probeLatest(key: string, hint: number): Promise<number> {
    let lo = Math.max(hint, this.latestSeen.get(key) ?? 0);
    if (lo === 0) {
      if (!(await this.exists(key, 1))) return 0;
      lo = 1;
    }
    // Most keys have one or two versions. Only a key that is already past lo+1 pays for the list probe,
    // which jumps to the highest power of two the list shows (a lower bound; lag only makes it low).
    if (await this.exists(key, lo + 1)) lo = Math.max(lo + 1, await this.listProbe(key));
    let step = 1;
    let hi = 0;
    for (;;) {
      const probe = lo + step;
      if (await this.exists(key, probe)) { lo = probe; step *= 2; } else { hi = probe; break; }
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await this.exists(key, mid)) lo = mid; else hi = mid;
    }
    this.latestSeen.set(key, Math.max(lo, this.latestSeen.get(key) ?? 0));
    return lo;
  }

  private fields(key: string, n: number, value: any, body: string): Record<string, unknown> {
    const parts = key.split(':');
    const kind = parts[3] ?? '';
    const jobKey = kind === 'job' ? key : typeof value?.job === 'string' ? `${parts.slice(0, 3).join(':')}:job:${value.job}` : '';
    const state = typeof value?.status === 'string' ? value.status : typeof value?.state === 'string' ? value.state : '';
    const f: Record<string, unknown> = { tnt__kind: kind, tnt__job_key: jobKey, tnt__state: state, tnt__version: n, tnt__body: body };
    if (leafOf(key) === 'work_event') f.tnt__source = parts[4] ?? 'other';
    return f;
  }

  /** Create-if-absent of `<key>@v<n>`. 409 means another writer owns that version. A create is ours only if the row carries our nonce. */
  private async createRow(key: string, n: number, value: unknown): Promise<'created' | 'exists'> {
    const nonce = randomBytes(8).toString('hex');
    const body = encode(value, nonce);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError(key, bytes);
    const ukey = uk(key, n);
    const won = (): 'created' => {
      this.rows.set(ukey, { value: structuredClone(value), body, nonce });
      this.latestSeen.set(key, Math.max(n, this.latestSeen.get(key) ?? 0));
      this.latest.set(key, n);
      return 'created';
    };
    // 1 try + at most 3 retries (429, timeouts, 5xx incl. "conflicted with an ongoing operation" with the row still absent).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.calls.create += 1;
      try {
        await this.api.call('custom-objects.create', { leaf_type: leafOf(key), unique_key: ukey, title: ukey, custom_fields: this.fields(key, n, value, body) });
        return won();
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 409) return 'exists';
        if (e.status === 429) { await this.sleep(200 * 2 ** attempt); continue; }
        if (e.ambiguous || CONFLICT_RE.test(e.message)) {
          // The create may have landed, or a concurrent one did. Re-read the key: my nonce = I won, another nonce = I lost, absent = retry.
          const row = await this.getRow(ukey).catch(() => null);
          if (row) return row.nonce === nonce ? won() : 'exists';
          await this.sleep(200 * 2 ** attempt);
          continue;
        }
        throw e;
      }
    }
    throw new ApiError(0, `create of ${ukey} did not settle after retries`, 'unsettled');
  }

  // ---------------------------------------------------------------- Store

  async getVersioned<T = unknown>(key: string): Promise<{ value: T | null; version: number }> {
    const n = this.latest.get(key) ?? await this.findLatest(key);
    if (n === 0) return { value: null, version: 0 };
    const row = await this.getRow(uk(key, n));
    return row ? { value: structuredClone(row.value) as T, version: n } : { value: null, version: 0 };
  }

  async get<T = unknown>(key: string): Promise<T | null> { return (await this.getVersioned<T>(key)).value; }

  async getManyVersioned<T = unknown>(keys: string[]): Promise<Array<{ value: T | null; version: number }>> {
    if (keys.length > MAX_BATCH) throw new RangeError(`getMany accepts at most ${MAX_BATCH} keys, got ${keys.length}`);
    // One list prefetches every key's first version into the cache. A list miss proves nothing (the list lags),
    // so every key is then confirmed by the immediate get inside getVersioned.
    const byLeaf = new Map<Leaf, string[]>();
    for (const k of keys.filter((x) => !this.latestSeen.has(x))) byLeaf.set(leafOf(k), [...(byLeaf.get(leafOf(k)) ?? []), uk(k, 1)]);
    for (const [leaf, list] of byLeaf) await this.listRows(leaf, list).catch(() => undefined);
    const out: Array<{ value: T | null; version: number }> = [];
    for (const key of keys) out.push(await this.getVersioned<T>(key));
    return out;
  }

  async getMany<T = unknown>(keys: string[]): Promise<Array<T | null>> { return (await this.getManyVersioned<T>(keys)).map((r) => r.value); }

  async putIfAbsent<T>(key: string, value: T): Promise<{ created: boolean; value: T }> {
    if ((await this.createRow(key, 1, value)) === 'created') return { created: true, value: structuredClone(value) };
    this.latest.delete(key);
    const cur = await this.getVersioned<T>(key);
    return { created: false, value: (cur.value ?? value) as T };
  }

  async putIfVersion<T>(key: string, value: T, version: number): Promise<{ ok: boolean; version: number }> {
    if ((await this.createRow(key, version + 1, value)) === 'created') return { ok: true, version: version + 1 };
    this.latest.delete(key);
    return { ok: false, version: await this.findLatest(key, version) };
  }

  async put<T>(key: string, value: T): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
      const cur = await this.getVersioned(key);
      if ((await this.putIfVersion(key, value, cur.version)).ok) return;
    }
    throw new Error(`put ${key}: lost the compare-and-set 8 times`);
  }
}
