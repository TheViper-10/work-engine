import { readFileSync } from 'node:fs';
const R = '/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine';
const { Engine } = await import(R + '/src/engine.ts');
const { MemoryStore, makeKey } = await import(R + '/src/store.ts');
const { ManualClock } = await import(R + '/src/clock.ts');
const { defineConfig, CHECK_NAMES } = await import(R + '/src/config.ts');
export const spec = JSON.parse(readFileSync(R + '/workflows/desktop-release/spec.json', 'utf8'));
export const WF = 'desktop-release', J = 'desktop-release:T1', BOT = 'UBOT', OWNER = 'U042GEDM4BB', HARRY = 'U0C4YRX93PS', MIN = 60000;
export function world(mode: 'flag' | 'hold' = 'flag', opts: { store?: any; clock?: any } = {}) {
  const w: any = { builds: { 'approve-desktop-qa-latest': 'abc', 'approve-desktop-prod-alpha': 'abc', pr_review: 'abc' }, sourceFail: false, posts: [] as any[], wakes: [] as any[], wakerFail: false };
  w.store = opts.store ?? new MemoryStore();
  w.clock = opts.clock ?? new ManualClock(Date.UTC(2026, 0, 1));
  const checks = Object.fromEntries(CHECK_NAMES.map((n: string) => [n, mode]));
  w.engine = new Engine({
    store: w.store, clock: w.clock,
    sourceReader: { currentBuild: async (_j: any, g: string) => { if (w.sourceFail) throw new Error('down'); return w.builds[g] ?? null; } },
    slackReader: { findOwnPostAfter: async (t: string, ts: number) => w.posts.find((p: any) => p.thread === t && p.ts >= ts) ?? null },
    waker: { postWake: async (dm: string, text: string) => { if (w.wakerFail) throw new Error('slack down'); w.wakes.push({ dm, text, at: w.clock.now() }); } },
    config: defineConfig({ env: 'sim', bot: 'bot', ownBotUserId: BOT, checks }), specs: [spec],
  });
  w.peek = (kind: string, id: string) => w.store.get(makeKey('sim', 'bot', kind, id));
  return w;
}
export function check(name: string, cond: boolean, detail = '') { console.log(`${cond ? 'REPRODUCED' : 'not reproduced'}: ${name}${detail ? ' :: ' + detail : ''}`); }
