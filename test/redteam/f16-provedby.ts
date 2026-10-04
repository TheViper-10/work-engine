// circleci_gate_approved proves both approve_qa_gate and publish_prod_alpha. Same pipeline ref -> late QA webhook verifies the prod publish.
import { world, J, WF, check } from './h.ts';
const w = world('hold');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.intend({ job: J, action: 'approve_qa_gate', ref: 'pipe-395883' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'working', operations: [{ ref: 'pipe-395883', action: 'approve_qa_gate', outcome: 'done' }] }, { session_id: 's1' });
await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'pipe-395883' }, { session_id: 's1' });
await w.engine.ingest({ source: 'circleci', delivery_id: 'late-qa-approval', kind: 'circleci_gate_approved', ref: 'pipe-395883', sender_kind: 'system', attrs: { job: 'approve-desktop-qa-latest' } });
const op = await w.peek('operation', `${J}:publish_prod_alpha:pipe-395883`);
const lease = await w.peek('lease', 'alpha');
check('QA gate webhook marks prod alpha publish webhook_verified done and frees alpha', op.outcome === 'done' && op.source === 'webhook_verified', `publish op=${op.outcome}/${op.source}, alpha holder=${lease.holder_job}`);
