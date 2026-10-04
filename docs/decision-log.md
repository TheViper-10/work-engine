# Decision log

Judgment calls made during the unattended phase 0 to 2 run (2026-10-04). Locked decisions D1 to D14
live in handoff file 28 §3 and are not repeated here. Each entry: the call, the evidence, the alternative.

## R1. Overlap phase 1 engine work with phase 0 scenario and playbook work
- Call: start the engine core as soon as the spec and record shapes exist, while scenarios and the playbook are still being written.
- Evidence: the engine is generic (D8) and depends only on the spec shape, not on scenario or playbook text. The 3-hour time box (file 28 §7.5) is tight.
- Alternative: strictly serial phases. Rejected because it adds about 25 minutes with no quality gain; phase 0 is still completed and reviewed before phase 1 is declared done.

## R2. Spec event kind names are engine-local
- Call: `proved_by` event kinds (`github_pr_merged`, `circleci_gate_approved`, ...) are names chosen for the spec; the simulator and harness use the same names. Phase 3 adapters map real webhook payloads onto them.
- Evidence: no source names them; the engine only matches names (D8).
- Alternative: real webhook event names. Rejected for now because no adapter exists and CircleCI is Tony-reported until after the live test.

## R3. Sign-off ask audience is the QA thread only
- Call: milestone `signoff_requested` has audience role `qa` with no promise holders.
- Evidence: `22-tony-coordinator-call-map.md:425` rule 26 puts the sign-off ask only in the QA thread.
- Alternative: D3 default (request thread plus promise holders). D3 says "unless the spec says otherwise", so this is within D3.

## R4. A `cancel` gate exists with responders but no action
- Call: the spec names who may cancel (owner); `sender_not_listed` can flag a cancel from someone else. The engine does not act on it.
- Evidence: call-map moment 11.
- Alternative: no cancel gate. Kept because it costs one spec entry and records authority.

## R5. The spec has no step order; `complete_release_issue` is a Tony action
- Evidence: call-map rules 21 to 23 were the rigid sequencing of v8 (L1 forbids it). In v8 the Coordinator closed the issue (call map line 195); in v3 Tony acts on systems with his own tools.
- Alternative: none faithful to L1.

## R6. People in the mock spec: owner and Harry only
- Evidence: `18-coordinator-design-decisions.md:6`, `21-work/B-live.md:153`. Owner is Harry's stand-in on prod alpha.
- Alternative: add the real-release sign-off person. Left out because phase 4 is a mock release; add in the spec before a real release.

## R7. Playbook gives a "usual path", not an order
- Call: the playbook lists the usual release path and says Tony may reorder it.
- Evidence: L1 (the engine never orders steps); a real model needs a starting plan; the spec has no order.
- Alternative: no path at all. Rejected because a model with no path tends to re-derive v8's handshakes.

## R8. Playbook keeps v2.38 Slack voice and drops Coordinator-era protocol
- Call: reuse v2.38 voice rules (plain, four sentences, no ids); drop receipts, `report_effect` and `execution_key`.
- Evidence: `21-work/run-data/live/tony-version-2.38.json` guidance and slack skills; v3 replaces those protocols.
- Alternative: keep worktree notes for PR authoring. Dropped; PR authoring is unchanged Tony skill text outside this playbook.

## R9. Scenario gaps filled with stated assumptions
- Call: where the sources lack a fact (update-server start versions for run 4 and v2.18, run 6 pipeline id, v2.18 approval and CI timings, Harry's v2.18 replies), the scenario uses a stated assumption recorded in its `notes`. Run 4's real ending (a cancel) is kept as a cancel case elsewhere and its scenario gets a marked synthetic tail to done.
- Evidence: the sources were read in full by the scenario worker; these facts were not exported.
- Alternative: a read-only DevRev re-pull through fde-agent. Rejected: the missing facts are Slack replies and CircleCI timings, which DevRev does not hold, and the replay scores engine behaviour, which these values do not change.

## R10. Scenario facts corrected from fde-agent read-only gap fill
- Call: run 4 start QA version set to 5.2.8; Harry's real v2.18 sign-off reply added to Q at 04:16:22Z. Other gap-fill answers (v2.18 timings, run 6 thread B) confirm what the scenarios already assume.
- Evidence: `scenarios/gap-fill.md` (local run collector files under `tony-mock/runs/`; no API calls were made).
- Parked: which run 6 pipeline id is number 395883 needs a CircleCI token, which `~/.zshrc` lacks. The replay does not depend on it.

## R11. Engine core deviations accepted
- `wake` on a job whose run is already active returns `run_active` and posts nothing (no twin wake). Faithful to "one work run per job" (L1).
- An `intend` in flag mode on an ended job moves it back to `cancel_requested` until the outcome is reported, so no job is closed with an operation in flight. A flag records; it does not stop Tony, so the engine must keep the record honest.
- `open_jobs` record lists open job ids for the "no job here" answer. Parked for phase 3: cap or bucket it, since it grows without bound.

## R12. A late checkpoint never reopens an ended job
- Call: `checkpoint` on a done or cancelled job records Tony's report and changes nothing else (simulator fix 5). Tony reopens work with `job_open`.
- Evidence: the simulator found a late `working` checkpoint on a cancelled job reopening it and clearing its wake, which broke "every open job has a next wake". Cancel is the owner's authority (spec `cancel` gate); a stale session must not undo it.
- Alternative: let a late checkpoint revive the job. Rejected: a session that missed the cancel would silently resume a release the owner stopped.

## R13. Playbook edits from the first trial replays
- Calls: (1) claim `qa_go_requested` with `say` before asking for the QA go, even inside a mention reply; (2) a conversation session may `promise_add` but does not `say` or `checkpoint`; (3) never post a milestone without a claim, and do not repost what a mention reply already told.
- Evidence: trial replays (`harness/out/trial-1` to `trial-final`): stale-go missed `build_changed` because no ask existed; v2-18 drew `not_work_run` and `unclaimed_post` flags and two "live" posts to A.
- Alternative: have the engine open asks without a claim. Rejected: the engine would have to guess from text that Tony asked for a go (L1, no reading text for meaning).

## R14. A mention reply that tells a milestone is claimed first
- Call: when Tony's reply to a mention tells that thread a milestone, he calls `say` first; the connector's relay of the reply then matches the open claim and marks the delivery sent.
- Evidence: trial v2-18 run 1: milestones told by mention replies stayed owed, and a later wake re-posted four stale messages to A. File 27 §3.5 says mention replies need no `say`; file 28 is silent. The relay already counts as a delivery (27 §3.5), but the engine cannot know which milestone a reply told without reading text (L1).
- Alternative: a `told` list on `checkpoint`. Rejected for now: one more field Tony must remember, while `say` is already the claim path.

## R15. A mention session that will act joins first
- Call: playbook tells a mention session to `job_open(join)` before acting when no work run is active (D10).
- Evidence: trial stale-go: a mention session (s5) acted without joining, the sweep woke a second session (s6) for the same job, and both called `intend(approve_qa_gate)`. The engine handled it (one operation, idempotent; `superseded_run` flagged), but it cost a twin session.
- Alternative: let `job_view` from a mention session adopt the run. Rejected: D10 says a mention session reads freely and becomes the work run only through `job_open(join)`.

## R16. Scoring separates false flags from true-but-unexpected flags
- Call: D7 "0 false holds or flags" counts a flag as false only when its stated fact is wrong per the engine's records and the world. A flag whose fact is true but which the scenario did not predict (for example `superseded_run` when Tony really did act from a second session) is reported as "unexpected, true" and counted separately; it fails the run only in hold mode, where it would have stopped Tony.
- Evidence: trial stale-go `superseded_run` was a true fact (two sessions acted).
- Alternative: count every unpredicted flag as false. Rejected because it scores the engine on Tony's behaviour; both counts are reported so the owner can apply the stricter reading.

## R17. Red-team 1 fixes: design choices (see `docs/red-team-1.md`)
All choices pick the option closest to L1 to L4: the engine records and wakes, Tony judges, and nothing locks forever.
- **Claims (H1, H2, H3, H6, M1).** A claim is its own create-if-absent record per thread (`claim:<thread>`), owned by the claiming session. `say` from the owner gets `go` again; from another session while the claim is younger than `claim_stale_minutes` (spec default 10) it gets `busy: another session is posting this; do not post`. After that, the engine reconciles through `SlackReader` first; if still unseen it answers `already_claimed: read the thread; post only if absent`, and the claim passes to the caller. Tony can confirm a post with `say(job, thread, milestone, posted_link)`; that marks the delivery sent as Tony-reported (L3) and clears the claim, so an unseen claim never locks a thread. A relay matches a claim only when it carries the claim owner's session; an own-bot post with no timestamp never matches. Alternative: the engine reads post text to match milestones; rejected (L1).
- **Compare-and-set (H1).** `Store` gains `putIfVersion(key, value, version)`. Job, lease and index writes use it with a bounded retry. Phase 3 must confirm the platform can do this (a version field checked by the engine inside the function's `supports_synchronization`); parked as a phase 3 proof.
- **Wakes only move earlier while an unblock is pending (H8, M3).** A pending unblock reason survives `job_view`, a later checkpoint and a failed wake post; it is cleared only after a wake is posted.
- **Conversation sessions (H8).** A checkpoint from a session that is not the work run is recorded as a note on the job; it does not replace the work run's status or wake (it may only bring the wake earlier), and it cannot cancel. Cancelling from a conversation session is recorded and wakes the work run with "cancel asked". D10 says these writes are recorded, not applied.
- **Reads never bind (M2).** `job_view` never makes a session the work run, not even a pending wake run. The first write call binds it.
- **Retrying `intend` (H4).** Same job, action and ref returns the same operation, but the session checks always run, and if the earlier outcome was `failed` the retry is a new attempt: checks run, the lease is taken and the operation goes back in flight.
- **Unknown outcomes (H5).** An `unknown` operation keeps its lease (it may still be publishing) and the job is woken with "verify the unknown outcome and report done or failed". A cancel with only unknown operations left finishes as cancelled, releases leases, and keeps the unknown operations on the record with a flag. Alternative: release the lease on a timer; rejected because it allows two publishes.
- **Re-ask for a new build (H7).** `say` for a milestone that opens an ask, when a fresh read shows the build differs from the latest ask's build, opens a new ask for the new build and answers `go`, even if that milestone was already sent for the old build. A failed source read never records a build and never holds; it flags `source_unreadable`.
- **A freed lease wakes its waiters (M4).** A `lease_held` finding records the waiting job on the lease; release sets each waiter's wake to now.
- **Operation matching (M5).** An external event proves an operation only when kind, ref and (if the action names a gate) the event's gate all match. A checkpoint outcome with no action closes an operation only if exactly one operation has that ref; otherwise it records an `ambiguous_outcome` flag.
- **Open promises at done (M6).** An open promise counts as owed: `checkpoint(done)` keeps the job closing with "still owed: <milestone> to <thread>".
- **Ingest durability (M8).** The event record is written as received, processed, then marked done; a retry of a received-but-not-done event reprocesses it.
- **Indexes (M9).** Ended jobs are pruned from `thread_index` and `open_jobs`. Per-job key arrays inside one record are parked for phase 3 sharding.
- **Lows.** L2: `intend` on a done job keeps it done and flags `job_ended`. L3: re-linking with `private: true` upgrades the link. L4: `say` and `promise_add` on an ended job record the call and answer in words, `ok` true. L1 (14-day outage, clock skew) is parked: phase 3 sweeps scan a bounded catch-up window and use the store's clock.
- **Lint (M7).** Add a Slack id pattern and string-split detection for banned words; add a spec lint that rejects keys outside the spec shape and values that are not plain ids. `qa`, `live` and `main` stay allowed in engine code only as spec-read values, not literals: literal comparisons to any spec id fail.

## R18. R17 completion: test expectations and two engine fixes from the random sim
- Calls: the named cases "crash after post", "missed bot post" and "twin runs" were stale tests, not engine bugs. R17 intentionally answers `busy` while a claim is younger than `claim_stale_minutes` and lets only a write bind a run (M2), so the tests now advance the clock past the stale window or bind with a write. Engine fixes found by the random sim: a delivery voided by a cancel after it was claimed is treated as a stale unseen claim (the next session reads the thread before posting), and `sweep` re-reads the due index for up to four passes so a job promoted during the sweep is woken in the same sweep. `intend` now sets the resource on an operation that first arrived by checkpoint.
- Evidence: `redteam-fixes` b7c2fb9; lint, 33 unit tests, 1,000 + 1,000 random orders, 16 named cases and 28 repros green. Merged to `main` (8b4f9fe; previous `main` tagged `pre-r17-merge`).
- Alternative: unbounded sweep loop. Rejected; four passes bound the work per sweep and the next sweep catches anything left.

## R19. Scripted Tony stands down only when another session is the work run
- Call: after R17 M2, a wake view shows `work_run: none` until the first write; the scripted Tony now continues on `none` and stops only on `other` (133ddd6). Scripted replay: 9 of 9 pass in flag and hold, engine calls median 82, max 95.
- Evidence: post-merge scripted run went 0 of 9 because every woken session quit after one `job_view`.
- Alternative: make `job_view` bind a pending wake run again. Rejected; it reopens red-team M2.

## A1-A4. Owner amendment 2026-10-04: job-home execution ownership (controlling)
- Owner decision: "Yes please, this is the way." One job, one engine-owned execution DM; Slack threads are communication only. No further A/B between old and new approach; the goal-oriented playbook is adopted.
- Amends D10 (replaced), D1 (extended with session-to-DM lookup; missing or failed identity is a fixed hold for consequential calls), file 28 §2 (sequential home replacement with generation fencing), 27 §3.1 (mention sessions no longer work). Full text and R20-R24: `docs/job-home-contract.md`.
- The real-model gate run on the pre-amendment engine (flag 6/10, hold 1/10 strict D7) is discarded as a gate; it is not classified further. The gate re-runs on the job-home engine only.
