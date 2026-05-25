---
description: Fast fixed-fleet bug hunt of the current branch (or a given path/diff-range). Recreation of the built-in bughunt-lite workflow via subagents — lighter/faster than bughunt.
argument-hint: "[path | diff-range]  (empty = origin/main...HEAD)"
---

Run the **bughunt-lite** skill recipe.

**Scope:** $ARGUMENTS
(If empty, default to the branch diff base `git rev-parse origin/main` → fallback `main`, hunted as `<base>...HEAD`.)

**Steps:**

1. Read the full recipe at `clawd/skills/bughunt-lite/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 0 — Scope:** resolve the diff base / scope, list changed files, summarize the change, extract CLAUDE.md conventions, build the shared `SCOPE_BLOCK`. Stop early if there is nothing to hunt.
   - **Phase 1 — Find:** dispatch the FIXED fleet of 5 finders IN PARALLEL via the Agent tool — 3 rapid surface scanners (biased to first/middle/last third of files) + 2 deep analysts (most-significant change, then a different subsystem). Each returns strict JSON bugs. Do NOT add a respawn loop — the fixed wave is what makes this "lite".
   - **Phase 1.5 — Harvest + naive dedup:** as finders land, sort by severity, dedup by file:5-line-bucket, and apply the 20-slot verification budget (critical/high always pass).
   - **Phase 2 — Adversarial verify:** for each novel bug, run 5-voter pigeonhole verification — voters 0+1 first; if both refute, early-kill and skip the other 3; otherwise run voters 2,3,4. ≥2 refutations of 5 kill the bug. Default to refuted when uncertain.
   - **Phase 3 — Synthesize:** semantically dedup the confirmed bugs, order critical→high→medium→low→nit, and emit the report in the skill's output format with vote tallies and best evidence.
3. Print the final severity-grouped report plus the stats line. Do not modify any code — this is hunt-only.

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off fleet-wide (`tengu_workflows_enabled` OFF). See `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`.
