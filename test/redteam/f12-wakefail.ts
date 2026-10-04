import { world, J, WF, check, MIN } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.promiseAdd({ job: J, thread: 'A', about: 'live', fallback_time: 10 }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'waiting', next_wake_in: '4h' }, { session_id: 's1' });
w.clock.advance(11 * MIN); w.wakerFail = true; const s1 = await w.engine.sweep();
w.wakerFail = false; w.clock.advance(2 * MIN); const s2 = await w.engine.sweep();
check('wake failure drops the reason: retry wake no longer says promise due', w.wakes.length === 1 && !/promise due/.test(w.wakes[0].text), `first sweep due=${s1.promises_due}; retry text: "${w.wakes[0]?.text}"`);
