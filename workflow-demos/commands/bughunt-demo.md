---
description: Adversarial bug hunt over the current branch (or a given path/diff-range). Self-respawning finder fleet + 5-vote refutation jury. Recreation of the built-in bughunt workflow via subagents.
argument-hint: "[path | diff-range]  (empty = origin/main...HEAD)"
---

Run the **bughunt** skill recipe.

**Scope:** $ARGUMENTS
(If empty, default to the branch diff `origin/main...HEAD`, falling back to `main...HEAD` when there is no remote.)

**Steps:**

1. Read the full recipe at `${CLAUDE_PLUGIN_ROOT}/skills/bughunt/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 0 — Scope:** resolve the diff base / scope, list changed files, summarize the change, read CLAUDE.md conventions, build the shared `CONTEXT_HEADER`. Stop early if there is nothing to hunt.
   - **Phase 1 — Find:** run the self-respawning fleet of 5 slots — up to 3 rapid surface scanners (one biased per file-list third), then deep analysts that go subsystem-by-subsystem until a 3-pass dry streak. Each finder returns strict-JSON bug candidates; harvest with bucketed dedup + the 20-slot verify budget (critical/high bypass the cap). Fire verifications the instant candidates are found; respawn slots immediately.
   - **Phase 2 — Verify:** for each candidate, run the 5-vote pigeonhole adversarial jury — 2 votes first, 3 more only if undecided; ≥2 refutations kill it. Verifiers default to `refuted=true` when uncertain.
   - **Phase 3 — Synthesize:** semantically dedup the confirmed survivors, order by severity (critical → nit), pick the best evidence per bug, and emit the report in the skill's output format with the final stats line.
3. Print the final severity-grouped report. **Do not modify any code — this is hunt-only (review/output only).**

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off in your org (`tengu_workflows_enabled` OFF).
