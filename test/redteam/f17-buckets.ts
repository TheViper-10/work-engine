import { world, J, WF, check, MIN } from './h.ts';
const { MemoryStore } = await import(new URL('../../src/store.ts', import.meta.url).href);
const { ManualClock } = await import(new URL('../../src/clock.ts', import.meta.url).href);
// (a) clock skew: writer instance 6 min behind the sweeper
const store = new MemoryStore(); const ca = new ManualClock(Date.UTC(2026, 0, 1, 1)); const cb = new ManualClock(Date.UTC(2026, 0, 1, 1) - 6 * MIN);
const sweeper = world('flag', { store, clock: ca }), writer = world('flag', { store, clock: cb });
await sweeper.engine.jobOpen({ workflow: WF, target: 'T9', thread: 'X' }, { session_id: 'sx' });
await sweeper.engine.sweep();
await writer.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await writer.engine.checkpoint({ job: J, status: 'waiting', next_wake_in: 0 }, { session_id: 's1' }); // wake me now
let woke = false;
for (let i = 0; i < 24; i++) { ca.advance(5 * MIN); cb.advance(5 * MIN); const s = await sweeper.engine.sweep(); if ((s.woke as string[]).includes(J)) woke = true; }
check('(a) 6-min clock skew: "wake me now" written behind the cursor is never swept in 2h', !woke, `woke=${woke}, wakes=${sweeper.wakes.length + writer.wakes.length}`);
