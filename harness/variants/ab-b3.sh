#!/bin/zsh
set -u
cd /Users/priyadharshanravichandran/DevRev/Github_Repos/work-engine
export WE_GATEWAY_KEY=$(security find-generic-password -s arcus-token -a $USER -w)
G=docs/proposals/agent-guidance-replay.md
for s in stale-go private-evidence; do
  npx tsx harness/run.ts --scenario $s --mode flag --runs 2 --binding engine --tony model --playbook harness/variants/playbook-B.md --reference harness/variants/engine-reference-B.md,$G --out harness/out/ab-B3 --quiet true > harness/out/ab-B3-$s.log 2>&1 &
done
wait
echo B3_DONE
