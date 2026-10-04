#!/usr/bin/env node
// Emits the six Tony skill workflow templates that wrap the work_engine_call operation.
// OFFLINE: no API calls. Usage:
//   node gen-skill-workflows.mjs --install <snap_in DON> --slug <package slug> [--out <dir>]
// Output: skill-job_open.json, skill-job_view.json, skill-intend.json, skill-say.json,
// skill-promise_add.json, skill-checkpoint.json. Each file is a `templates.generate` shaped body
// {template_version, workflow_template (string, v1), workflow_template_v2 (object)}; send it to
// `workflows.templates.instantiate` (see README.md).
//
// Shape source: v8 workflow 55/39 (`artifacts/rollback-v8-deploy-20261003T190455Z/workflow-39-template.json`):
// trigger -> "Platform agent context" -> operation -> set_ai_agent_skill_output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CALLS = ['job_open', 'job_view', 'intend', 'say', 'promise_add', 'checkpoint'];
export const OPERATION_SLUG = 'work_engine_call';
const TRIGGER_META = "$get('trigger', 'output').agent_metadata";

// Required flags mirror the engine (src/engine.ts): job_open needs workflow+target+thread; intend needs
// job+action+ref; say needs job+thread+milestone; promise_add needs job+thread+about; checkpoint needs job+status;
// job_view needs a job OR a thread (either alone works), so both are optional in the schema.
const T = 'text';
export const SKILLS = {
  job_open: {
    description: 'Start a job, link a thread to one, or replace or queue the home. The answer says whether the job already existed. Linking a thread never makes it the actor.',
    fields: [
      { name: 'workflow', type: T, required: true, description: 'Workflow id of the job to open, for example desktop-release.' },
      { name: 'target', type: T, required: true, description: 'The target of the job, for example the version being released.' },
      { name: 'thread', type: T, required: true, description: 'The Slack thread you are in, as <channel>:<ts>.' },
      { name: 'role', type: T, description: 'Role of this thread for the job: request, side or qa.' },
      { name: 'private', type: 'bool', description: 'True to keep this thread private.' },
      { name: 'intent', type: 'enum', values: ['join', 'replace', 'queue'], description: 'Join the running job, replace its home, or queue behind it.' },
      { name: 'requester', type: T, description: 'Who asked.' },
    ],
  },
  job_view: {
    description: 'Read the job briefing: commitments, open asks, actions in flight, who is owed, and the inbox. Read-only; reading never consumes inbox items. Start here. Give a job id, or a thread to find the job.',
    fields: [
      { name: 'job', type: T, description: 'Job id. Give this or thread.' },
      { name: 'thread', type: T, description: 'The Slack thread as <channel>:<ts>, to find the job linked to it. Give this or job.' },
    ],
  },
  intend: {
    description: 'Declare a merge, gate approval or publish before you do it. The answer is clear (maybe with flags to weigh) or hold (do not do it; the reason says what to do instead). Same job, action and ref is the same operation.',
    fields: [
      { name: 'job', type: T, required: true, description: 'Job id.' },
      { name: 'action', type: T, required: true, description: 'The action name.' },
      { name: 'ref', type: T, required: true, description: 'The reference the action works on, for example the PR or build.' },
      { name: 'because', type: T, description: 'The event or inbox id of the go.' },
    ],
  },
  say: {
    description: 'Claim a message before you post it yourself. The answer is go (post it now), busy (someone is posting in that thread; do not post), already_sent (it was posted), or already_claimed (read the thread and post only if absent). Pass the post link to confirm a post the engine has not seen.',
    fields: [
      { name: 'job', type: T, required: true, description: 'Job id.' },
      { name: 'thread', type: T, required: true, description: 'The Slack thread you will post in, as <channel>:<ts>.' },
      { name: 'milestone', type: T, required: true, description: 'The milestone id claimed, exactly as listed by job_view.' },
      { name: 'posted_link', type: T, description: 'Link to the message you posted.' },
    ],
  },
  promise_add: {
    description: 'Record "tell me when" for a milestone. The engine wakes the home at the fallback time if the milestone has not been told.',
    fields: [
      { name: 'job', type: T, required: true, description: 'Job id.' },
      { name: 'thread', type: T, required: true, description: 'The Slack thread that was promised an update, as <channel>:<ts>.' },
      { name: 'about', type: T, required: true, description: 'The milestone promised, exactly as listed by job_view.' },
      { name: 'fallback_time', type: T, description: 'ISO time or a duration such as 4h at which to wake if the milestone has not been told.' },
    ],
  },
  checkpoint: {
    description: 'Commit status, milestones you saw, action outcomes, when to look again, and the inbox items you handled. Outcomes: done (proof read), failed (read that it did not happen), unknown (cannot tell). If anything is still owed, the job stays open and the answer says what.',
    fields: [
      { name: 'job', type: T, required: true, description: 'Job id.' },
      { name: 'status', type: 'enum', values: ['working', 'waiting', 'blocked', 'done', 'cancelled'], required: true, description: 'Exactly one word. The engine closes a job only on done or cancelled, and only when nothing is owed. The sentence goes in waiting_for.' },
      { name: 'waiting_for', type: T, description: 'What the job waits for, as a sentence.' },
      { name: 'next_wake_in', type: T, description: 'When to look again, for example 5m or 2h.' },
      { name: 'operations', type: 'array', description: 'Operation outcomes, one JSON object per item: {"ref": "...", "action": "...", "outcome": "done|failed|unknown", "note": "..."}.' },
      { name: 'reached', type: 'array', description: 'Milestone ids seen, using the exact ids from job_view.' },
      { name: 'processed', type: 'array', description: 'Inbox items handled, by id.' },
    ],
  },
};

const ui = (name) => ({
  create_view: {},
  detail_view: { is_hidden: true },
  display_name: name,
  is_hidden: false,
  summary_view: { is_hidden: true },
});

function schemaField(f) {
  const o = {};
  if (f.values) o.allowed_values = f.values;
  if (f.type === 'array') o.base_type = 'text';
  o.description = f.description;
  o.field_type = f.type;
  o.is_filterable = false;
  o.is_required = !!f.required;
  o.name = f.name;
  o.ui = ui(f.name);
  return o;
}

const jsonata = (value) => ({ type: 'jsonata_expression', value });
const literal = (value) => ({ type: 'literal', value });
const inputs = (fields) => [{ fields: fields.map(([name, value]) => ({ name, value })), port_name: 'input' }];

export function buildTemplateV2(call, install, slug) {
  const s = SKILLS[call];
  if (!s) throw new Error(`unknown call ${call}`);
  const title = `work_engine_${call}`;
  const opFields = [
    ['call', literal(call)],
    ['snap_in_id', literal(install)],
    ['agent_session_id', jsonata(`${TRIGGER_META}.agent_session_id`)],
    ['request_id', jsonata(`${TRIGGER_META}.skill_call_id`)],
    // Omitted optional fields stay absent (jsonata), never "" (text_template would send an empty string).
    ...s.fields.map((f) => [f.name, jsonata(`$get('trigger', 'output').${f.name}`)]),
  ];
  return {
    description: `${s.description} Work engine call ${call}.`,
    labels: ['skill'],
    serialization_version: { major: 2, minor: 0, patch: 0 },
    steps: [
      {
        description: `Accept only the typed fields of the work engine ${call} call.`,
        input_values: inputs([['schema', literal({ fields: s.fields.map(schemaField) })]]),
        name: 'Agent skill trigger',
        next_steps: [{ next_step_reference_key: 'agent_context', next_port_name: 'input', port_name: 'output' }],
        operation: { namespace: 'devrev', slug: 'ai_agent_skill_trigger' },
        reference_key: 'trigger',
        ui_metadata: { position: { x: 100, y: 0 } },
      },
      {
        description: 'Bind hidden platform session metadata; no model field can supply it.',
        input_values: inputs([
          ['agent_session_id', jsonata(`${TRIGGER_META}.agent_session_id`)],
          ['skill_call_id', jsonata(`${TRIGGER_META}.skill_call_id`)],
          ['skill_name', jsonata(`${TRIGGER_META}.skill_name`)],
        ]),
        name: 'Platform agent context',
        next_steps: [{ next_step_reference_key: 'control', next_port_name: 'input', port_name: 'block_start' }],
        operation: { namespace: 'devrev', slug: 'ai_agent_skill' },
        reference_key: 'agent_context',
        ui_metadata: { position: { x: 350, y: 0 } },
      },
      {
        block_step_reference_key: 'agent_context',
        description: 'The operation looks the home DM up from the authenticated session; the model never passes it.',
        input_values: inputs(opFields),
        name: `Run work engine ${call}`,
        next_steps: [{ next_step_reference_key: 'output', next_port_name: 'input', port_name: 'output' }],
        operation: { namespace: slug, slug: OPERATION_SLUG },
        reference_key: 'control',
        ui_metadata: { position: { x: 600, y: 0 } },
      },
      {
        block_step_reference_key: 'agent_context',
        description: 'Return the engine answer to Tony.',
        input_values: inputs([
          ['outputs', {
            type: 'list_value',
            value: {
              items: [{
                type: 'composite_value_list',
                value: [{
                  fields: [
                    { name: 'key', value: { type: 'text_template', value: 'body' } },
                    { name: 'value', value: jsonata("$get('control', 'output')") },
                  ],
                }],
              }],
            },
          }],
        ]),
        name: 'Set work engine skill output',
        operation: { namespace: 'devrev', slug: 'set_ai_agent_skill_output' },
        reference_key: 'output',
        ui_metadata: { position: { x: 800, y: 240 } },
      },
    ],
    title,
  };
}

// v1 (string) format differs from v2 only in: numeric value types, serialization_version string, tier.
const V1_TYPE = { literal: 1, jsonata_expression: 3, text_template: 5, list_value: 6 };
function toV1(node) {
  if (Array.isArray(node)) return node.map(toV1);
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = toV1(v);
    if (typeof o.type === 'string' && 'value' in o && o.type in V1_TYPE) o.type = V1_TYPE[o.type];
    return o;
  }
  return node;
}

export function buildTemplate(call, install, slug) {
  const v2 = buildTemplateV2(call, install, slug);
  const v1 = toV1(v2);
  v1.serialization_version = '1.0.0';
  v1.tier = 1;
  return { template_version: '2.0.0', workflow_template: JSON.stringify(v1), workflow_template_v2: v2 };
}

export function validateIds(install, slug) {
  if (!/^don:integration:dvrv-us-1:devo\/[A-Za-z0-9]+:snap_in\/[0-9a-f-]{36}$/.test(install)) throw new Error('--install must be a snap_in DON: don:integration:dvrv-us-1:devo/<org>:snap_in/<uuid>');
  if (/snap_in\/(4d12f12a|4008e2f0|462070f3)/.test(install)) throw new Error('--install is a v8 install id');
  if (!/^[a-z0-9-]{3,32}$/.test(slug)) throw new Error('--slug must be a package slug (3-32 chars of a-z, 0-9, -)');
  if (/^tony-qa-mock-/.test(slug)) throw new Error('--slug is a v8 package slug');
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv) {
  const install = arg(argv, 'install');
  const slug = arg(argv, 'slug');
  const out = arg(argv, 'out') ?? '.';
  if (!install || !slug) throw new Error('usage: gen-skill-workflows.mjs --install <snap_in DON> --slug <package slug> [--out <dir>]');
  validateIds(install, slug);
  mkdirSync(out, { recursive: true });
  for (const call of CALLS) {
    const file = join(out, `skill-${call}.json`);
    writeFileSync(file, JSON.stringify(buildTemplate(call, install, slug), null, 1) + '\n');
    console.log(file);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
}
