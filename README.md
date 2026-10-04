# work engine

Tony v3 work engine. Holds job state, records what Tony commits, bridges events to jobs,
guarantees a next action, and wakes Tony when a job is unblocked. It never decides steps.

Design source: `~/.agents/memory/agents/fde-agent/artifacts/tony-shared-state/28-handoff-work-engine-build.md`
(binding), then file 27, then file 25.

Layout:
- `src/` generic engine core (no workflow names; enforced by `npm run lint:generic`)
- `workflows/<name>/` spec data and playbook text per workflow
- `scenarios/` replay inputs
- `sim/` simulator (random orders and named cases)
- `harness/` phase 2 replay harness
- `docs/` run state, decision log, reviews

Status: offline build, phases 0 to 2. No platform calls.
