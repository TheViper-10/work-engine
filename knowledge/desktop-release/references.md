# Work engine contract (shared reference for every workflow playbook)

guidance: engine contract v2 (job-home)

Generic: no workflow names. Loaded once for all workflows, not restated in each playbook. Tool
schemas carry the argument lists; this page carries only meaning.

The engine keeps the record, routes what arrives, sets wakes and recovers. It does not decide steps
or judge your work. Its answers are in words; the words are the next move.

Milestone ids come from the job briefing (`job_view` lists them); use those exact ids in `checkpoint(reached)`, `say` and `promise_add`.

Each job has one home: an engine-owned DM. Only the session in the home acts. Other conversations
(Slack threads, mention DMs) may read, link, record promises and leave inbox items.

| Call | Use it to | What its answer means to you |
|---|---|---|
| `job_view` | read the briefing: commitments, open asks, actions in flight, who is owed, the inbox | Read-only; reading never consumes inbox items. Start here. |
| `job_open` | start a job, link a thread to one, or replace or queue the home | Says whether the job already existed. Linking a thread never makes it the actor. |
| `intend` | declare a merge, gate approval or publish before you do it | `clear` (maybe with flags to weigh) or `hold` (do not do it; the reason says what to do instead). Same job, action and ref is the same operation. |
| `say` | claim a message before you post it yourself | `go`: post it now. `busy`: someone is posting in that thread; do not post. `already_sent`: it was posted. `already_claimed`: read the thread and post only if absent. Pass the post link to confirm a post the engine has not seen. |
| `promise_add` | record "tell me when" for a milestone | The engine wakes the home at the fallback time if the milestone has not been told. |
| `checkpoint` | commit status, milestones you saw, action outcomes, when to look again, and `processed: [...]` inbox items | Outcomes: done (proof read), failed (read that it did not happen), unknown (cannot tell). If anything is still owed, the job stays open and the answer says what. |

`checkpoint` status is exactly one word: `working`, `waiting`, `blocked`, `done` or `cancelled`; the sentence goes in `waiting_for`. The engine closes a job only on `done` or `cancelled`, and only when nothing is owed.

## Threads
A thread is written `<channel>:<ts>` (for a Slack mention, the comment's `external_ref` without `slack:`). Anything else answers
`bad_thread` and nothing is recorded. In a Slack conversation the engine can also read the thread from the platform when you omit it
or pass something wrong. A `job_open` with a placeholder target (`next`, empty) joins the job already running, or answers `bad_target`
when none runs; another version joins the running job with a flag unless you say `queue` (after it) or `replace` (the owner's call).
`say` with a post link from another thread answers `wrong_thread`: post in the owed thread and send that message's link. `say` for an
outcome milestone answers `not_reached` until `checkpoint(reached)` recorded it after you read the source.

## Special answers
- `route`: you are not in the home. The action was recorded for the job owner, who will do it.
  Nothing was started; tell the person the job owner will follow up.
- `hold: ownership unconfirmed`: the engine could not confirm which session you are. This hold is
  fixed, not a check you can weigh. Nothing was cleared and no lease was taken. The job is woken
  for the home, so resume from the home.
- `superseded`: the job moved to a new home. Stop; change nothing. Your call was only noted.
- Other holds and flags: follow the reason given.

## The inbox and notices
Everything that arrives for the job (messages, approvals, cancels, requests, routed actions)
becomes an inbox item, oldest first in `job_view`. Acknowledge the ones you have handled with
`checkpoint(processed: [...])`; unprocessed items keep showing. A late item on an ended job is
recorded and answered in one line; it never reopens the job. If a thread is linked to several
jobs, the item is marked ambiguous: clarify which job before acting on it.
In the home you may see a notice: "new input: read job_view". Finish the step in hand, then read.

## What the engine does without being asked
Dedupes events; wakes the home when a listed responder writes, a timer or promise falls due, a
lease frees, an action's result arrives or new input is waiting; turns an in-flight action with no
outcome into unknown after a timeout; reconciles posts it missed; keeps a job open while anything
is owed; never runs two owners for one job. After a replacement or resume, the wake lists pending
inbox items and unknown operations: read those back before repeating any effect.
