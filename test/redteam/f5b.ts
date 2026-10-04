import { world, J, WF, check, MIN } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' });
w.posts.length = 0; // reader cannot see it (connector filters bot authors; reader down or missing scope)
await w.engine.checkpoint({ job: J, status: 'done' }, { session_id: 's1' });
let reads = 0; const orig = w.engine['slackReader']; 
let seen = 0;
for (let i = 0; i < 24 * 12; i++) {
  w.clock.advance(5 * MIN); await w.engine.sweep();
  // the woken Tony reads the thread, finds his post, and confirms it with the link (playbook)
  if (w.wakes.length > seen && w.wakes.at(-1).text.includes('posted_link')) { seen = w.wakes.length; await w.engine.say({ job: J, thread: 'A', milestone: 'live', posted_link: 'https://x/live' }, { session_id: 's1' }); }
  seen = w.wakes.length;
}
const j = await w.peek('job', J);
check('closing job with an unseen claim: woken forever, never closes', j.status === 'closing', `status=${j.status}, wakes in 24h=${w.wakes.length}`);
