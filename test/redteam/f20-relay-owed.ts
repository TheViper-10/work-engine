// Playbook: mention reply needs no say. B (promise for live) mentions "is it live?"; Tony answers "yes" via relay. Delivery stays owed -> engine wakes "still owed: live to B" -> second post.
import { world, J, WF, check, BOT, MIN } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', role: 'side' }, { session_id: 's1' });
await w.engine.promiseAdd({ job: J, thread: 'B', about: 'live', fallback_time: '4h' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'working', reached: ['live'] }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'B', milestone: 'live' }, { session_id: 's1' }); // playbook: say first when the reply tells the thread a milestone
w.clock.advance(1000);
await w.engine.ingest({ source: 'slack', delivery_id: 'relayB', kind: 'message', thread: 'B', sender_id: BOT, attrs: { relay: true, session: 's1', ts: w.clock.now() + 1 } });
const c = await w.engine.checkpoint({ job: J, status: 'done' }, { session_id: 's1' });
w.clock.advance(31 * MIN); await w.engine.sweep();
check('mention reply to B relayed; live still owed to B; job closing; wake asks Tony to post live again', /live to B/.test(c.say_to_tony) && w.wakes.some((x: any) => /live to B/.test(x.text)), `checkpoint: "${c.say_to_tony.slice(0, 110)}"; wake: "${w.wakes.at(-1)?.text.slice(0, 90)}"`);
