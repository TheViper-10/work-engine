// CLI: npx tsx harness/compare.ts --a <outdirA> --b <outdirB> [--out <dir>]
// Reads *.outcome.json (and *.run.json for cost) from two run directories and writes compare.md to --out (default: cwd).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i]!.startsWith('--')) out[a[i]!.slice(2)] = a[i + 1] && !a[i + 1]!.startsWith('--') ? a[++i]! : 'true';
  return out;
}

interface Row { scenario: string; mode: string; n: string; o: any }

function load(dir: string): Row[] {
  const rows: Row[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.outcome.json')).sort()) {
    const [scenario, mode, n] = f.replace(/\.outcome\.json$/, '').split('.') as [string, string, string];
    rows.push({ scenario, mode, n, o: JSON.parse(readFileSync(join(dir, f), 'utf8')) });
  }
  return rows;
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : 0);
const mark = (s: any) => (!s.applicable ? 'n/a' : s.ok ? 'pass' : 'FAIL');

function cell(rows: Row[]): string {
  if (!rows.length) return '| - | - | - | - | - |';
  const all = (k: string) => (rows.every((r) => !r.o[k].applicable) ? 'n/a' : rows.every((r) => r.o[k].ok || !r.o[k].applicable) ? 'pass' : `FAIL ${rows.filter((r) => r.o[k].applicable && !r.o[k].ok).length}/${rows.length}`);
  const pass = rows.filter((r) => r.o.outcome_pass).length;
  return `| ${all('end_state')} | ${all('approval_correctness')} | ${all('recovery')} | ${all('communication')} | ${pass}/${rows.length} |`;
}

function stats(rows: Row[]) {
  const calls = rows.map((r) => r.o.info.engine_calls);
  const reqs = rows.map((r) => r.o.info.model_requests);
  return { runs: rows.length, pass: rows.filter((r) => r.o.outcome_pass).length, callsMed: med(calls), callsMax: Math.max(0, ...calls), reqMed: med(reqs), reqMax: Math.max(0, ...reqs) };
}

function config(dir: string): string {
  const f = join(dir, 'summary.json');
  if (!existsSync(f)) return '';
  const s = JSON.parse(readFileSync(f, 'utf8'));
  const runFile = readdirSync(dir).find((x) => x.endsWith('.run.json'));
  const c = runFile ? JSON.parse(readFileSync(join(dir, runFile), 'utf8')).config : null;
  return c ? `playbook ${c.playbook_path}; references ${c.reference_paths.join(', ') || 'none'}; tony ${s.tony}` : `tony ${s.tony}`;
}

function main() {
  const a = args();
  if (!a.a || !a.b) throw new Error('usage: compare.ts --a <outdirA> --b <outdirB> [--out <dir>]');
  const A = load(resolve(a.a));
  const B = load(resolve(a.b));
  const keys = [...new Set([...A, ...B].map((r) => `${r.scenario}|${r.mode}`))].sort();
  const lines: string[] = [];
  lines.push(`# Outcome comparison`, '', `- A: ${a.a} (${config(resolve(a.a))})`, `- B: ${a.b} (${config(resolve(a.b))})`, '');
  lines.push('| scenario | mode | A end | A approvals | A recovery | A comms | A pass | B end | B approvals | B recovery | B comms | B pass |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const [sc, mode] = k.split('|') as [string, string];
    const ra = A.filter((r) => r.scenario === sc && r.mode === mode);
    const rb = B.filter((r) => r.scenario === sc && r.mode === mode);
    lines.push(`| ${sc} | ${mode} ${cell(ra)}${cell(rb).slice(1)}`.replace('|  |', '|'));
  }
  lines.push('');
  lines.push('| variant | runs | outcome pass | engine calls median | engine calls max | model requests median | model requests max |', '|---|---|---|---|---|---|---|');
  for (const [name, rows] of [['A', A], ['B', B]] as const) {
    const s = stats(rows);
    lines.push(`| ${name} | ${s.runs} | ${s.pass}/${s.runs} | ${s.callsMed} | ${s.callsMax} | ${s.reqMed} | ${s.reqMax} |`);
  }
  const fails: string[] = [];
  for (const [name, rows] of [['A', A], ['B', B]] as const) {
    for (const r of rows) {
      if (r.o.outcome_pass) continue;
      const d = ['end_state', 'approval_correctness', 'recovery', 'communication'].flatMap((k) => (r.o[k].ok ? [] : r.o[k].details.map((x: string) => `${k}: ${x}`)));
      fails.push(`- ${name} ${r.scenario}.${r.mode}.${r.n}: ${d.join(' | ')}`);
    }
  }
  if (fails.length) lines.push('', '## Failures', ...fails);
  const outDir = resolve(a.out ?? '.');
  mkdirSync(outDir, { recursive: true });
  const text = lines.join('\n') + '\n';
  writeFileSync(join(outDir, 'compare.md'), text);
  console.log(text);
}

main();
