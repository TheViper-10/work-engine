# Red team 1: work engine phase 1

Reviewer: Opus red-team subagent, 2026-10-04. This was a read-only review: no engine, sim, spec or playbook file was changed.
Baseline: `npm test` gave 33/33 passing, `npm run lint` passed, and `npm run sim` passed (2 x 1,000 orders plus 16 named cases).

Repro scripts are in `/tmp/we-rt/`. The shared harness is `/tmp/we-rt/h.ts`, and each script is listed with its finding. Run them from the repo directory with `npx tsx /tmp/we-rt/<file>.ts`. Each script prints `REPRODUCED` or `not reproduced`.

**What was checked and held up:** a missing session id never causes a hold (D1; `touchRun` returns `unknown` and `superseded_run` needs a session id, `engine.ts:175,501`). The hold/flag config lives in one place (`config.ts:24-37`), and `missing_session` cannot be set to hold. No call has a required order or handshake. `build_changed` does re-read the `SourceReader` (`engine.ts:518`). `job_view` masks private events by thread. No code path lists a whole kind.

---

## High

### H1. Two engine instances on one store double-post and lose wakes, because nothing is compare-and-set
- `engine.ts:42,109-113` (the `serial` chain is per process only). Read-modify-write without compare-and-set happens at `engine.ts:635-657` (thread_index claim), `150-153` (due_index), every `saveJob`, and the lease at `578-584`.
- Scenario: in phase 3, `say` from session s1 and `say` from session s2 arrive as two function invocations. Both read `thread_index:A` with no claim, both write a claim, and both answer `go` for `live` in A. In the same way, `ingest` (Harry's sign-off, which sets the next wake to now) races a `checkpoint` (next wake 4h). The checkpoint's job write wins, and the unblock wake is lost for 4h. Two `schedule()` calls into one bucket lose one job id.
- Repro: `f2-race.ts` (gives `go/go`, and a next wake 240 min away with no reasons) and `f27-dueidx-race.ts` (T1's entry is lost). **CONFIRMED** on the code. Exposure in phase 3 depends on whether `supports_synchronization` serialises ingest, sweep and all six skills as one queue. That is unverified, and the handoff (§2) only says it keeps "calls in order".
- D6 and D13 promise create-if-absent semantics. Only runs, events, deliveries, asks and promises use `putIfAbsent`. The claim, which is the one record that prevents double posts, uses plain `put`.

### H2. `already_claimed` tells a second session to "post now" while the first is still posting
- `engine.ts:636-640`. The claim stores `{job, milestone, at}` and no session, so every caller is told "you claimed ... if your post is absent, post now".
- Scenario: s1 gets `go` for `live` in A and spends 3 s composing. A wake session s2 calls `say` for the same milestone and gets `already_claimed`. It reads the thread, finds nothing yet, and posts, as playbook line 96 tells it to. s1 then posts on its `go` (playbook line 94). That makes two `live` posts. The engine records the second only as `unclaimed_post`.
- Repro: `f3-already-claimed.ts` and `f3b.ts` (posts by s2 and s1, then `unclaimed own post in A flagged`). **CONFIRMED.**
- This is v1 drift. `sim/actors.ts:185-186` hard-codes "a resumed session does not trust its old go: it asks again", so the simulator's Tony does extra work that the playbook never tells the real Tony to do.

### H3. Any own-bot post in a thread satisfies the open claim, whichever milestone is claimed
- `engine.ts:984-988` (ingest matches any own post at or after the claim, and also any event with no `attrs.ts`). `engine.ts:1105` (the sweep reconcile accepts any own post after the claim time).
- Scenario: Tony claims `live` in A. Before he posts, the connector relays his reply to a status mention in A (`attrs.relay`), or delivers a late event for an earlier post that carries no `ts`. The delivery is marked `sent`, the promise is fulfilled and the claim is closed, but `live` was never posted. A's requester is never told (the run 6 shape). The sweep variant matches the same way.
- Repro: `f4-relay.ts` (both the relay and sweep variants) and `f21-nots.ts`. **CONFIRMED.**
- Under L2, claim matching is the engine's only proof of delivery. Mis-crediting a delivery is a lost message that nothing will ever re-wake.

### H4. Retrying `intend` with the same ref skips every check, takes no lease and puts nothing in flight
- `engine.ts:490-495`: `already_recorded` returns before `touchRun`, before the checks, and before any lease is taken.
- Scenario A: s1 is the work run and calls `intend(publish_prod_alpha, b1)`. A second session calls the same intend under the all-hold config and gets `already_recorded`. There is no `superseded_run` finding and no `not_work_run` flag.
- Scenario B: Tony reports `failed` for b1, which releases alpha. T2 then takes alpha. Tony retries with the same ref, as playbook line 45 says ("use the same ref if you retry"). The answer is `already_recorded ... failed`. No `lease_held` check runs, no lease is taken and nothing is in flight, so the unknown timeout never fires and two releases are publishing to alpha.
- Repro: `f1-intend-early-return.ts`. **CONFIRMED** (both scenarios).

### H5. An `unknown` outcome holds the lease forever and the cancel never finishes, yet the playbook tells Tony to report `unknown`
- `engine.ts:320` (`unknown` counts as unresolved), `761` (`unknown` does not release the lease) and `403` (`cancel_requested` waits for no unresolved operations). Playbook line 123: "operation still in flight marked `unknown` if you cannot tell".
- Scenario: a publish is in flight and the owner says cancel. Tony follows the playbook: `checkpoint(cancelled, [{b1, unknown}])`. 48 h later the job is still `cancel_requested`, alpha is still held by T1, the queued T1#2 never opens, and T2's `publish_prod_alpha` is held. Tony gets 48 wakes to a job the owner cancelled. The automatic timeout to unknown keeps the lease too (D5's fallback becomes a permanent lock).
- No D7 fresh read happens before `lease_held` fires. The finding rests only on a Tony-reported absence of an outcome.
- Repro: `f6-unknown-stuck.ts`. **CONFIRMED.**

### H6. A claim the engine never sees blocks the thread forever
- `engine.ts:636-643` (`busy`) and `1101-1114` (the sweep re-checks every 5 min with no limit). No call lets Tony say "posted, here is the link" or release a claim.
- Scenario: the connector filters bot authors today (handoff §2), and the Slack reader fails or lacks scope. A `merged` claim in A stays open. Every later milestone in A, including `live`, gets `busy`. `checkpoint(done)` stays `closing` ("still owed: merged to A") and the job gets 48 wakes a day, forever. Playbook line 97 ("post it now, then claim this one") cannot clear it, because the claim only clears when a post is seen.
- Repro: `f5-busy-livelock.ts` and `f5b.ts`. **CONFIRMED.**
- File 27 G7 listed the alternative (`say(sent, link)`). The current design has no fallback when the engine is blind.

### H7. Under hold, `build_changed` has no way out: re-asking for the new build is impossible
- `engine.ts:513-521` (the check reads `latest_ask[gate]`), `658-663` (asks only open when `say` claims a new milestone) and `631-633` (`already_sent`).
- Scenario: the owner said go for build abc, then the build changes to def. `intend(approve_qa_gate)` is held: "Ask the responders again for build def". Tony calls `say(A, qa_go_requested)` and gets `already_sent`, so no new ask opens. The owner says go again, and `intend` (with or without `because`) is still held. The open ask still names abc. Under hold this is a permanent refusal, which is v8 rigidity. Under flag, every later intend carries the flag.
- Related: `engine.ts:456-457` records a failed source read as build `"unknown"`. The next fresh read, `abc`, then differs and gives a false `build_changed` hold (`f10-sentinel.ts`). That breaks the D7 bar of 0 false holds.
- Repro: `f19-rebuild-deadlock.ts`. **CONFIRMED.**

### H8. A conversation session's checkpoint replaces the work run's wake and status, and can cancel the job
- `engine.ts:729-830`. Writes from a session that is not the work run are flagged `not_work_run`, then applied in full. Playbook line 135 makes every session checkpoint before it ends.
- Scenario: the work run checkpoints with a 5-minute wake while a pipeline runs. A mention session in B answers a question and checkpoints with `waiting_for "nothing for B"` and a 4h wake, as the playbook requires. The 5-minute wake is gone, so the sweep at +6 min wakes nobody. A third session's `checkpoint(cancelled)` moves the job to `cancel_requested` with no ask, even though the spec's `cancel` gate exists.
- D10 says these writes are "recorded with 'not the work run'". They are also applied.
- Repro: `f25-convo-checkpoint.ts`. **CONFIRMED.**

## Medium

### M1. A mention reply relayed into an owed thread is not counted, so the engine asks Tony to post again
- `engine.ts:991` (a relay with no open claim is ignored) and playbook line 33 ("Replying to the mention... No `say`").
- Scenario: B holds a promise for `live` and asks "is it live?". Tony answers "yes, live" through the relay. The delivery to B is still owed, so `checkpoint(done)` gives `closing`. The wake says "still owed: live to B", and Tony posts `live` to B a second time. This is the v2.18 double-live shape (`review-opus-v2.md` B5/B6), still open.
- Repro: `f20-relay-owed.ts`. **CONFIRMED.**

### M2. A pure read binds the engine's pending wake run
- `engine.ts:182-187` runs even when `mayAdopt=false` (`875`).
- Scenario: the sweep wakes T1's DM, creating a pending run. Before the DM session starts, a status-question mention in A calls `job_view` and becomes the work run. The woken DM session is then `other`, and under hold its `intend(merge_pr)` is held `superseded_run`. Wakes are suppressed for 20 minutes because a run is "active". D10 says a read must not make a session the work run. The design's "first session that calls the engine about that job binds" (engine-design.md, wake section) is exactly the risk.
- Repro: `f8-bind.ts`. **CONFIRMED.**

### M3. Wake reasons get erased: by `job_view` and by a failed wake
- `engine.ts:877`: the "read-only" `job_view` clears `wake_reasons` and saves the job. A later checkpoint from the work run then does not bring the wake forward (`818-822`). Harry's sign-off wake becomes a 4h wait (`f9-viewclear.ts`).
- `engine.ts:1169`: `wake_reasons` is cleared before `postWake` (`1175`). When the post fails, the retry wake says "next wake time reached" instead of "promise due" (`f12-wakefail.ts`).
- **CONFIRMED** (both).

### M4. A freed lease wakes nobody
- `engine.ts:839-847`. File 27 §1 lists "a lease frees" as an unblock wake. The hold's next move, "open this job with intent queue" (`510`), does nothing across targets, because the queue is per workflow plus target.
- Scenario: T2 is held on alpha and checkpoints "waiting for alpha" with a 4h wake. T1 releases alpha one minute later. T2 sleeps 233 more minutes. This is v1 drift: Tony has to poll.
- Repro: `f13-leasefree.ts`. **CONFIRMED.**

### M5. A `proved_by` event matched only by ref verifies the wrong operation
- In `spec.json`, `approve_qa_gate` and `publish_prod_alpha` are both `proved_by: circleci_gate_approved`. The matcher at `engine.ts:1005-1016` checks only ref and kind.
- Scenario: both use pipeline ref `pipe-395883`. A late QA-gate webhook marks the prod alpha publish `webhook_verified` and `done`, and frees alpha.
- Related: a checkpoint outcome without `action` (`engine.ts:744`) closes every operation with that ref, so a `verify_qa` result closes the in-flight publish (`f22-sharedref.ts`).
- Repro: `f16-provedby.ts`. **CONFIRMED.**
- This is phase 3 exposure under L3: a verified label on the wrong operation is worse than a Tony-reported one.

### M6. An open promise is silently voided when the job is done
- `engine.ts:355-356` and `794-796`.
- Scenario: B asked "tell me when live". Tony checkpoints `done` without marking `live` reached, which is the run 6 shape. The answer is "The job is done and closed." B's promise becomes `void` and B is never told. D4 only covers deliveries that were already created.
- Repro: `f11-promise-void.ts`. **CONFIRMED.**

### M7. The D8 lint can be evaded, and the spec is never linted for conditions
- `scripts/lint-generic.mjs:7-8` and `24-35`. These pass the lint: `'desk'+'top'`, a hard-coded Slack id `U0C4YRX93PS`, `job.roles[t] === 'qa'` (`qa`, `live` and `main` are in GENERIC), `endsWith('_alpha')`, and a spec with `"when": {op: 'and', ...}` or a `proved_by` holding "... if job==...".
- D8 says the lint fails "on conditions in spec mappings". No spec check exists.
- Repro: a copy in `/tmp/we-rt/lintcopy` passed with all of these, exit 0. **CONFIRMED.**

### M8. Ingest records the dedupe before doing the work
- `engine.ts:960-961`. If the invocation dies after `putIfAbsent` (a timeout, or a store error on a job write), the retry answers `duplicate` and the unblock is lost.
- Repro: `f24-dedupe-crash.ts`, with a fault injected into `store.put`. **CONFIRMED.**

### M9. Hot paths grow without bound and amount to listing a kind (D13)
- `engine.ts:215-217`: `thread_index.jobs` is never pruned. `963-966` and `861`: every event and every `job_view` on the long-lived QA thread loads every job ever linked. In the repro, 300 releases meant 300 keys read per event and a 41 KB view.
- `open_jobs:all` (`221-224`, already parked in R11) and the per-job `op_keys`, `flag_keys` and `delivery_keys` grow inside one custom-object record.
- Repro: `f18-threadidx.ts`. **CONFIRMED.**

## Low

### L1. The due index has gaps: a 14-day outage, and clock skew
- `engine.ts:27,1037`: an outage of more than 4,032 buckets means an overdue job is never woken again (`f17-buckets.ts` part b).
- `engine.ts:148,1049`: when the writer's clock is 6 min behind the sweeper's, an unblock lands in a bucket already swept. It is delayed to the next older entry, 30 min in the repro (`f23b-skew.ts`).
- **CONFIRMED.**

### L2. Under flag, `intend` on a done job relabels the release as cancelled
- `engine.ts:568-575`. A `complete_release_issue` intend after `checkpoint(done)` ends with status `cancelled`.
- Repro: `f15-donecancel.ts`. **CONFIRMED.**

### L3. `private: true` on a thread that is already linked is ignored without a word
- `engine.ts:210`. C's later evidence then shows in A's view.
- Repro: `f26-private-upgrade.ts`. **CONFIRMED.**

### L4. `say` and `promise_add` on an ended job refuse to record
- `engine.ts:623-625` and `678-680` answer `ok:false job_ended`, and nothing is recorded. This is arguably a refusal under the L1 reading of "records what Tony commits". **PLAUSIBLE** (traced from the code, not run).

---

## What the simulator missed, and why
- **One engine instance with an in-process `serial` chain**, so the H1 races are structurally impossible in the sim.
- **The sim's Tony carries the fixes.** `actors.ts:185-186` re-asks before acting on an old `go` (hiding H2). It only ever posts the claimed milestone (hiding H3). `ownStray` fires only when no claim is open (`actors.ts:220-224`), which avoids exactly the H3 collision. It never relays a mention reply (hiding M1). It never retries a failed intend with the same ref (hiding H4).
- **The invariants are too weak.** They check that a next wake exists, not that it reflects the latest unblock or the work run's own wish (H8, M3, M4). An `unknown` operation holding a lease counts as "live" (`invariants.ts:93`, `engine.ts:1235`), so H5 passes. "Sent" is checked only against `hasPost(job, thread, milestone)`. A wrongly credited claim (H3) or a voided promise (M6) is not checked at all.
- **The bounds are too small.** Downtime is at most 300 min (no 14-day gap), there is no clock skew and no store faults, and the Slack-blind toggle flips back quickly, so H6 never persists. Rebuild after a go is covered only as a one-shot named case that stops at the first hold (H7).
- **The lint was tested against honest code only.**

## Ranked list
1. H1 cross-instance races, with no compare-and-set on claim, due index or job (`engine.ts:42,109,635-657`)
2. H2 `already_claimed` tells a second session to post (`engine.ts:636-640`)
3. H3 any own post or relay satisfies the claim (`engine.ts:984-988,1105`)
4. H5 `unknown` holds the lease forever and the cancel never finishes (`engine.ts:320,403,761`; playbook line 123)
5. H6 an unseen claim locks the thread, and the job stays closing forever (`engine.ts:636-643,1101-1114`)
6. H4 an idempotent `intend` skips checks and the lease (`engine.ts:490-495`)
7. H7 hold-mode `build_changed` cannot be cleared, plus the `unknown` build false hold (`engine.ts:456,513-521,631`)
8. H8 a conversation checkpoint replaces the work run's wake and can cancel (`engine.ts:729-830`)
9. M1 a relay is not counted toward an owed delivery, causing a double post (`engine.ts:991`)
10. M2 a read binds the pending wake run (`engine.ts:182-187`)
11. M3 wake reasons are erased by `job_view` and by a failed wake (`engine.ts:877,1169`)
12. M4 a freed lease wakes nobody (`engine.ts:839-847`)
13. M5 `proved_by` and ref collisions (`spec.json` actions; `engine.ts:744,1005-1016`)
14. M6 a promise is voided at done (`engine.ts:355`)
15. M7 the lint can be evaded, and the spec is not linted (`lint-generic.mjs:7-35`)
16. M8 the dedupe-first ingest loses events on a crash (`engine.ts:960`)
17. M9 unbounded thread_index and job arrays (`engine.ts:215,963`)
18. L1 due-index gaps; L2 done relabelled cancelled; L3 private ignored on re-link; L4 `job_ended` refusals

## Verdict
The engine avoids the obvious v8 traps. There is no call order, no token, missing session ids are flag-only, the hold/flag config sits in one place, and the source is re-read before `build_changed`. But its two core promises, "no double post" and "no lost wake", hold only inside a simulator whose Tony already has the fixes built in and whose invariants check that a wake exists rather than that it is right. The claim is a plain put with no owner, so two sessions or two instances both post. Any own-bot post or relay credits whatever milestone is claimed. A claim that is never seen, or an outcome reported as `unknown` (which the playbook itself tells Tony to report), turns into a permanent lock on a thread, a lease or a cancel, with a wake every 30 minutes and no call that clears it. Several unblock wakes are overwritten by ordinary calls (`job_view`, a conversation session's checkpoint, a concurrent write). Hold mode cannot clear a stale build, so the phase 2 hold-versus-flag replay would be measuring this bug rather than the policy. These need fixing before phase 2. In priority order: claims that are owned by a session, compare-and-set, and milestone-specific; a Tony-callable "posted" or "release claim" route that clears an unseen claim (`say(sent, link)` or equivalent); a lease/cancel path out of `unknown`; a re-ask route that opens a fresh ask; and wakes that only ever move earlier. Phase 1 cannot be called done on today's simulator evidence.
