# Phase 0 review (one page)

Phase 0 wrote down what a desktop release is, how Tony should behave, and what the records look like. No engine behaviour lives here. Threads used below: A is the request thread, B is a side thread, C is a private side thread, Q is Harry's QA thread.

## 1. What phase 0 produced
- `workflows/desktop-release/spec.json`: the release written as data. Names only.
- `workflows/desktop-release/spec.md`: the same spec in plain English, with sources.
- `workflows/desktop-release/playbook.md`: Tony's system prompt for a release.
- `docs/record-shapes.md`: the two platform record types and their fields (for phase 3).
- `docs/engine-design.md`: the contract between spec, engine, simulator and playbook.
- `scenarios/README.md` plus 9 scenario files: replay inputs for phase 2.
- `docs/decision-log.md`: judgment calls R1 to R9. `docs/run-state.md`: run progress.

## 2. The spec in one table
The spec names things only. It has no conditions and no step order. Tony keeps the judgment.

| Kind | Name | Who or what | Detail |
|---|---|---|---|
| Gate | `pr_review` | owner, no stand-in | Approves the bump PR |
| Gate | `approve-desktop-qa-latest` | owner, no stand-in | Go for the QA publish |
| Gate | `approve-desktop-prod-alpha` | Harry, stand-in owner | Sign-off before prod alpha |
| Gate | `cancel` | owner | No action uses it |
| Milestone | `bump_pr_open`, `pr_approved`, `merged`, `qa_go_requested`, `qa_ready`, `prod_alpha_approved` | A plus promise holders | The D3 default |
| Milestone | `signoff_requested` | Q only | Asks Harry once |
| Milestone | `live` | A, Q, and every thread with a promise | One message per thread |
| Action | `open_bump_pr` | no lease, no gate | proved by `github_pr_opened` |
| Action | `merge_pr` | lease `main`, gate `pr_review` | proved by `github_pr_merged` |
| Action | `approve_qa_gate` | gate QA | proved by `circleci_gate_approved` |
| Action | `verify_qa` | gate QA | proved by `circleci_job_succeeded` |
| Action | `publish_prod_alpha` | lease `alpha`, gate prod alpha | proved by `circleci_gate_approved` |
| Action | `verify_served` | lease `alpha` | proved by `update_server_served` |
| Action | `complete_release_issue` | none | proved by `devrev_issue_completed` |

Example: B says "tell me when QA is ready". That is a promise on `qa_ready`, so B is owed that message even though A started the job.

## 3. The playbook in five bullets
- First move is `job_view`. Tony reads the whole briefing and the live sources before he speaks. Example: a mention in B shows two linked jobs, and Tony picks the one B means.
- `intend` before merge, approve or publish. An answer of `flag` is information. Tony reads it, tells the thread once if it matters, and may still act. An answer of `hold` means stop. Tony follows the next move it names, then checkpoints the operation as failed. Example: the owner said go for build abc, the build is now def, so Tony asks again for def.
- Say, then post (option B). Tony calls `say(job, thread, milestone)`, and on `go` he posts himself with `slack_post`. If the answer is `already_claimed`, he reads the thread and posts only if his message is missing. Replying to the mention that started him needs no `say`.
- A promise needs a fallback time. Example: B asks for QA news, so Tony adds a promise with a 4 hour fallback. If it passes, the engine wakes him.
- Checkpoint with outcomes and a wake. Each outcome is `done`, `failed` or `unknown`. Every open job has a next wake. Example: after approving the QA hold, Tony checkpoints "waiting for the pipeline", wake in 5 minutes.

## 4. Record shapes
- Two types. `work_record` holds job, link, run, ask, operation, promise, delivery, lease, flag and index records. `work_event` holds inbound events only.
- Filterable fields: `unique_key`, `kind`, `job_key`, `state`. Events also have `source`. Everything else is in a JSON `body`, so a new field never needs a schema change.
- Key format: `work-engine:<env>:<bot>:<kind>:<id>`. Example: `work-engine:dev:tony:job:desktop-release:5.2.9`.
- The engine never lists a whole type. It reads by key or by up to 100 keys. Example: "which jobs are linked to B" is one index record keyed by B's thread, not a search.

## 5. Scenarios
| Id | What it tests | Assumed (from its notes) |
|---|---|---|
| `run4` | Unmentioned approval, B and C arrive together, merge webhook dropped, Harry bot post | Start versions qa and alpha 5.2.7; wording of some messages; tail to done is synthetic (real run was a cancel) |
| `run6` | B never told QA is ready; one live per thread; direct push | Playwright flake; pipeline id `p6`; owner's go wording |
| `v2-18` | 40 minute merge delay, flake, CircleCI error, owner as stand-in | GitHub approval time and CI timings; Harry's reply not in export |
| `stale-go` | Go for build abc, build becomes def, `build_changed` fires | Build ids abc and def are placeholders |
| `cancel-mid-publish` | Cancel while publish is in flight | Shortened base timeline; synthetic |
| `private-evidence` | C's evidence shown to B only as "held" | Marker `PRIVATE-REC-7731` is synthetic |
| `twin-mention` | Two mentions 12 s apart plus a twin wake, one work run | Synthetic burst |
| `missed-bot-post` | Tony's live post not seen, sweep reconciles, no re-post | Synthetic |
| `queued-second-release` | 5.2.12 asked mid-run becomes a queued job | Job 2 is scripted only until it is woken |

## 6. Judgment calls to review
- R1: start engine work before scenarios and playbook were finished, to save about 25 minutes.
- R2: event kind names like `github_pr_merged` are invented here. Adapters map real webhooks later.
- R3: `signoff_requested` goes to Q only, not A, because the sign-off ask is allowed only in Q.
- R4: a `cancel` gate exists (owner) but no action uses it and the engine does not act on it.
- R5: no step order in the spec. Tony, not the engine, completes the release issue.
- R6: people are the owner and Harry only. The real sign-off person (Abhay) is left out.
- R7: the playbook gives a "usual path" that Tony may reorder.
- R8: the playbook keeps the v2.38 Slack voice and drops receipts, `report_effect` and `execution_key`.
- R9: missing facts in scenarios are filled with stated assumptions in each file's notes.

## 7. What to check first
1. People and stand-ins in `spec.json`. Is "owner only, no stand-in" right for PR review, QA go and cancel? Abhay is not in the mock spec (R6).
2. Sign-off asked only in Q (R3). If you want A told as well, change `signoff_requested` audience roles to `request` and `qa`.
3. Assumed facts in scenarios (R9). Run 4 and v2-18 use guessed start versions and CI timings. Read the `notes` field of those two files.
4. Invented event kind names (R2), so adapters later follow them.
5. Every engine check defaults to `flag`, not `hold` (engine-design, D2). Confirm that is the intended first setting.
