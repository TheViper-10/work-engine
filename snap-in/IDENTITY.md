# Identity table (R49)

Rule: scopes are necessary but not sufficient. Private objects (an agent, a DM) are shared with users, not with the service account, so a call that touches one runs as the owner token's user (`owner_identity` keyring, devu/1). The service account is used only for the snap-in's own custom objects and its own install record. The owner token is passed only to the waker and to the directory adapter (`buildRuntime` in `src/index.ts`); the store never receives it.

Identities: `service` = service account token (timer path), `caller` = calling Tony session user token (operation path), `owner` = `owner_identity` keyring user token, `none` = not called on that path.

"Body proven live" (R50) compares the exact request body the adapter sends with a body seen working live (S1, S2, S3, S4c, S5a evidence and the local live probe, `scripts/live-probe.ts`, 2026-10-05). Audit result: all 13 routes yes, plus `chats.get` (R51, offline only). The one body that was wrong (`chats.update` without `type`) is fixed; the fake now rejects it, and also rejects a `chats.create` without `type:"dm"`/`agent_members` and a `workflows.trigger` without `step_reference_key:"start"`.

Proven = seen working live as that identity on that path. "offline" = exercised only against the access-faithful fake (`test/fake-platform.ts`), not yet seen live.

| Route | Timer | Operation | Reason | Proven live | Body proven live |
|---|---|---|---|---|---|
| `custom-objects.create` | service | caller | work_record/work_event rows; leaf scopes granted to both identities | yes, both paths | yes: `{leaf_type, unique_key, title, custom_fields{tnt__*}}` (S1/S3, probe 2026-10-05) |
| `custom-objects.get` | service | caller | same | yes, both paths | yes: `{unique_key}` (S1, probe) |
| `objects.list` | service | caller | same (batch read of row versions) | yes, both paths (list and delete seen live) | yes: `{dql_query{filter{and[leaf_type in, unique_key in]}, limit}}`, limit inside dql_query (S1, S3, probe) |
| `snap-ins.get` | service | caller | read this install's inputs; the install's own record, not a private object. Could not move to owner: the operation path has no keyring | implied: every live tick and operation call reads it | yes: `{id}` (every live tick; not run by the probe, which supplies inputs itself) |
| `ai-agent.sessions.get` | owner | caller | resolve a session to its DM. Operation path keeps the caller token. Timer path uses owner if ever called (the engine resolves sessions only on operation calls today) | operation: yes (session 474 to dm/nHH9Wn2Z); timer: offline | yes: `{id}` (session 474, probe) |
| `ai-agents.get` | owner | none | advisory stale-version read of private ai_agent/2 (shared with devu/1 only). Service account got 403 live even with ai_agent:read. A failure never blocks a wake | owner: offline (devu/1 has access); service: 403 live | yes: `{id}` as owner (probe, 200) |
| `dev-users.self` | owner | none | resolve the owner token's user for the home DM | yes (owner) | yes: `{}` (probe) |
| `chats.create` | owner | none | create the job-home DM for the owner token's user | yes (owner) | yes: `{agent_members[{agent}], users, type:"dm", is_default:false, display_state:"global"}` (S4c, probe) |
| `chats.get` | none | caller | R51: read the custom fields (Slack channel and thread ts) the Slack connector left on a mention DM, to resolve the thread of a mention session. The DM belongs to devu/2 (the connector's act-as user); the owner token (devu/1) got 403 on `chats.get` for those DMs in live run 1, so this runs as the caller token, which is the session's own user. If the platform refuses, `threadOf` returns an error and the engine falls back to `bad_thread` with words on where the thread is (R51) | no (offline only; the coordinator's live probe step `i` checks it) | no: `{id}` (as the connector reads it, `chats.get {id}`) |
| `chats.update` | owner | none | hide the home DM | yes (owner) | yes: `{id, type:"dm", display_state:"hidden"}` only; without `type` 400 invalid_field (S4c, probe) |
| `workflows.trigger` | owner | none | wake workflow/58; its comment step runs as the triggering user | yes (owner) | yes: `{id, step_reference_key:"start", payload{value{dm_id, continuation_note, receipt_key}}}` (probe; S5a used the same workflow) |
| `timeline-entries.list` | owner | none | wake read-back on the home DM; needs DM membership | yes (owner, DMs devu/1 is a member of) | yes: `{object, limit}` (probe) |
| `conversations.replies` (Slack) | none | none | Slack keyring `tony_slack_token`, read only, allowlisted channels; not a DevRev identity | yes | yes: GET `channel, ts, limit` (probe, read only) |
| `github GET` | none | none | keyring `github_read`, one repo, one branch; not a DevRev identity | yes | yes: `commits/<branch>`, `pulls?base&state`, `contents/<path>?ref` (probe) |

Notes
- Timer path = `runTick`; operation path = `runOperation` (`src/index.ts`). On the operation path the owner keyring is not delivered, so an owner call there fails before sending anything.
- The row for `snap-ins.get` is the one non-custom-object call left on the service account. If a live run shows 403, the fallback is the owner token on the timer path only.
- `test/identity.test.ts` fails if an adapter calls a route not in this table, lists a route nothing calls, or runs a route as an identity the table does not allow.
- Live run 1 (2026-10-04): the owner token (devu/1) got 403 on `chats.get` for the connector mention DMs, which belong to devu/2 (the connector's act-as user). So `threadOf` (R51) calls `chats.get` as the caller token, the session's own user, and never with the owner token. Unproven live until the probe step `i` runs.
