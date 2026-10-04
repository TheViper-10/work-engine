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

/** flag and hold set every check to that mode (sim). deploy is the pilot preset, DEPLOY_CHECKS in src/config.ts (R31). */
export type Mode = 'flag' | 'hold' | 'deploy';

export interface EngineBinding {
  readonly name: string;
  /** Optional: the driver hands over the fake world and the (placeholder-filled) scenario before the run starts. */
  attach?(world: any, scenario: any): void;
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
  snapshot?(): any | Promise<any>;
  /** Optional: tell the engine which DM a session lives in (its session directory). Called once when a session starts. */
  registerSession?(sessionId: string, dm: string): void;
  /** Optional: the job's current home DM, read without side effects (for the one_action_owner bar). */
  homeOf?(job: string): Promise<string | undefined>;
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
  /** DM of the session that made the call. */
  dm?: string;
  /** The job's home DM when the call was made (jobs only). */
  home?: string;
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
  /** Text heuristic (live / qa_ready) at post time, for relay posts too. Used only for the double-post bar. */
  text_milestone?: string | null;
  /** An open say claim in the thread was consumed by this post. */
  claimed?: boolean;
  /** The connector never emitted an event for this post (fault). */
  dropped: boolean;
}

export interface SessionRecord {
  id: string;
  trigger: { kind: 'mention' | 'wake'; thread?: string; sender?: string; text: string };
  /** The DM this session runs in: the job home for a wake, mention:<thread>:<n> for a Slack mention. */
  dm: string;
  /** Wakes and notices delivered into this session as new user messages while it was active. */
  steers: { t: number; text: string }[];
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
  /** Which playbook/reference files built the system prompt (harness extra). */
  config?: { playbook_path: string; reference_paths: string[]; playbook_sha256: string; prompt_sha256: string; guidance_version: { combined: string; files: Record<string, string> } };
}
