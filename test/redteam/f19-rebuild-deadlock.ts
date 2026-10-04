// hold mode: build changed after the go. Hold says "Ask the responders again for build def". say for the same milestone/thread is already_sent,
// so no new ask opens; intend holds forever.
import { world, J, WF, check, OWNER } from './h.ts';
const w = world('hold');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'A', milestone: 'qa_go_requested' }, { session_id: 's1' });
await w.engine.ingest({ source: 'slack', delivery_id: 'mine', kind: 'message', thread: 'A', sender_id: 'UBOT', attrs: { ts: w.clock.now() + 1 } });
w.builds['approve-desktop-qa-latest'] = 'def';
const h1 = await w.engine.intend({ job: J, action: 'approve_qa_gate', ref: 'p2' }, { session_id: 's1' });
const re = await w.engine.say({ job: J, thread: 'A', milestone: 'qa_go_requested' }, { session_id: 's1' });
await w.engine.ingest({ source: 'slack', delivery_id: 'go2', kind: 'message', thread: 'A', sender_id: OWNER, sender_kind: 'human' });
const h2 = await w.engine.intend({ job: J, action: 'approve_qa_gate', ref: 'p2' }, { session_id: 's1' });
const h3 = await w.engine.intend({ job: J, action: 'approve_qa_gate', ref: 'p2', because: 'slack:go2' }, { session_id: 's1' });
const v = await w.engine.jobView({ job: J }, { session_id: 's1' });
check('re-ask path does not exist: say already_sent, intend holds forever after the owner re-approves', h1.status === 'hold' && re.status === 'already_sent' && h2.status === 'hold' && h3.status === 'hold',
  `hold1=${h1.status}; re-ask say=${re.status} ("${re.say_to_tony}"); after owner go: ${h2.status}/${h3.status}; open asks=${JSON.stringify((v.jobs as any)[0].open_asks)}`);
