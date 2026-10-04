# Desktop release (proposed goal-oriented playbook)

Status: proposal for owner review. Not published. Assumes the one-job, one-execution-DM model
(`docs/proposals/one-dm-per-job-review.md`); where a line depends on it, it is marked [DM].
Engine call contract: `docs/proposals/engine-contract-reference.md`. Voice, credentials and self-recovery: agent guidance.

## Goal
Take the requested desktop version from the version bump PR to served on prod alpha, with every
person who is owed an update told once, or stop at a named person or the owner's cancel with the
evidence of where it stands.

## Evidence (re-read every time you work on the job, in this order)
1. The job briefing (`job_view`): what was committed, what arrived (inbox), open asks, actions in
   flight or unknown, who is owed what.
2. Live systems, which win over the briefing: GitHub (the bump PR, its reviews and merge commit),
   CircleCI (the pipeline built from that merge commit, its jobs and approval holds, in CircleCI's
   own state words), the update server (what QA and prod alpha serve), the Slack threads.
3. If a read fails, retry once, then say what you could not check and claim nothing about it.
A fact you have not read in this session is not a fact.

## Approvals and boundaries
- A go counts only from the gate's listed person or a named stand-in (the briefing shows them on
  each open ask), about the build it names. You judge whether a message means go. Your own message is
  never a go, and neither is a message from anyone not listed for that gate (a listed responder may
  be a bot account). If the build changed after a go, the go does not cover the
  new build: ask again for the new one.
- Approve or publish only a pipeline on the release base branch whose build is the one the go
  named (the merge commit, or a later commit the owner's go covers). Change the base branch only
  through a reviewed PR; never push to it yourself.
- People: the owner is Priyadharshan (Slack <@U042GEDM4BB>, GitHub TheViper-10; a GitHub approval
  by TheViper-10 is the owner's review). Harry (Slack <@U0C4YRX93PS>) signs off for prod alpha; the
  owner is his stand-in.
- Declare intent before every merge, gate approval or publish. A hold means do not do it; follow
  the reason it gives. A flag is information: weigh it, and tell a human in plain words when it
  matters to them (the build changed since the go, a stand-in approved).
- The owner may cancel at any time. After a cancel, start nothing new; settle anything uncertain
  from the live source and tell the requester the honest outcome.
- Evidence from a private thread stays there. Tell other threads only milestones, from public facts.
- [DM] You act only from the job's own DM. In a Slack-started conversation, answer from the
  briefing and live reads; anything that needs action is routed to the job for you automatically.

## Outcomes to reach (a map, not an order; genuine dependencies are noted)
- Bump PR open for the version, and one release issue for it, linked under the parent.
  Done: PR open, issue linked, the requester knows where it is.
- PR reviewed by the owner (a GitHub approval counts) and merged. Done: merge commit known; the
  pipeline built from it identified. Depends on the review.
- QA decision. Judge any Playwright failure from the evidence on this pipeline and earlier ones
  (flake, test or product problem; hand deep triage to the Playwright triage skill). Report it and
  ask the owner once per build for the QA go. Done: the QA hold approved for this build after a go
  for this build, or the owner told what blocks it.
- QA ready. Done: the update server's QA channel serves the version.
- Sign-off. Ask Harry once, in the QA thread only. Done: sign-off from Harry or the owner as
  stand-in, for this build.
- Live. Approve the prod alpha hold after sign-off. Done: the update server's prod alpha channel
  serves the version.
- Everyone owed is told once, in their own thread: the request thread, every thread that asked to
  be told, and for live also the QA thread. The briefing lists who is still owed.
- Release issue completed.

## Waiting, handoff and the four ways a run ends
Every time you stop, the job is in exactly one of these, and you record which with `checkpoint`:
- Waiting for input or a system (a review, a go, a pipeline): say what and from whom; set when to
  look again. Waiting is not done.
- Blocked with a named owner: say who, what failed, what you tried and what you need, in the thread
  of the person who asked.
- Cancelled: nothing new started after the cancel; every uncertain action settled from the live
  source and reported; the requester told.
- Done: prod alpha serves the version, the issue is completed, nobody is still owed.
When you report an action's outcome, use done only with proof read from the source, failed only
when you read that it did not happen, and unknown when you cannot tell. Unknown is never a retry:
read the source again before acting on it.

Done: prod alpha serves the version, the release issue is completed and the briefing shows nobody
owed; or the job is recorded as blocked with a named person and the evidence, as cancelled with
every uncertain action settled and the requester told, or as waiting with what it waits for and
when it will be checked.

## Handoffs
- Playwright failure triage: the Playwright triage skill.
- PR authoring details (branch, version bump files): the PR authoring skill.

## Temporary (remove when the condition holds)
- Claim a message with `say` before you post it, and confirm it with the link if the briefing says
  it was not seen. Remove when the connector ingests Tony's own bot posts (phase 3, G12) and the
  sweep reconcile is proven live.
- If the briefing says another session is working this job, answer questions only. Remove when the
  engine refuses execution writes from sessions outside the job DM [DM].
