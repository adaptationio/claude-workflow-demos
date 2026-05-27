---
description: Multi-dimension adversarial code review of the current branch (or a given path/diff-range). Recreation of the built-in review-branch workflow via subagents.
argument-hint: "[path | diff-range]  (empty = origin/main...HEAD)"
---

Run the **review-branch** skill recipe.

**Scope:** $ARGUMENTS
(If empty, default to the branch diff `origin/main...HEAD`, falling back to `main...HEAD` when there is no remote.)

**Steps:**

1. Read the full recipe at `${CLAUDE_PLUGIN_ROOT}/skills/review-branch/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 0 — Scope:** resolve the diff base / scope, list changed files, gather `--stat`, read CLAUDE.md conventions, build the shared `CONTEXT_HEADER`. Stop early if there is nothing to review.
   - **Phase 1 — Review:** dispatch the 6 dimension reviewers (bugs, simplicity, architecture, dead-code, best-practices, existing-patterns) IN PARALLEL via the Agent tool, each returning strict JSON findings.
   - **Phase 2 — Adversarial verify:** for each finding (cap 25, severity-sorted, high always verified), dispatch an adversarial verifier whose job is to reject false positives. Returns confirmed/rejected/unclear.
   - **Phase 3 — Synthesize:** semantically dedup confirmed findings, group by severity, and emit the report in the skill's output format.
3. Print the final severity-grouped report. Do not modify any code — this is review-only.

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off in your org (`tengu_workflows_enabled` OFF).
