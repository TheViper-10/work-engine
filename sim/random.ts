// Seeded PRNG (mulberry32) with small helpers. Same seed, same run.
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  range(lo: number, hi: number): number { return lo + this.int(hi - lo + 1); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]; }
  weighted<T>(items: ReadonlyArray<readonly [number, T]>): T {
    const total = items.reduce((a, [w]) => a + w, 0);
    let r = this.next() * total;
    for (const [w, v] of items) { r -= w; if (r < 0) return v; }
    return items[items.length - 1][1];
  }
}
