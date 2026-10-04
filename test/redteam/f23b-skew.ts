import { world, J, WF, check, MIN } from './h.ts';
const { MemoryStore } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/store.ts');
const { ManualClock } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/clock.ts');
const store = new MemoryStore(); const t = Date.UTC(2026, 0, 1, 1);
const ca = new ManualClock(t), cb = new ManualClock(t - 6 * MIN);
const sweeper = world('flag', { store, clock: ca }), connector = world('flag', { store, clock: cb });
await sweeper.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await sweeper.engine.checkpoint({ job: J, status: 'waiting', waiting_for: 'Harry', next_wake_in: '4h' }, { session_id: 's1' });
await sweeper.engine.sweep();
await connector.engine.ingest({ source: 'slack', delivery_id: 'harrybot', kind: 'message', thread: 'A', sender_id: 'UHARRY', sender_kind: 'other_bot' });
let wokeAt: number | null = null;
for (let i = 0; i < 60 && wokeAt === null; i++) { ca.advance(5 * MIN); cb.advance(5 * MIN); const s = await sweeper.engine.sweep(); if ((s.woke as string[]).includes(J)) wokeAt = ca.now(); }
check('ingest instance 6 min behind sweeper: other-bot unblock lands behind the cursor; woken only by the old 30-min/4h entry', wokeAt === null || (wokeAt - t) / MIN > 10, `woke after ${wokeAt ? (wokeAt - t) / MIN : 'never'} min`);
