// In-process: s1 gets go; s2 (another session) gets already_claimed with "you claimed ... if absent, post now" while s1 is still composing.
import { world, J, WF, check } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
const a = await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' });
w.clock.advance(2000);
const b = await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's2' });
const ti = await w.peek('thread_index', 'A');
check('second session told to post now if absent, 2s after first go; claim has no session', a.status === 'go' && b.status === 'already_claimed' && /post now/.test(b.say_to_tony) && !('session' in ti.claim), `s2: "${b.say_to_tony}" claim=${JSON.stringify(ti.claim)}`);
