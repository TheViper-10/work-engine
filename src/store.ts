// Storage interface. No list or scan method exists on purpose: every read is by key
// or by a batch of at most 100 keys. Indexes are records keyed by the lookup value.

export const MAX_BATCH = 100;

export interface Store {
  get<T = unknown>(key: string): Promise<T | null>;
  getMany<T = unknown>(keys: string[]): Promise<Array<T | null>>;
  putIfAbsent<T>(key: string, value: T): Promise<{ created: boolean; value: T }>;
  put<T>(key: string, value: T): Promise<void>;
}

/** The one place record keys are built: work-engine:<env>:<bot>:<kind>:<id>. */
export function makeKey(env: string, bot: string, kind: string, id: string): string {
  return `work-engine:${env}:${bot}:${kind}:${id}`;
}

export class MemoryStore implements Store {
  private readonly data = new Map<string, unknown>();

  get size(): number {
    return this.data.size;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    await Promise.resolve();
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : null;
  }

  async getMany<T = unknown>(keys: string[]): Promise<Array<T | null>> {
    if (keys.length > MAX_BATCH) {
      throw new RangeError(`getMany accepts at most ${MAX_BATCH} keys, got ${keys.length}`);
    }
    await Promise.resolve();
    return keys.map((k) => (this.data.has(k) ? (structuredClone(this.data.get(k)) as T) : null));
  }

  async putIfAbsent<T>(key: string, value: T): Promise<{ created: boolean; value: T }> {
    await Promise.resolve();
    if (this.data.has(key)) return { created: false, value: structuredClone(this.data.get(key)) as T };
    this.data.set(key, structuredClone(value));
    return { created: true, value: structuredClone(value) };
  }

  async put<T>(key: string, value: T): Promise<void> {
    await Promise.resolve();
    this.data.set(key, structuredClone(value));
  }
}
