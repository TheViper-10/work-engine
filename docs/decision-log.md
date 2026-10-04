# Decision log

Judgment calls made during the unattended phase 0 to 2 run (2026-10-04). Locked decisions D1 to D14
live in handoff file 28 §3 and are not repeated here. Each entry: the call, the evidence, the alternative.

## R1. Overlap phase 1 engine work with phase 0 scenario and playbook work
- Call: start the engine core as soon as the spec and record shapes exist, while scenarios and the playbook are still being written.
- Evidence: the engine is generic (D8) and depends only on the spec shape, not on scenario or playbook text. The 3-hour time box (file 28 §7.5) is tight.
- Alternative: strictly serial phases. Rejected because it adds about 25 minutes with no quality gain; phase 0 is still completed and reviewed before phase 1 is declared done.
