// Connector and reader both miss Tony's post (connector filters bot authors today): claim never resolves,
// every other milestone in the thread is busy forever, job stays closing forever. No call lets Tony mark it sent.
import { world, J, WF, check, MIN } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'A', milestone: 'merged' }, { session_id: 's1' }); // posted, never seen
let last: any;
for (let h = 0; h < 48; h++) { w.clock.advance(60 * MIN); await w.engine.sweep(); last = await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' }); }
const c = await w.engine.checkpoint({ job: J, status: 'done' }, { session_id: 's1' });
check('48h later: live to A still busy, job cannot close', last.status === 'busy' && c.job_status === 'closing', `say=${last.status}; checkpoint=${c.job_status}: ${c.say_to_tony.slice(0, 120)}`);
