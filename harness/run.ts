// CLI: npx tsx harness/run.ts --scenario <id|all> --mode flag|hold --runs N --binding stub|engine --tony model|scripted [--playbook <path>] [--reference <path>[,<path>]] --out harness/out/<stamp>
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Driver, loadPlaybook } from './driver.ts';
import { GatewayTony, type TonyModel } from './model.ts';
import { ScriptedTony } from './scripted-tony.ts';
import { aggregate, score, summaryLine, type Score } from './score.ts';
import { outcome, outcomeLine } from './outcome.ts';
import { RealEngineBinding } from './engine-binding.ts';
import { StubEngineBinding } from './stub-binding.ts';
import type { EngineBinding, Mode } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i]!.startsWith('--')) out[a[i]!.slice(2)] = a[i + 1] && !a[i + 1]!.startsWith('--') ? a[++i]! : 'true';
  return out;
}

function makeBinding(kind: string): EngineBinding {
  if (kind === 'stub') return new StubEngineBinding();
  if (kind === 'engine') return new RealEngineBinding(ROOT);
  throw new Error(`unknown --binding ${kind}`);
}

async function main() {
  const a = args();
  const scenario = a.scenario ?? 'v2-18';
  const modes: Mode[] = a.mode === 'both' ? ['flag', 'hold'] : [((a.mode ?? 'flag') as Mode)];
  const runs = Number(a.runs ?? 1);
  const bindingKind = a.binding ?? 'stub';
  const tonyKind = a.tony ?? 'model';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(ROOT, a.out ?? `harness/out/${stamp}`);
  mkdirSync(out, { recursive: true });

  const ids = scenario === 'all' ? readdirSync(join(ROOT, 'scenarios')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [scenario];
  const sha256 = (x: string) => createHash('sha256').update(x).digest('hex');
  const playbookPath = resolve(ROOT, a.playbook ?? 'workflows/desktop-release/playbook.md');
  const referencePaths = (a.reference && a.reference !== 'true' ? a.reference.split(',') : []).map((p) => resolve(ROOT, p.trim())).filter(Boolean);
  const playbookText = loadPlaybook(ROOT, playbookPath);
  // Reference files follow the playbook, each under a heading with its file name.
  const playbook = [playbookText.trimEnd(), ...referencePaths.map((p) => `## Reference: ${basename(p)}\n\n${readFileSync(p, 'utf8').trim()}`)].join('\n\n');
  const scores: Score[] = [];
  const outcomes: ReturnType<typeof outcome>[] = [];

  for (const id of ids) {
    const sc = JSON.parse(readFileSync(join(ROOT, 'scenarios', `${id}.json`), 'utf8'));
    for (const mode of modes) {
      for (let n = 1; n <= runs; n++) {
        const binding = makeBinding(bindingKind);
        const tony: TonyModel = tonyKind === 'scripted' ? new ScriptedTony() : new GatewayTony();
        const driver = new Driver({ scenario: sc, playbook, binding, tony, mode, log: a.quiet ? undefined : (l) => console.log('  ' + l) });
        const run = await driver.run();
        run.config = { playbook_path: playbookPath, reference_paths: referencePaths, playbook_sha256: sha256(playbookText), prompt_sha256: sha256(driver.system) };
        const s = score(run, driver.sc);
        const oc = outcome(run, driver.sc, s);
        scores.push(s);
        outcomes.push(oc);
        const base = `${id}.${mode}.${n}`;
        writeFileSync(join(out, `${base}.run.json`), JSON.stringify(run, null, 1));
        writeFileSync(join(out, `${base}.score.json`), JSON.stringify(s, null, 1));
        writeFileSync(join(out, `${base}.outcome.json`), JSON.stringify(oc, null, 1));
        console.log(summaryLine(s, run));
        console.log(outcomeLine(oc));
      }
    }
  }
  const agg = aggregate(scores);
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ tony: tonyKind, binding: bindingKind, aggregate: agg, outcome_pass: outcomes.filter((o) => o.outcome_pass).length, outcome_total: outcomes.length, playbook: playbookPath, references: referencePaths, scores, outcomes }, null, 1));
  console.log(`output: ${out}`);
}

main().catch((e) => {
  console.error('run failed:', (e as Error).message);
  process.exit(1);
});
