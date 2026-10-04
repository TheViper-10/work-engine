import type { Clock } from './types.ts';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Deterministic clock for tests and the simulator. */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  advanceMinutes(min: number): void {
    this.t += min * 60_000;
  }
}
