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
  assert.deepEqual(f.githubRequests, [{ method: 'GET', path: `/repos/devrev/devrev-web/commits/${encodeURIComponent(BRANCH)}` }]);
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
    `/repos/devrev/devrev-web/pulls?base=main&state=open`,
    `/repos/devrev/devrev-web/contents/package.json?ref=${encodeURIComponent(BRANCH)}`,
    `/repos/devrev/devrev-web/contents/mock-release/state.json?ref=main`,
    `/repos/devrev/devrev-web/git/refs`,
    `/repos/devrev/devrev-web/commits/${encodeURIComponent(BRANCH)}/../main`,
  ]) assert.throws(() => r.guard(bad), GithubSourceError, bad);
  assert.equal(f.githubRequests.length, 0);
  assert.ok(f.githubRequests.every((x) => x.method === 'GET'));
});
