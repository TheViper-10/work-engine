# Run state: work engine phases 0 to 2

Started 2026-10-04 17:17 IST. Time box: stop building about 20:00 IST, then write report.
Resume: read this file, then docs/decision-log.md, then handoff file 28.

## Slices
| Slice | Goal | Status |
|---|---|---|
| P0-skel | repo skeleton, state file, decision log | done |
| P0-spec | spec.json + docs/record-shapes.md | pending |
| P0-scen | scenarios from run 4, run 6, v2.18 | pending |
| P0-play | playbook.md | pending |
| P0-review | docs/phase-0-review.md | pending |
| P1-core | engine core + memory store + six calls + lint | pending |
| P1-sim | simulator: 1,000 random orders + named cases | pending |
| P1-red | Opus red-team, fix confirmed | pending |
| P2-harness | replay harness, real model via gateway | pending |
| P2-runs | replays under flag and hold, scored vs D7 | pending |
| Report | 29-work-engine-run-report.md + /tmp copy | pending |

## Facts
- AI gateway reachable (GET /v1/models 200 with keychain arcus-token). D14 real-model replay feasible.

## Parked
(none yet)
