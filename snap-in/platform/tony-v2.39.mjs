#!/usr/bin/env node
// Builds the Tony v2.39 `ai-agents.versions.create` body from the saved v2.38 state. OFFLINE.
//   node tony-v2.39.mjs <saved-2.38.json> --workflows job_open=<DON>,job_view=<DON>,intend=<DON>,say=<DON>,promise_add=<DON>,checkpoint=<DON>
//        [--plan <ai_agent_plan DON>] [--out <dir>] [--overlay <file>]
//   node tony-v2.39.mjs --check-absent <live-text-file>... [--base <clean-plan-file>]
// --overlay appends the file (the phase-4 mock overlay, pilot/overlay.md) to the END of the plan guidance, after a blank line, and also
// writes plan-work-engine-desktop-release.base.md (the clean text) and teardown-check.json (the mock identifiers that must be gone
// after teardown). Without --overlay the plan is the clean base. --check-absent is the teardown proof: it counts each mock identifier
// in the given live texts (plan guidance, agent guidance, every scheduled-task query) and exits 1 if any count is above the clean base.
// The saved file is either an `ai-agents.versions.get` answer ({agent_version:{...}}) or a previous create body.
// Writes <out>/tony-versions-create-body-v2.39.json and <out>/plan-work-engine-desktop-release.md
// (plus plan-work-engine-desktop-release.create-body.json, the plan create payload without skill_artifact).
// Removes workflow skills 55/56 and plans 24/25, keeps every other skill and field, adds six workflow skills
// and one plan skill. There is NO scopes field: the server recomputes it (a scopes field returns 400).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLS, SKILLS } from './gen-skill-workflows.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE = join(here, '../../knowledge/desktop-release');

export const REMOVE_WORKFLOWS = ['55', '56'];
export const REMOVE_PLANS = ['24', '25'];
export const PLAN_NAME = 'work-engine-desktop-release';
export const PLAN_ID_PLACEHOLDER = 'don:core:dvrv-us-1:devo/1lKlCUXYGG:ai_agent_plan/__WORK_ENGINE_PLAN_ID__';
export const PLAN_DESCRIPTION = 'Owns a desktop release from the version bump PR to served on prod alpha through the work engine job-home calls (job_view, job_open, intend, say, promise_add, checkpoint). Trigger on: start or join a desktop release; a person asks about a release; a release wake.';
// No plan size limit is documented in the playbooks (org-skill-create-update.md, ui-operator-tony.md).
// Plan 24 was 6773 chars and the plan recipe sends guidance as a plain string. Warn above this soft bound.
export const PLAN_SOFT_LIMIT = 20000;

/** Identifiers that only the mock overlay may introduce. Live text must contain none of them beyond the clean base after teardown. */
export const MOCK_IDENTIFIERS = ['C0C4K4EGZT6', 'ISS-37', 'mock/tony-desktop-release', 'mock-release/', 'U0C4YRX93PS'];

export const countIdentifiers = (text, ids = MOCK_IDENTIFIERS) => Object.fromEntries(ids.map((id) => [id, text.split(id).length - 1]));

/** Appends the overlay to the end of the plan text. The clean base is unchanged when overlay is empty. */
export function withOverlay(text, overlay) {
  const o = (overlay ?? '').trim();
  return o ? `${text.trimEnd()}\n\n${o}\n` : text;
}

/** Hits above the clean base, per identifier. The base may legitimately name a person (the playbook names Harry), so the proof is "no more than the base". */
export function excessHits(live, base = planText()) {
  const allowed = countIdentifiers(base);
  const got = countIdentifiers(live);
  return Object.fromEntries(Object.entries(got).filter(([k, n]) => n > allowed[k]).map(([k, n]) => [k, n - allowed[k]]));
}

const idOf = (x) => (typeof x === 'string' ? x : x?.id);

/** Trigger DON of a skill, flattened: {workflow|plan|operation: DON}. */
function flatTrigger(t) {
  const kind = ['workflow', 'plan', 'operation'].find((k) => t?.[k]);
  if (!kind) throw new Error(`skill trigger has no workflow, plan or operation: ${JSON.stringify(t)}`);
  return { kind, id: idOf(t[kind]) };
}

function flatSkill(s) {
  const { kind, id } = flatTrigger(s.trigger);
  const out = { ...s, trigger: { [kind]: id } };
  return out;
}

export function removed(s) {
  const { kind, id } = flatTrigger(s.trigger);
  if (kind === 'workflow') return REMOVE_WORKFLOWS.some((n) => id.endsWith(`:workflow/${n}`));
  if (kind === 'plan') return REMOVE_PLANS.some((n) => id.endsWith(`:ai_agent_plan/${n}`));
  return false;
}

export function planText(dir = KNOWLEDGE) {
  const playbook = readFileSync(join(dir, 'playbook.md'), 'utf8').trimEnd();
  const references = readFileSync(join(dir, 'references.md'), 'utf8').trimEnd();
  return `${playbook}\n\n${references}\n`;
}

export function buildBody(saved, workflows, plan = PLAN_ID_PLACEHOLDER) {
  const v = saved.agent_version ?? saved;
  for (const c of CALLS) if (!/^don:integration:dvrv-us-1:devo\/[A-Za-z0-9]+:workflow\/\d+$/.test(workflows[c] ?? '')) throw new Error(`workflow DON for ${c} missing or malformed: ${workflows[c]}`);
  if (new Set(Object.values(workflows)).size !== CALLS.length) throw new Error('the six workflow DONs must be distinct');
  const kept = [];
  let dropped = 0;
  for (const s of v.skills) {
    if (removed(s)) { dropped++; continue; }
    kept.push(flatSkill(s));
  }
  if (dropped !== REMOVE_WORKFLOWS.length + REMOVE_PLANS.length) throw new Error(`expected to drop 4 skills (workflows 55/56, plans 24/25), dropped ${dropped}`);
  const added = CALLS.map((c) => ({
    act_as_user: true,
    key: `work-engine-${c}-v1`,
    name: `work_engine_${c}`,
    description: SKILLS[c].description,
    trigger: { workflow: workflows[c] },
  }));
  added.push({ act_as_user: true, key: `${PLAN_NAME}-v1`, name: PLAN_NAME, description: PLAN_DESCRIPTION, trigger: { plan } });
  return {
    agent: idOf(v.agent),
    goal: v.goal,
    guidance: v.guidance,
    ai_agent_config: idOf(v.ai_agent_config),
    skills: [...kept, ...added],
    enable_code_execution: v.enable_code_execution,
    disable_default_guardrails: v.disable_default_guardrails,
    notes: 'v2.39: work engine. Workflow skills 55/56 and plans 24/25 replaced by six work_engine_* workflow skills and plan work-engine-desktop-release. Rollback = republish the saved 2.38 body.',
    knowledge: v.knowledge,
  };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function checkAbsent(argv) {
  const files = [];
  for (let i = 1; i < argv.length && !argv[i].startsWith('--'); i++) files.push(argv[i]);
  if (!files.length) throw new Error('usage: tony-v2.39.mjs --check-absent <live-text-file>... [--base <clean-plan-file>]');
  const baseFile = arg(argv, 'base');
  const base = baseFile ? readFileSync(baseFile, 'utf8') : planText();
  let bad = 0;
  for (const f of files) {
    const excess = excessHits(readFileSync(f, 'utf8'), base);
    const n = Object.keys(excess).length;
    bad += n;
    console.log(`${n ? 'FAIL' : 'OK  '} ${f} ${n ? JSON.stringify(excess) : 'no mock identifier above the clean base'}`);
  }
  console.log(bad ? 'TEARDOWN CHECK FAILED' : `TEARDOWN CHECK OK (${MOCK_IDENTIFIERS.join(', ')} absent beyond base)`);
  return bad ? 1 : 0;
}

export function main(argv) {
  if (argv[0] === '--check-absent') return checkAbsent(argv);
  const file = argv[0];
  const wf = arg(argv, 'workflows');
  if (!file || file.startsWith('--') || !wf) throw new Error('usage: tony-v2.39.mjs <saved-2.38.json> --workflows job_open=<DON>,... [--plan <DON>] [--out <dir>]');
  const workflows = Object.fromEntries(wf.split(',').map((p) => p.split('=')));
  const out = arg(argv, 'out') ?? '.';
  const body = buildBody(JSON.parse(readFileSync(file, 'utf8')), workflows, arg(argv, 'plan'));
  const base = planText();
  const overlayFile = arg(argv, 'overlay');
  const overlay = overlayFile ? readFileSync(overlayFile, 'utf8') : '';
  if (overlayFile && !overlay.trim()) throw new Error(`overlay file ${overlayFile} is empty`);
  const text = withOverlay(base, overlay);
  if (text.length > PLAN_SOFT_LIMIT) console.error(`warning: plan text is ${text.length} chars, above the soft bound ${PLAN_SOFT_LIMIT}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'tony-versions-create-body-v2.39.json'), JSON.stringify(body, null, 1) + '\n');
  writeFileSync(join(out, 'plan-work-engine-desktop-release.md'), text);
  writeFileSync(join(out, 'plan-work-engine-desktop-release.create-body.json'), JSON.stringify({ name: PLAN_NAME, description: PLAN_DESCRIPTION, guidance: text }, null, 1) + '\n');
  if (overlayFile) {
    writeFileSync(join(out, 'plan-work-engine-desktop-release.base.md'), base);
    writeFileSync(join(out, 'teardown-check.json'), JSON.stringify({ must_be_absent_after_teardown: MOCK_IDENTIFIERS, allowed_counts_in_clean_base: countIdentifiers(base), check: 'node snap-in/platform/tony-v2.39.mjs --check-absent <live plan guidance, agent guidance, each scheduled-task query as files>', overlay_hits: countIdentifiers(overlay) }, null, 1) + '\n');
  }
  console.log(`skills ${(JSON.parse(readFileSync(file, 'utf8')).agent_version ?? JSON.parse(readFileSync(file, 'utf8'))).skills.length} -> ${body.skills.length}; plan text ${text.length} chars${overlayFile ? ` (overlay ${overlay.trim().length} chars)` : ''}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
}
