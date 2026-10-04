# Work engine contract (shared reference for every workflow playbook)

Status: proposal for owner review. Generic: no workflow names. Loaded once for all workflows, not
restated in each playbook. Tool schemas carry the argument lists; this page carries only meaning.

The engine keeps the record, routes what arrives, sets wakes and recovers. It does not decide steps
or judge your work. Its answers are in words; the words are the next move.

| Call | Use it to | What its answer means to you |
|---|---|---|
| `job_view` | read the briefing for a job or thread | Read-only. Start here. |
| `job_open` | start a job, or link a thread to one | Says whether the job already existed. |
| `intend` | declare a merge, gate approval or publish before you do it | `clear` (maybe with flags to weigh) or `hold` (do not do it; the reason says what to do instead). Same job, action and ref is the same operation. |
| `say` | claim a message before you post it yourself | `go`: post it now. `busy`: someone is posting in that thread; do not post. `already_sent`: it was posted. `already_claimed`: read the thread and post only if absent. |
| `promise_add` | record "tell me when" for a milestone | The engine wakes you at the fallback time if the milestone has not been told. |
| `checkpoint` | commit status, milestones you saw, action outcomes, and when to look again | Outcomes: done (proof read), failed (read that it did not happen), unknown (cannot tell). If anything is still owed, the job stays open and the answer says what. |

What the engine does without being asked: dedupes events, wakes the job when a listed responder
writes, a timer or promise falls due, a lease frees, or an action's result arrives; turns an
in-flight action with no outcome into unknown after a timeout; reconciles posts it missed; keeps a
job open while anything is owed; never starts a second worker for a job.
