import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineConfig, readInputs, SPECS } from '../src/specs.ts';
import { CALLS, shapeArgs } from '../src/index.ts';
import { operationScopesOf, serviceScopesOf } from './fake-platform.ts';

const root = join(fileURLToPath(import.meta.url), '../..');
const m = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const names = (re: RegExp) => [...m.matchAll(re)].map((x) => x[1]);

test('one function, one operation, one timer source on a per-minute cron', () => {
  assert.deepEqual(names(/^  - name: (work_engine)$/gm), ['work_engine']);
  assert.deepEqual(names(/^  - name: (work_engine_call)$/gm), ['work_engine_call']);
  assert.equal((m.match(/type: timer-events/g) ?? []).length, 1);
  assert.match(m, /cron: '\* \* \* \* \*'/);
  assert.equal((m.match(/^    function: work_engine$/gm) ?? []).length, 2);
  assert.match(m, /supports_synchronization: true/);
  assert.match(m, /max_execution_time: 120000/);
});

test('the operation declares the call enum, hidden platform ids and a struct result', () => {
  const callBlock = m.slice(m.indexOf('- name: call\n'));
  for (const c of CALLS) assert.ok(callBlock.slice(0, 400).includes(c), c);
  for (const hidden of ['request_id', 'agent_session_id']) assert.match(m, new RegExp(`name: ${hidden}\\n[^]*?is_hidden: true`));
  assert.match(m, /outputs:\n\s+fields:\n\s+- name: result\n\s+field_type: struct/);
  for (const f of ['workflow', 'target', 'thread', 'role', 'private', 'intent', 'requester', 'job', 'action', 'ref', 'because', 'milestone', 'posted_link', 'about', 'fallback_time', 'status', 'waiting_for', 'next_wake_in', 'operations', 'reached', 'processed']) {
    assert.match(m, new RegExp(`- name: ${f}\\n`), f);
  }
  // no field lets the caller name a DM or a session object
  for (const bad of ['dm', 'dm_id', 'session_object', 'caller_id']) assert.doesNotMatch(m, new RegExp(`- name: ${bad}\\n`));
});

test('static scopes include the custom-object write scopes and session read', () => {
  const ops = m.slice(m.indexOf('static_scopes:'));
  for (const s of ['custom_object:work_record:all', 'custom_object:work_event:all', 'ai_agent_session:read', 'snap_in:read']) assert.ok(ops.includes(s), s);
  const svc = m.slice(m.indexOf('service_account:'), m.indexOf('keyrings:'));
  for (const s of ['custom_object:work_record:all', 'custom_object:work_event:all', 'ai_agent_session:read', 'conversation:write']) assert.ok(svc.includes(s), s);
});

test('keyrings and organization inputs match the design, allowlist defaults to the one channel', () => {
  assert.deepEqual(names(/^    - name: (owner_identity|tony_slack_token|github_read)$/gm), ['owner_identity', 'tony_slack_token', 'github_read']);
  for (const i of ['env', 'bot', 'own_bot_user', 'tony_agent', 'wake_user', 'wake_workflow', 'slack_channel_allowlist', 'github_repo', 'mock_branch', 'state_path', 'guidance_version']) {
    assert.match(m, new RegExp(`^    - name: ${i}$`, 'm'), i);
  }
  assert.match(m, /name: slack_channel_allowlist\n\s+field_type: text\n\s+default_value: 'C0C4K4EGZT6'/);
  assert.doesNotMatch(m, /C08TJE6SDME/);
});

test('no secret-shaped value in the manifest', () => {
  assert.doesNotMatch(m, /xox[bp]-|ghp_|eyJ[A-Za-z0-9_-]{10,}|-----BEGIN/);
});

test('specs: the desktop-release workflow is bundled and inputs become engine config', () => {
  assert.deepEqual(SPECS.map((s) => s.workflow), ['desktop-release']);
  const i = readInputs({ guidance_version: 'abc', slack_channel_allowlist: 'C0C4K4EGZT6, C08TJE6SDME' });
  assert.deepEqual(i.slack_channel_allowlist, ['C0C4K4EGZT6']);
  const c = engineConfig(i);
  assert.equal(c.env, 'qa'); assert.equal(c.bot, 'tony'); assert.equal(c.ownBotUserId, 'U0C4FFYJGE6'); assert.equal(c.guidanceVersion, 'abc');
  assert.deepEqual(readInputs({}).slack_channel_allowlist, ['C0C4K4EGZT6']);
});

test('checkpoint operations arrive as objects, JSON strings or one JSON array string', () => {
  const op = { ref: 'pr-1', action: 'open_bump_pr', outcome: 'done' };
  for (const input of [[op], [JSON.stringify(op)], JSON.stringify([op])]) {
    assert.deepEqual(shapeArgs('checkpoint', { job: 'j', status: 's', operations: input }).operations, [op]);
  }
  assert.equal(shapeArgs('checkpoint', { job: 'j', status: 's' }).operations, undefined);
});

/** R47: scope names seen working in the v8 snap-ins or the connector manifests. A name outside this list is a guess and fails the lint. */
const SCOPE_ALLOWLIST = new Set([
  'ai_agent:read', 'ai_agent:execute', 'ai_agent_session:read', 'ai_agent_session:write', 'snap_in:read', 'event_source:read', 'conversation:write',
  'custom_object:work_record:all', 'custom_object:work_event:all', 'custom_object:slack_connector_state:all', 'custom_object:slack_connector_receipt:all',
  'app_fragment:write', 'tenant_fragment:write', 'role:read', 'artifact:read', 'artifact:create', 'dev_org:read', 'dev_user:read',
]);

test('R47 lint: every ui.display_name is at most 50 characters (the platform rejects longer with a 400 on version create)', () => {
  const labels = [...m.matchAll(/display_name: '([^']*)'/g)].map((x) => x[1]).concat([...m.matchAll(/display_name: ([^'\n][^\n]*)/g)].map((x) => x[1].trim()));
  assert.ok(labels.length > 10, 'labels were found');
  for (const l of labels) assert.ok(l.length <= 50, `${l.length} chars: ${l}`);
  assert.ok(labels.includes('Admin close jobs (job-id=reason; job-id=reason)'));
});

test('R47 lint: every scope name is on the allowlist of names seen working', () => {
  const all = [...m.matchAll(/- scope: (\S+)/g)].map((x) => x[1]);
  assert.ok(all.length >= 10);
  for (const s of all) assert.ok(SCOPE_ALLOWLIST.has(s), `scope ${s} is not on the allowlist`);
});

test('R47: the service account holds ai_agent:read (ai-agents.get on the timer path), and the operation scopes stay as proven', () => {
  assert.ok(serviceScopesOf(m).includes('ai_agent:read'));
  assert.deepEqual(operationScopesOf(m).sort(), ['ai_agent_session:read', 'conversation:write', 'custom_object:work_event:all', 'custom_object:work_record:all', 'snap_in:read']);
});

test('R69: the shipped engine config holds every hold-class check, for any install inputs', () => {
  for (const inputs of [{}, { env: 'prod' }, { guidance_version: 'x' }]) {
    const c = engineConfig(readInputs(inputs));
    for (const name of ['build_changed', 'job_cancelled', 'superseded_run', 'no_go_for_build', 'sender_not_listed'] as const) assert.equal(c.checks[name], 'hold', `${name} must be hold in the shipped config`);
  }
});
