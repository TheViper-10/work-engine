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
for (let i = Number(process.env.FROM ?? 0); i < orders; i++) {
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
    // No permanent busy thread (H6): a claim nobody ever confirms must not block the thread for a fresh session.
    for (const th of ['A', 'B', 'D', 'E', 'Q', 'C', 'Z']) {
      const c = await w.peek<any>('claim', th);
      if (c?.state !== 'open') continue;
      const j = await w.peek<any>('job', c.job);
      if (!j || j.status === 'done' || j.status === 'cancelled') continue;
      // one probe per thread: a fresh session asks for a different milestone, which must not be told to wait forever
      const other = Object.keys(w.spec.milestones!).find((m) => m !== c.milestone)!;
      const probe = await w.api('say', { job: c.job, thread: th, milestone: other }, 'probe-fresh');
      if (probe.status === 'busy') throw new Violation(`thread ${th}: milestone ${other} is busy behind a claim for ${c.milestone} that was last touched ${Math.round((w.now() - c.touched) / 60000)} min ago`);
    }
    totalSteps += n;
  } catch (e) {
    console.log(`VIOLATION seed=${seed} mode=${mode} order=${i} step=${sim.steps}/${n}`);
    console.log(e instanceof Violation ? e.message : (e as Error).stack);
    console.log('--- last 20 steps ---');
    console.log(w.trace.slice(-Number(process.env.TAIL ?? 20)).join('\n'));
    process.exit(1);
  }
}
console.log(`OK mode=${mode} seed=${seed}: ${orders} orders, ${totalSteps} steps, no violations`);
