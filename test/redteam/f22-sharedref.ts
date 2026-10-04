// checkpoint operation without action matches every op with that ref. Playbook: ref = pipeline or build.
import { world, J, WF, check } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.intend({ job: J, action: 'verify_qa', ref: '5.2.9' }, { session_id: 's1' });
await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: '5.2.9' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'working', operations: [{ ref: '5.2.9', outcome: 'done', note: 'QA serves it' }] }, { session_id: 's1' });
const op = await w.peek('operation', `${J}:publish_prod_alpha:5.2.9`), lease = await w.peek('lease', 'alpha');
check('QA verify outcome without action closes the in-flight prod publish and frees alpha', op.outcome === 'done' && !lease.holder_job, `publish=${op.outcome} note="${op.note}" alpha=${lease.holder_job}`);
