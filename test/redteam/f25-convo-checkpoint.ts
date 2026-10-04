// Playbook: every session checkpoints before it ends. Conversation session's checkpoint overwrites the work run's next wake.
import { world, J, WF, check, MIN } from './h.ts';
const w = world('hold');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 'work' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'B', role: 'side' }, { session_id: 'work' });
await w.engine.intend({ job: J, action: 'approve_qa_gate', ref: 'p1' }, { session_id: 'work' });
await w.engine.checkpoint({ job: J, status: 'waiting', waiting_for: 'QA publish job', next_wake_in: 5 }, { session_id: 'work' });
const c = await w.engine.checkpoint({ job: J, status: 'answered B', waiting_for: 'nothing for B', next_wake_in: '4h' }, { session_id: 'convoB' });
w.clock.advance(6 * MIN); const s = await w.engine.sweep();
const j = await w.peek('job', J);
check('conversation session clobbers the work run 5-min pipeline wake to 4h; also cancels/finishes with no hold', !(s.woke as string[]).includes(J) && j.waiting_for === 'nothing for B', `sweep woke=${JSON.stringify(s.woke)}; waiting_for="${j.waiting_for}"; next wake in ${Math.round((j.next_wake_at - w.clock.now()) / MIN)} min; convo status=${c.status}`);
const x = await w.engine.checkpoint({ job: J, status: 'cancelled' }, { session_id: 'convoC' });
check('...and a non-work-run session can cancel the job with checkpoint (no flag beyond not_work_run)', ['cancel_requested', 'cancelled'].includes(x.job_status as string), `job_status=${x.job_status}`);
