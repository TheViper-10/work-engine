// Playbook cancel instruction: "operation still in flight marked unknown if you cannot tell". unknown keeps lease and blocks finish.
// Updated for R22 (supersedes R17 H5 release-on-cancel): the cancel now ends as cancelled with cleanup_pending, the lease stays
// held until readback, and the real defect to guard against is a lease held with no wake or escalation. Repro = that silent state.
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
  lease.holder_job === J && (w.wakes.filter((x: any) => x.dm === 'dm:' + J).length === 0 || !j.cleanup_escalated || j.cleanup_pending.length === 0 || t2.status !== 'hold'),
  `job=${j.status} lease=${lease.holder_job} queued=${qj.status} T2 intend=${t2.status} wakes to cancelled job=${w.wakes.filter((x: any) => x.dm === 'dm:' + J).length}`);
// variant: Tony never reports; sweep turns it unknown and WAKES the job to verify; once Tony reports, alpha is free
const w2 = world('hold');
await w2.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w2.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's1' });
w2.clock.advance(40 * MIN); await w2.engine.sweep();
const woke = w2.wakes.some((x: any) => x.dm === 'dm:' + J && /unknown/.test(x.text) && /verify/i.test(x.text));
await w2.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D' }, { session_id: 's3' });
const h = await w2.engine.intend({ job: 'desktop-release:T2', action: 'publish_prod_alpha', ref: 'b9' }, { session_id: 's3' });
await w2.engine.checkpoint({ job: 'desktop-release:T2', status: 'waiting', waiting_for: 'alpha', next_wake_in: '4h' }, { session_id: 's3' }); // playbook: checkpoint after a hold
await w2.engine.checkpoint({ job: J, status: 'working', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'failed' }] }, { session_id: 's1' });
w2.clock.advance(6 * MIN); await w2.engine.sweep();
const h2 = await w2.engine.intend({ job: 'desktop-release:T2', action: 'publish_prod_alpha', ref: 'b9' }, { session_id: 's3' });
const woke2 = w2.wakes.some((x: any) => x.dm === 'dm:desktop-release:T2' && /free/.test(x.text));
check('timeout to unknown: no wake to verify, or the lease stays held after the outcome is reported, or the held job is not woken', !woke || h.status !== 'hold' || h2.status !== 'clear' || !woke2, `woke=${woke} first=${h.status} after report=${h2.status} T2 woken=${woke2}`);
