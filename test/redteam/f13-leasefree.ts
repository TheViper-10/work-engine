// L1/file 27 §1: "wakes Tony when ... a lease frees". T2 held on lease_held; T1 releases alpha; T2 gets no wake.
import { world, J, WF, check, MIN } from './h.ts';
const w = world('hold');
const J2 = 'desktop-release:T2';
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D' }, { session_id: 's2' });
await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's1' });
const h = await w.engine.intend({ job: J2, action: 'publish_prod_alpha', ref: 'b2' }, { session_id: 's2' });
await w.engine.checkpoint({ job: J2, status: 'waiting', waiting_for: 'alpha', next_wake_in: '4h' }, { session_id: 's2' });
w.clock.advance(MIN);
await w.engine.checkpoint({ job: J, status: 'working', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'done' }] }, { session_id: 's1' });
w.clock.advance(6 * MIN); await w.engine.sweep();
const j2 = await w.peek('job', J2);
const q = await w.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D', intent: 'queue' }, { session_id: 's2' });
check('lease freed, held job not woken (next wake still ~4h); "open with intent queue" next move is a no-op across targets', h.status === 'hold' && (j2.next_wake_at - w.clock.now()) / MIN > 200 && w.wakes.every((x: any) => x.dm !== 'dm:' + J2), `T2 next wake in ${Math.round((j2.next_wake_at - w.clock.now()) / MIN)} min, wake_reasons=${JSON.stringify(j2.wake_reasons)}; job_open queue -> ${q.status}`);
