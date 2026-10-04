# Tony skill workflows and Tony v2.39 (prepared offline)

Nothing here calls an API. A live worker generates the files with real ids, then runs the sequence below.
Shape source: v8 workflow 55/39 (`~/.agents/memory/agents/fde-agent/artifacts/rollback-v8-deploy-20261003T190455Z/workflow-39-template.json`,
`workflow_template_v2`), four steps per skill: agent skill trigger, "Platform agent context", operation `work_engine_call`,
`set_ai_agent_skill_output`. Design: `docs/phase3-platform-design.md` sections 2 and 9.

## Values the live worker fills in
| Value | Where it comes from | Used by |
| --- | --- | --- |
| `<snap_in DON>` | the active Work Engine QA install, `don:integration:dvrv-us-1:devo/1lKlCUXYGG:snap_in/<uuid>` | `--install` |
| `<package slug>` | the deployed package's slug (the operation namespace, 3 to 32 chars), NOT the hash | `--slug` |
| six workflow DONs | returned by each `templates.instantiate` (`don:integration:dvrv-us-1:devo/1lKlCUXYGG:workflow/<n>`) | `--workflows` |
| plan DON | returned by `ai-agents-plans.create` (`...:ai_agent_plan/<n>`) | `--plan` |
| plan `skill_artifact` | artifact id if the plan recipe needs one (`org-skill-create-update.md`, prepare, upload, 204) | plan create |
| saved v2.38 file | fresh `ai-agents.versions.get` of `ai_agent/2` default version (or the saved `.../21-work/run-data/live/tony-version-2.38.json`) | `tony-v2.39.mjs` argument 1 |

## Live sequence
0. Rollback copy dir first (`artifacts/rollback-<chunk>-<date>/` with README): `ai-agents.get`, `ai-agents.versions.get {id: default_version_id.id}`, plans 24 and 25 (`ai-agents-plans.get`), workflow 55/56 `get`. No secrets in copies. Keep the saved 2.38 state file: it is what the Rollback section republishes.
1. Generate the templates:
   `node snap-in/platform/gen-skill-workflows.mjs --install <snap_in DON> --slug <package slug> --out <dir>`
   Six files: `skill-job_open.json`, `skill-job_view.json`, `skill-intend.json`, `skill-say.json`, `skill-promise_add.json`, `skill-checkpoint.json`. Each is `{template_version, workflow_template, workflow_template_v2}`.
2. Instantiate x6: `workflows.templates.instantiate {template_version, workflow_template_v2}` (no `workflow` key) per file. Record each new workflow DON.
3. Validate x6: `workflows.components.validate {components:[{type:"workflow", workflow_version_id:"<wf DON>:workflow_version/<n>.1"}]}` must return `valid:true`. A failure on the operation step means the slug or the operation inputs do not match the deployed manifest: stop.
4. Activate x6: `workflows.update-status {id, status:"active"}` (publishes N.1). Read back with `templates.generate` on each new id: 0 hits for any v8 id or slug, 2 hits each (v1 and v2 format) for the new install and slug.
5. Create the plan (if it does not exist yet): generate the text first with step 6's command (any placeholder ids work), then `ai-agents-plans.create {name:"work-engine-desktop-release", description, guidance, skill_artifact}` (org scope: omit `space`; duplicate check with `ai-agents-plans.list`; `plan-work-engine-desktop-release.create-body.json` has name, description and guidance). Record the plan DON. Read back `guidance` equal to `plan-work-engine-desktop-release.md`.
6. Build the Tony body:
   `node snap-in/platform/tony-v2.39.mjs <saved-2.38.json> --workflows job_open=<DON>,job_view=<DON>,intend=<DON>,say=<DON>,promise_add=<DON>,checkpoint=<DON> --plan <plan DON> --out <dir>`
   Outputs `tony-versions-create-body-v2.39.json`, `plan-work-engine-desktop-release.md`, `plan-work-engine-desktop-release.create-body.json`. Without `--plan` the plan trigger keeps the placeholder `__WORK_ENGINE_PLAN_ID__`, which the API will reject: always pass `--plan` for the real body.
7. Publish Tony: no run in flight, `scheduled_task/9` stays paused. `ai-agents.versions.create <body>` (no `scopes` field; the server recomputes them), then `ai-agents.versions.update-state {id, state:"published"}`.
8. Read back: default version is 2.39, 14 skills (11 - 2 workflows - 2 plans + 6 workflows + 1 plan), guidance and goal equal 2.38, scopes a superset of 2.38 and including `ai_agent_session:read`. Start the next Slack run in a NEW thread.

## Rollback
Republish the saved 2.38 body: build it from the saved `tony-version-2.38.json` exactly as in the recipe (`agent, goal, guidance, ai_agent_config, skills` flattened to `key, name, description, act_as_user, trigger`, plus `enable_code_execution, disable_default_guardrails, notes, knowledge`; no `scopes`), `ai-agents.versions.create`, then `versions.update-state published`. The v8e body of the same shape is `artifacts/rollback-v8e-20261004T024043Z/tony-versions-create-body-v8e.json` (identical kept skills). Published versions stay in history, so rollback is a new version. The new plan and the six workflows can stay unattached.

## What to check live (unproven offline)
- The v1 `workflow_template` string is derived here from the v2 object with the v8 differences (numeric value types 1/3/5/6, `serialization_version` "1.0.0", `tier` 1). If `instantiate` rejects it, send `workflow_template_v2` alone or re-generate v1 from a live `templates.generate` of a validated clone.
- Array trigger fields (`operations`, `reached`, `processed`) use `field_type: array, base_type: text` as the manifest does. Confirm the skill trigger accepts them (none of the saved v8 templates had an array field). The operation also accepts a JSON string or comma list for arrays as a fallback.
- The `status` trigger field is an enum of the five checkpoint words while the operation input is text.
- The plan text is about 12 KB. No plan size limit is documented in the playbooks; plan 24 was 6.8 KB. If `plans.create` rejects the size, split off `lessons`-style detail, not the contract.
- Plan skill `description` in the body must match the plan's `description` (`PLAN_DESCRIPTION` in `tony-v2.39.mjs`); pass the same text to `plans.create`.
- Skill keys are `work-engine-<call>-v1` and `work-engine-desktop-release-v1` (v8 used readable keys for workflow skills and plan UUIDs for plans; the server may assign its own key for plans).
