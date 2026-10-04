import { world, check, WF, J } from './h.ts';
// Tony posts a status update ("still waiting on sign-off") to B that is not a milestone. If it is claimed under
// 'live', the engine marks live reached and owes live to A and Q. The playbook now says to claim a status update
// under a non-milestone id (status_update); the engine must then leave milestones and owed deliveries alone.
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', role: 'side' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'Q', role: 'qa' }, { session_id: 's1' });
await w.engine.promiseAdd({ job: J, thread: 'B', about: 'live', fallback_time: 10 }, { session_id: 's1' });
const g = await w.engine.say({ job: J, thread: 'B', milestone: 'status_update' }, { session_id: 's1' });
const j = await w.peek('job', J);
const v = await w.engine.jobView({ job: J }, { session_id: 's1' });
check('a status update claimed under its own id marks live reached or owes live to A and Q', !!j.milestones.live || (v.jobs as any[])[0].owed.length > 0, `go=${g.status}; milestones=${JSON.stringify(j.milestones)}; owed=${JSON.stringify((v.jobs as any)[0].owed)}`);
// an unclaimed post must not create owed deliveries either, and the claim closes once the post is seen
const w2 = world('flag');
await w2.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B' }, { session_id: 's1' });
await w2.engine.say({ job: J, thread: 'B', milestone: 'status_update' }, { session_id: 's1' });
w2.clock.advance(1000);
await w2.engine.ingest({ source: 'slack', delivery_id: 'u1', kind: 'message', thread: 'B', sender_id: 'UBOT', attrs: { ts: w2.clock.now() } });
const c = await w2.peek('claim', 'B'); const d = await w2.peek('delivery', `${J}:B:status_update`);
check('the status update post is not matched to its claim', !(c.state === 'closed' && d.state === 'sent'), `claim=${c.state} delivery=${d.state}`);
