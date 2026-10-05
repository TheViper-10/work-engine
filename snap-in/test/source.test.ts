import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubSourceReader, GithubSourceError } from '../src/source.ts';
import { FakePlatform } from './fake-platform.ts';

const BRANCH = 'mock/tony-desktop-release';
function readerFor(f: FakePlatform, repo = 'devrev/devrev-web') {
  return new GithubSourceReader({ api: f.deps().github(f.timerEvent()), repo, branch: BRANCH, statePath: 'mock-release/state.json', prGates: ['pr_review'] });
}
const job = { id: 'desktop-release:5.2.11', workflow: 'desktop-release', target: '5.2.11' };

test('merge-dependent gates read the branch head sha', async () => {
  const f = new FakePlatform();
  assert.equal(await readerFor(f).currentBuild(job, 'approve-desktop-qa-latest'), '39f8a8c8');
  assert.deepEqual(f.githubRequests, [{ method: 'GET', path: `/repos/devrev/devrev-web/commits?sha=${encodeURIComponent(BRANCH)}&per_page=10` }]);
});

test('the pr_review gate reads the open PR head sha against the mock base', async () => {
  const f = new FakePlatform(); f.prs = [{ number: 7, head: { sha: 'abcdef0123456789' }, base: { ref: BRANCH } }];
  assert.equal(await readerFor(f).currentBuild(job, 'pr_review'), 'abcdef01');
  assert.ok(f.githubRequests[0].path.includes(`base=${encodeURIComponent(BRANCH)}`) && f.githubRequests[0].path.includes('state=open'));
});

test('no open PR, API failure, or missing token all read as null (source_unreadable)', async () => {
  const f = new FakePlatform();
  assert.equal(await readerFor(f).currentBuild(job, 'pr_review'), null);
  f.failGithub();
  assert.equal(await readerFor(f).currentBuild(job, 'approve-desktop-qa-latest'), null);
  const bare = new GithubSourceReader({ api: f.deps().github({ input_data: { resources: { keyrings: {} } } }), repo: 'devrev/devrev-web', branch: BRANCH, statePath: 'mock-release/state.json' });
  f.failGithub(false);
  assert.equal(await bare.currentBuild(job, 'x'), null);
});

test('served state is decoded from the contents API on the mock branch', async () => {
  const f = new FakePlatform();
  assert.deepEqual(await readerFor(f).servedState(), { qa: { latest: '5.2.10' }, prod: { alpha: '5.2.10' } });
  assert.ok(f.githubRequests[0].path.endsWith(`?ref=${encodeURIComponent(BRANCH)}`));
  f.stateFile = 'not json at all'; (f as any).stateFile = undefined;
});

test('the adapter is GET-only and confined to one repo and one branch', async () => {
  const f = new FakePlatform();
  const r = readerFor(f) as any;
  for (const bad of [
    '/repos/devrev/other/commits/main',
    `/repos/devrev/devrev-web/commits/main`,
    `/repos/devrev/devrev-web/commits?sha=main&per_page=10`,
    `/repos/devrev/devrev-web/pulls?base=main&state=open`,
    `/repos/devrev/devrev-web/contents/package.json?ref=${encodeURIComponent(BRANCH)}`,
    `/repos/devrev/devrev-web/contents/mock-release/state.json?ref=main`,
    `/repos/devrev/devrev-web/git/refs`,
    `/repos/devrev/devrev-web/commits/${encodeURIComponent(BRANCH)}/../main`,
  ]) assert.throws(() => r.guard(bad), GithubSourceError, bad);
  assert.equal(f.githubRequests.length, 0);
  assert.ok(f.githubRequests.every((x) => x.method === 'GET'));
});

// ---- R57 (live run 1 F7): real-shaped GitHub responses for the mock branch
import { readFileSync } from 'node:fs';
import { SnapshotSourceReader } from '../src/source.ts';
import { storeFor, dispatcher } from './helpers.ts';
import { ALLOWED, OWN_BOT } from './fake-platform.ts';
const REAL = JSON.parse(readFileSync(new URL('./fixtures/mock-branch-commits.json', import.meta.url), 'utf8'));

test('F7: the branch head is the [skip ci] state commit; the build is the newest commit that is not (live: 1bbe07cf head, f32f69b2 build)', async () => {
  const f = new FakePlatform(); f.branchCommits = REAL;
  assert.equal(REAL[0].sha.slice(0, 8), '1bbe07cf');
  assert.equal(await readerFor(f).currentBuild(job, 'approve-desktop-qa-latest'), 'f32f69b2');
});

test('F7: without the github_read keyring (operation path) a live read is null, and the snapshot the timer wrote answers', async () => {
  const f = new FakePlatform(); f.branchCommits = REAL;
  const bare = new GithubSourceReader({ api: f.deps().github({ input_data: { resources: { keyrings: {} } } }), repo: 'devrev/devrev-web', branch: BRANCH, statePath: 'mock-release/state.json' });
  const opts = { store: storeFor(f), env: 'qa', bot: 'tony', now: () => f.clock.now() };
  assert.equal(await new SnapshotSourceReader({ ...opts, live: bare }).currentBuild(job, 'approve-desktop-qa-latest'), null, 'no snapshot yet: unreadable, as before');
  await new SnapshotSourceReader({ ...opts, live: readerFor(f) }).refresh(['approve-desktop-qa-latest']);
  const op = new SnapshotSourceReader({ ...opts, live: bare });
  assert.equal(await op.currentBuild(job, 'approve-desktop-qa-latest'), 'f32f69b2');
  f.clock.advanceMinutes(20);
  assert.equal(await op.currentBuild(job, 'approve-desktop-qa-latest'), null, 'a stale snapshot is not trusted');
});

test('F7 end to end: say on the operation path names the build from the tick snapshot, never unknown', async () => {
  const f = new FakePlatform(); f.branchCommits = REAL; const d = dispatcher(f);
  const root = f.postSlack(ALLOWED, null, { user: 'U1', text: 'root' });
  const thread = `${ALLOWED}:${root}`;
  const mention = f.newMentionDm();
  await d.call({ call: 'job_open', workflow: 'desktop-release', target: '5.2.11', thread, role: 'request', intent: 'join', agent_session_id: mention.session });
  await d.tick(); f.clock.advanceMinutes(2); await d.tick();
  const hs = f.sessionIn([...f.chats.keys()].find((k) => k.endsWith('home'))!);
  await d.call({ call: 'checkpoint', job: 'desktop-release:5.2.11', status: 'working', reached: ['qa_go_requested'], agent_session_id: hs });
  const s = await d.call({ call: 'say', job: 'desktop-release:5.2.11', thread, milestone: 'qa_go_requested', agent_session_id: hs });
  assert.equal(s.status, 'go');
  assert.match(s.say_to_tony, /build f32f69b2/);
  assert.doesNotMatch(s.say_to_tony, /unknown/);
  void OWN_BOT;
});
