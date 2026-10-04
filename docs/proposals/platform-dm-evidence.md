# Platform DM evidence: what Agent Studio does with a message posted into an agent DM

Written 2026-10-04 for the "one engine-owned DM per job" proposal. Read-only; nothing was posted or changed.
`S` = `~/.agents/memory/agents/fde-agent/artifacts/tony-shared-state`, `R4` = `S/21-work/run-data/run4`, `FM` = `fde-agent/MEMORY.md`.
Status labels: **DOCUMENTED** (the owner or platform docs/source say so), **OBSERVED** (stored or live-read data), **ASSUMED** (inferred, not seen), **UNKNOWN**.

## State x question

| # | State, question | Answer | Status | Evidence | Cheapest phase-3 proof |
|---|---|---|---|---|---|
| a1 | Active turn: is the message steered into the same session, or does it start a new one? | Owner: it steers the same session and gets one reply. No stored case of a post landing mid-tool-call. | DOCUMENTED (owner); not OBSERVED | `S/28-handoff-work-engine-build.md:52`; every stored timeline is one prompt plus one reply (`R4/hb-dm-comments.json`, `S/evidence/live-reads/tl_*.json`) | P1 |
| a2 | Active turn: is the input queued, dropped or merged? | Connector source says each agent-executable comment wakes the agent, and the owner says there is one reply. In run 4, thread A got A2 (01:26:56) and the cancel 104 s later; one session id followed, and A2 got no reply of its own until 01:35:22. | UNKNOWN (merge is suggested, not proven) | `slack-agent-connector/code/src/agent/invoke.ts:403-404`; `S/21-work/C-run4.md:99-104` | P1 |
| a3 | Active turn: can two sessions run in one DM? | Never seen: 340 sessions, 340 distinct parent DMs, one session each (only devu/1 sessions are readable). | OBSERVED (no twins); a mid-turn twin is UNKNOWN | `R4/sessions-raw.json` (parent and session_object are unique per row) | P1 |
| b1 | Waiting: same session or new? | Same session resumes. Mention session 463 made skill calls at 02:59:55 and 03:00:47, then again at 03:46:36 under the same id. Session 436 resumed after idle gaps of 2086 s and 2255 s. Continuation `ai_agent_session/1100` was unchanged after the workflow-12 comment. | OBSERVED | live read of workflow 55 trigger metadata (calls below); `R4/tmx-all.json` command rows `auth.session_id`; `fde-agent/playbooks/github-continuation-2026-09-15.md:29`; `agent-skill-conversation-e2e.md:94` | none needed |
| b2 | Waiting: latency to resume | 436's first skill call came 49 s after the A nudge, including up to 60 s of connector poll. A GitHub-wake DM got a reply about 3 min after the entry. | OBSERVED | `S/21-work/C-run4.md:81`; `FM` (Harry wake proof) | P1 measures a direct post |
| b3 | Waiting: what does the resumed turn run with? | The **session's original agent version** and **secrets baked at session start**: session 1100 stayed on 2.51 while the default was 2.54; a keyring refresh does not reach a running session. | OBSERVED | `github-continuation-2026-09-15.md:29,33`; `validate-agent-continuation/references/invariants.md:9`; `FM:82` | P3 |
| c1 | Ended long ago: same session or new? | Longest resume seen is 46 min (463) and 37 min (436). Nothing is stored beyond that. The connector's 24 h thread watch is a connector rule, not a platform one. | UNKNOWN past 46 min; ASSUMED to resume (owner's "one DM is one session") | `slack-agent-connector/code/src/poller/poll.ts:8` | P3 |
| c2 | Is there a session timeout or expiry? | The session object has no expiry field (only `execution_state` running/completed). Longest observed spans: 1h47m (436) and 2h18m (Harry session 55, object_version 338). | UNKNOWN (no documented limit) | `R4/sessions-raw.json` field set | P3 |
| d1 | Crash or timeout mid-tool-call: what does the platform record? | 21 of 340 sessions stay `running` forever: object_version 3, last modified 4.5 to 7.5 min after creation (for example `/75` on 10-01, `/456` on 10-04). So `running` is not a liveness signal. Related failure: "unable to process" with no trace when start is 116 to 256 s late. | OBSERVED | `R4/sessions-raw.json`; `fde-agent/playbooks/ui-operator-tony.md:53` | none for the fact |
| d2 | Crash: does the next post resume the stuck session, start a new one, or do nothing? | No stored case. | UNKNOWN | none | P4 |
| d3 | Crash: what happens to the in-flight skill call? | The workflow run finishes on its own; v8 results were written after the asking session had stopped polling. The engine must treat the result as `unknown` (D5). | OBSERVED (v8) | `S/21-work/C-run4.md:75` (processed 14 s after Tony gave up) | none |
| x1 | Fresh DM start latency | Scheduled run: session created with the run (median -0.4 s, n=60); first skill call 18 to 57 s later (n=15); reply 81 to 1440 s. API-posted DM: reply in 25 to 100 s. Slack mention: first skill call 1m20s to 2m48s after the message. The "100 to 390 s" in files 24-26 has no source. | OBSERVED | `R4/hb-runs.json` x `sessions-raw.json` x `tmx-all.json`; `R4/hb-dm-comments.json`; `agent-skill-conversation-e2e.md:96`; `C-run4.md:45-73` | P1 |
| x2 | Does a DM post by the snap-in's service account trigger the agent? | Every triggering post seen was authored by a dev user: devu/1 heartbeat, the connector's act-as devu/2 (it mints a user token instead of posting as itself), and workflow 12 as `execute_as_user`. A run starts only with `agent_execution_options` on the internal endpoint. Keyrings resolve per acting user, so a service-account-authored wake would probably reach Tony with **no SECRET_* credentials**. | UNKNOWN (trigger); ASSUMED (no credentials) | `invoke.ts:286-287,405-419`; `FM:20-21`; `FM` credential rule; `S/04-session-log.md:147` | P5 |
| x3 | Are skill calls from one session serialised or concurrent? | No overlap seen: the smallest gap between consecutive v8 calls in one session is 11.3 s over 207 rows, but v8's 15 s polling forced that. Traces show the model issuing parallel tool calls in one turn (2x Bash, 2-3x FetchObjectContext in the same second). Across sessions, calls interleave (heartbeat 444 alongside mention sessions 441 and 445). | ASSUMED concurrent within a session; OBSERVED concurrent across sessions | `R4/tmx-all.json`; `S/evidence/live-reads/trace_13RDCYLyc.txt`, `trace_1Ga6yRVko.txt`; `C-run4.md:74` | P6 |

## Session identity (asked twice; high priority)

| # | Question | Answer | Status | Evidence | Proof |
|---|---|---|---|---|---|
| i1 | Is `agent_session_id` stable across messages in one DM? | Yes, across waits of up to 46 min (b1). Every DM seen has exactly one session. `session_object` = `<dm>\|<acting user>`, `parent` = the DM. | OBSERVED | b1; `R4/sessions-raw.json` | P3 for longer gaps |
| i2 | Does skill-call metadata carry the DM? | **No.** Trigger output is `agent_metadata {agent_session_id, skill_call_id, skill_name}`, `execution_context {user_id}` and `_metadata.user`. The schema declares an optional `execution_context.parent_id` (types dm, conversation, ...), but it was absent in all 15 distinct sampled runs: devu/1 scheduled sessions 466-473 and mention session 463 (devu/2). | OBSERVED | `S/21-work/run-data/live/workflow-55-steps.json:2366-2421`; live step-run metadata (calls below) | P7 (is it absent for a plain DM too?) |
| i3 | Can the engine tell "job DM session" from "Slack-mention session" from metadata alone? | Only by acting user: devu/2 is the connector's act-as user. Job-DM wakes, heartbeats and owner chats would all be devu/1, so the user is not enough. | OBSERVED | i2; `S/21-work/B-live.md:51` | none |
| i4 | Can the engine map `agent_session_id` to its DM read-only? | Yes: `POST /internal/ai-agent.sessions.get {id}` returns `agent_session.parent` (the DM) and `session_object`. The v8 dispatcher did this with the snap-in service-account token and got mention-session DMs (binding rows 941, 998, 1001, 1098 hold the connector DMs). The devu/1 org token gets 403 on devu/2 sessions. The workflow needs scope `ai_agent_session:read`. | OBSERVED | `tony-coordinator-deploy/v8b-deploy/x/dist/native.js:259-271,683`; `R4/tmx-all.json` slack_binding rows; `S/04-session-log.md:145`; `B-live.md:57` | none; cache per session (ASSUMED immutable) |

## What this means for the proposal

- **Holds:** wake-by-post into an idle job DM resumes the same session, so `agent_session_id` works as the work-run key (D1) while the job stays in one DM.
- **Risk 1, version and secrets pinning (b3):** a job that spans a Tony publish or a keyring change keeps running the old agent version and old credentials in its DM. The engine needs a "new run in a new DM" path: rotate the job DM on publish, or when a wake meets a stale version.
- **Risk 2, stuck `running` (d1):** never use `execution_state` to decide "active, so steer" versus "idle, so start". Base it on the engine's own last-call time, with the D5 timeout.
- **Risk 3, wake author (x2):** post wakes as the owner user (workflow `execute_as_user`, like workflow 12), not as the engine service account, or Tony may start without credentials.
- **Identity (i2-i4):** look up `ai-agent.sessions.get` once per new session id (service-account token) and compare `parent` with the job DM. Do not rely on `parent_id` in metadata.
- **Concurrency (x3):** do not assume serialised skill calls within a session. Keep create-if-absent unique keys plus `supports_synchronization` (already in file 28 §2).
- **Connector caution:** run 4 produced 4 connector DMs (bindings) for 3 threads; the C ping got DM `hfG3rVp`, not C's `hEdkpGR8`. Whether the ping was top-level is UNVERIFIED. Do not assume one DM per thread on the connector side.

## Cheapest phase-3 proofs (QA, fresh hidden DM with Tony svcacc/29 plus devu/1, non-posting prompts)

- **P1 (a1-a3, x1):** in a new DM, turn 1 says "run `sleep 120`, then reply X1; no other tools". At +30 s, post turn 2: "also say X2". Read `ai-agent.sessions.list` (count for that DM's parent) and the timeline. Pass: one session id, and the reply count and X2 handling are recorded. Costs 2 posts.
- **P3 (b3, c1, c2, i1):** post "reply ok, no tools" into a devu/1 test DM idle for at least 24 h. Check the session id, and the agent version in the trace (`dvrv.agent_version_id`), against the default.
- **P4 (d2):** post "reply ok, no tools" into the DM of stuck session `/456`. Record: same session, new session, or no run.
- **P5 (x2):** clone the QA mock continuation workflow (`tony-qa-mock-continuation.md`) without `execute_as_user` and trigger it once into a fresh DM. Record: run starts or not, `session_object` user, and the `SECRET_*` names (`env` from the trace).
- **P6 (x3):** in a fresh DM, ask Tony to call the read-only `tony_mock_command_result` twice in parallel with bogus receipts. Compare the two workflow 56 run start and end times.
- **P7 (i2):** in P1's DM, one skill call, then read its trigger step-run metadata. Check whether `execution_context.parent_id` appears for a non-scheduled DM session.

## Read-only API calls made (QA `api.qa.devrev-eng.ai`, devu/1 org token; no writes)

- `POST /internal/workflow-runs.list` (workflow 55; 6 calls over 3 pages), `POST /internal/workflow-runs.get` (1)
- `POST /internal/workflow-step-runs.list` (2 rejected 400 with `workflow_run`/`run`, then 16 with `workflow_run_id`), `POST /internal/workflow-step-runs.metadata` (16)
- 41 calls, all reads. Only ids and key names were kept. Temporary files in `/tmp` were deleted.
