import { ENGINE_TOOLS } from './engine-tools.ts';
import type { EngineBinding, EngineCtx, EngineEvent, Mode, WakeMsg } from './types.ts';

/** Records everything and answers {say_to_tony:"ok"}. For smoke tests without the engine. */
export class StubEngineBinding implements EngineBinding {
  readonly name = 'stub';
  events: EngineEvent[] = [];
  sweeps: number[] = [];
  calls: { name: string; input: any; ctx: EngineCtx }[] = [];
  mode: Mode = 'flag';
  private wakeCb: (w: WakeMsg) => void = () => {};

  setMode(mode: Mode): void {
    this.mode = mode;
  }
  ingest(e: EngineEvent): void {
    this.events.push(e);
  }
  sweep(nowMs: number): void {
    this.sweeps.push(nowMs);
  }
  toolsForModel() {
    return ENGINE_TOOLS;
  }
  callTool(name: string, input: any, ctx: EngineCtx) {
    this.calls.push({ name, input, ctx });
    return { ok: true, status: 'ok', say_to_tony: 'ok' };
  }
  onWake(cb: (w: WakeMsg) => void): void {
    this.wakeCb = cb;
  }
  snapshot() {
    return { stub: true, events: this.events.length, sweeps: this.sweeps.length, calls: this.calls.length };
  }
}
