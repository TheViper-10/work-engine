// R49: every route an adapter calls is listed in IDENTITY.md with an identity, and what actually ran against the fake matches it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { ALLOWED, FakePlatform } from './fake-platform.ts';
import { dispatcher } from './helpers.ts';

const DOC = readFileSync(new URL('../IDENTITY.md', import.meta.url), 'utf8');
interface Row { route: string; timer: string; operation: string }
/** Rows of the identity table: | `route` | timer | operation | reason | proven | */
function table(): Row[] {
  return DOC.split('\n').filter((l) => /^\| `[^`]+` \|/.test(l)).map((l) => {
    const c = l.split('|').map((x) => x.trim());
    return { route: c[1].replaceAll('`', ''), timer: c[2], operation: c[3] };
  });
}
const SRC = new URL('../src/', import.meta.url);
const called = (): string[] => {
  const out = new Set<string>();
  for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) {
    for (const m of readFileSync(new URL(f, SRC), 'utf8').matchAll(/\.call\('([a-z.-]+)'/g)) out.add(m[1]);
  }
  return [...out].sort();
};
const WF = 'desktop-release';

test('R49: every DevRev route the adapters call is in IDENTITY.md with a timer and an operation identity', () => {
  const rows = table();
  for (const route of called()) {
    const r = rows.find((x) => x.route === route);
    assert.ok(r, `${route} is missing from IDENTITY.md`);
    assert.match(r.timer, /^(service|owner|caller|none)\b/, `${route} timer identity`);
    assert.match(r.operation, /^(service|owner|caller|none|n\/a)\b/, `${route} operation identity`);
  }
  for (const r of rows) if (!['conversations.replies', 'github GET'].includes(r.route)) assert.ok(called().includes(r.route), `${r.route} is listed but no adapter calls it`);
});

test('R49: only work_record/work_event custom objects use the service account; every other platform call uses the owner token or the caller token', async () => {
  const f = new FakePlatform(); const d = dispatcher(f);
  const mention = f.newMentionDm();
  await d.call({ call: 'job_open', workflow: WF, target: '5.2.11', thread: `${ALLOWED}:1.000001`, role: 'request', intent: 'join', requester: 'U1', agent_session_id: mention.session });
  await d.tick(); f.clock.advanceMinutes(2); await d.tick(); f.clock.advanceMinutes(6); await d.tick();
  const rows = table();
  const seen = new Set<string>();
  for (const l of f.log) {
    const r = rows.find((x) => x.route === l.path); assert.ok(r, `${l.path} is not in the table`);
    seen.add(l.path);
    const allowed = r.timer.split(/[ ,/]+/)[0];
    const opAllowed = r.operation.split(/[ ,/]+/)[0];
    assert.ok(l.as === allowed || l.as === opAllowed, `${l.path} ran as ${l.as}; the table says timer ${r.timer}, operation ${r.operation}`);
    if (l.as === 'service') assert.ok(/^(custom-objects|objects\.list|snap-ins\.get)/.test(l.path), `the service account must not reach ${l.path}`);
  }
  for (const route of ['ai-agents.get', 'timeline-entries.list', 'chats.create', 'chats.update', 'workflows.trigger', 'dev-users.self']) {
    assert.ok(seen.has(route), `${route} ran in the journey`);
    assert.ok(f.log.filter((l) => l.path === route).every((l) => l.as === 'owner'), `${route} runs as the owner token`);
  }
});
