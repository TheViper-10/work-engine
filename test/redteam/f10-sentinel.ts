// Source read fails when the ask opens -> build recorded as 'unknown'; later fresh read 'abc' != 'unknown' -> build_changed hold.
import { world, J, WF, check } from './h.ts';
const w = world('hold');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
w.sourceFail = true;
await w.engine.say({ job: J, thread: 'A', milestone: 'qa_go_requested' }, { session_id: 's1' });
w.sourceFail = false; // build never changed, it was 'abc' all along
const r = await w.engine.intend({ job: J, action: 'approve_qa_gate', ref: 'p1' }, { session_id: 's1' });
check('false build_changed hold from the unknown sentinel', r.status === 'hold', r.say_to_tony.slice(0, 160));
