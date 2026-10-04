// Own-bot event without attrs.ts (an earlier unclaimed post delivered late) matches a fresh claim.
import { world, J, WF, check, BOT, MIN } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' });
await w.engine.ingest({ source: 'slack', delivery_id: 'old-post-late', kind: 'message', thread: 'A', sender_id: BOT });
const d = await w.peek('delivery', `${J}:A:live`);
check('late event with no ts marks the new live claim sent before Tony posts', d.state === 'sent', `delivery=${d.state}`);
