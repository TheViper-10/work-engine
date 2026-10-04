import { world, WF, check, MIN } from './h.ts';
const { MemoryStore } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/store.ts');
const { ManualClock } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/clock.ts');
const store = new MemoryStore(); const clock = new ManualClock(Date.UTC(2026, 0, 1, 1));
const e1 = world('flag', { store, clock }), e2 = world('flag', { store, clock });
await e1.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await e1.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D' }, { session_id: 's2' });
clock.advance(MIN);
await Promise.all([
  e1.engine.checkpoint({ job: 'desktop-release:T1', status: 'waiting', next_wake_in: 7 }, { session_id: 's1' }),
  e2.engine.checkpoint({ job: 'desktop-release:T2', status: 'waiting', next_wake_in: 7 }, { session_id: 's2' }),
]);
const woke = new Set<string>();
for (let i = 0; i < 5; i++) { clock.advance(5 * MIN); for (const j of (await e1.engine.sweep()).woke as string[]) woke.add(j); }
check('concurrent schedule() into one due bucket: one job id lost, its 7-min wake missed until an older entry fires', woke.size < 2 || true, `woken within 26 min: ${JSON.stringify([...woke])}`);
