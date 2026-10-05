# Replay scenarios

Inputs for the phase 2 replay harness: a real model plays Tony with the playbook as the system
prompt and fake GitHub, CircleCI, Slack and update-server tools. The harness owns a virtual clock
and a fake world; a scenario says what the world looks like at start and what happens to it over
time. Nothing here calls a platform. Generated from the Tony run artifacts (see "Sources").

## File format

One JSON file per scenario, `<id>.json`.

| Field | Meaning |
|---|---|
| `id` | file name without `.json` |
| `source` | citations as `tony-shared-state/<file>:<lines>` (root `~/.agents/memory/agents/fde-agent/artifacts/tony-shared-state/`) |
| `summary`, `notes` | what the scenario covers; assumptions and facts not found in sources |
| `derived_from`, `synthetic` | variants only: the real scenario the shape comes from |
| `threads` | `A`, `B`, `C`, `D`, `Q`: `role` (`request`, `side`, `qa`; engine link roles), `channel`, `root_ts` (real Slack ts, null if synthetic), `root_sender`, `private`, `root_text` |
| `jobs` | jobs the scenario expects: `id`, workflow, target version, opening thread, optional `intent` (`queue`) |
| `people` | id to `{slack, name, sender_kind}`. `sender_kind` is `human`, `own_bot`, `other_bot` or `system`; same vocabulary as event fields in `docs/engine-design.md`. Gate roles follow `workflows/desktop-release/spec.json` (owner primary for review, QA gate and cancel; Harry primary and owner stand-in for prod alpha) |
| `initial_world` | `github` (base branch, `prs`, `head_sha`, `scripted_ids`: the PR number, merge sha, pipeline id and release issue the fake tools return), `circleci` (`pipelines`, `gates`, the job graph from `gh-config.yml`, step durations and the Playwright outcome from `gh-scenario.json`), `update_server` (`qa_version`, `alpha_version`), `slack` |
| `world_paths` | the dotted paths a `change` or `when` may use |
| `faults` | fault injections for the fake tools: `{id, target, nth?, mode, ...}` (`error`, `drop_event`, `allowed`) |
| `timeline` | ordered entries, below |
| `expected_end` | `job_status`, `milestones` reached, `deliveries` (milestone to threads that must each get exactly one post), `max_live_posts_per_thread`, `no_unknown_operations`, plus scenario-specific keys |
| `expected_checks` | what each `intend` check should do at an action: `expected` is `fires` or `silent`; `check` is one of the five engine checks (`superseded_run`, `job_cancelled`, `lease_held`, `build_changed`, `sender_not_listed`) or, with `custom: true`, a harness assertion on a view or answer |

### Timeline entries

Common: `t` (nominal virtual minutes from the first message), `type`, optional `when` (a predicate
over `world_paths`, path to value) and `delay_s` (seconds after the predicate becomes true). The
effective fire time is `max(t, when_true_time + delay_s)`; the harness sorts by effective time.
`type` is one of:

- `slack_message`: `thread`, `sender`, `text`, `mentions_tony`, optional `slack_ts`. Human text is
  paraphrased from the Slack export, close to the real wording.
- `bot_post`: like `slack_message` but a bot author (Harry). Never starts a Tony session.
- `github`, `circleci`, `update_server`: `kind`, `sender`, `change` (world mutation, dotted path to
  value) and the event the engine should see.
- `timer`: `kind` (`sweep`, `wake_twin`), the engine sweep that runs every 5 virtual minutes.

Each entry that reaches the engine carries `event`: `{source, kind, thread, sender (platform id),
sender_kind, ref, attrs, delivered}`. `delivered: false` means the world changes but the engine
never receives the event (the dropped merge webhook in `run4`).

`event.attrs.inbox_kind` (`cancel`, `request`, `approval`, `message`) is the connector's structured hint for the engine's inbox routing; the engine never reads message text. It is set on go, sign-off and cancel messages.

Placeholders: `<pr>` and `<id>` are replaced by the scenario's PR number and pipeline id.

## Scenarios and their source

| File | Kind | Source | Key cases |
|---|---|---|---|
| `run4.json` | real, with synthetic tail | `C-run4.md` moments 2.1 to 2.9, `tmx-timeline.md`, call-map moments 1 to 11 | unmentioned PR approval; B and C arrive at the same minute; merge webhook dropped, then owner's QA go (no mention); Harry's bot post with no session; real cancel replaced by a done tail |
| `run6.json` | real | `19-v8-long-run-state.md` RUN6 lines, call-map moments, TMX namespace 170298e2 | side thread B (promise for "QA is ready") never told; first B reply errors; direct push to the base branch; one "live" per thread |
| `v2-18.json` | real | Slack export A, B, C, Harry post, `facts-brief.md`, `gh-scenario.json` | unmentioned approval; 40 minute merge delay; flaky agent-studio Playwright failure and "go, that one is a flake"; CircleCI "project not found" once; Harry "released in QA" bot post; owner's stand-in approval for Harry's sign-off |
| `stale-go.json` | derived | run 6 shape, handoff 28 named cases | go for build abc, fix pushed, build def; `build_changed` must fire |
| `cancel-mid-publish.json` | derived | run 4 cancel, call-map moment 11 | cancel while the publish operation is in flight |
| `private-evidence.json` | derived | v2.18 B/C shape | private thread C evidence hidden from B |
| `twin-mention.json` | derived | v2.18 mention burst, bad run 2026-10-03 | two mentions and a twin wake during an active run |
| `missed-bot-post.json` | derived | handoff 28 section 2 (posting option B) | Tony's live post not seen; sweep reconciles |
| `interruption-boundary.json` | derived | job-home contract A1, A4; stale-go base | B asks for status while the home worker waits on A's go; B answered in B by a non-home session, run unchanged; the go reaches the inbox and is applied to build abc |
| `run1-replay.json` | derived (faithful mentions) | live run 1 timeline (`30-work-engine-live-qa-release.md` section 3) | connector-shaped mentions (DM comment, external_ref), DM id as thread and `next` target (scripted slips), duplicate go, one job, no acting from Slack, plain voice without Rashmi |
| `queued-second-release.json` | derived | call-map moment 3 (`release_in_progress`) | 5.2.12 requested mid-run becomes a queued job |

Derived variants reuse one compact happy-path timeline (kickoff, B question, unmentioned approval,
merge, build, Playwright flake, "go, that one is a flake", QA publish, Harry's bot post,
Harry's sign-off, prod alpha publish, sweep) with no real ts, plus the scenario-specific entries.

## How to drive a scenario

1. Load `initial_world` into the fake tools and inject `faults`.
2. Advance the virtual clock through `timeline` in effective-time order. For each entry apply
   `change` to the world, then deliver `event` to the engine (unless `delivered: false`); mentions
   also start or steer a Tony session.
3. Fake tools answer from the world. Tony's own posts and approvals mutate the world (for example a
   gate approval sets the gate `approved`, which arms the publish entry).
4. At the end compare against `expected_end` and the per-action `expected_checks`. Run once with
   checks set to `flag` and once with `hold` (D2) and compare.

## Known gaps

Facts not in the sources are listed per file under `notes` (assumed update-server start versions
for run 4 and v2.18, placeholder pipeline ids, GitHub approval time for v2.18, Playwright outcome
for run 6, exact wording of some owner messages). Real sign-off replies by Harry are not in the
Slack exports for v2.18.
