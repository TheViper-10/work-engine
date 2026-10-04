// Storage interface. No list or scan method exists on purpose: every read is by key
// or by a batch of at most 100 keys. Indexes are records keyed by the lookup value.

export const MAX_BATCH = 100;

export interface Store {
  get<T = unknown>(key: string): Promise<T | null>;
  getMany<T = unknown>(keys: string[]): Promise<Array<T | null>>;
  putIfAbsent<T>(key: string, value: T): Promise<{ created: boolean; value: T }>;
  put<T>(key: string, value: T): Promise<void>;
  /** Read with the record's version (0 when absent). */
  getVersioned<T = unknown>(key: string): Promise<{ value: T | null; version: number }>;
  getManyVersioned<T = unknown>(keys: string[]): Promise<Array<{ value: T | null; version: number }>>;
  /** Compare-and-set: write only if the stored version equals `version` (0 means absent). */
  putIfVersion<T>(key: string, value: T, version: number): Promise<{ ok: boolean; version: number }>;
}

/** The one place record keys are built: work-engine:<env>:<bot>:<kind>:<id>. */
export function makeKey(env: string, bot: string, kind: string, id: string): string {
  return `work-engine:${env}:${bot}:${kind}:${id}`;
}

export class MemoryStore implements Store {
  private readonly data = new Map<string, { value: unknown; version: number }>();

  get size(): number {
    return this.data.size;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    await Promise.resolve();
    const e = this.data.get(key);
    return e ? (structuredClone(e.value) as T) : null;
  }

  async getMany<T = unknown>(keys: string[]): Promise<Array<T | null>> {
    if (keys.length > MAX_BATCH) {
      throw new RangeError(`getMany accepts at most ${MAX_BATCH} keys, got ${keys.length}`);
    }
    await Promise.resolve();
    return keys.map((k) => { const e = this.data.get(k); return e ? (structuredClone(e.value) as T) : null; });
  }

  async getVersioned<T = unknown>(key: string): Promise<{ value: T | null; version: number }> {
    await Promise.resolve();
    const e = this.data.get(key);
    return e ? { value: structuredClone(e.value) as T, version: e.version } : { value: null, version: 0 };
  }

  async getManyVersioned<T = unknown>(keys: string[]): Promise<Array<{ value: T | null; version: number }>> {
    if (keys.length > MAX_BATCH) {
      throw new RangeError(`getMany accepts at most ${MAX_BATCH} keys, got ${keys.length}`);
    }
    await Promise.resolve();
    return keys.map((k) => { const e = this.data.get(k); return e ? { value: structuredClone(e.value) as T, version: e.version } : { value: null, version: 0 }; });
  }

  async putIfAbsent<T>(key: string, value: T): Promise<{ created: boolean; value: T }> {
    await Promise.resolve();
    const e = this.data.get(key);
    if (e) return { created: false, value: structuredClone(e.value) as T };
    this.data.set(key, { value: structuredClone(value), version: 1 });
    return { created: true, value: structuredClone(value) };
  }

  async put<T>(key: string, value: T): Promise<void> {
    await Promise.resolve();
    const e = this.data.get(key);
    this.data.set(key, { value: structuredClone(value), version: (e?.version ?? 0) + 1 });
  }

  async putIfVersion<T>(key: string, value: T, version: number): Promise<{ ok: boolean; version: number }> {
    await Promise.resolve();
    const e = this.data.get(key);
    const cur = e?.version ?? 0;
    if (cur !== version) return { ok: false, version: cur };
    this.data.set(key, { value: structuredClone(value), version: cur + 1 });
    return { ok: true, version: cur + 1 };
  }
}
