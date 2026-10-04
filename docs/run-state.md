# Run state: work engine phases 0 to 2

Started 2026-10-04 17:17 IST. Time box: stop building about 20:00 IST, then write report.
Resume: read this file, then docs/decision-log.md, then handoff file 28.

## Slices
| Slice | Goal | Status |
|---|---|---|
| P0-skel | repo skeleton, state file, decision log | done |
| P0-spec | spec.json + docs/record-shapes.md | done |
| P0-scen | scenarios from run 4, run 6, v2.18 (+6 variants) | done |
| P0-play | playbook.md | done |
| P0-review | docs/phase-0-review.md | done |
| P1-core | engine core + memory store + six calls + lint | done: lint ok, 33 unit tests pass |
| P1-sim | simulator: 1,000 random orders + named cases | done: flag 1000 + hold 1000 orders, 16 named cases, 0 violations; 7 engine bugs fixed |
| P1-red | Opus red-team, fix confirmed | running (opus), report docs/red-team-1.md |
| P2-harness | replay harness, real model via gateway | world/driver/model/scorer done (smoke ok on real model); engine binding + trials running (sonnet) |
| P2-runs | replays under flag and hold, scored vs D7 | pending |
| Report | 29-work-engine-run-report.md + /tmp copy | pending |

## Facts
- AI gateway reachable: POST /v1/messages with model anthropic.claude-sonnet-5-5 returns 200 (auth: keychain arcus-token as Bearer + x-api-key). D14 real-model replay feasible.
- Contract for all slices: docs/engine-design.md.

| P0-gapfill | fde-agent read-only: scenario fact gaps into scenarios/gap-fill.md | done (no API calls) |

## Parked
- open_jobs record grows unbounded; cap or bucket in phase 3 (R11).
- Run 6 pipeline id for number 395883 (needs CircleCI token; not needed for replay).
