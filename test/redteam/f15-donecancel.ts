// flag mode: job closed done; Tony then intends (e.g. re-check served, or complete_release_issue after the done checkpoint).
import { world, J, WF, check } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'done' }, { session_id: 's1' });
const i = await w.engine.intend({ job: J, action: 'complete_release_issue', ref: 'ISS-1' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'done', operations: [{ ref: 'ISS-1', action: 'complete_release_issue', outcome: 'done' }] }, { session_id: 's1' });
const j = await w.peek('job', J);
check('a done release ends recorded as cancelled', j.status === 'cancelled', `intend=${i.status} flags=${JSON.stringify(i.flags)}; final status=${j.status} cancel_reason=${j.cancel_reason}`);
