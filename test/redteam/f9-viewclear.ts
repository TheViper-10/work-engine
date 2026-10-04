// job_view (documented read-only) clears wake_reasons; a later checkpoint from the work run then pushes the unblock wake out.
import { world, J, WF, check, MIN, HARRY } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'Q', role: 'qa' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'Q', milestone: 'signoff_requested' }, { session_id: 's1' }); // ask opens
await w.engine.jobView({ job: J }, { session_id: 's1' });
await w.engine.ingest({ source: 'slack', delivery_id: 'signoff', kind: 'message', thread: 'Q', sender_id: HARRY, sender_kind: 'human' });
await w.engine.jobView({ thread: 'A' }, { session_id: 'mentionA' }); // someone asks status in A
const c = await w.engine.checkpoint({ job: J, status: 'waiting', waiting_for: 'Harry sign-off', next_wake_in: '4h' }, { session_id: 's1' });
const j = await w.peek('job', J);
check('Harry sign-off unblock wake lost: next wake 4h after a third session viewed', (j.next_wake_at - w.clock.now()) / MIN >= 239, `next wake in ${(j.next_wake_at - w.clock.now()) / MIN} min; checkpoint said: "${c.say_to_tony.slice(0, 90)}"`);
