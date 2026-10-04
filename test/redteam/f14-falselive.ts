// Promise due for live to B: playbook says "tell them or say what you are waiting on". The only claim for a post is a milestone.
import { world, J, WF, check } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', role: 'side' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'Q', role: 'qa' }, { session_id: 's1' });
await w.engine.promiseAdd({ job: J, thread: 'B', about: 'live', fallback_time: 10 }, { session_id: 's1' });
// Tony posts "still waiting on sign-off" to B: claims under 'live' (the promise's milestone)
const g = await w.engine.say({ job: J, thread: 'B', milestone: 'live' }, { session_id: 's1' });
const j = await w.peek('job', J);
const v = await w.engine.jobView({ job: J }, { session_id: 's1' });
check('status update claimed as live marks live reached and owes live to A and Q', !!j.milestones.live, `go=${g.status}; milestones=${JSON.stringify(j.milestones)}; owed=${JSON.stringify((v.jobs as any)[0].owed)}`);
// alternative: post unclaimed -> flagged
const w2 = world('flag');
await w2.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B' }, { session_id: 's1' });
const r = await w2.engine.ingest({ source: 'slack', delivery_id: 'u1', kind: 'message', thread: 'B', sender_id: 'UBOT', attrs: { ts: w2.clock.now() } });
check('...or posting the update unclaimed is flagged unclaimed_post', /unclaimed/.test(r.say_to_tony), r.say_to_tony);
