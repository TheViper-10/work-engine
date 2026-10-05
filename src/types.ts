// Shared types. Nothing here names a workflow: all names arrive as data in a Spec.

export type CheckName =
  | 'superseded_run'
  | 'job_cancelled'
  | 'lease_held'
  | 'build_changed'
  | 'no_go_for_build'
  | 'sender_not_listed';
export type CheckMode = 'hold' | 'flag';
export type FlagKind =
  | CheckName | 'missing_session' | 'unclaimed_post' | 'not_work_run' | 'job_ended'
  | 'source_unreadable' | 'ambiguous_outcome' | 'unknown_outcome'
  | 'identity_unconfirmed' | 'ambiguous_association' | 'escalate' | 'unknown_milestone' | 'unknown_action'
  | 'wake_failed' | 'admin_close' | 'target_mismatch';

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
  /** R52: at most one open job for the workflow. A join for anything else (a placeholder target, another target) joins the open job. */
  one_open_job?: boolean;
  /** R52: regular expression a target must match to name a job of its own. A target that does not match is never a job. */
  target_pattern?: string;
  resources?: string[];
  people?: Record<string, { slack?: string; name?: string }>;
  gates?: Record<string, { responders: { primary: string[]; stand_ins?: string[] } }>;
  milestones?: Record<
    string,
    { audience: { roles: string[]; promise_holders?: boolean }; opens_ask?: string;
      /** R55: an outcome milestone is reached only through checkpoint(reached), after the source was read. `say` claims it only once reached. */
      outcome?: boolean }
  >;
  actions?: Record<string, { resource?: string; gate?: string; proved_by?: string }>;
  defaults?: {
    next_wake_minutes?: number;
    promise_fallback_minutes?: number;
    operation_unknown_minutes?: number;
    claim_stale_minutes?: number;
  };
}

export interface SourceReader {
  /** Fresh read of the outside system: which build a gate is about right now. */
  currentBuild(job: { id: string; workflow: string; target: string }, gate: string): Promise<string | null>;
}
export interface SlackReader {
  /** `relay` marks a reply to a mention; it never satisfies a claim. */
  findOwnPostAfter(thread: string, ts: number): Promise<{ link?: string; ts?: number; relay?: boolean } | null>;
  /** R54: the thread a posted message belongs to, from its link. null means it could not be told. Optional: without it links are taken as reported. */
  threadOfLink?(link: string): Promise<string | null>;
}
export interface Waker {
  /** May report `stale_version` when the home session is pinned to an old agent version (A3): the engine then replaces the home. */
  /**
   * `key` names the wake (the run id, or run id plus a notice sequence for notices). The same key is the same wake:
   * an adapter sends it at most once whatever the text, so a retry with a re-timed text does not stack a second one.
   */
  postWake(dm: string, text: string, key: string): Promise<void | { stale_version?: boolean }>;
  /**
   * R41: a cheap, local check (no I/O, no writes) for a configuration that makes every wake fail. A string is the
   * config error. The engine then records it once and does not try the post again until the next recheck.
   */
  preflight?(): string | null;
}

export type SessionLookup = { dm: string } | { error: string };
export type ThreadLookup = { thread: string } | { error: string };
/** A1: which DM a session lives in. Looked up, never passed by the caller. Phase 3: the platform's session record. */
export interface SessionDirectory {
  /** `job` is a hint for offline defaults that map a session to a job's home; a real directory ignores it. */
  dmOf(sessionId: string, job?: { id: string; dm: string; generation: number }): Promise<SessionLookup>;
  /** false when the answer depends on the job hint, so the engine must not cache it per session. */
  readonly cacheable?: boolean;
  /** R51: the external thread (channel and thread ts) a conversation was opened for, read from the platform record of the session's DM. Optional. */
  threadOf?(sessionId: string): Promise<ThreadLookup>;
}

export type JobStatus = 'queued' | 'open' | 'closing' | 'cancel_requested' | 'done' | 'cancelled';
export type MilestoneSource = 'tony_reported' | 'webhook_verified';

export interface Home { dm: string; generation: number; opened_at: number; closed_at: number | null; reason: string }

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
  notes: Array<{ at: number; session: string | null; status: string; waiting_for: string }>;
  sched_bucket: number;
  blocked_by_jobs: string[];
  replaced_by: string | null;
  opened_at: number;
  closed_at: number | null;
  // --- job-home contract (A1 to A4, R22, R24)
  generation: number;
  homes: Home[];
  /** session -> generation of the run it last held; a lower number than the job's generation means fenced (A3). */
  session_gen: Record<string, number>;
  /** Keys of inbox items not yet processed (per-job array like op_keys). */
  inbox_keys: string[];
  inbox_seq: number;
  inbox_notice_at: number | null;
  /** Count of notices into the home; with the run id it keys each notice for the exactly-once waker. */
  notice_seq?: number;
  /** owner session -> inbox keys shown in the view it last read (implicitly processed by its next checkpoint). */
  inbox_seen: Record<string, string[]>;
  inbox_escalated: boolean;
  identity: { since: number; last: number; sessions: string[]; attempts: number; escalated: boolean } | null;
  /** Operations left unknown when a cancel ended the job (R22); their leases stay held until readback. */
  cleanup_pending: string[];
  cleanup_escalated: boolean;
  guidance_version: string | null;
  /** R41: the state of a failing wake; absent when wakes work. */
  wake_fail?: WakeFail;
  /** R56: wakes in a row whose run was never answered by a session in the home. */
  wake_tries?: number;
}

/** R45: thrown by a Waker when no retry can help until configuration changes (not an outage). The engine flags it once and rechecks hourly. */
export class WakeConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'WakeConfigError'; }
}

export interface WakeFail { count: number; first_at: number; last_at: number; retry_at: number; error: string; config: boolean; escalated: boolean; /** config error found by preflight (fixed as soon as preflight passes) */ pre?: boolean }

export type InboxKind = 'message' | 'approval' | 'cancel' | 'request' | 'route' | 'note' | 'late';
export interface InboxItem {
  key: string;
  seq: number;
  event: string;
  job: string;
  sender: string | null;
  sender_kind: string;
  thread: string | null;
  origin_message: string | null;
  source: string;
  received_at: number;
  refs: string[];
  private: boolean;
  kind: InboxKind;
  state: 'received' | 'associated' | 'processed';
  processed_at: number | null;
  processed_by_run: string | null;
  ambiguous?: boolean;
  text?: string;
  /** Set on the coalesced overflow item (A4). */
  overflow?: { count: number };
}

export interface Run {
  id: string;
  job: string;
  n: number;
  /** Generation of the job home this run belongs to (A3 fencing). */
  generation?: number;
  session_id: string | null;
  origin: 'wake' | 'mention' | 'job_open' | 'adopted';
  started_at: number;
  last_activity_at: number;
  state: 'active' | 'idle' | 'superseded';
  /** R56: a session in the home has called the engine since this run was woken (a read counts). */
  answered?: boolean;
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
  seen_via: 'connector' | 'sweep' | 'relay' | 'agent' | null;
  /** Starts at 1; a re-ask for a new build starts another round. */
  round: number;
  /** Set when a claim for this message went stale unseen: the post may exist, so the next say must say read first. */
  prior_claim_at?: number | null;
}

/** One per thread (key claim:<thread>), create-if-absent, owned by the session that claimed. */
export interface Claim {
  thread: string;
  job: string;
  milestone: string;
  session: string | null;
  at: number; // when first claimed: a post must be at or after this
  touched: number; // last say by the owner, or hand-over time: staleness is measured from here
  state: 'open' | 'closed';
  round: number;
}

export interface Lease {
  resource: string;
  holder_job: string | null;
  ops: string[];
  since: number | null;
  waiters?: string[];
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
  state?: 'received' | 'done';
  /** Set when the event came from a private link of any job; views then show it only as held. */
  private_origin?: boolean;
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
