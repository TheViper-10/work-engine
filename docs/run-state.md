# Run state: work engine

Resume: read this file, then `docs/job-home-contract.md` (controlling), `docs/decision-log.md`, `docs/engine-design.md`.
Handoff: `/tmp/work-engine-handoff-2026-10-04-revised.md` (copy of the revised handoff).

## Direction (owner, 2026-10-04)
One job, one engine-owned execution DM (job home). Slack threads are communication routes only.
Goal-oriented playbook adopted. No A/B with the old approach.

## Done
- Phases 0 and 1; R17 red-team fixes merged to `main` (8b4f9fe; previous main tagged `pre-r17-merge`).
- Scripted harness 9/9 under flag and hold after R17 (133ddd6).
- Proposal `docs/proposals/hybrid-delta-and-phase3-scope.md`; contract `docs/job-home-contract.md`.

## Slices (job-home build)
| Slice | Goal | Status |
|---|---|---|
| JH-engine | A1-A4, R20-R24 in src; unit tests; sim invariants and ib-* named cases | done a1b560d: lint, 46 unit, sim 2x1000 + 42 named, 28 repros |
| JH-knowledge | knowledge/desktop-release/{playbook,references,lessons}.md, job-home wording | done 93487a3 |
| JH-harness | home vs mention sessions, notice/resume, interruption-boundary scenarios, new playbook path | running |
| P2-gate | scripted all, then real model 10/mode flag and hold on the job-home engine | after JH-harness |
| Report | 29-work-engine-run-report.md + /tmp/tony-shared-state copy | draft /tmp/we-longrun/29-draft.md; gate results pending |

## Parked
- Red-team L1 (due-index gap after long outage; clock skew): phase 3 bounded catch-up scan and store clock.
- Compare-and-set on the platform store: phase 3 proof.
- Phase 3 QA writes (schema, snap-in, skills, Tony publish, connector): need owner authorization.
- Run 6 pipeline id for number 395883 (needs CircleCI token; not needed for replay).

## Done condition and authorization (owner, 2026-10-04)
Done when the job-home work engine is fully deployed to QA and a live Slack mock-release run completes in channel `playwright-agent-test`. Read as authorization for phase 3 QA writes (custom types, snap-in, skills, scheduling, connector, Tony `ai_agent/2` republish) and the phase 4 live mock run in that channel. Protected resources unchanged.
- Owner approved QA deletions: empty packages owner-v3, onefunc, coord-v1; inactive terminal-v4 install 462070f3 with its version and package (records saved first).

## Phase 3 deployed (2026-10-05)
- Snap-in `work-engine-qa-v5`: install `snap_in/1a4de02e-8179-48d1-87ae-0fe10333fce4` (svcacc/121), package 71561124, version 3e588625, tarball sha256 7495bc50...84a0 (d748e54).
- Tony skill workflows: job_view 59, checkpoint 60, job_open 61, intend 62, say 63, promise_add 64. Wake workflow 58.
- Plan `ai_agent_plan/26` work-engine-desktop-release (playbook + references + mock overlay).
- Tony `ai_agent/2` v2.39 published, default, 14 skills; v8 workflows 55/56 and plans 24/25 detached. Rollback: republish `rollback-work-engine-s6-2026-10-05/tony-versions-create-body-v2.38-rollback.json`.
- Proofs: live adapter probe (home DM, one wake, Tony reply, session-to-DM identity, route vs hold, admin close); hidden-DM smoke (Tony called work_engine_job_view, answer no_job_here).
- Next: phase 4 live mock release 5.2.11 in playwright-agent-test (`pilot/RUNBOOK.md`).

## v6 deployed and live run 2 (2026-10-05, in progress at handoff)
- Snap-in `work-engine-qa-v6`: install `snap_in/3b38941c-66d4-4a43-803d-0286945006c1` (svcacc/128), package 041cc95d, version ca36b021, tarball sha256 e80fb8fa...79f4 (63fee31). v5 deleted; old skill workflows 59-64 paused.
- Skill workflows (v6): job_view 65, checkpoint 66, job_open 67, intend 68, say 69, promise_add 70. Wake workflow 58. Plan 26 carries the mock overlay during the run.
- Tony `ai_agent/2` v2.40 published (14 skills). Rollback bodies: `~/.agents/memory/agents/fde-agent/artifacts/rollback-work-engine-v6-2026-10-05/`.
- Live probe on v6: all steps PASS (`live-probe-pass.out` in that dir).
- Live run 2: release 5.2.12, run dir `~/.agents/memory/agents/fde-agent/artifacts/tony-mock/runs/engine-5.2.12-20261005T015229Z/`. At 02:38Z: PR #58061 merged, QA gate approved after the owner's go, QA 5.2.12 published, Harry's QA post up; sign-off and prod alpha pending. Handoff: `/tmp/work-engine-handoff-2026-10-05.md`.
- Live run 2 RESULT: 5.2.12 live at 02:51:21Z, job done, 0 interventions. PASS: external outcome, ownership, privacy, autonomy. FAIL: authorization (free-text because, asks not answered), communication (made-up linked thread gave top-level double posts; B's promises never delivered; private C got updates). Report: tony-shared-state/31-work-engine-live-qa-release-run2.md. Next: communication repair slice (handoff §2a), v7, live run 3 (5.2.13).

## Thread continuity slice (2026-10-05, offline, R61)
- Fixes F1, F2, F3, F8 of live run 2 in engine, snap-in reader, harness world/scorer and the general playbook. Not deployed; the next step is one real-model run each of run1-replay-shaped `thread-continuity-run2` and `thread-continuity-variation` (`--checks deploy`), then redeploy with a probe first.
- Still open from run 2 after R62/R63: F5 was fixed in c91d609; F9/F10 fixed in c91d609. Open: live proof of all of this (v7 deploy, probe, live run 3 on 5.2.13).


## Authorization and identity slice (2026-10-05, offline, R62, R63)
- Fixes F4 (because is the go event, ask answered on approval), F7 (requester identity from Slack evidence; general voice rule; scorer keys `voice_banned`, `threaded_only`, new bars `because_is_go_event`, `asks_answered`) and F6 (engine settles a merge from a GitHub read). Not deployed. Scripted scenarios pass; no real-model runs made in this slice.
- Next: real-model smoke (run1-replay, interruption-boundary, thread-continuity-run2/variation, `--checks deploy`, 1 run each), then probe, v7, live run 3 (5.2.13). The snap-in has a new read (`pulls/<n>`) and a Slack read (authorOf); run the live probe before deploy.
- Parked (owner approval needed): the slack-agent-connector could put the Slack author's display name in the comment body or in the DM custom fields. Not changed. Until then `asked_by` gives the Slack user id and the model addresses `<@id>` or reads the name from the thread.
- Parked: the IDENTITY.md row for `pulls/<n>` (GitHub read, timer path) and `conversations.replies` for authorOf (operation path has no Slack credential: `asked_by` is shown only where the SlackReader can read, i.e. the tick path and the probe; on the operation path `job_view` runs with the caller token and no Slack keyring, so live `asked_by` may be absent). This needs a decision: give `job_view` the Slack keyring, or have the tick path write the author into the thread index. Unknown author means no name is used, which is safe.

## v7 deployed to QA (2026-10-05, no live run started)
- Snap-in `work-engine-qa-v7`: install `snap_in/516a266b` (svcacc/135), tarball sha256 ee56f613...4563 (7d09f95). Manifest unchanged vs v6. v6 chain deleted (511 rows exported first); old skill workflows 65-70 paused.
- Skill workflows (v7): job_view 71, checkpoint 72, job_open 73, intend 74, say 75, promise_add 76. Wake workflow 58. All active, valid, 2 hits for new install and slug, 0 for v6/v8.
- Plan 26: clean base, no mock overlay (18209 chars, object_version 5). The live-run operator applies the overlay. Tony `ai_agent/2` v2.41 published (14 skills; only the six workflow triggers changed vs 2.40).
- Live probe on v7: all steps PASS, 0 probe rows left. Finding: Tony reacts to the probe wake comment and calls the real `job_open` in the live `qa` namespace, so a job `desktop-release:0.0.1` appears after each probe (also seen after the v6 probe). Closed with admin_close_jobs, rows deleted. Fix idea: run the probe with a Tony-free wake or clean up as a probe step.
- Hidden-DM smoke: a call with no thread answers `bad_thread` (R51 strict threads); with a well-formed job-less thread it answers `no_job_here`.
- Evidence and rollback: `~/.agents/memory/agents/fde-agent/artifacts/rollback-work-engine-v7-2026-10-05/` (rollback = republish `tony-build/tony-versions-create-body-v2.40-rollback.json`).
- Next: live run 3 (5.2.13) with the mock overlay applied by the operator.
