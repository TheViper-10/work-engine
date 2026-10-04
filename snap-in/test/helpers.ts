import { createWorkEngine } from '../src/index.ts';
import type { Answer } from '../../src/types.ts';
import { FakePlatform, OWN_BOT, SNAP_IN } from './fake-platform.ts';
import { PlatformStore } from '../src/store-platform.ts';
import { scoped } from '../src/platform.ts';

export const OWNER_SLACK = 'U042GEDM4BB';
export const HARRY = 'U0C4YRX93PS';
export { OWN_BOT, SNAP_IN };

/** The dispatcher under test, wired to the fake. */
export function dispatcher(fake: FakePlatform) {
  const fn = createWorkEngine(fake.deps());
  return {
    /** An operation call exactly as the platform delivers it: caller token only. */
    async call(data: Record<string, unknown>, o: { keyrings?: boolean } = {}): Promise<Answer> {
      const out: any = await fn([fake.opEvent(data, o)]);
      return out.output.values[0].result as Answer;
    },
    async raw(data: Record<string, unknown>): Promise<any> { return fn([fake.opEvent(data)]); },
    async tick(): Promise<void> { await fn([fake.timerEvent()]); },
    fn,
  };
}

export function storeFor(fake: FakePlatform): PlatformStore {
  return new PlatformStore({ api: scoped(fake.deps().devrev(fake.timerEvent()), 'service'), sleep: fake.deps().sleep });
}
