# Record shapes for the platform (phase 3 field list for fde-agent)

Two custom object types, created empty by the owner, then given these fields by fde-agent after the owner's go. Nothing here touches the platform in phases 0 to 2. Source of truth for kinds and ids: `docs/engine-design.md` (Record kinds). Locked decisions: handoff 28 section 2 (platform facts) and D13.

| Type | leaf_type | Display name | Holds |
|---|---|---|---|
| Work record | `work_record` | WRECORD | kinds job, link, run, ask, operation, promise, delivery, lease, flag, plus index records |
| Work event | `work_event` | WEVENT | kind event only (inbound facts: webhooks, Slack posts, timers, other bots) |

## Why a JSON body plus a few filterable fields
- The engine reads by key or by a batch of keys. It never searches by content, so almost no field needs to be a column.
- Each kind has a different shape (a job has milestones, an ask has responders, a lease has a holder). One JSON `body` holds the kind's own shape, so adding a field to a kind is a code change, not a schema change. Schema changes on a platform type mean fde-agent work and risk, so we avoid them.
- A few plain fields are kept for what the platform or a human needs: filter by kind, filter by job, see state at a glance, and the version counter for safe updates. Keep this list short. Every added filterable field is a cost on each write and a future migration.
- Rule: a value goes in a column only if a person debugging in the DevRev UI needs to filter on it, or the engine's own batch-get needs it. Everything else lives in `body`.

## Type 1: `work_record` (WRECORD)
| Field | Type | Required | Indexed/filterable | Purpose |
|---|---|---|---|---|
| `unique_key` | text | yes | yes (the lookup key) | `work-engine:<env>:<bot>:<kind>:<id>`. Unique across the whole org (handoff 28 section 2), so the prefix is mandatory. Create-if-absent writes rely on the platform rejecting a duplicate. |
| `kind` | enum: `job`, `link`, `run`, `ask`, `operation`, `promise`, `delivery`, `lease`, `flag`, `index` | yes | yes | Which record shape `body` holds. Lets a human filter "all flags". The engine already knows the kind from the key. |
| `job_key` | text | yes for every kind except `lease` and `index` (may be empty there) | yes | The full `unique_key` of the owning job, so a person can see everything for one job. Not used by hot paths. |
| `state` | text, free-form per kind (job: `open`, `queued`, `closing`, `cancel_requested`, `done`, `cancelled`; run: `active`, `idle`, `superseded`; ask: `open`, `answered`, `stale`; operation: `in_flight`, `done`, `failed`, `unknown`; promise: `open`, `fulfilled`, `due`; delivery: `owed`, `claimed`, `sent`) | yes | yes | Headline status for the UI. The engine's source of truth is `body`; `state` is a copy for humans. Kept as text, not an enum, so a new state never needs a schema change. |
| `body` | json | yes | no | The whole record for its kind, as in the engine-design table. Only the engine reads it. |
| `created_at` | timestamp | yes | no | When the record was first written. |
| `updated_at` | timestamp | yes | no | Last write. Used by sweeps and by humans reading the UI. |
| `version` | number (integer) | yes | no | Starts at 1 and increases on every write. The engine sends the expected version on update so a lost race shows up as a mismatch instead of silently overwriting (no transactions on the platform, whole-row updates). |

Index records (kind `index`) carry the lookup value in the key, for example `work-engine:<env>:<bot>:index:thread:<thread>` (job ids linked to a thread), `...:index:due:<time_bucket>` (jobs due in that bucket) and `...:index:open_jobs` only if a bounded list is needed. Their `body` is a list of ids and should stay well under 100 entries; if one would grow, split the key by a bucket.

## Type 2: `work_event` (WEVENT)
Separate type so the high-volume, write-once events do not compete with the hot job records, and so events can be cleaned up on their own schedule.
| Field | Type | Required | Indexed/filterable | Purpose |
|---|---|---|---|---|
| `unique_key` | text | yes | yes | `work-engine:<env>:<bot>:event:<source>:<delivery_id>`. Create-if-absent gives dedupe by source plus delivery id (the `ingest` rule). |
| `kind` | text (fixed value `event`) | yes | yes | Kept so both types share the same field names and tooling. |
| `source` | enum: `github`, `circleci`, `slack`, `timer`, `tony_report`, `other` | yes | yes | Where the event came from. The one extra filterable field, because debugging usually starts with "what did GitHub tell us". |
| `job_key` | text | no (empty if the event matched no job) | yes | Owning job if matched at ingest. Events can match several jobs; the list is in `body.matched_jobs` and this holds the first. |
| `state` | enum: `received`, `matched`, `unmatched`, `processed` | yes | yes | Ingest progress. |
| `body` | json | yes | no | source, event kind, thread?, sender id, sender kind (`human`, `own_bot`, `other_bot`, `system`), ref, attrs, received_at, matched jobs. |
| `created_at` | timestamp | yes | no | Time written. |
| `updated_at` | timestamp | yes | no | Last write (for example when it is matched). |
| `version` | number (integer) | yes | no | Same meaning as above. |

## Reading rule: batch get by key, never list a type
- Single read: `custom-objects.get` with `unique_key`.
- Batch read (up to 100 keys), from handoff 28 section 2:
```js
POST /objects.list
{ dql_query: { filter: { op: 'and', operands: [
    { field: 'custom_object.<object_name>.leaf_type', op: 'in', value: ['work_record'], value_type: 'json' },
    { field: 'custom_object.<object_name>.unique_key', op: 'in', value: [k1, k2], value_type: 'json' } ] },
  limit: 100 } }
```
- The engine never lists a whole type. Platform listing reads every row (50 per page, cap 5,000 rows, facts-brief line 18), which would break as records grow. Anything the engine needs to find ("jobs linked to thread T", "jobs due this bucket") is an index record keyed by the lookup value, read with a single key.
- Writes are create-if-absent by key, or update by key with the `version` check. The platform rejecting a duplicate `unique_key` is the only atomic primitive we rely on.
- Records survive snap-in redeploys (handoff 28 section 2), so no namespace change is needed when the engine code changes.

## Open points for phase 3
- Exact platform field types (text, enum, timestamp, json, number) and whether an enum can gain values later; `state` is text for that reason. fde-agent checks with the devrev-custom-schema skill.
- Whether `version` is enforced by the platform or only by the engine; this design assumes the engine checks it after reading.
- Retention of `work_event` rows is not decided; nothing in phases 0 to 2 needs it.
