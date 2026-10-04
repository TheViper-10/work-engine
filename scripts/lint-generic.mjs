// Fails (exit 1) if any file in src/ names a workflow or uses a desktop-specific word.
// Ban list = ids found in workflows/*/spec.json (minus short or generic words) + a fixed list.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED = ['desktop', 'release', 'alpha', 'circleci', 'playwright', 'harry', 'update-server', 'update_server', 'prod_alpha', 'electron', 'tony'];
const GENERIC = new Set(['request', 'side', 'qa', 'done', 'merged', 'live', 'main', 'owner', 'cancel', 'primary', 'name', 'slack', 'version']);

const ids = new Set();
function addId(id) {
  if (typeof id !== 'string') return;
  const v = id.trim();
  if (v.length < 4 || GENERIC.has(v.toLowerCase())) return;
  ids.add(v);
}

const wfDir = join(root, 'workflows');
if (existsSync(wfDir)) {
  for (const name of readdirSync(wfDir)) {
    const f = join(wfDir, name, 'spec.json');
    if (!existsSync(f)) continue;
    let spec;
    try { spec = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.error(`lint-generic: cannot parse ${relative(root, f)}: ${e.message}`); process.exit(1); }
    addId(spec.workflow);
    addId(name);
    for (const r of spec.link_roles ?? []) addId(r);
    for (const r of spec.resources ?? []) addId(r);
    for (const sect of ['people', 'gates', 'milestones', 'actions']) for (const id of Object.keys(spec[sect] ?? {})) addId(id);
    // proved_by kinds are external event kinds named by the spec
    for (const a of Object.values(spec.actions ?? {})) addId(a?.proved_by);
  }
}
for (const w of FIXED) ids.add(w);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [...ids].map((w) => ({ w, re: new RegExp(`(?<![A-Za-z0-9_])${esc(w)}(?![A-Za-z0-9_])`, 'i') }));

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

const srcDir = join(root, 'src');
let bad = 0;
for (const file of walk(srcDir)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { w, re } of rules) {
      if (re.test(line)) { console.log(`${relative(root, file)}:${i + 1}: banned word "${w}"`); bad++; }
    }
  });
}
if (bad) { console.error(`lint-generic: ${bad} offence(s) in src/`); process.exit(1); }
console.log(`lint-generic: ok (${ids.size} banned words, ${walk(srcDir).length} files)`);
