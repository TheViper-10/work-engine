// A mention session in thread B does a read (job_view) and binds the engine's pending wake run; the DM session the engine woke is then 'other'.
import { world, J, WF, check, MIN } from './h.ts';
const w = world('hold');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'waiting', next_wake_in: 10 }, { session_id: 's1' });
w.clock.advance(11 * MIN); const sw = await w.engine.sweep();
const vB = await w.engine.jobView({ thread: 'A' }, { session_id: 'mentionB' }); // a "what's the status?" mention, read only
const vDM = await w.engine.jobView({ job: J }, { session_id: 'dmWake' });
const r = await w.engine.intend({ job: J, action: 'merge_pr', ref: 'pr1' }, { session_id: 'dmWake' });
check('pure read by a mention session binds the wake run; woken DM session is held superseded_run', r.status === 'hold' && /superseded_run/.test(r.say_to_tony), `woke=${JSON.stringify(sw.woke)} mention view work_run=${(vB.jobs as any)[0].work_run} dm view work_run=${(vDM.jobs as any)[0].work_run}; intend=${r.status}`);
