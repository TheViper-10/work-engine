// intend returns already_recorded BEFORE any check: (a) a second, non-work-run session gets no superseded_run hold
// for the same action+ref; (b) a retry after "failed" is swallowed: no checks, no lease.
import { world, J, WF, check } from './h.ts';
for (const mode of ['hold'] as const) {
  const w = world(mode);
  await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
  const a = await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's1' });
  const b = await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's2' });
  check('(a) s2 (not work run) same action+ref under hold config is not held', a.status === 'clear' && b.status !== 'hold', `s1=${a.status} s2=${b.status} flags=${JSON.stringify(b.flags)} say="${b.say_to_tony}"`);
  // (b) report failed, another job takes alpha, retry same ref
  await w.engine.checkpoint({ job: J, status: 'working', operations: [{ ref: 'b1', action: 'publish_prod_alpha', outcome: 'failed' }] }, { session_id: 's1' });
  await w.engine.jobOpen({ workflow: WF, target: 'T2', thread: 'D' }, { session_id: 's9' });
  const other = await w.engine.intend({ job: 'desktop-release:T2', action: 'publish_prod_alpha', ref: 'b2' }, { session_id: 's9' });
  const retry = await w.engine.intend({ job: J, action: 'publish_prod_alpha', ref: 'b1' }, { session_id: 's1' });
  const lease = await w.peek('lease', 'alpha');
  check('(b) retry after failed while T2 holds alpha: no lease_held hold, nothing in flight', other.status === 'clear' && retry.status === 'already_recorded', `retry=${retry.status} "${retry.say_to_tony}" lease holder=${lease.holder_job}`);
}
