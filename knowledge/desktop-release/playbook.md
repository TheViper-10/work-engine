# Desktop release playbook

guidance: desktop-release playbook v1 (job-home)

Engine calls and answers: `references.md`. Voice, credentials and self-recovery: agent guidance.
Past reviewed lessons: `lessons.md`.

## Goal
Take the requested desktop version from the version bump PR to served on prod alpha, with every
person who is owed an update told once, or stop at a named person or the owner's cancel with the
evidence of where it stands.

## Which version
If the request names no version, read the open release issue under the parent issue and use its version. Ask the requester only if there is none.

## Reading a Slack request
A Slack mention reaches you as a DevRev conversation comment: `Request:` and the text (names shown as @name), sometimes followed by
read-only `Thread history`. The Slack thread is the comment's `external_ref` (`slack:<channel>:<ts>`); use it without the `slack:`
prefix as the `thread` of every engine call. Never pass the DevRev conversation id as a thread. The comment is written by the
connector's DevRev user, so its author is not the person who asked. Take the requester's identity only from evidence of who wrote the
Slack message: the `asked_by` line the engine shows in `job_view`, or the author of the message in the Slack thread you read. Never
take it from the DevRev comment author, from a name you guess, or from a name in the text. If you cannot tell who asked, do not
address anyone by name. Open a job with
the exact version (`5.2.11`), never `next` or a guess; the engine refuses anything else and joins the release already running.

## Where you speak
Every message belongs to a conversation. Reply in the thread where the person asked or is waiting; the requester's thread is the
job's main conversation. The only reason to speak in another thread is one the workflow defines for an audience (for example the
thread where a sign-off is asked). A new top-level message is never the default. An answer about status goes back where the question
was asked. Someone who asked to be told something is told in the thread where they asked. A thread you did not get from the request,
the briefing or a read of the channel is not a thread: never make one up or work one out. Use the post target the engine returns
(the exact channel and thread) for the post itself. You are finished with communication when every update that is owed sits in the
thread its audience reads, once, and nowhere else.

## Where you act
You act only from the job's home DM. In a Slack conversation, answer from the briefing and live
reads; record promises; anything needing action is routed to the home automatically, so tell the
person the job owner will follow up. In the home, read unprocessed inbox items first and
acknowledge them with `checkpoint(processed)`. A conversation that is not the home never creates a PR, issue or approval, and
never merges or publishes: it answers, links its thread, records promises, and tells the person the job owner will follow up.
After a replacement or a resume, read back unknown
operations before repeating any effect.

## Evidence (re-read every time you work on the job, in this order)
1. The job briefing (`job_view`): what was committed, what arrived (the inbox), open asks, actions
   in flight or unknown, who is owed what.
2. Live systems, which win over the briefing: GitHub (the bump PR, its reviews and merge commit),
   CircleCI (the pipeline built from that merge commit, its jobs and approval holds, in CircleCI's
   own state words), the update server (what QA and prod alpha serve), the Slack threads.
3. If a read fails, retry once, then say what you could not check and claim nothing about it.
A fact you have not read in this session is not a fact.

## Voice
Write to people in plain words: what happened, what you need, what comes next. Everything a person reads in Slack is written for that
person, not for the system behind you: no tool, engine or process vocabulary (how you keep track of the work, what you were shown, the
names of your calls or states), no markdown bold or checkmark symbols, and no tracker issue ids unless the person asked for one.
Name a person only when the evidence shows who they are (see "Reading a Slack request"); otherwise do not name anyone.

## Approvals and boundaries
- A go counts only from the gate's listed person or a named stand-in (the briefing shows them on
  each open ask), about the build it names. You judge whether a message means go. Your own message
  is never a go, and neither is a message from anyone not listed for that gate. A listed responder
  may be a bot account (Harry is one). If the build changed after a go, the go does not cover the
  new build: ask again for the new one.
- Approve or publish only a pipeline on the release base branch whose build is the one the go
  named: the pipeline built from the merge commit, or from a later commit the owner's go covers.
  Change the base branch only through a reviewed PR; never push to it yourself.
- People: the owner is Priyadharshan (Slack <@U042GEDM4BB>, GitHub login TheViper-10; a GitHub
  approval by TheViper-10 is the owner's review). Harry (Slack <@U0C4YRX93PS>) signs off for prod
  alpha; the owner is his stand-in.
- Declare intent before every merge, gate approval or publish. The reason for a consequential action is the event that authorized
  it: pass the id of the go event (or its #n) from the briefing as `because`, never a sentence. Without a listed go there is nothing
  to pass: wait for it. The engine ties the approval to that event and marks the ask answered. A hold means do not do it; follow
  the reason it gives. A flag is information: weigh it, and tell a human in plain words when it
  matters to them (the build changed since the go, a stand-in approved).
- The owner may cancel at any time; listed stand-ins may too. After a cancel, start nothing new;
  settle anything uncertain from the live source and tell the requester the honest outcome.
  Tell that outcome once per thread owed, and claim it as `cancel_notice`, never as `live`, also
  when the cancel came too late and the publish had already finished (say so plainly). `live` is
  only for a release nobody cancelled. Claim and post it before the final `checkpoint(cancelled)`:
  once the job is cancelled the engine takes no new claims.
- Evidence from a private thread stays there. Tell other threads only milestones, from public
  facts. The sign-off ask goes only in the QA thread, never in the request thread or any other.

## Outcomes to reach (a map, not an order; genuine dependencies are noted)
Milestone ids are exact: use only these in `checkpoint(reached)`, `say` and `promise_add`. The engine
records nothing for any other name.
- Bump PR open for the version, and one release issue for it, linked under the parent.
  Milestone `bump_pr_open`. Done: PR open, issue linked, the requester knows where it is.
- PR reviewed by the owner (a GitHub approval counts) and merged. Depends on the review.
  Milestones `pr_approved`, then `merged`. Done: merge commit known; the pipeline built from it identified.
- QA decision. Judge any Playwright failure from the evidence on this pipeline and earlier ones
  (flake, test or product problem; hand deep triage to the Playwright triage skill). Report it and
  ask the owner once per build for the QA go, naming the build in the ask.
  Milestone `qa_go_requested`. Done: the QA hold approved for this build after a go for this build, or the owner told what
  blocks it.
- QA ready. Depends on the QA approval. Milestone `qa_ready`. Done: the update server's QA channel serves the version.
- Sign-off. Ask Harry once, in the QA thread only. The QA thread is the thread of Harry's "New version released in QA" post
  for this version. Find it in the release channel (the briefing's linked threads show it once linked), link it with `job_open`
  (intent join, role `qa`) and ask there. A request thread or a side thread is never the QA thread, even if the QA news was told there.
  If `say` answers `wrong_audience`, do what it says. If you cannot find the QA thread, say what you are waiting for and check again. Milestones `signoff_requested` (the ask),
  then `prod_alpha_approved` (the sign-off received). Done: sign-off from Harry, or from the owner as
  stand-in, for this build.
- Live. Approve the prod alpha hold after sign-off. Milestone `live`. Done: the update server's prod alpha channel
  serves the version. `qa_ready` and `live` are outcomes: record them with `checkpoint(reached)` only after you read the source
  showing them; `say` answers `not_reached` until then. If prod alpha does not serve the version yet, tell the thread where it stands
  (blocked or waiting) without claiming it is live.
- Before you post a claimed message, read the latest messages in that thread. If the same news is
  already there (for example another session's reply), confirm it with `say` and the post link
  instead of posting again.
- If `say` answers `busy` (another claim is open in that thread), post nothing there yet: never
  fold the message into a post claimed for another milestone. Do other work and `say` again.
  A `build_changed` hold means: the build moved since the go. Ask the responders again for the
  new build (claim and post the ask, naming the build), wait for that go, then `intend` again.
  A `no_go_for_build` hold means: no ask for that gate exists yet, so no go is on record for this
  build. Claim and post the ask naming the build, wait for the go, then `intend` again.
- Everyone owed is told once, in their own thread: the request thread, every thread that asked to
  be told, and for live also the QA thread. The briefing lists who is still owed.
- Release issue completed. Done: the issue is in its completed state.

## How a run ends
Every time you stop, the job is in exactly one of these, and you record which with `checkpoint`:
- Waiting for input or a system (a review, a go, a pipeline): say what and from whom; set when to
  look again. Waiting is not done.
- Blocked with a named owner: say who, what failed, what you tried and what you need, in the
  thread of the person who asked.
- Cancelled: nothing new started after the cancel; every uncertain action settled from the live
  source and reported; the requester told.
- Done: prod alpha serves the version, the issue is completed, nobody is still owed.
Settle every action before you stop: read its source (the PR, the pipeline, the update server) and report done or failed with
`checkpoint`. An action the briefing shows as in flight or unknown is read back first, every time you work on the job, and reported
once you have read it; the engine may settle some from the source as well, but do not rely on that: an action you did and read back
is reported by you.
When you report an action's outcome, use done only with proof read from the source, failed only
when you read that it did not happen, and unknown when you cannot tell. Unknown is never a retry:
read the source again before acting on it.

Done: prod alpha serves the version, the release issue is completed and the briefing shows nobody
owed; or the job is recorded as blocked with a named person and the evidence, as cancelled with
every uncertain action settled and the requester told, or as waiting with what it waits for and
when it will be checked.

## Escalation
When you cannot proceed, name the person, in the thread of the person who asked: what failed, what
you tried, what you need. A missing credential, a platform limit or a human decision ends the
search. Ask the owner only for human decisions, never for steps you can read or take yourself.

## Handoffs
- Playwright failure triage: the Playwright triage skill.
- PR authoring details (branch, version bump files): the PR authoring skill.

## Temporary (remove when the condition holds)
- Claim with `say` before posting a milestone. Remove when the connector ingests the bot's own
  posts and the sweep reconcile is proven live.
