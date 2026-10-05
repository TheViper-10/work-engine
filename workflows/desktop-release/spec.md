# Desktop release spec, in plain English

File: `workflows/desktop-release/spec.json` (version 1). It only names things. It holds no order of steps and no conditions; Tony keeps the judgment and the playbook explains how to use these names.
Short source names: CALLMAP = `22-tony-coordinator-call-map.md`, HANDOFF = `28-handoff-work-engine-build.md`, DECISIONS = `18-coordinator-design-decisions.md`, CFG = `21-work/run-data/live/gh-config.yml`, BLIVE = `21-work/B-live.md` (all under `tony-shared-state`).

## Setup
- Link roles: `request` (the thread that asked), `side` (threads that joined later, such as B and C), `qa` (Harry's QA thread).
- Resources: `alpha` (the prod alpha channel) and `main` (the base branch). An action that names a resource takes a lease on it.
- People: `owner` (Slack U042GEDM4BB) and `harry_bot` (Slack U0C4YRX93PS, Harry in the mock; DECISIONS line 6). The real release will use Abhay (U0ANLN96KNH) as the sign-off person; that is not in this mock spec.

## Gates (who may say go)
| Gate | Primary | Stand-in | What it is | Source |
|---|---|---|---|---|
| `pr_review` | owner | none | Approval of the version bump PR, on GitHub or in Slack | CALLMAP moment 4; DECISIONS line 6 |
| `approve-desktop-qa-latest` | owner | none | The owner's go for QA. Also the real CircleCI approval job that triggers the QA publish | CFG 118-126; CALLMAP moment 6 |
| `approve-desktop-prod-alpha` | Harry | owner | Sign-off before prod alpha. Also the real CircleCI approval job for the prod alpha publish | CFG 128-137; CALLMAP moment 8; DECISIONS line 6 |
| `cancel` | owner | none | Who may cancel a release at any time | CALLMAP moment 11; BLIVE 153 |

## Milestones (what Tony can tell people)
Audience is the request thread plus everyone holding a promise for that milestone, unless noted (HANDOFF D3).
| Milestone | Meaning | Audience | Opens ask | Source |
|---|---|---|---|---|
| `bump_pr_open` | The bump PR is open and waiting for review | request, promise holders | `pr_review` | CALLMAP moment 1 |
| `pr_approved` | Owner approved the PR (often with no Slack mention) | request, promise holders | none | CALLMAP moment 4 |
| `merged` | PR merged, pipeline started | request, promise holders | none | CALLMAP moment 5 |
| `qa_go_requested` | Tony asks the owner for the QA go after triaging Playwright | request, promise holders | `approve-desktop-qa-latest` | CALLMAP moment 6 |
| `qa_ready` | Build is in QA and Harry's "released in QA" post was seen. This is what thread B's "tell me when QA is ready" promise waits on | request, promise holders | none | CALLMAP moments 2 and 7 |
| `signoff_requested` | Tony asked Harry, once, in the QA thread | qa thread only (judgment call, see below; `audience_only`, R58) | `approve-desktop-prod-alpha` | CALLMAP moment 8 and rule 26 |
| `prod_alpha_approved` | Sign-off received | request, promise holders | none | CALLMAP moment 8 |
| `live` | Live on prod alpha, served revision read from the update server | request, qa thread, promise holders | none | HANDOFF D3; CALLMAP moments 9 and 10 |

## Actions (what Tony tells the engine he is about to do)
| Action | Resource | Gate | Proved by (event kind) | What it is |
|---|---|---|---|---|
| `open_bump_pr` | none | none | `github_pr_opened` | Open the version bump PR (CALLMAP 196) |
| `merge_pr` | `main` | `pr_review` | `github_pr_merged` | Merge the PR (CALLMAP moment 5) |
| `approve_qa_gate` | none | `approve-desktop-qa-latest` | `circleci_gate_approved` | Approve the CircleCI QA job (CFG 118-126) |
| `verify_qa` | none | `approve-desktop-qa-latest` | `circleci_job_succeeded` | Check the QA publish job ran for the merged build (CFG 122-126; CALLMAP moment 6) |
| `publish_prod_alpha` | `alpha` | `approve-desktop-prod-alpha` | `circleci_gate_approved` | Approve the CircleCI prod alpha job (CFG 128-137) |
| `verify_served` | `alpha` | none | `update_server_served` | Read what the update server serves (CALLMAP moment 9) |
| `complete_release_issue` | none | none | `devrev_issue_completed` | Complete the release issue under ISS-37 (CALLMAP moment 10) |

Until the CircleCI and GitHub adapters exist, every "proved by" is Tony-reported through `checkpoint` (L3, HANDOFF §2). The event kind names only say which webhook event would later upgrade the label to webhook-verified.

## Judgment calls and gaps
- The event kind names (`github_pr_merged`, `circleci_gate_approved` and so on) are invented here. No source lists event kinds, so the engine and simulator should treat them as the agreed names.
- `signoff_requested` is addressed to the `qa` thread only, not the request thread, because the sign-off ask is only allowed in the bound QA thread (CALLMAP rule 26). Alternative: use the D3 default and also tell the request thread.
- Step order is deliberately not in the spec (gate order was release code in v8 and caused rigidity; CALLMAP rules 21 to 23). CircleCI itself only requires the build for the prod alpha gate (CFG line 127 comment), so order stays Tony's judgment.
- Stand-ins are only listed where a source names them: Harry primary with owner stand-in for prod alpha (DECISIONS line 6). Other gates have none.
