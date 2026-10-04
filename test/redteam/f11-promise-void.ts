// B asked "tell me when live". Tony checkpoints done without reporting live reached (run 6 shape). Job closes; B's promise voided, never told.
import { world, J, WF, check } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', role: 'side' }, { session_id: 's1' });
await w.engine.promiseAdd({ job: J, thread: 'B', about: 'live', fallback_time: '4h' }, { session_id: 's1' });
const c = await w.engine.checkpoint({ job: J, status: 'done' }, { session_id: 's1' });
const p = await w.peek('promise', `${J}:B:live`);
check('done closes with an open promise; promise voided silently', c.job_status === 'done' && p.state === 'void', `job=${c.job_status} promise=${p.state} answer="${c.say_to_tony}"`);
