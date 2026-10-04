# Hybrid delta, next slice and phase-3 scope

Status: for owner review. Nothing here is implemented, published or authorized. Written 2026-10-04 from the revised handoff (`/tmp/work-engine-handoff-2026-10-04-revised.md`, sections "Hybrid design", "Decisions to settle", "Phase 3").
Citations: `engine.ts:N` is `main`; `rt:engine.ts:N` is branch `redteam-fixes` (worktree `work-engine-rt`); `28:N` and `27:` are the tony-shared-state files; `DL` is `docs/decision-log.md`; `PDE` is `proposals/platform-dm-evidence.md`; `ODM` is `proposals/one-dm-per-job-review.md`; `PC` is `proposals/playbook-comparison.md`.

## 0. Verified state today

- `main` (45aa504): 33 unit tests pass. It has no R17 fixes (`run-state.md:16,38`).
- `redteam-fixes` (47aa0ce, uncommitted edits in the worktree): 33 unit tests pass, generic lint passes, all 28 red-team repros clear (2 parked, L1 outage and skew, still reproduce by design). `npm run sim` is still red: random order 525 (seed 1, flag) double-posts `live`, and named cases "twin runs" (flag and hold), "crash after post" and "missed bot post" fail. So `run-state.md:38` ("6 named sim cases and lint failing") is stale on lint and still right on sim.
- Phase 2 gate (10 runs in a row per mode) and report 29 are not started (`run-state.md:19-21,39`).

## 1. Delta table

Columns follow the handoff: current implementation, accepted work (already decided or built, keep), outstanding repair (R17 on `redteam-fixes`, being finished now), new delta from the hybrid handoff, deferred until after the pilot.

| Item | Current (main / redteam-fixes) | Accepted work | Outstanding repair | New delta (hybrid) | Deferred (after pilot) |
|---|---|---|---|---|---|
| **Execution identity and continuity** | | | | | |
| Job | Record keyed workflow:target with threads, roles, dm_id (`types.ts:55-88`) | Keep as is; D3-D5, R11, R12 | none | Store a reference to the release issue, not a copy of its content | none |
| Execution home | `dm_id: dm:<id>` is only a name (`engine.ts:231`); wakes post to it (`engine.ts:1175`) | 28 §2: engine-owned DM per job, never Slack-linked | none | Real DM created once per job (create-if-absent, keyed by job); id stored; phase 3 | none |
| Session | `Run.session_id` from the platform (`types.ts:94`); the platform pins agent version and secrets at session start (PDE b3) | D1 | none | Record session identity per run and per home | Persisted working context beyond what the platform keeps |
| Run | First writer becomes the run (`touchRun`, `engine.ts:171-196`); 20-minute timeout (`config.ts`) | Wake makes a run create-if-absent (`engine.ts:1164`) | Reads never bind, wake-bound run (rt:`engine.ts:234-246`, DL R17) | Run is owned only by the session whose DM is the job DM; a checkpoint records progress and does not end context (ODM §5.2) | none |
| Ownership generation | Absent | none | none | Integer on job and run, bumped on each replacement, written with `putIfVersion`; old and new home, session and generation recorded | none |
| Controlled replacement | A stale run lets the next wake create a new run in the same DM (`engine.ts:1148-1180`); no second DM | ODM §2 rotation idea | none | Sequential replacement, same job, new run or new DM, pending inputs and obligations carried; never two active owners (decision (a)) | Automatic rotation on every agent publish |
| Stale-worker fencing | `superseded_run` is a check, default flag (`engine.ts:502`, `config.ts:24-37`); retried `intend` skips checks (red-team H4) | D2 | H4 fix (rt:`engine.ts:615` on) | Every write call compares the caller's generation; a superseded worker's commit is recorded as a note, not applied. Tool-side fencing: none known today (GitHub, CircleCI and Slack calls take no owner token). Exposure: a call already started, or an external call that cannot carry the generation, can still land | Idempotency keys or conditional calls per external tool, where supported |
| Concurrency and leases | One serial chain per process only (`engine.ts:42`, H1); lease per resource (`types.ts:159`) | Lease model, D13 | `putIfVersion` on job, lease, index; waiters wake on release (rt:`engine.ts:140,587-597`) | Config for independent-job capacity; phase 3 proof that updates are atomic across invocations. Shared-target leases stay separate from ownership | Capacity tuning from pilot load |
| Delegates | Absent | none | none | Delegates may read and return evidence; a delegated consequential action needs an explicit scope string on the operation | Delegate tooling |
| **Durable input and communication** | | | | | |
| Inbox states | Main: no state on events (`types.ts:176-191`). Branch: `received` then `done` (rt:`types.ts:211`, rt:`engine.ts:1229-1233,1321`) | M8: retry reprocesses a received-but-not-done event | Land M8 | Add `associated`, aligned with the planned enum received/matched/unmatched/processed (`record-shapes.md:38`); retry resumes incomplete processing | none |
| Per-job acknowledgment | `matched_jobs` list only (`types.ts:188`) | none | none | `processed_by` per job id, so one event touching two jobs completes independently | none |
| Worker routing | Ingest wakes only for a listed responder, another bot or a watched ref; nothing goes to an active run (`engine.ts:992-1000`, `engine.ts:1155-1160`) | Wake refuses a twin (R11) | Pending unblock survives views and failed wakes (DL R17) | Active: notice or queued follow-up in the job DM. Waiting: schedule resume in the same home. Unavailable: retain, retry, escalate. Steering versus follow-up chosen by P1 | Steering-specific tuning |
| Coalescing and bounds | `MAX_EVENTS_KEPT` 200 (`engine.ts:28`); `MAX_REASONS` 20 (rt:`engine.ts:29`) | none | none | Collapse repeated notices; never drop approvals, cancellations, obligations; overload answer names what was coalesced | Retention policy for `work_event` (`record-shapes.md:61`) |
| Non-consuming reads | `job_view` does not bind the run (DL R17, "Reads never bind") | DL R17 | Land it | Inbox items are not consumed by a read; a checkpoint keeps an earlier pending unblock | none |
| Ambiguous association | `job_view` returns every job on a thread (L4, `engine.ts:851`) | L4: Tony judges | none | An approval or cancel that could belong to two jobs yields a clarification request; it cannot authorize an action | none |
| Late input | Ingest skips ended jobs (`engine.ts:972`); late checkpoint never reopens (DL R12); `job_ended` records (DL R17 L2-L4) | R12 | `job_ended` lows | Record the late input against the ended job and give the sender one line; reopening is explicit (`job_open` replace) | none |
| Delivery ack bound to message id | Claim per thread, matched by session and time; `posted_link` confirms (DL R17; rt:`engine.ts:797-809`); delivery has `message_link` (`types.ts:155`) | L2 option B | Claim fixes H2, H3, H6 | Acknowledgment stores message id, destination, job and obligation; connector delivers Tony's own posts with ids (G12, phase 3) | Webhook-verified labels beyond Slack |
| **State, memory and evidence** | | | | | |
| `work_event` versus `work_record` | Two types planned (`record-shapes.md:5-8`); memory store only | D13, G10 | none | Approval validity is computed from events plus asks, never stored as a property of the event. Field plan deltas: section 4 | Event retention |
| Session, files | No file concept | none | none | Session is working context; files optional and job-associated; one authoritative writer per coordination field, summaries link to records | Recovery summary, file discovery, retrieval |
| Live-system contradictions | `SourceReader.currentBuild` re-read before `build_changed` (`types.ts:41-44`, D7) | D7 | Unreadable source never holds (DL R17) | Keep the earlier observation and its source; flag a recorded claim that live evidence contradicts; broaden beyond build | Contradiction dashboard |
| Uncertain operations | `unknown` after 30 min (`engine.ts:1076-1087`); D5; R17 keeps the lease and wakes to settle | D5 | H5 | Reconcile by readback before repeating; use external idempotency where supported | none |
| Build-scoped approval and revocation | Ask keyed job:gate:build, goes stale when a new build is asked (`engine.ts:471`); `build_changed` (`engine.ts:518`); no revocation | D9 | H7 re-ask | Ask records action, target, responder and source event; revocation is an event that voids the ask; revalidate at `intend` (decision (c)) | none |
| Cancellation | `cancel_requested` until operations settle (`engine.ts:329-335`); spec `cancel` gate exists but nothing enforces it (`spec.json:23`, DL R4) | R12 | Cancel finishes with unknowns flagged (DL R17 line 92) | Cancel is an inbox item from an authorized responder; it governs later actions; uncertain effects still read back (decision (c)) | none |
| Resource safety | `unknown` keeps the lease on main (`engine.ts:761`); R17 releases leases when a cancel finishes with unknowns | D5 | Contradiction, see section 6 | Stopped work and unresolved cleanup recorded separately; bounded follow-up and escalation | none |
| Access classification | Link `private` flag; private events masked in views (`engine.ts:905-907`); `private_origin` (`engine.ts:970`); relink upgrade (DL R17 L3) | R-series privacy rules | L3 | Carry the label into derived summaries, files and outgoing posts; a shared context sees only in-scope evidence; restricted work uses a separate context or an explicit handoff | Separate scoped contexts as a feature |
| **Guidance and knowledge** | | | | | |
| Canonical playbook location | `workflows/desktop-release/playbook.md` (live); goal-oriented draft under `proposals/` | DL R7, R13-R15 | none | Pick one (decision (b)); recommend migrating to `knowledge/desktop-release/playbook.md` with updated references | none |
| Knowledge layout | No `knowledge/` directory | none | none | playbook.md, references.md, lessons.md, topic files; read-only in normal execution | Lessons promotion, retrieval |
| Guidance version per job | Job has `spec_version` only (`types.ts:59`) | D8 | none | Job stores `guidance_version` at open; changing operating assumptions is a reviewed migration | Per-job knowledge access log |

## 2. Decisions needing the owner

Only blockers for the next slice. Answers already recorded are reused.

### (a) Adopt job-home execution ownership
- Change: amend D10 (only the session in the job DM owns execution; mention sessions answer and record), extend D1 (owner is a session whose DM, looked up from the session id, is the job DM) and allow sequential DM replacement (28 §2 "one DM per job" gains a second DM in sequence, never concurrently).
- Options: (1) Adopt. (2) Keep D10 and finish R17 only. (3) Adopt, but bind by the wake-created run when the lookup is unavailable.
- Evidence: All 3 of A's failures and 1 of B's 4 are the competing-worker defect (`PC:87-91`). The model removes H8 and M2 outright and shrinks H2, M1, M3 (`ODM:94`). Lookup works with the snap-in service account and `ai-agent.sessions.get` (`PDE:33`), and skill metadata does not carry the DM (`PDE:31`).
- Lookup failure, as proposed: (i) record an `identity_lookup_failed` diagnostic with session id and reason, visible in `job_view`; do not cache failures; retry on the next call. (ii) Reads, `say` and `promise_add` for the caller's own thread still work. (iii) Consequential calls (`intend`, status `checkpoint`) get no `clear` and no lease: the answer says ownership is unconfirmed. (iv) Recovery path: the sweep wakes a replacement run in the job DM, and after a bounded time escalates to the owner.
- Tension: D1 says "record and flag, never hold" (`28:70`, `engine-design.md:35-36`, `ODM:52,137`). The handoff says missing identity cannot establish authority. Point (iii) is a hold for consequential calls, so D1 must be amended, not reinterpreted. Also, an engine `hold` is text to Tony (L1, `engine-design.md:10`); real enforcement is at the tool (decision (d)).
- Recommendation: option 1, with the D1 amendment limited to consequential calls when identity is unconfirmed.

### (b) Adopt the goal-oriented playbook B
- A (current) scored 7/10, B 6/10 over 5 scenarios x 2 runs; B used about a third fewer engine calls (median 31-35 versus 48) and model requests (50-61 versus 75) (`PC:76-78`). The sample is too small to call a winner (`PC:93`). B's four failures classify as one runtime defect, two evaluation defects (one mixed) and one judgment miss (`PC:85-91`), and approval correctness held in all 20 runs.
- Options: (1) Adopt B after the ownership slice. (2) Keep A. (3) Adopt B now.
- Recommendation: option 1, conditional on a rerun of at least 3 runs per scenario under flag and hold on the new engine (`PC:97-98`), and on fixing the two evaluation defects first (post-cancel honest outcome post; stale-go owner trigger).

### (c) Build changes, cancellation, uncertain publication, late decisions
- Which build changes invalidate an approval. Options: any new commit; only product code; only a different pipeline build. Evidence: H7 (`ODM:77`). Recommendation: any change in the build the ask named invalidates; the owner's later go may cover a named later build.
- Who may cancel. The spec's `cancel` gate lists the owner only (`spec.json:23`). Recommendation: owner plus listed stand-ins, routed as an authoritative inbox item, with a non-authorized cancel recorded and asked about.
- Resource handling while a publish is uncertain. Conflict: DL R17 releases the lease when a cancel finishes with unknowns (`DL:92`), while ODM row H5 recommends no release until read back (`ODM:75`) and the handoff says keep ownership safe. Recommendation: keep the lease until the readback settles; cancel ends as "cancelled, unresolved cleanup" with bounded follow-up and escalation.
- Late decisions after done (`ODM:92`). Recommendation: record and send one line; a late go never reopens.

### (d) Hold versus flag, and advisory versus enforceable
- Evidence gap: hold-mode evidence on the repaired engine does not exist yet (sim red). Scripted hold failed H7 before R17 (`run-state.md:18`).
- Options: (1) All flag until the gates finish. (2) Pick a split now and confirm it in replay.
- Recommendation: option 2. Hold (for consequential actions only): `job_cancelled`, `build_changed` when the fresh read succeeded, `sender_not_listed`, `lease_held` on prod alpha, stale ownership, unconfirmed identity. Flag: `missing_session` on reads, `unclaimed_post`, `not_work_run` on communication. Advisory means Tony sees it and judges; enforceable means outside the engine: branch protection, the native prod-alpha lock (D11), credential scope. The engine cannot stop a tool call (L1), so no authority claim may rest on an engine hold alone. Confirm the split with the phase-2 gate runs.

## 3. Smallest offline implementation slice (after (a) and (b))

| File | Change | About lines |
|---|---|---|
| `src/types.ts` | `generation`, home history, inbox item and state, `guidance_version`, `SessionDirectory` | 50 |
| `src/session-directory.ts` (new) | Interface plus a fake with failure injection | 40 |
| `src/engine.ts` | Ownership in `touchRun` and six calls (100), inbox and per-job ack (80), routing and notice (60), late input and revocation (60), generation fencing (40) | 340 |
| `src/config.ts` | Queue bound, lookup-failure window, per-check consequential set | 15 |
| `harness/driver.ts`, `engine-binding.ts`, `scripted-tony.ts` | Job-DM versus mention-DM session context (ODM §7) | 100 |
| `sim/world.ts`, `named.ts`, `invariants.ts` | Scenarios below; invariant "one action-owning session per job generation" | 170 |
| `test/engine.test.ts` | Unit tests per new rule | 220 |
| `scenarios/interruption-boundary.json` plus variants | Replay inputs | data |
| `workflows/desktop-release/` or `knowledge/desktop-release/playbook.md` | Playbook B adapted, `guidance_version` | about 90 (text) |

Total: about 700 lines of code and tests, plus text. Core ownership and routing is about 320 by ODM §7, growing to about 500 with generation, late input and revocation.

Named scenarios (sim and harness, from ODM §5.4 plus four gap cases): `ib-base` (request in A, job DM, PR, ask in A, go in A to inbox, continue, tell A); `ib-status-b` (status question in B while active, no run change); `ib-go-active` and `ib-go-after-done`; `ib-build-changed` (go for abc, build becomes def); `ib-cancel-unknown` (cancel while publish unknown, read back, tell requester); `ib-crash-after-approval` (replacement session settles it); `ib-duplicate` (one inbox item, one worker, one effect); `ib-private-c` (C evidence stays out of A and B). Added: `ib-lookup-fail` (diagnostic, no consequential clear, replacement wake); `ib-stale-worker` (old session commits after a generation bump); `ib-overload` (queue bound keeps approvals); `ib-late-decision`.

Order:
1. Finish R17 to green on `redteam-fixes`: sim seed 1 order 525, named "twin runs", "crash after post", "missed bot post". Merge to `main`. Required first, because the slice assumes claim and compare-and-set fixes.
2. Decisions (a)-(d); log them in `decision-log.md` as amendments to D1 and D10.
3. Implement the slice; sim 2 x 1,000 orders plus named cases, lint, red-team repros.
4. Then the phase-2 gates (scripted all, then real model, 10 in a row per mode, D7 bars unchanged) on the new engine only; a gate on the old engine would be discarded. Report 29 last.

## 4. Phase-3 deployment scope for authorization

Targets (file 28): host `api.qa.devrev-eng.ai`; org `devo/1lKlCUXYGG`; Tony `ai_agent/2`, currently 2.38 (version after the publish is recorded, not assumed). Credentials by name only: `AGENTCORE_RUNTIME_INSTANCE_ORG_TOKEN` (org), `TONY_SLACK_BOT_TOKEN` (Tony's Slack). Confirm scopes before any write; display names and scopes only.

Protected, never touched: production; `#desktop-deployment C08TJE6SDME`; AGE-12; Harry `ai_agent/3`; `scheduled_task/9` stays paused; v8e (`snap_in/4008e2f0`) frozen; the `coordinator_control` secret.

| # | Object | Action | Authorization | Rollback | Stop condition |
|---|---|---|---|---|---|
| 1 | Target check | Read-only confirm of host, org, Tony at 2.38, credential scopes | Covered by read-only fde-agent assignment | none | Any target differs from above |
| 2 | `work_record`, `work_event` types | Owner creates empty types; fde-agent adds fields (`record-shapes.md:16-42`): unique_key, kind, job_key, state, body (json), created_at, updated_at, version; event adds source. Deltas: none as columns (generation, inbox state, guidance_version live in `body`); event `state` keeps the planned enum | Explicit QA schema change | Additive only; stop using the keys, delete test rows | Platform cannot enforce unique_key per org or create-if-absent; field types cannot hold json |
| 3 | Snap-in (new package) | Deploy and activate engine with functions and the sweep event source | Explicit snap-in deployment | Deactivate and delete the new version | 409 or function quota; any change would touch v8e |
| 4 | Six skills | Register and attach to Tony: `job_open`, `job_view`, `intend`, `say`, `promise_add`, `checkpoint` | Explicit skill attachment | Detach skills | Tony's other skills change |
| 5 | Scheduling | New engine-owned sweep every 5 minutes | Explicit workflow/schedule | Delete or pause the new schedule | `scheduled_task/9` would be resumed or edited |
| 6 | Guidance and Tony | Attach approved playbook and contract reference; republish `ai_agent/2`; record new version | Explicit Tony republish | Republish 2.38 content and pin as default | Harry or shared prompts affected |
| 7 | Job DM | Create engine-owned DM per job; session lookup needs `ai_agent_session:read`; wakes post as the owner user, not the service account (`PDE:40`) | Covered by 3 and 6 | Close test DMs | Scope not grantable to the snap-in (then decision (a) option 3) |
| 8 | Connector (G12) | Deliver linked-thread inputs with sender identity and Tony's own posts with message ids; dry run first | Explicit connector change | Redeploy the previous connector version | Any read or write in C08TJE6SDME; Harry's bindings change |
| 9 | GitHub event path | Webhook to the snap-in for mock targets, plus reconciliation. CircleCI stays readback and Tony-reported; its receiver follows the live pilot | Explicit webhook creation | Delete the webhook | Repository is not a named mock target |
| 10 | Branch protection and approvals | Apply on mock targets; scope pilot credentials to mock and QA; D11 native protection is a prerequisite for any real prod-alpha action | Explicit per repository | Restore prior protection rules (record them first) | Protection would apply to a real release branch |
| 11 | Proofs P1-P7 | Run selectively in fresh hidden DMs with non-posting prompts (`PDE:47-52`) | Covered by 6 and 7 | Close test DMs | Any post leaves the test DM |

Proofs: P1 active-turn input and start latency; P3 long-idle, version and secret pinning; P4 crash resume; P5 wake author and credentials; P6 parallel calls; P7 `parent_id` for a plain DM. `PDE` defines no P2 (handoff says P1-P7), so renumber or define it. Add two proofs the handoff requires: atomic conditional update across independent invocations, and session-to-DM lookup through the snap-in token.

### Readiness matrix (template)

| Seam | Class | Evidence level | Fallback | Owner |
|---|---|---|---|---|
| Pilot blocker, broken means no pilot | | implemented / offline / observed QA / assumed | | |
| Bounded limitation accepted for the restricted pilot | | | | |
| Requirement before broader team or production use | | | | |

Starting classification proposed for the template: pilot blocker: job-DM identity lookup, atomic conditional writes, intended-message ack, build-scoped approval and cancel, mock-target credential boundary, private-evidence filtering. Bounded limitation: steering unresolved (durable inbox plus wake fallback), long-idle resume beyond 46 minutes, in-flight tool call cannot be fenced. Before broader use: retention, capacity limits, CircleCI webhook receiver, L1 outage catch-up, D11 native prod lock.

## 5. Remaining platform assumptions

From `PDE` UNKNOWN or ASSUMED rows, plus engine-level items:

| Row | Assumption | Status | Proof |
|---|---|---|---|
| a1, a2 | A post into an active turn steers the same session; queue versus merge is unknown | Documented by owner, not observed | P1 |
| a3 | No twin session mid-turn | Unknown | P1 |
| c1, c2 | Resume after 46 minutes; no expiry | Unknown (assumed to resume) | P3 |
| d2 | Next post after a crash resumes, replaces or does nothing | Unknown | P4 |
| x2 | A service-account wake reaches Tony with no credentials | Unknown, assumed | P5 |
| x3 | Skill calls within a session may run concurrently | Assumed | P6 |
| i2 | `parent_id` absent for a plain DM | Observed only for other sessions | P7 |
| i4 | Session-to-DM mapping is immutable and the scope is grantable | Assumed | Lookup proof |
| H1 | `supports_synchronization` serializes ingest, sweep and the six skills | Unverified (`red-team-1.md`) | Atomic update proof |
| record-shapes | `version` enforced only by the engine; `work_event` retention undecided | Open (`record-shapes.md:60-61`) | Schema check |
| 28:64 | Connector drops bot authors today | Known; G12 work | Connector test |

## 6. Where sources disagree with the handoff

- Playbook A/B: A (current) is 7/10 and B is 6/10 (`PC:76`); B's advantage is fewer calls, not more passes.
- D1 "never hold" (`28:70`) versus the handoff's rule that missing identity cannot establish authority (section 2(a)).
- R17 releases the lease on a cancel with unknown operations (`DL:92`), while ODM H5 and the handoff keep resources safe.
- `run-state.md:38` says lint fails on `redteam-fixes`; it passes now. Sim is still red.
- 28 §2 says skill calls carry the session identity; they carry the session id but not the DM (`PDE:31`).
- 27 §3.1 wake text includes a run token; D1 says there is no run token.
