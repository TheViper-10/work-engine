# Decision log

Judgment calls made during the unattended phase 0 to 2 run (2026-10-04). Locked decisions D1 to D14
live in handoff file 28 §3 and are not repeated here. Each entry: the call, the evidence, the alternative.

## R1. Overlap phase 1 engine work with phase 0 scenario and playbook work
- Call: start the engine core as soon as the spec and record shapes exist, while scenarios and the playbook are still being written.
- Evidence: the engine is generic (D8) and depends only on the spec shape, not on scenario or playbook text. The 3-hour time box (file 28 §7.5) is tight.
- Alternative: strictly serial phases. Rejected because it adds about 25 minutes with no quality gain; phase 0 is still completed and reviewed before phase 1 is declared done.

## R2. Spec event kind names are engine-local
- Call: `proved_by` event kinds (`github_pr_merged`, `circleci_gate_approved`, ...) are names chosen for the spec; the simulator and harness use the same names. Phase 3 adapters map real webhook payloads onto them.
- Evidence: no source names them; the engine only matches names (D8).
- Alternative: real webhook event names. Rejected for now because no adapter exists and CircleCI is Tony-reported until after the live test.

## R3. Sign-off ask audience is the QA thread only
- Call: milestone `signoff_requested` has audience role `qa` with no promise holders.
- Evidence: `22-tony-coordinator-call-map.md:425` rule 26 puts the sign-off ask only in the QA thread.
- Alternative: D3 default (request thread plus promise holders). D3 says "unless the spec says otherwise", so this is within D3.

## R4. A `cancel` gate exists with responders but no action
- Call: the spec names who may cancel (owner); `sender_not_listed` can flag a cancel from someone else. The engine does not act on it.
- Evidence: call-map moment 11.
- Alternative: no cancel gate. Kept because it costs one spec entry and records authority.

## R5. The spec has no step order; `complete_release_issue` is a Tony action
- Evidence: call-map rules 21 to 23 were the rigid sequencing of v8 (L1 forbids it). In v8 the Coordinator closed the issue (call map line 195); in v3 Tony acts on systems with his own tools.
- Alternative: none faithful to L1.

## R6. People in the mock spec: owner and Harry only
- Evidence: `18-coordinator-design-decisions.md:6`, `21-work/B-live.md:153`. Owner is Harry's stand-in on prod alpha.
- Alternative: add the real-release sign-off person. Left out because phase 4 is a mock release; add in the spec before a real release.

## R7. Playbook gives a "usual path", not an order
- Call: the playbook lists the usual release path and says Tony may reorder it.
- Evidence: L1 (the engine never orders steps); a real model needs a starting plan; the spec has no order.
- Alternative: no path at all. Rejected because a model with no path tends to re-derive v8's handshakes.

## R8. Playbook keeps v2.38 Slack voice and drops Coordinator-era protocol
- Call: reuse v2.38 voice rules (plain, four sentences, no ids); drop receipts, `report_effect` and `execution_key`.
- Evidence: `21-work/run-data/live/tony-version-2.38.json` guidance and slack skills; v3 replaces those protocols.
- Alternative: keep worktree notes for PR authoring. Dropped; PR authoring is unchanged Tony skill text outside this playbook.

## R9. Scenario gaps filled with stated assumptions
- Call: where the sources lack a fact (update-server start versions for run 4 and v2.18, run 6 pipeline id, v2.18 approval and CI timings, Harry's v2.18 replies), the scenario uses a stated assumption recorded in its `notes`. Run 4's real ending (a cancel) is kept as a cancel case elsewhere and its scenario gets a marked synthetic tail to done.
- Evidence: the sources were read in full by the scenario worker; these facts were not exported.
- Alternative: a read-only DevRev re-pull through fde-agent. Rejected: the missing facts are Slack replies and CircleCI timings, which DevRev does not hold, and the replay scores engine behaviour, which these values do not change.
