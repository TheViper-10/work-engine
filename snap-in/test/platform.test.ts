import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { shapeArgs } from '../src/index.ts';
// @ts-ignore untyped generator modules
import { CALLS, SKILLS, buildTemplate, validateIds } from '../platform/gen-skill-workflows.mjs';
// @ts-ignore untyped generator modules
import { buildBody, planText, PLAN_SOFT_LIMIT } from '../platform/tony-v2.39.mjs';

const root = join(fileURLToPath(import.meta.url), '../..');
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const INSTALL = 'don:integration:dvrv-us-1:devo/1lKlCUXYGG:snap_in/11111111-2222-3333-4444-555555555555';
const SLUG = 'work-engine-qa-v1';
const WF = 'don:integration:dvrv-us-1:devo/1lKlCUXYGG:workflow';
const workflows = Object.fromEntries(CALLS.map((c: string, i: number) => [c, `${WF}/${70 + i}`]));

/** Operation input declarations from the manifest: name -> {type, base, required}. */
function manifestInputs() {
  const block = manifest.slice(manifest.indexOf('inputs:\n      fields:'), manifest.indexOf('outputs:\n      fields:'));
  const out: Record<string, { type: string; base?: string }> = {};
  for (const chunk of block.split(/\n        - name: /).slice(1)) {
    const name = chunk.split('\n')[0].trim();
    out[name] = { type: /field_type: (\w+)/.exec(chunk)![1], base: /base_type: (\w+)/.exec(chunk)?.[1] };
  }
  return out;
}
const MI = manifestInputs();
const V2 = Object.fromEntries(CALLS.map((c: string) => [c, buildTemplate(c, INSTALL, SLUG)]));
const steps = (c: string) => V2[c].workflow_template_v2.steps;
const triggerFields = (c: string): any[] => steps(c)[0].input_values[0].fields[0].value.value.fields;
const opFields = (c: string): Record<string, any> => Object.fromEntries(steps(c)[2].input_values[0].fields.map((f: any) => [f.name, f.value]));

test('the manifest parse sees the operation inputs', () => {
  assert.equal(MI.call.type, 'enum');
  assert.equal(MI.operations.type, 'array');
  assert.ok(Object.keys(MI).length >= 25);
});

test('six templates, each with the four step kinds in order', () => {
  assert.equal(CALLS.length, 6);
  for (const c of CALLS) {
    const s = steps(c);
    assert.deepEqual(s.map((x: any) => `${x.operation.namespace}.${x.operation.slug}`), ['devrev.ai_agent_skill_trigger', 'devrev.ai_agent_skill', `${SLUG}.work_engine_call`, 'devrev.set_ai_agent_skill_output'], c);
    assert.deepEqual(s.map((x: any) => x.reference_key), ['trigger', 'agent_context', 'control', 'output']);
    assert.equal(V2[c].workflow_template_v2.title, `work_engine_${c}`);
    assert.deepEqual(V2[c].workflow_template_v2.labels, ['skill']);
    // both formats parse and carry the same four steps
    const v1 = JSON.parse(V2[c].workflow_template);
    assert.equal(v1.steps.length, 4);
    assert.equal(v1.steps[2].operation.namespace, SLUG);
  }
});

test('trigger carries only that call\'s fields, typed like the manifest', () => {
  for (const c of CALLS) {
    const names = triggerFields(c).map((f: any) => f.name);
    assert.deepEqual(names, SKILLS[c].fields.map((f: any) => f.name));
    for (const f of triggerFields(c)) {
      assert.ok(f.name in MI, `${c}.${f.name} is not an operation input`);
      // an enum in the trigger narrows a text operation input (checkpoint.status); every other type must match
      assert.ok(f.field_type === MI[f.name].type || (f.field_type === 'enum' && MI[f.name].type === 'text'), `${c}.${f.name} type ${f.field_type} vs ${MI[f.name].type}`);
      if (f.field_type === 'array') assert.equal(f.base_type, MI[f.name].base, `${c}.${f.name} base_type`);
      assert.ok(f.description.length > 3);
    }
  }
  assert.deepEqual(triggerFields('job_open').map((f: any) => f.name), ['workflow', 'target', 'thread', 'role', 'private', 'intent', 'requester']);
  assert.deepEqual(triggerFields('checkpoint').map((f: any) => f.name), ['job', 'status', 'waiting_for', 'next_wake_in', 'operations', 'reached', 'processed']);
  for (const a of ['operations', 'reached', 'processed']) assert.equal(MI[a].type === 'array' && MI[a].base, 'text');
  // no authority-like field is ever offered to the model
  for (const c of CALLS) for (const bad of ['agent_session_id', 'request_id', 'snap_in_id', 'call', 'dm', 'caller_id']) assert.ok(!triggerFields(c).some((f: any) => f.name === bad), `${c} exposes ${bad}`);
});

test('required fields match the engine\'s bad_input checks', () => {
  const req = (c: string) => triggerFields(c).filter((f: any) => f.is_required).map((f: any) => f.name);
  assert.deepEqual(req('job_open'), ['workflow', 'target', 'thread']);
  assert.deepEqual(req('job_view'), []); // a job OR a thread
  assert.deepEqual(req('intend'), ['job', 'action', 'ref']);
  assert.deepEqual(req('say'), ['job', 'thread', 'milestone']);
  assert.deepEqual(req('promise_add'), ['job', 'thread', 'about']);
  assert.deepEqual(req('checkpoint'), ['job', 'status']);
  const status = triggerFields('checkpoint').find((f: any) => f.name === 'status');
  assert.deepEqual(status.allowed_values, ['working', 'waiting', 'blocked', 'done', 'cancelled']);
  assert.deepEqual(triggerFields('job_open').find((f: any) => f.name === 'intent').allowed_values, ['join', 'replace', 'queue']);
});

test('operation step: call literal, snap_in literal, hidden ids from the agent context, one mapping per field', () => {
  for (const c of CALLS) {
    const o = opFields(c);
    assert.deepEqual(o.call, { type: 'literal', value: c });
    assert.deepEqual(o.snap_in_id, { type: 'literal', value: INSTALL });
    assert.equal(o.agent_session_id.type, 'jsonata_expression');
    assert.equal(o.agent_session_id.value, "$get('trigger', 'output').agent_metadata.agent_session_id");
    assert.equal(o.request_id.value, "$get('trigger', 'output').agent_metadata.skill_call_id");
    // step 2 copies the same hidden metadata
    const ctx = Object.fromEntries(steps(c)[1].input_values[0].fields.map((f: any) => [f.name, f.value.value]));
    assert.deepEqual(Object.keys(ctx), ['agent_session_id', 'skill_call_id', 'skill_name']);
    assert.equal(ctx.agent_session_id, o.agent_session_id.value);
    // every operation field exists in the manifest; every trigger field is mapped, omitted ones stay absent (jsonata)
    for (const name of Object.keys(o)) assert.ok(name in MI, `${c}: ${name} not in manifest`);
    for (const f of SKILLS[c].fields) assert.deepEqual(o[f.name], { type: 'jsonata_expression', value: `$get('trigger', 'output').${f.name}` });
    assert.deepEqual(Object.keys(o).filter((k) => !['call', 'snap_in_id', 'agent_session_id', 'request_id'].includes(k)), SKILLS[c].fields.map((f: any) => f.name));
    // output: body = operation output
    const out = steps(c)[3].input_values[0].fields[0].value.value.items[0].value[0].fields;
    assert.equal(out[0].value.value, 'body');
    assert.equal(out[1].value.value, "$get('control', 'output')");
  }
});

test('shapeArgs accepts exactly what each skill can send', () => {
  for (const c of CALLS) {
    const sample: Record<string, any> = {};
    for (const f of SKILLS[c].fields) sample[f.name] = f.type === 'array' ? ['x'] : f.type === 'bool' ? true : f.values ? f.values[0] : 'x';
    sample.thread = sample.thread === undefined ? undefined : 'C0C4K4EGZT6:1.2';
    const shaped = shapeArgs(c, sample);
    for (const f of SKILLS[c].fields) assert.ok(f.name in shaped, `${c}.${f.name} is dropped by the operation`);
  }
});

test('no template mentions the v8 install, slug or coordinator', () => {
  for (const c of CALLS) {
    const text = JSON.stringify(V2[c]);
    for (const old of ['4d12f12a', '4008e2f0', '462070f3', 'tony-qa-mock', 'manage_tony_mock_release', 'procedure_version', 'execution_key', '__NEW_']) assert.ok(!text.includes(old), `${c} contains ${old}`);
    assert.equal(text.split(INSTALL).length - 1, 2, 'install appears once per format'); // v1 string + v2
    assert.equal(text.split(`"namespace\\":\\"${SLUG}`).length - 1 + text.split(`"namespace":"${SLUG}"`).length - 1, 2, 'slug appears once per format');
  }
  assert.throws(() => validateIds('don:integration:dvrv-us-1:devo/1lKlCUXYGG:snap_in/4008e2f0-0000-0000-0000-000000000000', SLUG));
  assert.throws(() => validateIds(INSTALL, 'tony-qa-mock-slack-v8e'));
});

/** A v2.38 shaped fixture: 11 skills, workflows 55/56, plans 24/25 and the kept ones. */
function fixture() {
  const plan = (n: number, name: string) => ({ key: `k${n}`, name, description: name, act_as_user: true, trigger: { plan: { id: `don:core:dvrv-us-1:devo/1lKlCUXYGG:ai_agent_plan/${n}`, name } } });
  const op = (slug: string) => ({ key: slug, name: slug, description: slug, act_as_user: true, needs_approval: false, devrev_input_schema: { field_descriptors: [] }, trigger: { operation: { id: `don:integration:dvrv-us-1:operation/devrev.${slug}`, slug } } });
  const wf = (n: number) => ({ key: `w${n}`, name: `wf${n}`, description: 'd', act_as_user: true, trigger: { workflow: { id: `${WF}/${n}`, display_id: `workflow-${n}` } } });
  return {
    agent_version: {
      agent: { id: 'don:core:dvrv-us-1:devo/1lKlCUXYGG:ai_agent/2', display_id: 'ai_agent-2' },
      goal: 'G', guidance: 'GUIDE', ai_agent_config: { id: 'cfg' }, enable_code_execution: true, disable_default_guardrails: false, knowledge: { include_all_objects: true },
      scopes: { impersonation: [] }, state: 'published', version: '38.0',
      skills: [wf(55), wf(56), plan(24, 'p24'), plan(25, 'p25'), plan(1, 'p1'), plan(4, 'p4'), plan(8, 'p8'), op('add_comment'), op('update_issue'), op('hybrid_search'), plan(6, 'slack')],
    },
  };
}

test('Tony v2.39 body: drops 55/56/24/25, keeps the rest, adds 7 skills, no scopes', () => {
  const saved = fixture();
  const b = buildBody(saved, workflows);
  const ids = b.skills.map((s: any) => s.trigger.workflow ?? s.trigger.plan ?? s.trigger.operation);
  for (const gone of ['workflow/55', 'workflow/56', 'ai_agent_plan/24', 'ai_agent_plan/25']) assert.ok(!ids.some((i: string) => i.endsWith(gone)), gone);
  assert.equal(b.skills.length, 11 - 4 + 7);
  for (const keep of ['ai_agent_plan/1', 'ai_agent_plan/4', 'ai_agent_plan/8', 'ai_agent_plan/6', 'operation/devrev.add_comment', 'operation/devrev.update_issue', 'operation/devrev.hybrid_search']) assert.ok(ids.some((i: string) => i.endsWith(keep)), keep);
  const added = b.skills.slice(-7);
  assert.deepEqual(added.slice(0, 6).map((s: any) => s.name), CALLS.map((c: string) => `work_engine_${c}`));
  assert.deepEqual(added.slice(0, 6).map((s: any) => s.trigger.workflow), CALLS.map((c: string) => workflows[c]));
  assert.equal(added[6].name, 'work-engine-desktop-release');
  assert.match(added[6].trigger.plan, /__WORK_ENGINE_PLAN_ID__/);
  assert.equal(new Set(b.skills.map((s: any) => s.key)).size, b.skills.length, 'skill keys unique');
  assert.ok(!('scopes' in b), 'no scopes field');
  assert.deepEqual(Object.keys(b).sort(), ['agent', 'ai_agent_config', 'disable_default_guardrails', 'enable_code_execution', 'goal', 'guidance', 'knowledge', 'notes', 'skills']);
  // flattened triggers: DON strings, kept skills untouched otherwise
  for (const s of b.skills) for (const v of Object.values(s.trigger)) assert.equal(typeof v, 'string');
  assert.equal(b.agent, saved.agent_version.agent.id);
  assert.equal(b.guidance, 'GUIDE');
  // nothing in the saved object is mutated
  assert.equal(saved.agent_version.skills.length, 11);
  assert.throws(() => buildBody(saved, { ...workflows, say: workflows.intend }));
  assert.throws(() => buildBody({ agent_version: { ...saved.agent_version, skills: saved.agent_version.skills.slice(2) } }, workflows));
});

const SAVED_238 = join(process.env.HOME ?? '', '.agents/memory/agents/fde-agent/artifacts/tony-shared-state/21-work/run-data/live/tony-version-2.38.json');
test('the real saved v2.38 state (when present locally) goes 11 -> 14 skills with the kept skills unchanged', { skip: !existsSync(SAVED_238) }, () => {
  const saved = JSON.parse(readFileSync(SAVED_238, 'utf8'));
  const b = buildBody(saved, workflows);
  assert.equal(saved.agent_version.skills.length, 11);
  assert.equal(b.skills.length, 14);
  assert.ok(!('scopes' in b));
});

test('plan text is the playbook then the references, within the size bound', () => {
  const t = planText();
  const pb = readFileSync(join(root, '../knowledge/desktop-release/playbook.md'), 'utf8').trimEnd();
  const refs = readFileSync(join(root, '../knowledge/desktop-release/references.md'), 'utf8').trimEnd();
  assert.ok(t.startsWith(pb));
  assert.ok(t.indexOf(refs) === pb.length + 2);
  assert.ok(t.length < PLAN_SOFT_LIMIT);
});

test('CLI: generates the six files and the Tony body into a temp dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  execFileSync('node', [join(root, 'platform/gen-skill-workflows.mjs'), '--install', INSTALL, '--slug', SLUG, '--out', dir]);
  for (const c of CALLS) {
    const j = JSON.parse(readFileSync(join(dir, `skill-${c}.json`), 'utf8'));
    assert.deepEqual(Object.keys(j), ['template_version', 'workflow_template', 'workflow_template_v2']);
  }
});
