// Shared types. Nothing here names a workflow: all names arrive as data in a Spec.

export type CheckName =
  | 'superseded_run'
  | 'job_cancelled'
  | 'lease_held'
  | 'build_changed'
  | 'sender_not_listed';
export type CheckMode = 'hold' | 'flag';
export type FlagKind = CheckName | 'missing_session' | 'unclaimed_post' | 'not_work_run';

export interface Clock {
  now(): number; // epoch ms
}

export interface Ctx {
  /** Platform-provided session identity. The caller never sets it by hand. */
  session_id?: string;
}

/** Workflow data. The engine reads these fields generically and never interprets ids. */
export interface Spec {
  workflow: string;
  version: number;
  link_roles: string[];
  resources?: string[];
  people?: Record<string, { slack?: string; name?: string }>;
  gates?: Record<string, { responders: { primary: string[]; stand_ins?: string[] } }>;
  milestones?: Record<
    string,
    { audience: { roles: string[]; promise_holders?: boolean }; opens_ask?: string }
  >;
  actions?: Record<string, { resource?: string; gate?: string; proved_by?: string }>;
  defaults?: {
    next_wake_minutes?: number;
    promise_fallback_minutes?: number;
    operation_unknown_minutes?: number;
  };
}

export interface SourceReader {
  /** Fresh read of the outside system: which build a gate is about right now. */
  currentBuild(job: { id: string; workflow: string; target: string }, gate: string): Promise<string | null>;
}
export interface SlackReader {
  findOwnPostAfter(thread: string, ts: number): Promise<{ link?: string; ts?: number } | null>;
}
export interface Waker {
  postWake(dm: string, text: string): Promise<void>;
}

export type JobStatus = 'queued' | 'open' | 'closing' | 'cancel_requested' | 'done' | 'cancelled';
export type MilestoneSource = 'tony_reported' | 'webhook_verified';

export interface Job {
  id: string;
  workflow: string;
  target: string;
  spec_version: number;
  status: JobStatus;
  reported_status: string;
  waiting_for: string;
  next_wake_at: number | null;
  requester: string | null;
  cancel_reason: string | null;
  milestones: Record<string, { at: number; source: MilestoneSource }>;
  run_seq: number;
  current_run: number | null;
  dm_id: string;
  threads: string[];
  private_threads: string[];
  roles: Record<string, string>;
  op_keys: string[];
  ask_keys: string[];
  latest_ask: Record<string, string>;
  delivery_keys: string[];
  promise_keys: string[];
  flag_keys: string[];
  event_ids: string[];
  flag_seq: number;
  wake_reasons: string[];
  claims: Record<string, string>; // thread -> milestone with an open claim
  sched_bucket: number;
  blocked_by_jobs: string[];
  replaced_by: string | null;
  opened_at: number;
  closed_at: number | null;
}

export interface Run {
  id: string;
  job: string;
  n: number;
  session_id: string | null;
  origin: 'wake' | 'mention' | 'job_open' | 'adopted';
  started_at: number;
  last_activity_at: number;
  state: 'active' | 'idle' | 'superseded';
}

export type OpOutcome = 'in_flight' | 'done' | 'failed' | 'unknown' | 'held';
export interface Operation {
  key: string;
  job: string;
  action: string;
  ref: string;
  because: string | null;
  intent_at: number;
  session: string | null;
  outcome: OpOutcome;
  source: 'tony_reported' | 'webhook_verified';
  flags: string[];
  holds: string[];
  note: string;
  resource: string | null;
  lease_taken: boolean;
  outcome_at: number | null;
}

export interface Ask {
  key: string;
  job: string;
  gate: string;
  build: string;
  responders: string[]; // person ids (primary plus stand-ins)
  responder_slack: string[];
  thread: string;
  state: 'open' | 'answered' | 'stale';
  opened_at: number;
  answered_at: number | null;
  answered_by: string | null;
}

export interface Promise_ {
  key: string;
  job: string;
  thread: string;
  milestone: string;
  fallback_at: number;
  state: 'open' | 'fulfilled' | 'due' | 'void';
  created_at: number;
}

export interface Delivery {
  key: string;
  job: string;
  thread: string;
  milestone: string;
  state: 'owed' | 'claimed' | 'sent' | 'void';
  owed_at: number;
  claimed_at: number | null;
  next_check_at: number | null;
  sent_at: number | null;
  sent_count: number;
  message_link: string | null;
  seen_via: 'connector' | 'sweep' | 'relay' | null;
}

export interface Lease {
  resource: string;
  holder_job: string | null;
  ops: string[];
  since: number | null;
}

export interface FlagRecord {
  key: string;
  job: string;
  check: FlagKind;
  mode: CheckMode | 'flag_only';
  detail: string;
  call: string;
  at: number;
}

export interface EventRecord {
  key: string;
  id: string;
  source: string;
  delivery_id: string;
  kind: string;
  thread: string | null;
  sender_id: string | null;
  sender_kind: 'human' | 'own_bot' | 'other_bot' | 'system';
  ref: string | null;
  attrs: Record<string, unknown>;
  received_at: number;
  matched_jobs: string[];
}

export interface IngestEvent {
  source: string;
  delivery_id: string;
  kind: string;
  thread?: string;
  sender_id?: string;
  sender_kind?: 'human' | 'other_bot' | 'system';
  ref?: string;
  attrs?: Record<string, unknown>;
}

/** Every answer is a plain object with say_to_tony in plain words plus structured fields. */
export interface Answer {
  ok: boolean;
  status: string;
  say_to_tony: string;
  [field: string]: unknown;
}
