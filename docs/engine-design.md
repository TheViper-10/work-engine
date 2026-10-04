# Engine design contract (phases 0 to 2)

This file is the shared contract between the spec, engine, simulator, playbook and harness.
Source of truth: handoff file 28 §3 (D1 to D14), then file 27 (L1 to L4), then file 25.
If code and this file disagree, fix one of them and log it in `decision-log.md`.

## Principle (L1)
The engine keeps state, records what Tony commits, bridges events to jobs, guarantees a next
action, and wakes Tony when a job is unblocked. It never decides steps, their order, or what a
message means. It never refuses for protocol reasons. It cannot physically stop Tony.

## Record kinds
Stored in two platform types later (phase 3): `work_record` (all kinds below except event) and
`work_event`. Every record has `unique_key = work-engine:<env>:<bot>:<kind>:<id>`.
Writes are create-if-absent by key (or update by key). Reads are by key or a batch of keys
(at most 100). Never list a whole kind. Indexes the engine needs (for example "jobs linked to
thread T") are themselves records keyed by the lookup value (for example
`thread_index:<thread>` holding job ids).

| Kind | Id | Holds |
|---|---|---|
| job | `<workflow>:<target>` plus a sequence when queued or replaced | workflow, target, spec version, status, waiting_for, next_wake_at, requester, cancel state, milestones reached (with source), current run id, dm id |
| link | `<job>:<thread>` | role (from spec link roles), private flag, created_at |
| run | `<job>:<n>` | session_id (D1) or pending, origin (wake, mention, job_open), started_at, last_activity_at, state active, idle, superseded |
| event | `<source>:<delivery_id>` | source, kind, thread?, sender id, sender kind (human, own_bot, other_bot, system), ref, attrs, received_at, matched jobs |
| ask | `<job>:<gate>:<build>` | gate, build, responders (primary plus stand-ins from spec, D9), thread, state open, answered, stale |
| operation | `<job>:<action>:<ref>` | action, ref, because, intent time, session, outcome in_flight, done, failed, unknown, source (tony_reported, webhook_verified), flags, note |
| promise | `<job>:<thread>:<milestone>` | fallback_at, state open, fulfilled, due |
| delivery | `<job>:<thread>:<milestone>` | state owed, claimed, sent, with claim time, sent time, message link, how seen (connector, sweep, relay) |
| lease | `<resource>` | holder job, operation, since |
| flag | `<job>:<n>` | check, detail, call, time (flags are records, so Tony and the auditor see them) |

## The six calls (D12)
Every call takes a platform context `{ session_id?: string, now }`. Tony never passes a token (D1).
A call without a session id is recorded and flagged `missing_session`, never held.
All calls answer synchronously. No call throws for protocol reasons; bad input gets an answer
that says what was recorded and what is missing.

1. `job_open(workflow, target, thread, role?, private?, intent = join | replace | queue)`
   - No open job for workflow plus target: create it, link the thread (role defaults to the spec's
     first link role), and the caller becomes the work run if no run is active.
   - Open job exists and intent is join: link the thread (if not linked), answer "already running,
     linked you". The caller becomes the work run only if no run is active (D10).
   - intent replace: the old job becomes cancel requested (see cancel below) and a new job opens.
   - intent queue: a new job opens with status queued; it is woken when the leases it needs free.
   - Returns the view plus `work_run: you | other (what it is doing) | none`.
2. `job_view(job | thread)` read-only, never refused.
   - Thread linked to several jobs: return all of them (L4). Unlinked thread: "no job here" plus a
     one-line list of open jobs.
   - View: status, waiting_for, next wake, events with age and source, open asks, operations with
     outcome and age (in-flight past the timeout shows unknown), owed deliveries per milestone and
     thread, open claims ("claimed, not seen yet"), promises, flags, work run busy or idle.
   - Privacy: events from a private link are shown to other threads only as "held: evidence from
     another thread".
3. `intend(job, action, ref, because?)`
   - Same job, action and ref returns the same operation (idempotent, D5).
   - Runs the checks below. Each check's result is `hold` or `flag` by the one config place
     `EngineConfig.checks` (D2, every check defaults to `flag`).
   - flag (or no finding): records the operation in flight, takes the spec's lease for the action
     if any, marks the matching ask answered, answers `clear` with any flags listed in words.
   - hold: records the attempt, does not take the lease, answers `hold` with the reason and the
     next legal moves in words (for example "ask the owner again for build def").
   - Before any finding that relies on an outside fact (the build), re-read the source through the
     `SourceReader` interface (D7, verify before hold). A Tony-reported fact never causes a hold (L3).
4. `say(job, thread, milestone)` claim only (L2, D6). Tony posts himself afterwards.
   - Delivery for thread plus milestone already sent: answer `already_sent` with the link.
   - Open claim for the same thread and milestone: answer `already_claimed` with claim time and
     "not seen yet: check the thread; if your post is absent, post now".
   - Open claim for another milestone in the thread: answer `busy: claim for <milestone> still open`.
   - Otherwise record the claim and answer `go`. If the milestone's spec entry names a gate, open an
     ask for that gate and the job's current build (read through `SourceReader`).
   - First claim for a milestone marks the milestone reached (Tony-reported) if not already.
5. `promise_add(job, thread, about, fallback_time)` about is a milestone id. Fallback is required;
   if missing, the engine sets the spec default and says so (recorded, not refused).
6. `checkpoint(job, status, waiting_for, next_wake_in?, operations?, reached?)`
   - Commits status and waiting_for, `reached` milestones (Tony-reported), and operation outcomes
     `[{ref, action?, outcome: done | failed | unknown, note}]` (D5). done and failed release leases.
   - Sets next_wake_at from next_wake_in, or the spec default if absent. Every open job always has a
     next wake.
   - status done with deliveries still owed: the job stays open as `closing`, with a wake, and the
     answer says "still owed: <milestone> to <thread>" (D4). It closes when nothing is owed.
   - status cancelled with operations in flight: `cancel_requested` until they have outcomes.
   - Marks the caller's run idle. A later call from the same session re-activates it if no other run
     is active.

## Checks run by `intend` (D2)
| Check | Fires when |
|---|---|
| `superseded_run` | another session holds the active work run for the job |
| `job_cancelled` | the job is cancelled or cancel requested |
| `lease_held` | the action's spec resource is leased by another job |
| `build_changed` | the action's gate has an answered or open ask for build X and a fresh read says the build is now Y |
| `sender_not_listed` | `because` names an event whose sender is not on the ask's responder list |

`missing_session` is a flag only and never configurable to hold (D1).

## Engine-side processes (not Tony calls)
- `ingest(event)`: dedupe by source plus delivery id (create-if-absent). Match to jobs by thread
  link or ref. Own-bot post in a thread with an open claim: mark the delivery sent, fulfil promises
  for that thread plus milestone. Own-bot post with no open claim: record and flag `unclaimed_post`.
  Unblock rules (each sets the job's next wake to now): a message from a responder of an open ask in
  any linked thread; another bot's post in a linked thread; an external event whose ref the job
  watches; a mention is handled by the platform session, not a wake.
- `sweep(now)`: every 5 minutes. For each job due (by a due-index record keyed by time bucket, not a
  list): in-flight operations past the spec timeout become unknown and wake the job; promises past
  fallback wake the job with "promise due"; open claims not seen are reconciled through
  `SlackReader.findOwnPostAfter(thread, claim_time)`; jobs whose next wake passed and whose run is
  not active get a wake.
- `wake(job, reason)`: creates run `<job>:<n>` create-if-absent (a twin wake for the same n is a
  no-op), then posts the wake text into the job's own DM through the `Waker` interface. The first
  session that calls the engine about that job binds the pending run.
- A run is active while `now - last_activity_at` is under the config run timeout (default 20 min).

## Spec shape (data only, D8)
`workflows/<name>/spec.json`. Mappings only name things; no expressions, operators or conditions.
```json
{
  "workflow": "<name>", "version": 1,
  "link_roles": ["request", "side", "qa"],
  "resources": ["<resource>"],
  "people": { "<person_id>": { "slack": "<U...>", "name": "<name>" } },
  "gates": { "<gate>": { "responders": { "primary": ["<person_id>"], "stand_ins": ["<person_id>"] } } },
  "milestones": { "<milestone>": { "audience": { "roles": ["request"], "promise_holders": true }, "opens_ask": "<gate>?" } },
  "actions": { "<action>": { "resource": "<resource>?", "gate": "<gate>?", "proved_by": "<external event kind>?" } },
  "defaults": { "next_wake_minutes": 30, "promise_fallback_minutes": 240, "operation_unknown_minutes": 30 }
}
```
Milestone audience (D3): the request thread plus promise holders unless the spec says more; for
`live` in desktop release, also the `qa` role thread.

## Interfaces the engine depends on
- `Store`: `get(key)`, `getMany(keys)` (at most 100), `putIfAbsent(key, value)`, `put(key, value)`.
- `SourceReader`: `currentBuild(job, gate)` (fresh read of the outside system, a fake in phases 1 and 2).
- `SlackReader`: `findOwnPostAfter(thread, ts)`.
- `Waker`: `postWake(dm, text)`.
- `Clock`: injected `now`.
