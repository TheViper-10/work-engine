// Playbook cancel instruction: "operation still in flight marked unknown if you cannot tell". unknown keeps lease and blocks finish.
import { world, J, WF, check, MIN } from './h.ts';
const w = world('hold');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's1' });
const q = await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', intent: 'queue' }, { session_id: 's2' });
await w.engine.checkpoint({ job: J, status: 'cancelled', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'unknown', note: 'cannot tell' }] }, { session_id: 's1' });
let wakes = 0;
for (let i = 0; i < 48; i++) { w.clock.advance(60 * MIN); await w.engine.sweep(); }
const j = await w.peek('job', J), qj = await w.peek('job', q.job), lease = await w.peek('lease', 'alpha');
await w.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D' }, { session_id: 's3' });
const t2 = await w.engine.intend({ job: 'desktop-release:T2', action: 'publish_prod_alpha', ref: 'b9' }, { session_id: 's3' });
check('cancel with unknown outcome (as the playbook says): 48h later job cancel_requested, alpha leased, queued job never opens, other release held',
  j.status === 'cancel_requested' && lease.holder_job === J && qj.status === 'queued' && t2.status === 'hold',
  `job=${j.status} lease=${lease.holder_job} queued=${qj.status} T2 intend=${t2.status} wakes to cancelled job=${w.wakes.filter((x: any) => x.dm === 'dm:' + J).length}`);
// variant: Tony never reports; sweep turns it unknown; lease still held
const w2 = world('hold');
await w2.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w2.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's1' });
w2.clock.advance(40 * MIN); await w2.engine.sweep();
await w2.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D' }, { session_id: 's3' });
const h = await w2.engine.intend({ job: 'desktop-release:T2', action: 'publish_prod_alpha', ref: 'b9' }, { session_id: 's3' });
check('timeout to unknown keeps lease; lease_held hold with no re-read (D7) and no expiry', h.status === 'hold', h.say_to_tony.slice(0, 160));
