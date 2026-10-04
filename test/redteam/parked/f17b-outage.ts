// L1 (parked): a 15-day outage is longer than one sweep window. Phase 3 sweeps scan a bounded catch-up window.
import { world, J, WF, check, MIN } from '../h.ts';
// (b) downtime longer than MAX_BUCKETS_PER_SWEEP (14 days)
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'waiting', next_wake_in: 30 }, { session_id: 's1' });
w.clock.advance(15 * 1440 * MIN);
let w2 = 0; for (let i = 0; i < 12; i++) { const s = await w.engine.sweep(); w2 += (s.woke as string[]).length; w.clock.advance(5 * MIN); }
const j = await w.peek('job', J);
check('(b) 15-day outage: job with next_wake_at in the past is never woken again', w2 === 0, `next_wake_at overdue by ${Math.round((w.clock.now() - j.next_wake_at) / MIN / 1440)} days, wakes=${w2}`);
