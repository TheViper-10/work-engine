// Mention-reply relay (no say) lands in a thread with an open claim: claim marked sent, milestone never posted.
import { world, J, WF, check, BOT } from './h.ts';
const w = world('flag');
await w.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w.engine.say({ job: J, thread: 'A', milestone: 'live' }, { session_id: 's1' });
w.clock.advance(5000);
const r = await w.engine.ingest({ source: 'slack', delivery_id: 'relay1', kind: 'message', thread: 'A', sender_id: BOT, attrs: { relay: true, session: 'mention-session', ts: w.clock.now(), link: 'https://x/mention-answer' } });
const d = await w.peek('delivery', `${J}:A:live`);
check('relay of a mention answer satisfies the live claim', d.state === 'sent' && d.seen_via === 'relay', `delivery=${d.state} via ${d.seen_via}; ${r.say_to_tony}`);
// sweep variant: reader returns any own post after claim time
const w2 = world('flag');
await w2.engine.jobOpen({ workflow: WF, target: 'T1', thread: 'A' }, { session_id: 's1' });
await w2.engine.say({ job: J, thread: 'A', milestone: 'qa_ready' }, { session_id: 's1' });
w2.posts.push({ thread: 'A', ts: w2.clock.now() + 1000, link: 'https://x/unrelated-reply', relay: true }); // the mention reply (the reader marks replies to mentions), not the milestone
w2.clock.advance(6 * 60000);
await w2.engine.sweep();
const d2 = await w2.peek('delivery', `${J}:A:qa_ready`);
check('sweep reconcile matches an unrelated own post', d2.state === 'sent', `delivery=${d2.state} link=${d2.message_link}`);
