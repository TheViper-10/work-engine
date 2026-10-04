#!/bin/zsh
# A/B: current playbook (A) vs goal-oriented proposal (B), same model, scenarios, engine (main).
set -u
cd /Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine
export WE_GATEWAY_KEY=$(security find-generic-password -s arcus-token -a $USER -w)
SC="v2-18 stale-go cancel-mid-publish private-evidence twin-mention"
G=docs/proposals/agent-guidance-replay.md
for s in ${=SC}; do
  npx tsx harness/run.ts --scenario $s --mode flag --runs 2 --binding engine --tony model --playbook workflows/desktop-release/playbook.md --reference $G --out harness/out/ab-A --quiet true > harness/out/ab-A-$s.log 2>&1 &
  npx tsx harness/run.ts --scenario $s --mode flag --runs 2 --binding engine --tony model --playbook harness/variants/playbook-B.md --reference harness/variants/engine-reference-B.md,$G --out harness/out/ab-B --quiet true > harness/out/ab-B-$s.log 2>&1 &
done
wait
npx tsx harness/compare.ts --a harness/out/ab-A --b harness/out/ab-B --out harness/out/ab-compare
echo AB_DONE
