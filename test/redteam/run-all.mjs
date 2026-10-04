// Runs every red-team repro (f*.ts) and prints one line per repro.
// Exits 1 if any repro prints REPRODUCED (or fails to run).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, '..', '..');
const files = readdirSync(dir).filter((f) => /^f.*\.ts$/.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(dir, f)], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  const lines = (r.stdout ?? '').split('\n').filter((l) => /^(REPRODUCED|not reproduced):/.test(l));
  const hit = lines.filter((l) => l.startsWith('REPRODUCED'));
  if (r.status !== 0 || lines.length === 0) {
    bad++;
    console.log(`${f}: ERROR (no result) ${(r.stderr ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
  } else if (hit.length) {
    bad++;
    console.log(`${f}: REPRODUCED ${hit.map((l) => l.slice(0, 160)).join(' || ')}`);
  } else {
    console.log(`${f}: not reproduced (${lines.length} check${lines.length > 1 ? 's' : ''})`);
  }
}
// L1 is parked: these repros are listed but do not fail the run.
const parked = readdirSync(join(dir, 'parked')).filter((f) => /\.ts$/.test(f));
for (const f of parked) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(dir, 'parked', f)], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  const hit = (r.stdout ?? '').split('\n').some((l) => l.startsWith('REPRODUCED'));
  console.log(`parked/${f}: ${hit ? 'still reproduces (L1, parked for phase 3)' : 'not reproduced'}`);
}
console.log(bad === 0 ? `redteam: all ${files.length} repros not reproduced` : `redteam: ${bad} of ${files.length} repros still reproduce`);
process.exit(bad === 0 ? 0 : 1);
