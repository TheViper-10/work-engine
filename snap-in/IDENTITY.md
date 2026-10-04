# Identity table (R49)

Rule: scopes are necessary but not sufficient. Private objects (an agent, a DM) are shared with users, not with the service account, so a call that touches one runs as the owner token's user (`owner_identity` keyring, devu/1). The service account is used only for the snap-in's own custom objects and its own install record. The owner token is passed only to the waker and to the directory adapter (`buildRuntime` in `src/index.ts`); the store never receives it.

Identities: `service` = service account token (timer path), `caller` = calling Tony session user token (operation path), `owner` = `owner_identity` keyring user token, `none` = not called on that path.

Proven = seen working live as that identity on that path. "offline" = exercised only against the access-faithful fake (`test/fake-platform.ts`), not yet seen live.

| Route | Timer | Operation | Reason | Proven live |
|---|---|---|---|---|
| `custom-objects.create` | service | caller | work_record/work_event rows; leaf scopes granted to both identities | yes, both paths |
| `custom-objects.get` | service | caller | same | yes, both paths |
| `objects.list` | service | caller | same (batch read of row versions) | yes, both paths (list and delete seen live) |
| `snap-ins.get` | service | caller | read this install's inputs; the install's own record, not a private object. Could not move to owner: the operation path has no keyring | implied: every live tick and operation call reads it |
| `ai-agent.sessions.get` | owner | caller | resolve a session to its DM. Operation path keeps the caller token. Timer path uses owner if ever called (the engine resolves sessions only on operation calls today) | operation: yes (session 474 to dm/nHH9Wn2Z); timer: offline |
| `ai-agents.get` | owner | none | advisory stale-version read of private ai_agent/2 (shared with devu/1 only). Service account got 403 live even with ai_agent:read. A failure never blocks a wake | owner: offline (devu/1 has access); service: 403 live |
| `dev-users.self` | owner | none | resolve the owner token's user for the home DM | yes (owner) |
| `chats.create` | owner | none | create the job-home DM for the owner token's user | yes (owner) |
| `chats.update` | owner | none | hide the home DM | yes (owner) |
| `workflows.trigger` | owner | none | wake workflow/58; its comment step runs as the triggering user | yes (owner) |
| `timeline-entries.list` | owner | none | wake read-back on the home DM; needs DM membership | yes (owner, DMs devu/1 is a member of) |
| `conversations.replies` (Slack) | none | none | Slack keyring `tony_slack_token`, read only, allowlisted channels; not a DevRev identity | yes |
| `github GET` | none | none | keyring `github_read`, one repo, one branch; not a DevRev identity | yes |

Notes
- Timer path = `runTick`; operation path = `runOperation` (`src/index.ts`). On the operation path the owner keyring is not delivered, so an owner call there fails before sending anything.
- The row for `snap-ins.get` is the one non-custom-object call left on the service account. If a live run shows 403, the fallback is the owner token on the timer path only.
- `test/identity.test.ts` fails if an adapter calls a route not in this table, lists a route nothing calls, or runs a route as an identity the table does not allow.
