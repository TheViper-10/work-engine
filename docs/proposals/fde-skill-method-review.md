# FDE skill method, applied to the desktop-release playbook

Read-only review by fde-agent, 2026-10-04. Target: `workflows/desktop-release/playbook.md` (153 lines, "PB").
Path keys: `M=~/.agents/memory/agents/fde-agent`. SDP = `M/playbooks/skill-design-principles.md`;
SDPE = `M/evals/skill-design-principles.md`; APC = `M/playbooks/agent-persona-and-communication.md`;
MEM = `M/MEMORY.md`; PIT = `M/playbooks/tony-coordinator-pitfalls.md`; UOT = `M/playbooks/ui-operator-tony.md`;
MOCK = `M/playbooks/ui-operator-tony-mock.md`; TME = `M/evals/tony-mock-release.md`; ED = `docs/engine-design.md`;
DL = `docs/decision-log.md`; RT = `docs/red-team-1.md`; GOS = devrev-web auto-memory `feedback-goal-oriented-skills.md`.

## 1. The method

1. Five parts, nothing else: goal (one sentence), evidence (truth sources in priority order, re-read every wake), done bar, handoffs (name other skills, do not restate them), guardrail (stated as the behaviour wanted). SDP:16-21; GOS:8.
2. The `Done:` line is mandatory. It names a state that can be checked live, never an activity, and covers every exit: success; blocked or handed to a named person with evidence; still in progress (next wake set, state noted); nothing to do (a one-line note). Each exit is checkable from the system the skill reads, not from the agent's word. SDP:5-12; SDPE:7-9.
3. The agent picks the execution. No numbered command lists, fixed commands, scripts or flags the environment already states. The `fix-lint` rewrite (150 lines down to 6) is the origin: a hard-coded base ref was wrong on main. SDP:16,25; GOS:10; SDPE:10.
4. Body vs reference: the body is about 5-10 lines. Repository procedure lives in the repository behind an index, and the skill points to it. Voice, persona, self-recovery and secrets live in agent `guidance`, because every entry path loads that. Domain facts live in the skill. Mock facts go only in a removable overlay. SDP:25,29,34-35; APC:13-14; SDPE:11.
5. Tool contracts are references, not prose. Do not restate signatures or answer branches the tool definition or its response already carries. Ground the agent in the live contract (APIs are the control plane), and when a tool answers, its words are the next move. AGENT.md:38; MEM:34; ED:36-37,61-62.
6. A rule that has to work even when the model forgets it belongs in the runtime, not the text. A prompt-level duplicate guard did not stop a repeatable operation, and Tony followed script output over guidance. The script or engine must refuse or answer. MEM:187; sessions/2026-09-30-tony-instructions-lessons.md:19.
7. No accretion after failures. Find the cause first (a skill line that asks for it, a platform pull, a missing general rule). Then fix the goal, evidence or `Done:` line in general form. Never add an incident example, a quoted question or a per-scenario rule. SDP:26; APC:15; SDPE:12.
8. Lean, not lossy. Before trimming, list the load-bearing facts every `Done:` clause depends on. Cut a fact only after a rerun shows behaviour holds without it. Calibration: one trim cut "when to create the tracking issue" and "where status comes from", and the score fell from 5/15 to 3/15. SDP:27; SDPE:23,34; APC:16.
9. Write in the words the agent should use with people. Internal terms in a skill leak into replies: plan 23's vocabulary produced "candidate/revision" and "thread is bound". SDP:30; MOCK:67; SDPE:14.
10. Name the single writer when several entry paths can act on one request, and name the live state the others read. Text is not a lock. Never ask for what the platform cannot do. SDP:21,37; `M/playbooks/mock-validation/platform-limits.md:12`.
11. Triggers are fixed in the skill's own name and description, never by "load X first" lines elsewhere. A specific trigger beats guidance order. SDP:41-42; MEM:169,222.
12. Prove it by behaviour. After each change, run a fresh conversation and the real entry paths, and check the `Done:` state on live objects. One change at a time, never stacked. SDP:55-57; APC:51-53.

## 2. The current playbook, range by range

Verdicts: KEEP (goal, evidence, guardrail or flexible guidance), REF (move to a shared engine-contract reference), RUNTIME (bookkeeping the engine should own), REMOVE.

| PB lines | Verdict | Why |
|---|---|---|
| 1-3 | KEEP | Goal, done and "the engine's reply is information" are the right core (ED:8-10). Merge with 151-153. |
| 5-13 | REF | Six call signatures restate ED:39-84 and the tool schemas the harness already passes (`harness/engine-tools.ts`). Method 5. |
| 15 | KEEP, 1 line | Which of his own tools do real work is useful. Drop the tool names (method 3). |
| 17-19 | KEEP (evidence) | "Read the briefing and live sources first, never from memory" is the evidence clause (SDP:18). REF the list of briefing contents (ED:50-52). |
| 21 | KEEP, shorten | Joining the same release and judging which job a thread means is flexible judgment. |
| 23-37 | REMOVE | The "what you see -> what you call" table is call sequencing. Its load-bearing bits (intend before acting, claim before posting, mention reply is relayed) are stated again at 43, 92 and 145. |
| 39-41 | RUNTIME | Work-run binding is engine state. R17 already says "first write call binds it" (DL:90 "Reads never bind"). The R15 "join before acting" rule (DL:74-77) is accretion. Keep one guardrail: when another session is working, answer questions only. |
| 43-44, 47-48 (first sentences) | KEEP (guardrail) | Before a merge, gate approval or publish, state intent; never work past a hold; weigh each flag. |
| 45 | REF + RUNTIME | Action ids belong in the spec (spec.json:65-101) and can be listed in `job_view`. The same-ref retry rule caused RT:35 (H4); the engine now owns retry semantics (DL:91). |
| 47-48 (examples) | REMOVE | Hold reasons and next moves come in the engine's words (ED:61-62). The examples are scenario lists. |
| 50 | REF | Which actions carry no gate is spec data. |
| 52-60 | KEEP (evidence) | The best section: ranked live sources, "QA ready only when the update server serves it", "approved only when the hold reads approved", retry once and then claim nothing. Line 60 is the anti-hallucination bar. |
| 62-73 | Table REF; 64 and 73 KEEP | Responders are already in spec.json:10-27, so the engine should show them on each open ask. Keep: "you judge whether a message is a go"; "your own or another bot's message is never a go"; "a go covers only the build it named". |
| 75-77 | KEEP (voice) | No ids or engine words in Slack (SDP:30). |
| 79-88 | REF, except 83-84 KEEP | Milestone semantics duplicate spec.json:28-63. Keep two load-bearing facts in words: what "QA ready" means, and that the sign-off ask goes once, in the QA thread only (TME:43). |
| 90-101 | RUNTIME | The `say` answer branches are engine protocol and already drift: PB:97 "post it now" contradicts R17 "busy: do not post" (DL:86) and the engine's busy answer "wait until that post is seen" (`src/engine.ts:643`). PB:96 caused the double "live" post (RT:22). 99-101 is R13/R14 accretion. Keep one line: tell every owed thread once, claim before you post. |
| 103-105 | KEEP 1 line + RUNTIME | Keep "promise when asked to tell". The fallback default is engine-side already (ED:73-74, spec defaults). |
| 107-109 | KEEP (guardrail) | Privacy of held evidence. |
| 111-121 | KEEP as flexible path (DL R7) | Strip action ids and claim mechanics. Hand off failure triage to `desktop-playwright-triage` instead of restating it at 117 (method 1). The "claim before the QA ask, even in a mention reply" clause at 117 is RUNTIME/REF (DL R13-R14). |
| 123 | KEEP guardrail; RUNTIME detail | Keep: the owner's cancel stops new work and the asker is told. Unknown-outcome lease handling is engine work (RT:39-40 H5; DL:92). |
| 125 | REMOVE from skill | Self-recovery lives in agent guidance (APC:23-30). The harness must compose guidance plus skill (see limitations). |
| 127-131 | KEEP (evidence) | "Do not assume it worked; read the result" plus the meaning of done/failed/unknown. REF the field shape. |
| 132-135 | RUNTIME | "Every open job needs a wake" is engine-guaranteed (ED:78-79). A session that ends without a checkpoint should become an engine wake, not a rule Tony must remember. |
| 137-139 | REWRITE as `Done:` | It lacks the blocked/handed-off and nothing-to-do exits (SDPE:8). "Do not stop at closing" is RUNTIME: the engine answer already says "still owed" (ED:80-81). |
| 141-145 | Move to agent guidance | Voice, mention relay and the connector-author rule are needed on every entry path (APC:32-45; SDP:34-35). Keep the Slack `ok:false` line in the skill. |
| 147-149 | Move to agent guidance | Secret names vary by acting user (UOT:41; APC item 7 at :47). |
| 151-153 | KEEP | Division of labour plus "check the live source when the engine looks wrong". |

Missing (add in general form):
- A full `Done:` line.
- Who creates and links the release issue. PB never creates one and only completes it at 121/139 (PIT:32 shows two were created).
- A named single writer per release.
- Handoffs to the triage and PR-authoring skills.
- Mock people (spec.json:8, Harry as a bot) kept out of base text (SDP:29).

## 3. Pitfalls a goal-oriented rewrite must keep

- Tell every audience thread once: request thread, QA thread and every promise holder. Run 6 posted twice and missed B (spec.json:62; TME:38 "one it's live post").
- Ask for sign-off once, in the QA thread only, never in the request thread (spec.json:54; TME:33,43).
- A mention session's final message is relayed. Never also post it, and never end on a recap (MEM:233; platform-limits:12; MOCK:70).
- The DevRev author of a Slack DM is the connector account, not the asker. Resolve the sender from Slack before treating a message as a go or naming anyone (PIT:27; APC:37; TME:41 S6).
- A go comes only from a listed responder, about this build. A build change needs a fresh ask (PB:64,73; RT H7; DL:93).
- Copy ids from the source; never invent them. A made-up event id and an empty revision broke C7 (PIT:25).
- One release issue, linked `is_parent_of` from the parent with the token that can write links. A wrong link type or token failed (PIT:32; UOT:46; MOCK:64,72).
- Verify from source: the pipeline matches the merge commit (spec.json:84, `qa_correlation_mismatch`); approval jobs are in the deployment workflow, not `pr_checks` (MEM:214); follow artifact redirects (MEM:93); read the hold before saying "approved" (PB:56-57).
- `unknown` is never `failed` or a retry. A retry needs read-back proof of no effect (`M/playbooks/tony-resilient-mock.md:33`; RT:39-40).
- Never work past a hold. A late session never undoes the owner's cancel (PB:48; DL R12).
- Merge only via the bump PR after the owner's review. Run 6 pushed straight to the base branch (spec.json:74).
- Never repeat held private evidence into another thread (PB:107-109).
- No ids, gate names, tool names or engine words in Slack. At most 4 plain sentences (TME:27-31; APC:44-45).
- Always attempt the Slack post and report the real error code. Inferring "bot not in channel" skipped the post (MEM:222; PB:145).
- Check which `SECRET_*` names exist before calling one missing. Names differ by acting user (UOT:41; MEM:235).
- Ask the owner only for human decisions, never for steps Tony can read or take himself (TME:44 H3).
- No stacked changes. Score the rewrite in the replay harness under the same scenarios before and after, and list load-bearing facts before cutting (SDP:27,57; SDPE:34).

## Limitations

- `harness/model.ts:96-104` uses the playbook as the whole system prompt. Moving voice, self-recovery and secrets to guidance needs the harness to prepend a guidance block, or replay scores will drop for the wrong reason.
- R17 engine fixes are only partly landed (`docs/run-state.md:16`). The RUNTIME verdicts assume the R17 answers ship. Until then, PB:90-101 is the only carrier of those rules.
- Read-only review. No live DevRev objects were read, and no replay was run.
