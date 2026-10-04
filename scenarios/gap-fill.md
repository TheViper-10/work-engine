# Gap fill for replay scenarios (run4, run6, v2-18)

Read-only fact check, 2026-10-04. Scenario JSONs are not edited. Paths are relative to:

- `S` = `~/.agents/memory/agents/fde-agent/artifacts/tony-shared-state/`
- `R` = `~/.agents/memory/agents/fde-agent/artifacts/tony-mock/runs/` (per-run collector output; this is where most of the missing facts were)

Times are UTC. Slack ts values were converted with `datetime.fromtimestamp(ts, UTC)`.

## 1. Run 4 (5.2.9): update-server versions at start, and the version being released

- Released version: **5.2.9**. Sources: `R/v8c4-20261003T234719Z/run.json` (`version` 5.2.9, bump PR 58041, merge sha 266c8232, pipeline id cb983b39-4556-4804-aef0-f3b61f964974, workflow 198c0536); TMX C-TMX-947/949 (`candidate` 5.2.9, namespace 6dce4201).
- At the start (kickoff 2026-10-03T23:47:29Z): **qa/latest 5.2.8, prod/alpha 5.2.7**. Sources:
  - `S/21-work/run-data/live/gh-state.json:29-38` (mock update-server history): 5.2.8 published to qa/latest at 2026-10-03T20:52:23Z; 5.2.7 published to prod/alpha at 2026-10-03T19:53:34Z; the next entry is 5.2.9 to qa/latest at 2026-10-04T01:02:54Z, which is during run 4. The same sequence is in `R/v8e6-20261004T025721Z/github/state-commits.json` (commits 3d81d4e0 "mock publish 5.2.8 to qa" 20:52:24Z, 8284883d "mock publish 5.2.7 to alpha" 19:54:27Z, 0b05c9cc "mock publish 5.2.9 to qa" 01:02:55Z).
  - Corroborated in run 4 itself: heartbeat at 2026-10-04T00:00Z says "prod/alpha is still at 5.2.7" (`S/21-work/run-data/run4/hb-dm-comments.json:190`), and the heartbeat at 00:20Z says Harry's QA post 1791060764.934469 "is for 5.2.8" (`hb-dm-comments.json:158`).
- Scenario impact: `run4.json` assumes qa 5.2.7 / alpha 5.2.7 (`run4.json:658`). The verified start state is **qa 5.2.8, alpha 5.2.7**.

## 2. Run 6 (5.2.10): CircleCI pipeline, and the Playwright outcome per suite

- Pipeline: the deployed (graded) pipeline is **number 395883**, workflow **0a282645**. It was built after Tony's direct push 89b0db53b0 to the base branch. The merge-sha pipeline (PR 58042, merge 840f0720) failed its build. Sources: `R/v8e6-20261004T025721Z/grade.md:39`; `R/v8e6-20261004T025721Z/run.json` `notes[1..4]`.
- Pipeline UUIDs on record (which one maps to 395883 is not verified):
  - `ccdac04a-6eab-49ba-af01-1e6ccd52c643` with workflow `84717941-30a5-43c5-8a05-ff6a40353db9`. Sources: `run.json` `pipeline_id` / `workflow_id`, "pinned ... to deployed pipeline 395883" per its notes. The same id is in the Coordinator job evidence and in the merge / verify_qa operation facts (TMX C-TMX-1384, C-TMX-1455, C-TMX-1492).
  - `7f8ba0d8-f1e3-45fe-916f-75747236a7e2`. This is what Tony reported for verify_qa at 03:59:00Z; it was rejected with `qa_correlation_mismatch` (TMX C-TMX-1493).
  - Note: `run.json` pins workflow 84717941, while `deployment-jobs.json` was "hand-refreshed from deployed workflow 0a282645". The run files contradict each other on the workflow id. A CircleCI read could settle the mapping, but no CircleCI token is configured (see the API call log).
- Playwright per suite. Source: `R/v8e6-20261004T025721Z/circleci/deployment-jobs.json`, deployed workflow 0a282645.
  - computer: job **9782735** `desktop-pw-e2e-tests-qa-computer`, **success**, 03:36:25Z to 03:39:06Z.
  - agent-studio: job **9782738** `desktop-pw-e2e-tests-qa-agent-studio`, **failed**, 03:36:24Z to 03:39:38Z. This is the known flake; Tony called it pre-existing in Slack ts 1791085430.915859 and 1791085959.933619.
  - Other job times in the same file:
    - build 9782731: 03:32:30Z to 03:34:39Z, success.
    - publish-dev: done 03:36:22Z.
    - approve-desktop-qa-latest: approved 03:53:45Z by TheViper-10.
    - publish-qa 9782737: done 03:55:29Z.
    - approve-desktop-prod-alpha: approved 04:20:11Z.
    - publish-prod-alpha 9782733: done 04:21:57Z.
- Scenario impact: the assumed known-flake outcome (`run6.json:352,599`) is confirmed. Placeholder `p6` becomes 395883, but the UUID mapping is still open.

## 3. v2.18 (5.2.6): update-server before the release, PR approval time, build and Playwright finish times

- Update server before the release (request 02:16:22Z): **qa/latest 5.2.5, prod/alpha 5.2.5**. Source: `S/21-work/run-data/live/gh-state.json:54-63`: 5.2.5 to prod/alpha at 2026-10-02T00:33:29Z, 5.2.5 to qa/latest at 2026-10-01T23:33:59Z; the next entries are 5.2.6 (qa 03:42:57Z, alpha 04:19:40Z). The bump PR said "5.2.5 → 5.2.6" (`S/evidence/slack-threads/1790907382.580039.md:20`). The scenario's assumption (`v2-18.json` `initial_world.update_server`) is confirmed.
- Bump PR 57998:
  - Created: 02:22:50Z.
  - **Approved: 2026-10-02T02:23:57Z** by TheViper-10.
  - Merged: 03:06:10Z by nrashmi06 (Tony's GitHub login).
  - Merge sha: 89dfbaa892926ab941c4202f76b6d09278a292f3 (replaces `"merge_sha": "unknown"` at `v2-18.json:104`).
  - Sources: `R/v218-20261002T021617Z/github/reviews.json`, `github/pr.json`. The run notes give approval as 02:23:58Z (`R/v218-20261002T021617Z/run.json` notes[0]).
- Pipeline: number **395563**, id 69bec5be-4d61-4c62-a60a-96ec2cae9cef, workflow 2edf1c28-1d13-4278-b131-0bb78015c101. Source: `R/v218-20261002T021617Z/run.json` (`pipeline_id`, `workflow_id`, notes[3]).
- Job times. Source: `R/v218-20261002T021617Z/circleci/deployment-jobs.json`.
  - build 9769001 `build-product-desktop-app`: 03:06:16Z to **03:08:29Z**, success.
  - publish-dev 9769004: done 03:10:13Z.
  - Playwright computer 9769005: 03:10:16Z to **03:13:04Z**, **success**.
  - Playwright agent-studio 9769006: 03:10:16Z to **03:13:43Z**, **failed**.
  - approve-desktop-qa-latest 9769007: approved **03:38:24Z** (approver fb59b594 = nrashmi06, Tony's session).
  - publish-qa 9769008: done 03:40:09Z.
  - approve-desktop-prod-alpha 9769002: approved 04:17:41Z.
  - publish-prod-alpha 9769003: done 04:19:31Z.

## 4. v2.18: Harry's replies in the QA thread

- QA root: 1790912579.524889 (**03:42:59Z**), Harry's bot (U0C4YRX93PS), "New version released in QA :rocket: (desktop 5.2.6, mock)".
- The two replies behind `reply_count=2` are **one from Tony and one from Harry**, not two from Harry. Source: `R/v218-20261002T021617Z/slack.json` (thread_ts 1790912579.524889) and `watch2.log:46-47`.
  1. Tony, ts 1790912765.689239 (**03:46:05Z**): "<@Harry> QA is out for 5.2.6. Good to go for prod alpha?"
  2. Harry, ts 1790914582.844729 (**04:16:22Z**): "signing off for Sentinel tests for 5.2.6". It came 3 s before the owner's "yes please go ahead with the alpha" (04:16:25Z, thread A). The alpha gate was approved at 04:17:41Z, 79 s later.
- Harry has no other message in the export. The thread-A message "Harry, do you think 5.2.6 is in good enough shape..." (03:46:17Z) is from the owner (`S/evidence/slack-threads/1790907382.580039.md:146`).
- DevRev timelines were not needed; the Slack collector export already has the reply. The stored DM timelines (`S/evidence/live-reads/tl_*.json`, `tli52/53`) are all dated 2026-10-03 and do not cover v2.18.
- Correction: ISS-41's closing comment says "Sentinel signed: Harry 03:47:00Z", which is wrong. The real sign-off was 04:16:22Z (`run.json` notes, "Live" entry).
- Scenario impact: the real sign-off can be scripted as a `bot_post` in thread Q at t≈120.0 (04:16:22Z), overlapping the owner's stand-in go at 04:16:25Z.

## 5. Run 6: side thread B "tell me when QA is ready", and whether Tony ever posted "live" or "QA ready" there

- B root: ts **1791083172.538979** (**2026-10-04T03:06:12Z**), owner U042GEDM4BB. Exact text: "<@U0C4FFYJGE6> quick one from me, which version is this release and what's the ETA for it hitting alpha? and tell me when QA is ready". Source: `R/v8e6-20261004T025721Z/slack.json` message index 3.
- B's only reply: ts 1791083228.977649 (03:07:08Z), "Something went wrong invoking the Tony. Please try again." (connector error).
- **Tony never posted "QA ready" or "live" in B.** No other message has thread_ts 1791083172.538979 in the export, which runs until 1791088934 (~04:42Z) and covers the release end.
  - "Live" went only to Q, ts 1791088405.724459 (04:33:25Z), and to A, ts 1791088419.207489 (04:33:39Z). Both read "5.2.10 is live on prod alpha. The release is complete."
  - "QA ready" was never posted to B. QA status went to Q in the sign-off ask, 1791087111.356369, "5.2.10 is verified on QA..."
  - Source: same `slack.json`, messages 5, 16, 17.

## API calls made

- None reached a server. A read-only CircleCI v2 `GET /pipeline/{id}` and `GET /pipeline/{id}/workflow` for ccdac04a and 7f8ba0d8 was attempted, but `~/.zshrc` has no CircleCI token variable, so no request was sent. No DevRev, Slack or GitHub API calls were made; all answers come from local files.
