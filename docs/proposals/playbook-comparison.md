# Playbook: current versus goal-oriented proposal

Status: for owner review. The proposal is `playbook-goal-oriented.md`; it is not published and the
current `workflows/desktop-release/playbook.md` is unchanged. Method: fde-agent's skill design
principles (`~/.agents/memory/agents/fde-agent/playbooks/skill-design-principles.md`), consulted
through the fde-agent; its line-by-line review is `fde-skill-method-review.md`.

The current playbook is not all rigid. Its evidence section (live sources, "QA ready only when the
update server serves it", "say approved only when the hold reads approved", "retry once, then claim
nothing"), its approval judgment lines and its "usual path you may reorder" are already flexible
guidance, and the proposal keeps them nearly word for word. What gets pruned is mechanics and rules
added after individual failures.

## What moved where

| Current playbook (lines) | Proposal | Where it went |
|---|---|---|
| Six call signatures (5-13) | Removed from the playbook | `engine-contract-reference.md`, shared by every workflow; schemas carry arguments |
| "What you see, what you call" table (23-37) | Removed | Command sequencing; its three load-bearing rules stay as boundaries |
| Work run rules and R15 "join first" (39-41) | One temporary line | Runtime (one-DM model); removal condition stated |
| intend before act, hold vs flag (43-48) | Kept as a boundary, examples dropped | Hold reasons come in the engine's words |
| Action id list, lease names (45, 50) | Removed | Spec data |
| Verify before acting (52-60) | Kept | Evidence section |
| Gates table, who may approve (62-73) | Judgment lines kept; table removed | Spec; shown on each open ask in the briefing |
| Milestone list (79-88) | Replaced by outcomes with done clauses | Spec holds ids; two facts kept in words (QA ready meaning, sign-off once in Q) |
| `say` answer branches, R13/R14 (90-101) | One temporary line | Engine answers; reference page |
| Promises (103-105) | Folded into "everyone owed is told once" | Engine wakes at fallback |
| Private links (107-109) | Kept | Boundary |
| Usual path (111-121) | Outcomes map with done clauses and real dependencies | Triage handed to the Playwright triage skill |
| Cancel (123) | Kept, plus "settle uncertain actions, tell requester" | Boundary and end state |
| Self-recovery (125), voice (141-145), credentials (147-149) | Removed from the playbook | Agent guidance (every entry path loads it) |
| After the action (127-135) | Outcome meanings kept; "every job needs a wake" removed | Engine guarantees the wake |
| Done (137-139) | Rewritten as a `Done:` line with all four exits | New: blocked, cancelled, waiting exits |

Added (gaps the method review found): a full `Done:` line; one release issue linked under the
parent; "approve only the pipeline built from the merged bump PR"; "change the base branch only
through the PR" (run 6 pushed directly); handoffs to triage and PR authoring skills.

## Safety or completion requirements at risk from simplification

- Mention reply relayed, never posted again: moved to guidance. Safe only if every entry path
  loads the guidance (true on the platform; the replay harness now adds it with `--reference`).
- Sign-off ask once, in the QA thread only: kept in words. The spec audience also enforces it.
- The connector account is not the asker: moved to guidance; if the guidance is trimmed later,
  approval correctness is at risk.
- `unknown` is never `failed` and never a retry: kept.
- Copy ids exactly from sources: implicit in "a fact you have not read is not a fact"; the fde-agent
  flagged invented ids as a past C7 failure. Watch it in the replay.
- No claim mechanics in Slack words: guidance voice rule.

## A/B on the same model, tools and scenarios

Run: `harness/variants/ab.sh` (engine on `main`, model `anthropic.claude-sonnet-5-5`, flag mode,
5 scenarios x 2 runs per variant). A = current playbook + guidance block. B = proposal adapted to
today's engine (`harness/variants/playbook-B.md`: the one-DM lines replaced by the current rule)
+ engine reference + guidance block. Judged by `harness/outcome.ts`: end state, approval
correctness, recovery, communication; engine calls are information only.


### Results (flag mode, real model, outcome scorecard)

Final B = after three corrections to the proposal, each restoring a fact I had cut or fixing my own
wording, none a scenario rule: (1) the owner's GitHub login (B could not recognise the GitHub
review); (2) "approve only the pipeline built from the merge commit" was too narrow and blocked the
owner's go for a later build; (3) "another bot's message is never a go" contradicted Harry being the
listed responder and a bot account here. B for stale-go and private-evidence is the third rerun
(`harness/out/ab-B3`); the other three scenarios are from the first B run (`harness/out/ab-B`).

| Scenario | A (current) | B (proposal) |
|---|---|---|
| v2-18 | 0/2 (live told 3 times in A) | 1/2 (live told twice in A once) |
| stale-go | 2/2 | 1/2 |
| cancel-mid-publish | 2/2 | 1/2 (see evaluation defect) |
| private-evidence | 2/2 | 1/2 |
| twin-mention | 1/2 (live never reached A) | 2/2 |
| **Total** | **7/10** | **6/10** |
| Engine calls, median (max) | 48 (57) | 31 to 35 (44) |
| Model requests, median (max) | 75 (102) | 50 to 61 (82) |

Approval correctness passed in all 20 runs for both: no approval without a listed go, none on a
stale build's go, none after a cancel. No private evidence leaked in any run.

### Every failure, classified (fix the responsible layer)

| Run | Failure | Class | Layer to fix |
|---|---|---|---|
| A v2-18 x2, B v2-18 x1 | "live" told 2 to 3 times in A | Runtime defect: a mention session acted as a second worker (claimed and posted live), then its relayed reply told live again | One-DM ownership (mention sessions cannot post milestones) plus R17 claim matching. Not a playbook rule |
| A twin-mention x1 | live never reached A | Runtime defect (same competing-session family): a mention session posted milestones out of order and the A delivery was mis-credited (red-team H3) | R17 claim matching; ownership |
| B cancel-mid-publish x1 | "live" posted in Q after the cancel | Evaluation defect: Tony told Harry, truthfully, that alpha already served the version after a late cancel; the scorecard forbids any live post | Scorecard: allow an honest outcome post after a cancel that came too late |
| B stale-go x1 | re-asked the owner without naming the new build; the scripted owner never answered | Evaluation defect (the scripted owner keys on the build named in Tony's text) plus a minor communication miss | Scenario trigger; no rule |
| B private-evidence x1 | asked Harry for sign-off in B, not Q | Genuine judgment failure; the rule is present in both playbooks | None in text; the spec audience for `signoff_requested` could make `say` answer "this milestone goes to the QA thread" (runtime) |

Reading: on outcomes the two are close (7/10 vs 6/10, two runs per scenario is not enough to call
a winner). B uses about a third fewer engine calls and model requests. A's three failures and one
of B's are the competing-worker defect that the one-DM model targets. B's other failures are one
evaluation defect, one mixed evaluation and wording miss, and one judgment miss the text already
covers. Recommendation: adopt B's shape, with the three restored facts, after the one-DM change
lands, and re-run with 3 or more runs per scenario under flag and hold.
