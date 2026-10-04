// s1 gets go and is composing (Slack tool call takes seconds). s2 (wake or mention) claims same thread+milestone,
// is told "if your post is absent, post now", reads the thread (absent), posts. s1 then posts. Two live posts in A.
import { world, J, WF, check, BOT } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
const g = await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' });
w.clock.advance(3000);
const b = await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's2' });
const posts: string[] = [];
if (b.status === 'already_claimed' && /post now/.test(b.say_to_tony)) posts.push('s2'); // thread read shows nothing yet
posts.push('s1'); // s1 acts on its go
const r1 = await w.engine.ingest({ source: 'slack', delivery_id: 'p-s2', kind: 'message', thread: 'A', sender_id: BOT, attrs: { ts: w.clock.now() } });
const r2 = await w.engine.ingest({ source: 'slack', delivery_id: 'p-s1', kind: 'message', thread: 'A', sender_id: BOT, attrs: { ts: w.clock.now() + 1 } });
const d = await w.peek('delivery', `${J}:A:live`);
check('in-process double post: second session told to post while first holds a fresh go', posts.length === 2, `posts by ${posts.join(',')}; engine: delivery ${d.state} sent_count=${d.sent_count}; second post -> "${r2.say_to_tony}"`);
