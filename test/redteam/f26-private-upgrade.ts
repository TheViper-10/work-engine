import { world, J, WF, check } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'C', role: 'side' }, { session_id: 's1' });
const r = await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'C', role: 'side', private: true }, { session_id: 's1' });
await w.engine.ingest({ source: 'slack', delivery_id: 'secret_C', kind: 'message', thread: 'C', sender_id: 'U1', sender_kind: 'human' });
const v = await w.engine.jobView({ thread: 'A' }, { session_id: 's1' });
check('private:true on an already linked thread is silently ignored; C evidence visible in A', JSON.stringify(v).includes('secret_C'), `job_open said: "${r.say_to_tony.split('\n').slice(0, 2).join(' ')}"`);
