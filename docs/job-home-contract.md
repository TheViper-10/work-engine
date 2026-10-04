# Job-home execution contract (controlling amendment, 2026-10-04)

Owner-approved 2026-10-04: one job, one engine-owned execution DM ("job home"); Slack threads are
communication routes only. This file amends `docs/engine-design.md`; where they disagree, this file
wins. Precedence otherwise unchanged (28, then 27, then 25). Decision-log entries: A1 to A4 (owner
amendments), R20 onward (implementation judgments).

## Terms
- **Job**: stable identity for an outcome and its commitments. Unchanged key `<workflow>:<target>[:seq]`.
- **Home**: the job's engine-owned DM (`job.dm_id`). Created with the job, keyed by job id
  (create-if-absent), never a Slack-connector DM. `job.homes[]` keeps history: `{dm, generation,
  opened_at, closed_at, reason}`.
- **Generation**: integer on the job, starts at 1. Bumped only by controlled replacement.
- **Session**: platform `agent_session_id` (D1). Its DM is looked up, never passed by the caller.
- **Run**: a period of execution by one session in the home, with `generation`. Unchanged record kind.
- **Owner session**: the session whose looked-up DM equals the current home and whose run is the
  current run of the current generation.

## A1. Ownership (replaces D10, extends D1)
- New interface `SessionDirectory.dmOf(session_id) -> {dm} | {error}` (phase 3:
  `ai-agent.sessions.get`, `agent_session.parent`; offline: fake with failure injection). Cache
  successes per session; never cache failures.
- Only an owner session may: `intend` (gets `clear`/lease), `checkpoint` status/waiting_for/
  next_wake/outcomes, `say` for milestones, `job_open(replace|queue)`. The first write from a
  home session with no active run binds the run (reads never bind, R17 M2).
- Non-home sessions (Slack mention DMs, other DMs) may: `job_view`, `job_open(join)` (links the
  thread, never becomes the run), `promise_add` for their own thread, and leave inbox items.
  `intend` from a non-home session answers `route` (recorded as an inbox item: "<session> asked
  for <action> on <ref>"), takes no lease, opens no operation. `checkpoint` from a non-home session
  is a note plus inbox item; it never changes status, wake (except bringing it earlier) or
  outcomes. `say` from a non-home session answers `route`: "the job owner will tell this thread",
  and records the request as an inbox item (the mention reply itself still relays; 27 §3.5 stays).
- A second home session while the current run is active (crash replacement inside the same DM)
  follows R17 run supersession, inside the same generation.

## A2. Identity failure (amends D1 "never hold" for consequential calls only)
- `dmOf` error, or no `session_id`: record diagnostic flag `identity_unconfirmed` (session, reason,
  call), visible in `job_view`. Reads, `promise_add` and inbox items still work.
- Consequential calls (`intend`, status `checkpoint`, milestone `say`) answer `hold:
  ownership unconfirmed` regardless of check config: no `clear`, no lease, no operation in flight.
  This is the one non-configurable hold. Missing identity never establishes action authority.
- Recovery: the job gets wake reason "identity unconfirmed for <session>; resume from the job home",
  so the sweep wakes the home. After `identity_escalate_minutes` (config, default 30) of
  unconfirmed attempts with no confirmed owner call, the job records `escalate` and its wake text
  names the owner.

## A3. Controlled replacement (amends 28 §2 "one DM per job")
- `replaceHome(job, reason)` (engine-side, used by the sweep/wake and an explicit operator call):
  bumps `generation`, creates a new home DM id `dm:<job>:g<n>` create-if-absent, closes the old
  home in `homes[]`, supersedes the current run, and wakes the new home with: pending inbox items,
  unresolved/unknown operations to read back first, owed deliveries and promises.
- Trigger offline: explicit call, or a wake that finds the home session's pinned version stale
  (`Waker` reports `stale_version`). Never two open homes for one job.
- Fencing: every write carries the caller's generation (from its run). A write from a session whose
  run belongs to an older generation answers `superseded: this job moved to a new home` and changes
  nothing except recording an inbox note. External tools cannot be fenced by the engine; a call
  already started by the old session surfaces as an operation that the new home must read back.

## A4. Durable inbox and routing
- New record kind `inbox` keyed `<job>:<event_id>`: `{event, job, sender, sender_kind, thread,
  origin_message, source, received_at, refs, private, kind: message|approval|cancel|request|
  route|note|late, state: received|associated|processed, processed_at, processed_by_run}`.
  Associated = written for this job; processed = acknowledged by an owner `checkpoint` (field
  `processed: [event ids]`, or implicitly all items shown in the view the owner read before that
  checkpoint). Per-job state; one event may have items in several jobs.
- `ingest`: every human or other-bot message in a linked thread, plus route/note items, becomes an
  inbox item (event dedupe unchanged). Thread linked to several jobs: one item per job, marked
  `ambiguous: true`; an ambiguous item cannot be the `because` for an `intend` without a flag
  `ambiguous_association`, and the view says "clarify which job".
- Routing by worker state: active owner run: post a short notice into the home ("new input:
  <n> item(s); read job_view") at most once per `notice_coalesce_minutes` (config, default 2);
  idle/waiting: set wake now (resume in the same home); no home session reachable (wake post
  fails): keep items, retry on sweep, escalate after bound.
- Reads (`job_view`) show unprocessed items oldest first, never consume them.
- Bounds: `inbox_max_unprocessed` (config, default 50). Over the bound, coalesce plain messages
  into one `overflow` item with count and refs; never coalesce approval, cancel or route kinds.
- Ended job: new items are kind `late`, recorded; the view and the next wake (if the owner asked)
  answer the sender in one line; never reopen (R12). Reopen stays explicit via `job_open`.

## Implementation judgments locked with this direction
- **R20 approvals:** any change in the build an ask named invalidates its go (R17 H7 behaviour).
  A go is valid only from a listed responder, for that build, not revoked by a later message of the
  same responder marked cancel/revoke by Tony, and checked again at `intend`.
- **R21 cancel:** owner plus listed stand-ins may cancel; others are recorded (`sender_not_listed`)
  and routed to the home for Tony to ask about.
- **R22 lease under uncertainty (supersedes R17 H5 release-on-cancel):** a lease held by an
  `unknown` operation stays held until readback reports done or failed, even after cancel. A cancel
  with only unknown operations ends as `cancelled` with `cleanup_pending` listing them; the job
  keeps a wake until cleanup is reported, then escalates after `operation_unknown_minutes` x 4.
- **R23 checks:** D2 stays (each of the five checks defaults to flag; gates run in both modes).
  Only A2 is a fixed hold. Engine holds are advisory to the agent (L1); enforceable authority sits
  in branch protection, the native prod-alpha lock (D11) and credential scope (phase 3).
- **R24 guidance:** the goal-oriented playbook is adopted (no further A/B with the old playbook).
  Canonical path `knowledge/desktop-release/playbook.md` with `references.md` (engine contract,
  shared) and `lessons.md` (empty, reviewed promotions only). The job records
  `guidance_version` (sha of playbook + references) at open; a changed version mid-job is noted in
  the view, not applied silently. `workflows/desktop-release/` keeps `spec.json`/`spec.md`; its old
  `playbook.md` is removed once the harness points to the new path.

## Validation (offline)
Unit tests per rule above; sim invariant "at most one action-owning session per job generation"
and "no consequential clear without confirmed identity"; named cases `ib-*` (see
`docs/proposals/hybrid-delta-and-phase3-scope.md` §3); harness: job-home sessions vs mention
sessions, notice into an active home, resume in the same home. Phase-2 gate re-run on this engine
only: scripted all, then real model 10 per mode under flag and hold, D7 bars unchanged.
