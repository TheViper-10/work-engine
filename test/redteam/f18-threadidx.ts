import { world, WF, check } from './h.ts';
const w = world('flag');
let reads = 0; const g = w.store.getMany.bind(w.store); w.store.getMany = async (ks: string[]) => { reads += ks.length; return g(ks); };
for (let i = 0; i < 300; i++) {
  const r = await w.engine.jobOpen({ workflow: WF, target: `5.2.${i}`, thread: 'Q', role: 'qa' }, { session_id: 's' + i });
  await w.engine.checkpoint({ job: r.job, status: 'done' }, { session_id: 's' + i });
}
reads = 0;
await w.engine.ingest({ source: 'slack', delivery_id: 'm1', kind: 'message', thread: 'Q', sender_id: 'U1', sender_kind: 'human' });
const ingestReads = reads; reads = 0;
const v = await w.engine.jobView({ thread: 'Q' }, { session_id: 'x' });
check('long-lived thread: every event and view loads every job ever linked (done ones too)', ingestReads >= 300, `ingest batch-read ${ingestReads} keys; job_view returned ${(v.jobs as any[]).length} jobs, ${v.say_to_tony.length} chars`);
