// Cross-process: two engine instances (two snap-in invocations) share one store. No CAS anywhere.
import { world, J, WF, check, MIN } from './h.ts';
const { MemoryStore } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/store.ts');
const { ManualClock } = await import('/Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine/src/clock.ts');
const store = new MemoryStore(); const clock = new ManualClock(Date.UTC(2026, 0, 1));
const e1 = world('flag', { store, clock }), e2 = world('flag', { store, clock });
await e1.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await e1.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', role: 'side' }, { session_id: 's1' });
const [a, b] = await Promise.all([
  e1.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' }),
  e2.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's2' }),
]);
check('two instances: both sessions get go for the same thread+milestone', a.status === 'go' && b.status === 'go', `${a.status}/${b.status}`);
// lost unblock wake: ingest (sets next wake now) races checkpoint (sets +4h)
const w3 = world('flag', { store: new MemoryStore(), clock }); const w4 = world('flag', { store: w3.store, clock });
await w3.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'Q', role: 'qa' }, { session_id: 's1' });
await w3.engine.say({ job: J, thread: 'Q', milestone: 'signoff_requested' }, { session_id: 's1' });
await Promise.all([
  w3.engine.checkpoint({ job: J, status: 'waiting', waiting_for: 'Harry', next_wake_in: '4h' }, { session_id: 's1' }),
  w4.engine.ingest({ source: 'slack', delivery_id: 'h1', kind: 'message', thread: 'Q', sender_id: 'U0C4YRX93PS', sender_kind: 'human' }),
]);
const j = await w3.peek('job', J);
check('two instances: unblock wake lost to a concurrent checkpoint', j.next_wake_at - clock.now() > 60 * MIN && j.wake_reasons.length === 0, `next wake in ${(j.next_wake_at - clock.now()) / MIN} min, reasons=${JSON.stringify(j.wake_reasons)}`);
