// Shared types for the replay harness. No imports from src/ so the harness stays independent of the engine.

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Event handed to the engine. Field names match IngestEvent in src/types.ts, plus the own_bot sender kind. */
export interface EngineEvent {
  source: string;
  delivery_id: string;
  kind: string;
  thread?: string;
  sender_id?: string;
  sender_kind?: 'human' | 'own_bot' | 'other_bot' | 'system';
  ref?: string;
  attrs?: Record<string, unknown>;
  /** Virtual epoch ms when the event happened (harness extra, ignored by engines that do not need it). */
  at?: number;
}

export interface EngineCtx {
  /** Platform-provided session id. Tony never passes it. */
  session_id: string;
  /** Virtual epoch ms. */
  now: number;
}

export interface WakeMsg {
  dm: string;
  text: string;
  job?: string;
}

export type Mode = 'flag' | 'hold';

export interface EngineBinding {
  readonly name: string;
  ingest(event: EngineEvent): void | Promise<void>;
  /** Called every 5 virtual minutes. */
  sweep(nowMs: number): void | Promise<void>;
  /** The six engine tool JSON schemas Tony sees. */
  toolsForModel(): ToolSchema[];
  callTool(name: string, input: any, ctx: EngineCtx): any | Promise<any>;
  /** The binding calls cb when the engine wants to wake Tony (text posted in the job DM). */
  onWake(cb: (w: WakeMsg) => void): void;
  /** Optional: scenario timer entries other than sweep (for example wake_twin). */
  timer?(kind: string, nowMs: number, entry: any): void | Promise<void>;
  /** Optional: the run's hold/flag setting for the five intend checks. */
  setMode?(mode: Mode): void;
  /** Optional: final engine-side state for scoring (job status, milestones, deliveries). */
  snapshot?(): any;
}

export interface OwnCall {
  seq: number;
  t: number; // virtual minutes
  session: string;
  name: string;
  input: any;
  output: any;
  error: boolean;
  effects: string[];
}

export interface EngineCall {
  seq: number;
  t: number;
  session: string;
  name: string;
  input: any;
  output: any;
  error?: string;
}

export interface OwnPost {
  thread: string;
  ts: string;
  text: string;
  via: 'tool' | 'relay';
  session: string;
  t: number;
  /** Milestone this post delivers: an open say claim in the thread, else a text heuristic for live, else null. */
  milestone: string | null;
  /** The connector never emitted an event for this post (fault). */
  dropped: boolean;
}

export interface SessionRecord {
  id: string;
  trigger: { kind: 'mention' | 'wake'; thread?: string; sender?: string; text: string };
  start_t: number;
  end_t: number;
  turns: number;
  tool_calls: number;
  truncated: boolean;
  final_text: string;
  error?: string;
  transcript: any[];
}

export interface RunResult {
  scenario: string;
  mode: Mode;
  binding: string;
  tony: string;
  sessions: SessionRecord[];
  sessions_dropped: number;
  engine_calls: EngineCall[];
  own_calls: OwnCall[];
  posts: OwnPost[];
  timeline: { total: number; fired: number; unfired: { idx: number; kind: string; t: number; when?: unknown }[] };
  final_world: any;
  end_clock: number;
  usage: { input_tokens: number; output_tokens: number; requests: number };
  engine_snapshot?: any;
}
