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

## R25-R30. Job-home engine build (a1b560d)
- R25: tests changed where A1-A4 intentionally changed behaviour: every linked-thread message is an inbox item and wakes an idle home (old "stranger does not wake"); a call without a session id now gets the fixed A2 hold (old expected `clear`). `f6-unknown-stuck` now guards "lease held with no wake or escalation" because R22 supersedes R17 H5.
- R26: a cancelled job with `cleanup_pending` stays in the sweep, wakes every 30 minutes, escalates once at 4x the unknown window, and clears on reported or webhook-verified readback. The lease is kept only through the listed unknown operations.
- R27: a go whose sender later sent a cancel-kind message is caught at `intend` (R20). A cancel from a non-listed sender is an inbox item flagged `sender_not_listed` and does not cancel (R21). The inbox kind comes from `attrs.inbox_kind` set by the connector or harness; the engine never reads text (L1).
- R28: only successful session lookups are cached. `replaceHome` turns in-flight operations into `unknown` for the new home to read back and makes an open claim immediately takeable with a read-first warning.
- R29: sim invariants: clear/go needs confirmed identity; in hold mode the acting session holds the current run of the current generation; exactly one open home per job; no active run from an older generation.
- R30: a non-home `checkpoint` that reports operation outcomes is recorded as an inbox note and does not apply the outcomes (the home reads back and reports). `job_open(join)` from a mention session links the thread and records the lookup; it never confirms ownership. Both follow A1.
- Evidence: lint ok; 46 unit tests; sim 1,000 + 1,000 orders and 42 named cases; 28 repros clear; scripted harness 9/9 in flag and hold with the transition default `homeForAllSessions` (does not yet exercise non-home sessions).

## Superseded by A1-A4
- R15 (a mention session joins before acting) and D10 adoption: superseded by A1; mention sessions never act.
- R17 H5 lease release on cancel with unknowns: superseded by R22.
- R20-R24 are recorded in full in `docs/job-home-contract.md` ("Implementation judgments locked with this direction").

## R31. Deployment check configuration (implementation judgment, reversible config)
- Call: the pilot runs `build_changed`, `job_cancelled`, `superseded_run` as hold and `lease_held`, `sender_not_listed` as flag. The preset is `DEPLOY_CHECKS` in `src/config.ts` (the snap-in imports it); the harness takes `--checks deploy`. `--mode flag|hold` stays for the sim.
- Evidence: phase-2 gate: the only safety failure that reached a real gate (wrong-build approval) occurred in flag mode and was prevented in hold mode.
- Alternative: hold on all checks. Not chosen for the pilot (lease_held and sender_not_listed stay advisory); a config edit changes it. The owner has not reviewed this split.

## R32. A cancel outcome is its own milestone
- Call: the desktop-release spec gains `cancel_notice` (audience request and qa, no promise holders). The playbook says to tell the cancel outcome once per thread owed under this id, never under `live`, also when the cancel came too late. The scenario bar "no live post after cancel" is kept; the honest outcome is a `cancel_notice`. Engine-generic, spec data only.
- Evidence: `jh-real3-flag-3`: the home claimed its cancel message as `live`; run c: `cancel_notice` once in A and once in Q, no `live`.
- Alternative: loosen the bar to allow one `live` post. Rejected: it would hide a mis-claimed milestone.

## R33. Unknown action is recorded and answered, never cleared
- Call: `intend` with an action not in the job's spec records flag `unknown_action`, takes no lease, creates no operation, and answers status `unknown_action` with "unknown action <x>; this job's actions are: <ids>" and the structured `actions` list. Same rule as unknown milestones (L1). Replaces the old `action_not_in_spec` flag with a `clear`.
- Evidence: phase-2 hold run 2 approved the prod alpha gate via `approve_prod_alpha_gate`, evading every check.
- Alternative: refuse with an error. Rejected (L1): recorded and answered.

## R34. The interruption-boundary bar checks the designed property
- Call: `boundaryHolds` counts only writes the engine applied from a mention session (`clear`, `go`, a checkpoint not recorded as a note). A non-home checkpoint recorded as a note, and a routed intend or say, are the boundary working.
- Evidence: `jh-real3-flag-1` failed only this bar on a note-only checkpoint; rescored PASS on 12 of 12 bars.
- Alternative: forbid non-home checkpoints in the playbook. Rejected: R30 makes them harmless notes and the engine routes them.

## R35. Harness claim attribution counts only `go`
- Call: the driver registers a claim for a `say` only when the engine answered `go`. A `route`, `busy`, `already_sent` or hold is not a claim, so a relayed reply to a mention is not an announcement.
- Evidence: round 4 run a: cancel-mid-publish and stale-go showed a double count caused by a routed `say` from a non-home session. Pre-correction result kept in the Round 4 table.

## R36. A gated intend with no ask on the gate: `no_go_for_build`
- Call: new check `no_go_for_build` (configurable like the others, flag by default, hold in `DEPLOY_CHECKS`). When the action's spec names a gate and the gate has no live ask (none opened, or the latest is stale), one fresh `SourceReader` read gives build B and the answer says "no go recorded for build B on <gate>; ask <responders> for build B". `build_changed` keeps the case of an ask for another build. A failed read never holds: flag `source_unreadable` (R17 H7). An ask opened with an unreadable build ("unknown") is skipped as before. The general sim and red-team worlds keep this check as a flag because many of their cases intend a gated action with no ask on purpose; the named case `no-go-for-build` runs it as hold and flag.
- Evidence: phase-2 round 4 run a: QA approved for build def on a go about abc, because no ask existed so `build_changed` could not fire.
- Alternative: open the ask inside `intend`. Rejected: the engine would then claim an ask nobody posted (L2).

## R37. Waker key: exactly-once wake by run id
- Call: `Waker.postWake(dm, text, key)`. Key = the run id for a wake, `<run id>:n<seq>` for a notice (the job carries `notice_seq`). The snap-in waker keys its `wake_attempt` row on sha(dm|key), reads the timeline back for the first text sent under the key, and never resends while that text is visible; the sha(dm|text) key and the per-DM pending record are removed. A retry with a re-timed text and the same key sends once.
- Alternative: keep the text hash. Rejected: the wake text embeds a timestamp, which forced the per-DM workaround.

## R38. Harness: a repeat `go` and a connector post without time are not new claims
- Call: (a) the driver registers a claim only on a fresh `go` (`repeat` false) and settles it when the engine answers `confirmed` for the same thread and milestone; (b) the harness connector event for Tony's own post now carries `ts` and `link`, as the snap-in's poller does. Evaluation defect, not an engine or playbook defect.
- Evidence: see Round 5 in `docs/phase2-gate-results.md`. Without `ts` the engine cannot match the post to the claim ("carried no timestamp; not matched"), the model is told to say again with posted_link, the repeat `go` registered a second harness claim, and the next post in the thread was attributed to it.


## R39. Platform store: per-write nonce decides who created a row
- Call: live QA proof showed 20 concurrent creates of a byte-identical body collapse to one row with up to 19 x 201, so body equality cannot tell the winner. Every created row's body carries a per-write nonce `_w` (stripped on read). A create is "mine" only when the row read back has my nonce. A 500 "conflicted with an ongoing operation" re-reads the key: my nonce = won, another nonce = lost, absent = retry with bounded backoff, at most 3 times. The latest version per key is cached for one invocation (write-through on own writes, dropped after a lost CAS). The fake API mirrors both behaviours and 9 contract tests cover them. Top-level keys `_w` and `_wp` in a stored value are reserved and throw on write.
- Alternative: compare bodies. Rejected by the evidence above.

## R40. Idle ticks write nothing
- Call: `sweep_cursor` is written only when it lags more than 12 buckets (1 hour); the per-tick `putIfAbsent` in `schedule()` is removed. Idle ticks write 0 rows (live QA install wrote about 1,440 a day).
- Evidence: live S3 install e15290e4; offline repros `live defect 1`, `1b`.

## R41. Wake failures back off; missing wake config is a config error
- Call: failed wakes back off 1, 2, 4, 8, 16, 30 minutes with one `wake_failed` flag and one escalation naming the requester. Empty `wake_user`, `wake_workflow` or `tony_agent` is flagged once and rechecked hourly, never retried per tick. `dmmap: creating` is written only by a real attempt and recovered by the next.
- Evidence: live install churned about 4.5 rows a minute with empty wake config; offline repros `live defect 2`, `2b`.

## R42. Unchanged records are not rewritten
- Call: `Engine.save()` skips a record whose content is unchanged; the waker writes `wake_attempt` once after the trigger. Interruption-boundary journey: 77 to 66 rows, asserted in `snap-in/test/e2e-offline.test.ts`.

## R43. Operator close through an install input
- Call: `Engine.adminClose(jobId, reason)` closes a job as cancelled, releases leases, posts and wakes nothing. Reachable only from the timer through the install input `admin_close_jobs` (`job-id=reason; ...`), which needs install rights. A hidden operation token was rejected: it would be a second credential on a surface Tony's skills can see.
- Evidence: live scratch job could not be closed (conversation session cannot cancel; home never created).

## R44. Row authorship is not checked
- Call: rows written through the operation path are authored by the caller user, rows from the timer by the service account; the engine never checks the author, and deletes work for both (live cleanup deleted 79 mixed rows).

## R45. The home DM belongs to the owner token's user, created with the owner token
- Call: the wake workflow (workflow/58) adds its comment as the user whose token triggered it, and errors with 403 if that user is not in the DM. So `ensureHome` resolves the owner token's user once through `dev-users.self` (cached per instance) and creates and hides the DM with that same token (`chats.create`, `chats.update`), not with the service account; `users: [<that user>]`. `wake_user` is only a cross-check (full id or short form): a mismatch is a `WakeConfigError` before any DM or `dmmap` row exists. A 401/403 from `dev-users.self`, `chats.*` or `workflows.trigger` is also a `WakeConfigError`. The engine treats `WakeConfigError` like the preflight config error (R41): one `escalate` flag naming the owner, no retry of the post, one recheck row an hour. Nothing is hardcoded: workflow id, user and agent are install inputs; the trigger fields stay `dm_id`, `continuation_note`, `receipt_key`. `WAKE_GRACE_MS` is 5 minutes (was 3): a reply arrived about 102 s after the comment and can take about 3 minutes, so a wake is not resent or called failed before 5. Repros: the four `R45` tests in `snap-in/test/waker.test.ts`; the e2e journey asserts the service account never creates the DM.
- Evidence: live wake proof S5a (workflow/58, 403 for a non-member, chats.create proven only with a user token, reply at about 102 s).
- Alternative: let `wake_user` decide the DM user. Rejected: it can disagree with the token and the comment then fails with a 403.

## R46. Wake user is the owner (devu/1)
- Call: the job home DM is created and woken as devu/1 through the existing `owner_identity` keyring and wake workflow/58. Tony sessions started this way carry SECRET_TONY_SLACK_BOT_TOKEN, SECRET_GITHUB_PAT, SECRET_CIRCLE_CLI_TOKEN and SECRET_SLACK_BOT_TOKEN, but not SECRET_DEVREV_TOKEN. Release-issue writes use Tony's platform operation skills (CreateIssue, AddComment, UpdateIssue) instead.
- Evidence: S5a live proof (DM-1 devu/1, reply after 102 s, env read in trace; DM-2 devu/2 had the full set).
- Alternative: wake as devu/2 for the full secret set. Rejected for now: it would need another person's token placed in a new keyring, and devu/2 is also the Slack connector's act-as user, which blurs home and mention sessions.

## R47. The offline fake enforces scopes and real response shapes
- Call: the snap-in fake API checks a scope on every call and answers 403 when it is missing. The scope table is parsed from `snap-in/manifest.yaml`: service account scopes for the timer path, operation static scopes for the operation path. The owner keyring token is a user token and carries no scope (`workflows.trigger`, `dev-users.self`, `chats.*`). Route map: `ai-agents.get` needs `ai_agent:read`, `chats.create`, `chats.update` and `timeline-entries.list` need `conversation:write`, `ai-agent.sessions.get` needs `ai_agent_session:read`, `snap-ins.get` needs `snap_in:read`, `custom-objects.*` and `objects.list` need `custom_object:<leaf>:all`. Responses use the real shapes: `agent` for `ai-agents.get` (`default_version_id` as a string or an object with `id`), `custom_object`, `custom_objects[]`, and the 409 conflict bodies. A manifest lint test fails on any `ui.display_name` over 50 characters and on any scope name outside an allowlist of names seen working in v8 or the connector manifests.
- Rule: a live gap that a scope, a response shape or a platform limit explains is reproduced in the fake first, then fixed. A fake that is kinder than the platform is a defect in the fake.
- Evidence: QA v2 install ef736806 (svcacc/118): `ai-agents.get` returned 403 (no `ai_agent:read`; the connector manifest uses it), `waker.ts` read `ai_agent` while the platform returns `agent`, and version create returned 400 for a 75 character input label. v3 fixes all three; the regression tests remove the scope from the parsed manifest and expect the 403 with `dmmap` left `creating`.
- Alternative: assert scopes only in a manifest text test. Rejected: it would not have caught the call that needs the scope, which is the failure that reached live.

## R49. Object-level access decides who may call; the owner token is the boundary for private objects; the version check is advisory
- Call: a scope is necessary but not sufficient. A private object (the Tony agent, a DM) is shared with named users, and a service account that holds the scope still gets 403. Every DevRev call that is not on `work_record`/`work_event` custom objects (and the install's own `snap-ins.get`) now runs as the owner token on the timer path: `ai-agents.get`, the wake read-back `timeline-entries.list`, `chats.create`, `chats.update`, `dev-users.self`, `workflows.trigger`. `ai-agent.sessions.get` stays on the caller token on the operation path (proven) and uses the owner token if it is ever called on the timer path. The owner token is passed only to the waker and the directory adapter; the store never receives it. The waker lost its `chat` option. `snap-in/IDENTITY.md` lists every route, its identity per path, the reason and whether it is proven live; `test/identity.test.ts` fails when an adapter calls a route that is not listed or runs it as an identity the table does not allow.
- Stale-version check: non-blocking. If `ai-agents.get` fails for any reason, the version is unknown (null), one diagnostic is recorded per hour (`diag` row plus `waker.diagnostics`), and the wake proceeds. A failed version read never stops a wake or a home creation. A missing credential is not an API answer and is left to the trigger to report.
- Fake fidelity: private objects carry a sharing list. `ai_agent/2` is shared with the owner token's user only; a DM's list is its users. `ai-agents.get`, `chats.create`, `chats.update` and `timeline-entries.list` answer 403 to an identity not on the list even when it holds the scope. A timeline read by an owner token that is not a DM member is a `WakeConfigError`. Regression tests: (a) the v3 failure, a service-account agent read is 403 and the home DM and exactly one wake still happen; (b) a service-account timeline read is 403 and the waker reads with the owner token; (c) a non-member owner token gets 403 and a config error.
- Evidence: QA v3 install d1310925 (svcacc/119): `ai-agents.get` on ai_agent/2 was 403 as the service account with `ai_agent:read` granted; it came before the DM was created, so `dmmap` stayed `creating` and nothing woke. The service account works for custom objects on the timer path; the owner token (devu/1) works for chats, workflows and DM timelines; devu/1 has access to ai_agent/2.
- Rule: the fake must model who may see an object, not only which scope a call needs (extends R47). `ai-agents.get` as the owner token is proven offline only until the v4 install runs.
- Alternative: share ai_agent/2 with the service account. Rejected: it widens access on a private agent and ties correctness to a sharing setting outside this repo.

## R50. A local live probe runs before every deploy; a home DM is recorded before it is hidden; a failed hide never blocks a wake
- Call: (1) `chats.update` sends `{id, type:"dm", display_state:"hidden"}`; without `type` the platform answers 400 `invalid_field`. (2) `ensureHome` writes the `dmmap` row as `created` (with the DM id) right after `chats.create` succeeds, before the hide; only a row with no recorded DM may create one, so a logical home never gets a second DM. A recovery pass hides the recorded DM and marks it `ready`. (3) A failed hide is non-fatal: one diagnostic per hour (`diag` row, `waker.diagnostics`) and the wake still goes out, because a visible DM is cosmetic and a duplicate DM is a correctness problem. (4) `snap-in/scripts/live-probe.ts` (`node --import tsx snap-in/scripts/live-probe.ts`) builds the production wiring (`assembleRuntime`, shared with `buildRuntime`) with local tokens against live QA in its own namespace (`env=probe`, keys `work-engine:probe:tony:...`), runs the home-DM journey (open from a non-home session, sweep until the DM is created, hidden and woken once, Tony replies, session lookup, in-home view, route versus hold, adminClose) and deletes every probe row and hides the DM. No deploy ships until the probe passes. (5) `IDENTITY.md` has a "Body proven live" column per route; the fake rejects a `chats.create`, `chats.update` or `workflows.trigger` body that lacks the fields the live platform requires.
- Evidence: QA v4 install bb35f7d3: the hide returned 400, `dmmap` stayed `creating`, each backoff retry created another DM (three orphans). The offline fake had accepted the hide without `type`. The probe reproduced the production call path and passed against live QA (DM created, hidden with 200, one wake comment, Tony replied in 3 to 5 minutes, `dmOf` resolved to the logical home, 474 routed, the home session got `hold no_go_for_build`).
- Rule: a fake that accepts a body the platform rejects is a defect in the fake (extends R47). An adapter path is not "proven" until it has run live, from the machine that built it, before the deploy, not after.
- Alternative: hide first and create the mapping afterwards (the v4 order). Rejected: it is what produced duplicate DMs. Alternative: fail the wake when the hide fails. Rejected: it blocks the job for a cosmetic problem.

## R51. The thread of a mention session is resolved from the platform; the engine refuses anything that is not a thread
- Call: (a) `job_open`, `job_view`, `say` and `promise_add` accept a thread only as `<channel>:<ts>`; `slack:<C>:<ts>` and Slack permalinks (`https://...slack.com/archives/<C>/p<ts16>`, a reply permalink's `thread_ts` wins) are normalized to it (`src/thread.ts`). Anything else answers `bad_thread` with words on where to find it (the request comment's `external_ref` without `slack:`) and records nothing. (b) Better, and done: `SessionDirectory.threadOf(session)`. If `thread` is omitted or wrong, the engine asks the directory, and the snap-in adapter reads it from the platform: `ai-agent.sessions.get` gives the parent DM, `chats.get` on that DM gives the connector custom fields `app_slack_agent_connector__slack_channel` and `__slack_thread_ts` (`buildDmFields` in the connector's `invoke.ts`; the prompt ts is the fallback). The answer says which thread was used, so the model learns. The engine answers `bad_thread` only when the platform cannot say either.
- Identity: `threadOf` runs as the caller token (the session's own user) on the operation path. The owner token (devu/1) got 403 on `chats.get` for devu/2's mention DMs in live run 1 (recorded in `snap-in/IDENTITY.md`), so the owner token is not used. The fake models that 403 (a non-member identity is refused). Whether the caller token can read the DM is unproven live; the probe step `i` (not run by the builder) checks it. If it answers 403 live, the fallback is (a) plus the skill text, which is already shipped: the tool description, the playbook ("Reading a Slack request") and `references.md` say where the thread comes from.
- `strictThreads` is on in the snap-in and off in the offline sim, where labels (`A`, `B`) are threads. The poller watches the thread the engine resolved (`answer.thread`), not what the model sent, so `watch:all` can no longer be skipped silently by a bad thread.
- Evidence: live run 1 F1: the model passed `dm/10PhocjLu` as `job_open.thread`; `parseThread` rejected it, `poller.watch` returned false silently, and the owner's go and the duplicate were never inbox events.
- Alternative: keep accepting any string and only document the format. Rejected: that is what failed.

## R52. One open job per workflow and release
- Call: a workflow spec may set `one_open_job` and a `target_pattern` (desktop release: a three-part version). With it, `job_open` with intent join and a target that is empty or not a version (`next`) joins the open job of that workflow (status `joined`, with a note); with no open job it answers `bad_target` (nothing recorded) instead of creating a job named `next`. A join with a different valid version joins the open job too and records a `target_mismatch` flag, saying to use `queue` or `replace`. `queue` and `replace` are the explicit ways to run a second release; they are unchanged. The engine stays generic: the two fields are spec data.
- Evidence: live run 1 F2/F3: `desktop-release:next` and `desktop-release:5.2.11` for one release, two homes, 44 minutes between the owner's go and the approval. Repros: `test/live-run1.test.ts` (F2/F3 tests), named sim case "one open job per workflow", scenario `run1-replay` (`max_jobs: 1`).
- Alternative: a lookup of the release issue by the engine. Rejected: the engine does not read outside systems except through the SourceReader.

## R53. The build an ask names comes from a snapshot the timer keeps, and the branch head is not the build
- Call: F7 had two causes. (1) `say` runs on the operation path, which carries no `github_read` keyring, so the SourceReader could not read and the ask was keyed `unknown` (the flag `source_unreadable` was the only trace). The timer path has the keyring: while any job is open it refreshes one snapshot row (`source:builds`, per-gate builds) at most every 10 minutes (rewritten only on change or when 10 minutes old); the operation path falls back to it while it is at most 15 minutes old. A live read always wins. A stale or missing snapshot is still `null` (`source_unreadable`). (2) `commits/<branch>` returns the branch head, which after a publish is the `[skip ci]` state commit (`1bbe07cf`), not the commit the pipeline built (`f32f69b2`). The reader now lists the branch and takes the newest commit that is not `[skip ci]`.
- Evidence: `snap-in/test/fixtures/mock-branch-commits.json` is the real response for `mock/tony-desktop-release` (head 1bbe07cf, build f32f69b2); tests in `snap-in/test/source.test.ts` and the dispatcher test "say on the operation path names the build from the tick snapshot". Cost: the row-budget tests count the snapshot apart with its own cap (7 rows per 60 minutes, none without an open job).
- Unproven live: that the operation path really has no keyring (IDENTITY.md already says so) and that the timer refresh works with the live token; the coordinator's probe covers the GitHub reads.
- Alternative: give the operation the keyring. Rejected: a keyring on the operation path widens a credential the skills can reach.

## R54. A posted link must belong to the delivery's thread
- Call: `say(..., posted_link)` resolves the link's thread from the engine's own event record of that message (the poller ingests every post of a watched thread, so this works on the operation path), then from the Slack reader; if the link is in another thread, or another channel, the answer is `wrong_thread` and the delivery is not marked sent, the claim stays. If the engine cannot tell, the link is taken as reported (L3), as before.
- Evidence: live run 1 F9: B's `qa_ready` promise was fulfilled with the A-thread post link; nothing was posted in B. Repros: `test/live-run1.test.ts`, dispatcher test in `snap-in/test/e2e-offline.test.ts`.

## R55. Outcome milestones are reached only through checkpoint, after the source was read (D3, D4, L3)
- Call: the spec marks `qa_ready` and `live` as `outcome`. `say` for an outcome milestone that is not reached answers `not_reached` (nothing claimed, owed or recorded); `checkpoint(reached)` is the only way to reach it, which the playbook ties to reading the source first. Once reached, `say` claims it as before. Non-outcome milestones keep claim-on-say (D3: the audience is told what the agent says it will say). This is the smallest change: no new call, no change to deliveries, and it needs no confirmed post.
- Evidence: live run 1 F10: the second home recorded `live` when it posted "Blocked on prod alpha", because `say live` reached the milestone on claim. Repro: F10 test in `test/live-run1.test.ts`. The red-team repros that use `say live` directly turn the flag off in their helper (`test/redteam/h.ts`).
- Alternative: reach the milestone only on a confirmed post. Rejected: it would delay the owed record until a post is seen and break the sweep's reconcile.

## R56. A wake nobody in the home answers is repeated after 5 minutes, at most 3 times
- Call: a wake run whose home has not called the engine (a read counts) is given 5 minutes, not the 20 minute run timeout; the next wake is then scheduled 5 minutes out, for up to 3 re-wakes in a row (`wake_tries`), after which the ordinary 30 minute cadence applies until a home session calls. Each re-wake has its own run id, so the waker's receipt key is new and the platform sees a new comment. The waker's own `WAKE_GRACE_MS` (5 min) is unchanged.
- Evidence: live run 1 F4: the first home wake got the platform's "unable to process" reply and the engine re-woke it after about 25 minutes. Repro: F4 test. The e2e R49 test now stays inside the first wake's window so it still counts one trigger.

## R57. The live-run harness is connector-faithful, and the grader grades every job
- Call: scenarios marked `faithful` render a mention as the connector does: one DM comment from the connector user with `Request:\n@Tony <text with @names>`, optional `Thread history (READ ONLY ...)`, and a visible `external_ref: slack:<channel>:<ts>`; the session's DM is a fake connector DM with the channel and thread as custom fields; engine threads are `<channel>:<ts>`; labels exist only for scoring. The model is told the thread is the `external_ref`. What the real platform shows next to the body is not known; the header is the least the model can rely on. The new scenario `run1-replay` carries run 1's real timeline (kickoff text, B question, GitHub approval, go and a duplicate go ten seconds later, Harry's QA post and sign-off) and its `scripted_slips` make the scripted Tony pass the DM id as the thread and target `next`, so the engine must recover. New outcome bars for faithful scenarios: at most one job, no PR/approval/issue action from a mention session, no engine words in a post, no "Rashmi" in a post. The grader (`pilot/grade_engine.py`) now uses the internal `custom-objects.get` with `unique_key`, grades every job opened during the run (open-jobs history plus the thread index of the run's threads), and fails Ownership when more than one job exists for one workflow.
- Judgment items F5/F6/F8: the playbook already said "act only from the home", but not that a mention session must not create PRs or issues, nor how to name the requester or avoid engine words, nor to settle unknown operations each time. It now says all three (sections "Reading a Slack request", "Voice", a settle sentence in "How a run ends"); the real-model runs test them.

## R58. A milestone addressed to one thread role is claimed only in a thread of that role
- Call: a spec milestone may set `audience_only`. `say` for it in a thread that is not linked with one of the audience roles answers `wrong_audience` (nothing claimed, reached or owed) and says in words where to post it, or, when no such thread is linked, to find that thread, link it with `job_open` (intent join, that role) and say again. Desktop release sets it on `signoff_requested` (the QA thread only, R3). The engine stays generic: one spec field. The playbook now says what the QA thread is (the thread of Harry's "New version released in QA" post for this version), to link it with role `qa`, and never to use the request or a side thread for the ask.
- Evidence: live smoke v6, interruption-boundary FAIL (6 of 8 milestones, 18 sessions, class: missing policy plus an engine gap). The model never asked Harry in the QA thread: the QA thread Q was never linked, so it had no `qa` thread to say in. It posted the sign-off ask to Harry in the side thread B instead, where the scenario's Harry reply (fired by a Tony post in Q) never came. The engine accepted `say signoff_requested` in B and reached the milestone. F10 and F4 were ruled out: `qa_ready` was checkpointed `reached` first and claimed without a `not_reached` answer; the home was never woken while active (sessions s8 to s18 are the ordinary waiting cadence of a home that kept checkpointing 5 to 15 minutes, the re-wake applies only to a wake nobody answered, and every one of those wakes was answered within 3 minutes). The 18 sessions were the model polling an answer that could not come. Repro: R58 test in `test/live-run1.test.ts`.
- Alternative: have the engine link the QA thread itself from Harry's post. Rejected: the engine does not see a thread until something links it, and the QA thread is identified by judgment (which version, which post).

## R59. The replay context names each thread's first message, and a labelled run accepts the thread the way the connector names it
- Call: the harness system prompt lists every thread with its first message, so the model can tell the QA thread from the others as it can in the channel. The engine binding maps a `<channel>:<ts>` thread given by the model in a labelled (not faithful) scenario to its label before it reaches the engine. This is a harness fix only.
- Evidence: the first rerun after R58 moved the model to Q but it linked Q as `<channel>:<ts>` while the labelled scenario tracks it as `Q`, giving the engine two ids for one thread (`wrong_thread`, `wrong_audience`, Q delivery stuck at claimed, job stuck at closing). Evaluation defect: the real connector uses one id. Pre-correction result stays as recorded (v7 run: FAIL on `end_job_status` and `deliveries_once`).

## R60. Smoke results are recorded per round with the saved run, and only the affected scenarios are rerun
- Call: after an engine change the affected real-model scenarios are rerun, 1 run each; the unaffected real scenarios are not. The engine change here (R58) touches only `signoff_requested`, so `stale-go` and `cancel-mid-publish` were rerun scripted only; both pass.

## R61. Thread continuity is enforced where the engine records and where it answers; the playbook holds only the general goal
- Call: (1) `job_open`, `say` and `promise_add` verify a thread they would newly record through `SlackReader.threadExists` (one `conversations.replies` read, limit 1): unknown answers `bad_thread`, a reply ts resolves to its root, "cannot tell" takes the thread as given (snap-in `PlatformSlackReader`; the harness world models existence in faithful scenarios). (2) `promise_add` keys the promise to the calling session's own Slack thread (`directory.threadOf`) over any thread it names. (3) `say` go/already_claimed carries `post_to {thread, channel, thread_ts}` and words saying to reply in that thread; `job_view` threads carry channel and thread_ts. (4) A top-level own-bot post (event `attrs.top_level`, no thread) is recorded as `unthreaded_post` on every open job with a linked thread in that channel, never matched to a claim, never a delivery; the claim stays open. (5) Milestone audiences exclude private threads unless the thread is the request thread (the first linked) or holds a promise; a `job_open` without a role on a job that already has a request thread joins as `side`. (6) Harness: `slack_post` without a known thread (or with an unknown one) is a top-level post in the world, as in Slack; new bars `no_top_level_posts` and `posts_in_intended_thread` (expected deliveries, `no_milestone_posts_in`). (7) Playbook: one general "Where you speak" section and a references note; no incident ids or names.
- Evidence: live run 2 (report 31 F1, F2, F3, F8): a made-up thread ts was linked and watched, every say to it posted top-level, B's promise sat on A, private C got milestone posts. Regression tests: `test/live-run2.test.ts`; scenarios `thread-continuity-run2` (fabricated thread, promise naming the request thread, home posting progress then the QA go ask) and `thread-continuity-variation` (status in B answered in B, a "ping me when live" in B, private C silent, sign-off in the QA thread), both against the pre-fix engine fail the new bars.
- Alternative: reject only ts values that are not Slack-shaped (a unix-time look). Rejected: the made-up value was Slack-shaped; only Slack can say a thread exists. Alternative: have the engine post. Rejected: the owner-locked design has Tony post and the engine confirm.
- Not done here: requester identity, marking an ask answered on approval, go event id as `because`, sender classification, the grader (other slices).


## R62. The reason for a consequential action is the go event; the requester comes from Slack evidence; voice is a general rule
- Call: (1) `intend` on a gated action resolves `because`: an event id or `#n` as before; anything else (a sentence, nothing) is matched against the listed go, meaning the newest approval item from a responder of the gate after the latest ask opened. A match is recorded as the reason and the answer says so (`because_resolved_by_engine`); no match holds (`no_go_for_build`, which the deploy checks hold on), so free text alone never authorizes anything. The existing checks (build_changed, no_go_for_build with no ask, sender_not_listed, revoked go) are unchanged, and a duplicate go still gives `already_recorded`, one approval. (2) An approval answers every open ask of the gate and records `answered_by` (the go's sender) and `answered_event` (the go event); `job_view` shows `answered_asks`. (3) `job_view` (also `no_job_here`) in a Slack mention session carries `asked_by`: the Slack author of the mentioning message, from `SessionDirectory.threadOf` (now also `prompt_ts`, the connector's custom field) plus the new optional `SlackReader.authorOf` (one `conversations.replies` read in the snap-in; already allowlisted, no new credential). Unknown author shows nothing. (4) Playbook: general evidence rule (identity only from the Slack message author or the engine's `asked_by`, never the comment author or a guess; if unknown, address nobody), the old "Rashmi"-shaped wording is gone, a general voice rule (no system vocabulary, no bold or checkmarks, no issue ids), and the reason rule ("the event that authorized it"). (5) Scorer: `voice_banned` and `threaded_only` (used by the thread-continuity scenarios) now score; new always-on bars `because_is_go_event` (clear approval has an event id as because and the engine did not have to resolve it) and `asks_answered` (the gate's ask answered by its event, none open). The variation scenario uses another connector author name, so a fix that only knew the first name fails.
- Evidence: live run 2 F4, F7, D-a, D-d. Regression tests: `test/live-run2-authz.test.ts`, `test/harness-voice.test.ts`, `snap-in/test/slack.test.ts` (authorOf), `snap-in/test/directory.test.ts` (prompt_ts).
- Not done: the slack-agent-connector could carry the Slack author name in the comment body; that needs owner approval (parked in run-state). `asked_by` gives the id, and the model can read the name from Slack or address `<@id>`.
- Alternative: refuse free text outright. Rejected: a model that writes a sentence after a real go would be stuck in a loop; resolving against the listed go keeps safety (only a listed go counts) and teaches the model through the answer.

## R63. A merge the source shows is settled by the engine; everything else stays with the home
- Diagnosis (F6): the merge op was `in_flight` with no reported outcome; after 30 minutes it turned `unknown` and each sweep re-woke the home. The playbook already says to settle, and the home did not. The engine had `proved_by: github_pr_merged` in the spec but only credited it from a webhook event that is not wired live.
- Call: `SourceReader.operationOutcome(proved_by, ref)` (optional). The snap-in reads `pulls/<n>` (route added to the guard, base checked on the answer) and answers `done` only for a merged PR into the mock base; nothing else, never `failed`. The sweep calls it for in-flight ops past the timeout and for unknown ops, marks them `done` (source `webhook_verified`, as a verified event does) and releases the lease. The home can still report first, and a failure or an unreadable source changes nothing. Only the timer path carries the GitHub keyring, which is where the sweep runs. The playbook keeps the home responsible for reporting what it did and read back.
- Evidence: `test/live-run2-authz.test.ts` R63; `snap-in/test/source.test.ts`. Unproven live: the `pulls/<n>` read with the live token (the probe's GitHub reads cover the adjacent routes).
- Alternative: only playbook text. Rejected: it is already there and did not hold; the engine can prove a merge without judgment.

## R64. Real-model smoke fixes; `asked_by` stays absent on the operation path
- Diagnosis from the 2026-10-05 smoke runs. (1) Engine: on an ask that names no build (`pr_review`, a GitHub review the engine cannot read) an honest free-text reason made `intend` hold under the R62 rule, so the home waited for a go that could never be tied; with no reason the same call cleared. The free-text hold now applies only to asks that name a build (QA, prod alpha); on an unknown-build ask the words are flagged `reason_in_words` and the action clears on the ask, as before R62. Safety is unchanged for build-checked gates: no approval without a listed go for the named build, a duplicate go still gives one approval. (2) Harness: in a scenario without `root_ts`, a reply by `channel`+`thread_ts` for a ts the world had shown was treated as a top-level post; the world now resolves any ts a message holds to its thread (an unknown ts still posts top-level). (3) Scorer: `voice_banned` allows an issue id the requester wrote in their own message. (4) Playbook (general): read a message as its recipient before posting and drop what only someone who can see the tools would understand. (5) Probe: job_open verifies threads (R61), so the probe links the newest real thread of the allowlisted channel (read only) and gains step `j`: threadExists on a real and a fabricated ts, authorOf, and the `pulls/<n>` read.
- `asked_by` on the operation path: `index.ts` builds the SlackReader from `deps.slack(event)`, which needs the `tony_slack_token` keyring; the manifest declares the keyring for the install, but IDENTITY.md records that the operation path receives no keyrings (`snap-ins.get` could not move to owner for that reason, and R57 found the same for GitHub). If the keyring is absent, `threadExists` returns null (thread taken as given) and `authorOf` returns null (nobody named): safe. Not changed: supplying the Slack token to the operation path would widen a credential the skills can reach (R57 rejected the same for GitHub). The tick path could cache the author, but the tick does not know the mention session's prompt. Left absent; the first live run shows whether the keyring reaches the operation path (job_view carries `asked_by` if so).

## R65. Live run 3 findings: the deployed engine runs every check in flag mode; served state is not proof
- Live evidence (run 3, report 33): `snap-in/src/specs.ts` calls `defineConfig` without `checks`, so R31's `DEPLOY_CHECKS` never applied live; run 2's hold was model behaviour. A gate intend whose `because` came from a sender not on that gate's list cleared. Tony edited `mock-release/state.json` (bump PR, then a direct push) and reported `live` without a successful CircleCI publish job. The user-token classifier (R62) fails against the real shape (`bot_profile` present on bot-token reads).
- Decision: recorded only; nothing changed in this slice. Repairs are listed in report 33 section 9 and need their own offline reproduction first.
