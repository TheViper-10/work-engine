import { world, J, WF, check, MIN, HARRY } from './h.ts';
const { MemoryStore } = await import(new URL('../../src/store.ts', import.meta.url).href);
const { ManualClock } = await import(new URL('../../src/clock.ts', import.meta.url).href);
const store = new MemoryStore(); const t = Date.UTC(2026, 0, 1, 1);
const ca = new ManualClock(t), cb = new ManualClock(t - 6 * MIN);
const sweeper = world('flag', { store, clock: ca }), connector = world('flag', { store, clock: cb });
await sweeper.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'Q', role: 'qa' }, { session_id: 's1' });
await sweeper.engine.say({ job: J, thread: 'Q', milestone: 'signoff_requested' }, { session_id: 's1' });
await sweeper.engine.ingest({ source: 'slack', delivery_id: 'own', kind: 'message', thread: 'Q', sender_id: 'UBOT', attrs: { ts: t + 1 } });
await sweeper.engine.checkpoint({ job: J, status: 'waiting', waiting_for: 'Harry', next_wake_in: '4h' }, { session_id: 's1' });
await sweeper.engine.sweep(); // cursor at now
await connector.engine.ingest({ source: 'slack', delivery_id: 'harry-yes', kind: 'message', thread: 'Q', sender_id: HARRY, sender_kind: 'human' });
let wokeAt: number | null = null;
for (let i = 0; i < 60 && wokeAt === null; i++) { ca.advance(5 * MIN); cb.advance(5 * MIN); const s = await sweeper.engine.sweep(); if ((s.woke as string[]).includes(J)) wokeAt = ca.now(); }
check('ingest instance 6 min behind the sweeper: Harry sign-off unblock written into a swept bucket; wake comes only at the 4h timer', wokeAt !== null && (wokeAt - t) / MIN >= 235, `woke after ${wokeAt ? (wokeAt - t) / MIN : 'never'} min`);
