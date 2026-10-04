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
