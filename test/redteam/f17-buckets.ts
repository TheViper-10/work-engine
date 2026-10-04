import { world, J, WF, check, MIN } from './h.ts';
const { MemoryStore } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/store.ts');
const { ManualClock } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/clock.ts');
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
// (b) downtime longer than MAX_BUCKETS_PER_SWEEP (14 days)
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'waiting', next_wake_in: 30 }, { session_id: 's1' });
w.clock.advance(15 * 1440 * MIN);
let w2 = 0; for (let i = 0; i < 12; i++) { const s = await w.engine.sweep(); w2 += (s.woke as string[]).length; w.clock.advance(5 * MIN); }
const j = await w.peek('job', J);
check('(b) 15-day outage: job with next_wake_at in the past is never woken again', w2 === 0, `next_wake_at overdue by ${Math.round((w.clock.now() - j.next_wake_at) / MIN / 1440)} days, wakes=${w2}`);
