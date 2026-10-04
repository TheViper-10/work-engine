// ingest writes the dedupe record first, then does the work. A crash (throw) after that loses the event: redelivery is "duplicate".
import { world, J, WF, check, HARRY } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'Q', role: 'qa' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'Q', milestone: 'signoff_requested' }, { session_id: 's1' });
await w.engine.checkpoint({ job: J, status: 'waiting', next_wake_in: '4h' }, { session_id: 's1' });
const put = w.store.put.bind(w.store); let boom = true;
w.store.put = async (k: string, v: any) => { if (boom && k.includes(':job:')) { boom = false; throw new Error('function timeout'); } return put(k, v); };
let first = ''; try { await w.engine.ingest({ source: 'slack', delivery_id: 'harry-yes', kind: 'message', thread: 'Q', sender_id: HARRY, sender_kind: 'human' }); } catch (e) { first = (e as Error).message; }
const again = await w.engine.ingest({ source: 'slack', delivery_id: 'harry-yes', kind: 'message', thread: 'Q', sender_id: HARRY, sender_kind: 'human' });
const j = await w.peek('job', J);
check('crash mid-ingest then retry: event deduped away, unblock wake lost', again.status === 'duplicate' && j.wake_reasons.length === 0, `first=${first}; retry=${again.status}; job next wake in ${Math.round((j.next_wake_at - w.clock.now()) / 60000)} min`);
