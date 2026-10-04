// Scenario driver: virtual clock, timeline ordering, Tony sessions, engine delivery.

import { readFileSync } from 'node:fs';
import { ENGINE_TOOL_NAMES } from './engine-tools.ts';
import { buildSystemPrompt, type Block, type TonyMessage, type TonyModel } from './model.ts';
import type { EngineBinding, EngineCall, EngineEvent, Mode, RunResult, SessionRecord, WakeMsg } from './types.ts';
import { EPOCH_MS, World } from './world.ts';

export const MAX_TOOL_CALLS_PER_SESSION = 40;
export const MAX_SESSIONS_PER_RUN = 40;
export const SWEEP_EVERY_MIN = 5;
const QUIET_SWEEPS_TO_END = 8;
const TURN_MIN = 1;

interface Entry {
  idx: number;
  raw: any;
  trueAt: number | null;
  fired: boolean;
}

interface Session {
  rec: SessionRecord;
  key: string;
  messages: TonyMessage[];
  nextAt: number;
  done: boolean;
  relayThread?: string;
}

interface Trigger {
  kind: 'mention' | 'wake';
  key: string;
  thread?: string;
  sender?: string;
  text: string;
  at: number;
  dm?: string;
}

const isoAt = (tMin: number) => new Date(EPOCH_MS + tMin * 60000).toISOString();

function fillPlaceholders(sc: any): any {
  const ids = sc.initial_world?.github?.scripted_ids ?? {};
  let s = JSON.stringify(sc);
  if (ids.pr_number != null) s = s.split('<pr>').join(String(ids.pr_number));
  if (ids.pipeline_id != null) s = s.split('<id>').join(String(ids.pipeline_id));
  return JSON.parse(s);
}

export interface DriverOptions {
  scenario: any;
  playbook: string;
  binding: EngineBinding;
  tony: TonyModel;
  mode: Mode;
  log?: (line: string) => void;
}

export class Driver {
  readonly sc: any;
  readonly world: World;
  private now = 0; // virtual minutes
  private entries: Entry[];
  private sessions: Session[] = [];
  private queued: Trigger[] = [];
  private records: SessionRecord[] = [];
  private sessionCount = 0;
  private dropped = 0;
  private engineCalls: EngineCall[] = [];
  private nextSweep = SWEEP_EVERY_MIN;
  private system: string;
  private log: (l: string) => void;
  private deliverySeq = 0;

  constructor(private o: DriverOptions) {
    this.sc = fillPlaceholders(o.scenario);
    this.world = new World(this.sc);
    this.entries = (this.sc.timeline as any[])
      .map((raw, idx) => ({ idx, raw, trueAt: null, fired: false }))
      .filter((e) => e.raw.type !== 'timer' || e.raw.kind !== 'sweep');
    this.system = buildSystemPrompt(o.playbook, this.sc, 'the job DM');
    this.log = o.log ?? (() => {});
    o.binding.attach?.(this.world, this.sc);
    o.binding.setMode?.(o.mode);
    o.binding.onWake((w) => this.onWake(w));
  }

  // ---- engine plumbing ----
  private nowMs(t = this.now): number {
    return EPOCH_MS + Math.round(t * 60000);
  }
  private async ingest(e: EngineEvent): Promise<void> {
    await this.o.binding.ingest({ ...e, at: this.nowMs() });
  }
  private onWake(w: WakeMsg): void {
    this.queued.push({ kind: 'wake', key: `dm:${w.dm}`, text: w.text, at: this.now, dm: w.dm });
  }

  // ---- timeline ----
  private updatePredicates(): void {
    for (const e of this.entries) {
      if (e.fired || e.trueAt != null) continue;
      if (!e.raw.when || this.world.matches(e.raw.when)) e.trueAt = this.now;
    }
  }
  private effective(e: Entry): number | null {
    if (e.trueAt == null) return null;
    return Math.max(e.raw.t ?? 0, e.raw.when ? e.trueAt + (e.raw.delay_s ?? 0) / 60 : 0);
  }
  private nextEntry(): { e: Entry; at: number } | null {
    let best: { e: Entry; at: number } | null = null;
    for (const e of this.entries) {
      if (e.fired) continue;
      const at = this.effective(e);
      if (at == null) continue;
      if (!best || at < best.at || (at === best.at && e.idx < best.e.idx)) best = { e, at };
    }
    return best;
  }

  private async fire(e: Entry): Promise<void> {
    const r = e.raw;
    e.fired = true;
    const ev = r.event as any | undefined;
    const desc: string[] = [];
    if (r.type === 'slack_message' || r.type === 'bot_post') {
      const p = this.sc.people?.[r.sender] ?? {};
      const senderId = ev?.sender ?? p.slack ?? r.sender;
      this.world.addMessage(r.thread, { user: senderId, name: p.name ?? r.sender, text: r.text, ts: r.slack_ts, bot: r.type === 'bot_post', tMin: this.now });
      this.world.noteHumanMessage(r.thread, r.sender, r.text);
      desc.push(`${r.sender} in ${r.thread}: ${String(r.text).slice(0, 60)}`);
    } else if (r.type === 'timer') {
      await this.o.binding.timer?.(r.kind, this.nowMs(), r);
      desc.push(`timer ${r.kind}`);
    } else {
      desc.push(...this.world.applyChange(r.change));
    }
    this.log(`[t=${this.now.toFixed(1)}] timeline #${e.idx} ${r.type}${r.kind ? ':' + r.kind : ''} ${desc.join('; ').slice(0, 100)}`);
    if (ev && ev.delivered !== false) {
      await this.ingest({
        source: ev.source,
        delivery_id: ev.ref ? `${ev.ref}#${e.idx}` : `tl-${e.idx}`,
        kind: ev.kind,
        thread: ev.thread ?? undefined,
        sender_id: ev.sender,
        sender_kind: ev.sender_kind,
        ref: ev.ref,
        attrs: ev.attrs ?? {},
      });
    } else if (ev) {
      this.log(`   (event not delivered to engine, by scenario)`);
    }
    if ((r.type === 'slack_message') && r.mentions_tony) {
      this.queued.push({
        kind: 'mention',
        key: `thread:${r.thread}`,
        thread: r.thread,
        sender: r.sender,
        text: r.text,
        at: this.now,
      });
    }
    this.updatePredicates();
  }

  // ---- sessions ----
  private startQueued(): void {
    const stillQueued: Trigger[] = [];
    for (const tr of this.queued) {
      if (this.sessions.some((s) => !s.done && s.key === tr.key)) {
        stillQueued.push(tr); // serialize per thread (mentions) or per DM (wakes)
        continue;
      }
      if (this.sessionCount >= MAX_SESSIONS_PER_RUN) {
        this.dropped++;
        continue;
      }
      this.sessionCount++;
      const id = `s${this.sessionCount}`;
      const sender = tr.sender ? this.sc.people?.[tr.sender] : null;
      const userText =
        tr.kind === 'mention'
          ? `[${isoAt(this.now)}] Slack message in thread ${tr.thread} from ${sender?.name ?? tr.sender} (<@${sender?.slack ?? tr.sender}>) mentioning you:\n\n${tr.text}`
          : `[${isoAt(this.now)}] The work engine woke you in ${tr.dm ?? 'the job DM'}:\n\n${tr.text}`;
      const rec: SessionRecord = {
        id,
        trigger: { kind: tr.kind, thread: tr.thread, sender: tr.sender, text: tr.text },
        start_t: this.now,
        end_t: this.now,
        turns: 0,
        tool_calls: 0,
        truncated: false,
        final_text: '',
        transcript: [{ role: 'user', text: userText }],
      };
      this.records.push(rec);
      this.sessions.push({ rec, key: tr.key, messages: [{ role: 'user', content: userText }], nextAt: this.now, done: false, relayThread: tr.kind === 'mention' ? tr.thread : undefined });
      this.log(`[t=${this.now.toFixed(1)}] session ${id} start (${tr.kind}${tr.thread ? ' ' + tr.thread : ''})`);
    }
    this.queued = stillQueued;
  }

  private allTools() {
    return [...this.o.binding.toolsForModel(), ...this.world.toolSchemas()];
  }

  private async stepSession(s: Session): Promise<void> {
    this.now = Math.max(this.now, s.nextAt);
    const rec = s.rec;
    let resp;
    try {
      resp = await this.o.tony.send({ system: this.system, messages: s.messages, tools: this.allTools() });
    } catch (e) {
      rec.error = (e as Error).message;
      this.endSession(s);
      return;
    }
    rec.turns++;
    s.messages.push({ role: 'assistant', content: resp.content });
    const text = resp.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
    const uses = resp.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    rec.transcript.push({ role: 'assistant', t: this.now, text, tool_calls: uses.map((u) => ({ name: u.name, input: u.input })) });
    if (!uses.length) {
      rec.final_text = text;
      if (s.relayThread && text) {
        const { event } = this.world.tonyPost(s.relayThread, text, 'relay', { session: rec.id, t: this.now });
        if (event) await this.ingest(event);
      }
      this.endSession(s);
      return;
    }
    const results: Block[] = [];
    for (const u of uses) {
      if (rec.tool_calls >= MAX_TOOL_CALLS_PER_SESSION) {
        rec.truncated = true;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ ok: false, error: 'tool call budget for this session is spent' }), is_error: true });
        continue;
      }
      rec.tool_calls++;
      const { content, isError } = await this.execTool(s, u.name, u.input);
      results.push({ type: 'tool_result', tool_use_id: u.id, content, is_error: isError || undefined });
      rec.transcript.push({ role: 'tool', name: u.name, is_error: isError, content: content.slice(0, 1500) });
    }
    s.messages.push({ role: 'user', content: results });
    if (rec.truncated) {
      rec.final_text = text;
      this.endSession(s);
      return;
    }
    s.nextAt = this.now + TURN_MIN;
    this.updatePredicates();
  }

  private endSession(s: Session): void {
    s.done = true;
    s.rec.end_t = this.now;
    this.log(`[t=${this.now.toFixed(1)}] session ${s.rec.id} end (turns ${s.rec.turns}, tools ${s.rec.tool_calls}${s.rec.truncated ? ', TRUNCATED' : ''}${s.rec.error ? ', ERROR ' + s.rec.error.slice(0, 80) : ''})`);
  }

  private async execTool(s: Session, name: string, input: any): Promise<{ content: string; isError: boolean }> {
    const ctx = { session: s.rec.id, t: this.now };
    if (ENGINE_TOOL_NAMES.includes(name)) {
      let output: any;
      let error: string | undefined;
      try {
        output = await this.o.binding.callTool(name, input, { session_id: s.rec.id, now: this.nowMs() });
      } catch (e) {
        error = (e as Error).message;
        output = { ok: false, error };
      }
      this.engineCalls.push({ seq: this.world.nextSeq(), t: this.now, session: s.rec.id, name, input, output, error });
      if (name === 'say' && !error) {
        const st = String(output?.status ?? '');
        if (!/already_sent|busy/i.test(st) && input?.thread && input?.milestone) this.world.noteClaim(String(input.thread), String(input.milestone));
      }
      return { content: JSON.stringify(output), isError: !!error };
    }
    if (!this.world.ownToolNames.includes(name)) {
      return { content: JSON.stringify({ ok: false, error: `Unknown tool ${name}` }), isError: true };
    }
    const r = this.world.callTool(name, input, ctx);
    for (const ev of r.events) await this.ingest(ev);
    if (r.effects.length) this.log(`[t=${this.now.toFixed(1)}] ${s.rec.id} ${name} -> ${r.effects.join('; ')}${r.error ? ' (ERROR)' : ''}`);
    return { content: JSON.stringify(r.output), isError: r.error };
  }

  // ---- main loop ----
  async run(): Promise<RunResult> {
    this.updatePredicates();
    const lastT = Math.max(0, ...(this.sc.timeline as any[]).map((e) => e.t ?? 0));
    const horizon = lastT + 180;
    let quiet = 0;
    for (let guard = 0; guard < 5000; guard++) {
      this.startQueued();
      const ne = this.nextEntry();
      const live = this.sessions.filter((x) => !x.done);
      const ns = live.length ? live.reduce((a, b) => (b.nextAt < a.nextAt ? b : a)) : null;
      const cands: { at: number; rank: number; kind: 'entry' | 'session' | 'sweep' }[] = [];
      if (ne) cands.push({ at: ne.at, rank: 0, kind: 'entry' });
      cands.push({ at: this.nextSweep, rank: 1, kind: 'sweep' });
      if (ns) cands.push({ at: ns.nextAt, rank: 2, kind: 'session' });
      cands.sort((a, b) => a.at - b.at || a.rank - b.rank);
      const c = cands[0]!;
      if (c.at > horizon) break;
      if (c.kind === 'entry') {
        this.now = Math.max(this.now, c.at);
        await this.fire(ne!.e);
        quiet = 0;
      } else if (c.kind === 'session') {
        await this.stepSession(ns!);
        quiet = 0;
      } else {
        this.now = Math.max(this.now, c.at);
        this.nextSweep += SWEEP_EVERY_MIN;
        await this.o.binding.sweep(this.nowMs());
        const idle = !live.length && !this.queued.length && !this.entries.some((e) => !e.fired && this.effective(e) != null);
        if (idle) quiet++;
        else quiet = 0;
        if (quiet >= QUIET_SWEEPS_TO_END) break;
      }
      this.updatePredicates();
    }
    for (const s of this.sessions) if (!s.done) {
      s.rec.error ??= 'run ended with session still active';
      this.endSession(s);
    }
    return {
      scenario: this.sc.id,
      mode: this.o.mode,
      binding: this.o.binding.name,
      tony: this.o.tony.name,
      sessions: this.records,
      sessions_dropped: this.dropped,
      engine_calls: this.engineCalls,
      own_calls: this.world.calls,
      posts: this.world.posts,
      timeline: {
        total: this.entries.length,
        fired: this.entries.filter((e) => e.fired).length,
        unfired: this.entries.filter((e) => !e.fired).map((e) => ({ idx: e.idx, kind: `${e.raw.type}${e.raw.kind ? ':' + e.raw.kind : ''}`, t: e.raw.t, when: e.raw.when })),
      },
      final_world: this.world.data,
      end_clock: this.now,
      usage: { ...this.o.tony.usage },
      engine_snapshot: await this.o.binding.snapshot?.(),
    };
  }
}

export function loadPlaybook(root: string): string {
  return readFileSync(`${root}/workflows/desktop-release/playbook.md`, 'utf8');
}
