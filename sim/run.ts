// npx tsx sim/run.ts --orders 1000 --seed 1 --mode flag|hold
import { World, Violation } from './world.ts';
import { Sim } from './actors.ts';
import { Rng } from './random.ts';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const orders = Number(arg('orders', '1000'));
const seed = Number(arg('seed', '1'));
const mode = arg('mode', 'flag') as 'flag' | 'hold';

let totalSteps = 0;
for (let i = 0; i < orders; i++) {
  const rng = new Rng(seed * 1_000_003 + i);
  const w = new World(mode);
  const sim = new Sim(w, rng);
  const n = rng.range(60, 150);
  try {
    for (let s = 0; s < n; s++) await sim.step();
    // every order ends with an hour of quiet and a sweep, then a last full check
    w.clock.advanceMinutes(90);
    await w.sweep();
    sim.afterSweep = true;
    const { checkState } = await import('./invariants.ts');
    const bad = await checkState(w, true);
    if (bad.length) throw new Violation(bad.join('; '));
    totalSteps += n;
  } catch (e) {
    console.log(`VIOLATION seed=${seed} mode=${mode} order=${i} step=${sim.steps}/${n}`);
    console.log(e instanceof Violation ? e.message : (e as Error).stack);
    console.log('--- last 20 steps ---');
    console.log(w.trace.slice(-20).join('\n'));
    process.exit(1);
  }
}
console.log(`OK mode=${mode} seed=${seed}: ${orders} orders, ${totalSteps} steps, no violations`);
