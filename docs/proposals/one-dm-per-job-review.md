# Review: one job, one execution DM

Status: review for the owner. Nothing here is implemented. Offline only; no deploys.
Inputs: the owner's proposal (2026-10-04 evening), `src/engine.ts` on `main`, branch `redteam-fixes`
(partial R17 fixes), `docs/red-team-1.md`, `docs/proposals/platform-dm-evidence.md` (fde-agent,
read-only), `docs/proposals/fde-skill-method-review.md`, handoff 28 (D1 to D14), file 27 (L1 to L4).

## Recommendation (short)

Adopt it, as a change to who may own execution and how inputs reach the worker, not as a rewrite.
Most of the execution home already exists. The change is three things:
1. Only a session running in the job's own DM can own execution (replaces D10).
2. Every input from a linked thread lands in a durable job inbox, and the job DM is told
   (replaces the current "wake only on a few signals").
3. Mention sessions answer and record communication requests (promises, questions); they cannot
   intend, checkpoint status, or confirm effects.

It removes a class of bugs (competing workers, a conversation overwriting the worker's wake) and
four playbook rules. It does not remove concurrent writes, duplicate delivery, stale approvals or
uncertain external effects; those keep their engine fixes (table below).

## 1. What exists already, and what changes

| Part of the proposal | On `main` today | Change |
|---|---|---|
| One engine-owned DM per job, kept with the job, separate from Slack DMs | Yes. `job.dm_id` set at job creation (`engine.ts:231`); wakes post only there (`engine.ts:1175`); file 28 §2 forbids Slack-linked DMs | Phase 3 must create a real DM per job and store its id; offline it is a name |
| Work that advances the job happens in that DM | Partly. Wakes start or steer the DM session, but any session making a write call can become the work run (`touchRun`, `engine.ts:171-196`; D10) | **Main change.** Execution ownership is tied to the job DM, not to "first writer" |
| Inputs from linked threads go to a durable inbox, with sender, thread, time, privacy and refs | Partly. Events are stored with sender, thread, privacy (`engine.ts:960-1010`); only some wake the job (responder of an open ask, other bot, watched ref) | Add an inbox per job (records keyed by event), shown in `job_view`; every human message in a linked thread that is not answered by a mention session counts |
| Mention sessions answer and record, never execute | No. They may adopt the run when idle (D10), and their writes are applied with a flag (red-team H8) | **Main change.** Writes from outside the job DM become notes or inbox items; `intend` from outside is answered "route to the job" |
| Active worker gets notified, not twinned; idle worker resumed in the same DM | Partly. `wake` refuses a twin while a run is active (`engine.ts:1155-1160`) but does not notify the active run; the active run sees new inputs only on its next `job_view` | Post a short notice into the job DM when an input arrives during an active run (platform steers that session, see §2), and resume via the same DM when idle |
| Crash recovery stays on the same job and DM; exclusive ownership; reconcile uncertain actions first | Partly. Run timeout makes the next wake a new run in the same DM; `unknown` after timeout (D5) | Ownership becomes "the session in the job DM with the newest run"; the resume wake names unknown operations to settle first. Exclusivity still needs compare-and-set (H1) |
| Replies and promised updates return to Slack threads with delivery acknowledgment | Yes, by option B (L2): claim with `say`, Tony posts, the engine matches the bot post | Unchanged; the R17 claim fixes still apply |

Answer to the owner's question: yes. The job DM already exists as the wake target, so the real
changes are execution ownership (who may act) and routing (how inputs reach the worker).

## 2. Platform behaviour by state

Full table with sources: `docs/proposals/platform-dm-evidence.md` (fde-agent, read-only, 41 GET-style reads).

| State | What a post into the job DM does | Status |
|---|---|---|
| Active (mid-turn) | Owner: steers the same session, one reply. Whether it is queued or merged mid-tool-call: no stored case (run 4: a question and a cancel 104 s apart got one session and one late reply) | DOCUMENTED by owner; UNKNOWN in detail |
| Waiting (turn ended) | Resumes the same session, same `agent_session_id` (gaps of 35 to 46 min seen). The resumed turn keeps the agent version and secrets from session start | OBSERVED |
| Ended long ago | Nothing stored beyond 46 min; no expiry field | UNKNOWN |
| Recovering (crash mid-tool-call) | 21 of 340 sessions stay `running` forever, so `running` is not liveness. The in-flight skill call finishes on its own later. What a new post does: no stored case | OBSERVED / UNKNOWN |

Two facts change the design:
- **Skill-call metadata does not carry the DM** (OBSERVED in 15 runs). The engine can map
  `agent_session_id` to its DM with a read-only `ai-agent.sessions.get` (`agent_session.parent`),
  needing scope `ai_agent_session:read`; cache it per session. So ownership is "session whose DM is
  the job DM", looked up, not passed. If the lookup fails, record and flag, never hold (D1 spirit).
- **A session pins its agent version and secrets** (OBSERVED). A job that spans a Tony publish or a
  keyring change keeps running old text in its DM. Needs a "rotate the job DM" path: a new DM for
  the job when a wake meets a stale version, with the old DM closed in the record. This is the one
  place "one DM per job" must allow a second DM, sequentially, never concurrently.

Other consequences: liveness comes from the engine's own last-call time plus the D5 timeout, never
`execution_state`; wakes are posted as the owner user (as workflow 12 does), not the service
account, or Tony may start without credentials (ASSUMED); start latency is 18 to 57 s for a fresh
DM run and 1m20s to 2m48s for a Slack mention (the "100 to 390 s" figure had no source). The design
does not rely on steering: the inbox is the durable path and the DM notice is the fast path.
Phase 3 proofs P1 to P7 are listed in the evidence file.

## 3. Red-team findings under the new model

"Eliminated" means the ownership model removes the failure path itself, not that it becomes rarer.

| Finding | Eliminated by ownership | Still an engine fix | Still business policy |
|---|---|---|---|
| H1 cross-instance races (claim, due index, job writes) | No. Ingest, sweep and the worker's calls still run as separate invocations | Yes: create-if-absent claims, compare-and-set on job, lease and index (R17) | No |
| H2 `already_claimed` tells a second session to post | Mostly: only the job DM session posts milestones, so no second poster in normal flow | Yes: claim owned by session, for recovery after a crash (a replacement session in the same DM) | No |
| H3 any own-bot post satisfies the claim | No. Tony's mention replies and the worker's posts are still the same bot | Yes: match by session and time, never by "any post" (R17) | No |
| H4 retry `intend` skips checks and lease | No | Yes (R17) | No |
| H5 `unknown` holds the lease and blocks cancel | No | Yes: unknown wakes the worker to settle; cancel finishes with unknowns flagged (R17) | Yes: whether a cancelled job may release alpha while publish is unknown (recommend: no, until read back) |
| H6 unseen claim blocks the thread | No | Yes: `say(..., posted_link)` confirm route, stale-claim handoff (R17) | No |
| H7 hold-mode `build_changed` cannot clear | No | Yes: re-ask opens a fresh ask for the new build; unreadable source never holds (R17) | Yes: which build changes invalidate a go (any new commit, or only product code) |
| H8 conversation checkpoint replaces worker wake, can cancel | **Yes.** Only the job DM session checkpoints status | Small: outside writes become notes (already on `redteam-fixes`) | Yes: who may cancel from Slack (spec `cancel` gate), routed as an inbox item |
| M1 relay to an owed thread not counted | Partly: the worker, not a mention session, owes and sends milestones | Yes: a mention reply that tells a milestone still needs matching (claim by the mention session for that thread only) | No |
| M2 a read binds the pending wake run | **Yes.** Only the job DM session can bind | No | No |
| M3 wake reasons erased by `job_view` / failed wake | Partly: mention sessions' `job_view` can no longer touch the worker's state | Yes for failed wake posts (R17) | No |
| M4 a freed lease wakes nobody | No | Yes (R17) | No |
| M5 `proved_by` matches the wrong operation | No | Yes (R17) | No |
| M6 promise voided at done | No | Yes (R17) | No |
| M7 lint evasion | No | Yes (R17) | No |
| M8 dedupe before work | No | Yes (R17) | No |
| M9 unbounded indexes | No | Yes (R17, prune) | No |
| L1 due-index gaps | No | Parked, phase 3 | No |
| L2 done relabelled cancelled | No | Yes (R17) | No |
| L3 private flag ignored on re-link | No | Yes (R17) | No |
| L4 `job_ended` refusals | No | Yes (R17) | No |
| New: inbox items arriving after the job ended | n/a | Yes: record, and answer the sender in words; never reopen silently (R12) | Yes: does a late "go" or "cancel" after done need a reply (recommend: one line) |

Net: the model eliminates H8 and M2 outright and shrinks H2, M1 and M3. Every other finding still
needs its R17 fix. Concurrent writes (H1), duplicate delivery (H2, H3, H6, M1), stale approvals (H7)
and uncertain effects (H5) are not solved by one DM.

## 4. Playbook instructions the runtime can take over

From the current playbook (`workflows/desktop-release/playbook.md`, line numbers there):
- Work run rules (39-41) and R15 "join before acting": runtime enforces who may act.
- The "what you see, what you call" table (23-37): sequencing; removed.
- `say` answer branches (90-101) and R13/R14 claim clauses: the engine's answer words are the next
  move; one line remains (claim before posting), marked temporary.
- "Every open job needs a wake", "do not stop at closing" (132-139): engine-guaranteed.
None of these are replaced by new instructions; where the runtime is not ready, the proposed
playbook marks a temporary line with its removal condition.

## 5. Smallest migration and validation plan

Keep the R17 fixes on `redteam-fixes` (all 28 repros clear; 6 named sim cases and lint still fail).
1. Finish R17 to green on `redteam-fixes` (lint words, the 6 named cases), merge to `main`.
2. Engine change, small: a run may be owned only by a session whose DM (looked up from its session
   id through a `SessionDirectory` interface, faked offline) is the job DM; `touchRun` adopts only then. Writes from other sessions: `say` and
   `promise_add` allowed for their own thread (communication), `checkpoint` becomes a note,
   `intend` answers "route" and records an inbox item. Add an inbox kind; `ingest` files every
   linked-thread human message there and wakes or notifies the job DM.
3. Harness: sessions get a DM context (job DM for wakes, Slack DM for mentions); the driver posts a
   notice into an active job DM session (steer) or starts one (resume).
4. Validation, first milestone (offline scenario `interruption-boundary`, scripted Tony then real
   model): request in A, job DM created, worker opens PR, asks A for a go on build abc, waits,
   owner's go in A goes to the inbox, the worker checks it applies to the current build, continues,
   tells A. Variants: status question in B while active (answered in B, no work run change); go
   while active vs after done; build changes to def before the go (no approval of def on the abc
   go); cancel while publish is unknown (settled from the update server, requester told); crash
   after approval before checkpoint (replacement session in the same DM settles it); duplicate
   inbound events (one inbox item, one worker, one effect); private evidence in C stays out of A
   and B posts.
5. Then resume phase 2 replays under flag and hold.

## 6. Decisions that must change

- **D10** (conversation sessions may become the work run): replace with "only the job DM session
  owns execution; mention sessions answer and record communication".
- **D1** (work run = caller's session id): extend with the session's DM, looked up from the session
  id (`ai-agent.sessions.get`, read-only, cached), because skill metadata does not carry it.
  If the lookup fails, record and flag; never hold.
- **File 28 §2 "one DM per job"**: allow sequential DM rotation when a session's pinned agent
  version is stale, never two DMs active for one job.
- **27 §3.1** ("a Slack mention starts a session; it may work"): mention sessions stop working.
- **27 §3.5 exception** (mention reply needs no `say`): stays, but a mention reply that tells a
  milestone is the worker's job; the mention session says "the release owner will update you".
- Unchanged: L1 to L4, D2 to D9, D11 to D14.

## 7. Code versus playbook impact

- Code: `touchRun` and the six calls' ownership checks (about 100 lines), an inbox record kind and
  its view (about 80), ingest routing and DM notice (about 60), harness DM context (about 80).
- Playbook: about half the current text goes (see `playbook-goal-oriented.md` comparison).

## 8. Remaining risks

- Platform steering of an active DM session is the owner's fact (file 28 §2), not yet observed by
  us; if a notice queues until the turn ends, the worker sees inputs only at its next `job_view`.
  The inbox keeps it correct; only latency changes.
- Ownership depends on a session lookup the platform allows only with `ai_agent_session:read`;
  if that scope is not grantable to the snap-in, ownership falls back to wake-run binding (the run
  created by `wake` binds the first session that calls), which a crash replacement can confuse.
- Version and secret pinning (above) means a long job can run stale playbook text until rotated.
- The connector created four DMs for three Slack threads in run 4: mention-side DMs are not one per
  thread, so routing must key on the Slack thread, never on the mention DM.
- A mention session cannot act even when the owner says "merge it now" in one hop; it now takes one
  wake (up to about 11 minutes worst case, 27 §3.4). The notice path shortens this if steering works.
- Two jobs in one DM are not possible by construction; two DMs for one job are possible if job DM
  creation is not create-if-absent. Key the DM by job.
