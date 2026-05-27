---
description: Drive a task end-to-end from description to opened PR (Plan → Implement → Review → Fix → PR). Recreation of the built-in autopilot workflow via subagents. MODIFIES code.
argument-hint: "<task description>  (what to build/fix — required)"
---

Run the **autopilot** skill recipe.

**Task:** $ARGUMENTS
(Required. If empty, stop: "No task provided. Pass the task description as args.")

⚠️ **This workflow MODIFIES code and opens a PR** — it is a build loop, not a review. (Contrast with `/review-branch-demo`, which is read-only.) Make sure you are on a branch you can push and that this is a task you actually want built.

**Steps:**

1. Read the full recipe at `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 1 — Plan:** dispatch 1 draft agent (PLAN_SCHEMA) → 5 critics IN PARALLEL (scope, simplicity, reuse, verification, correctness; CRITIQUE_SCHEMA) → 1 harden agent (only if any critic says REVISE).
   - **Phase 2 — Implement:** dispatch 1 implement agent (IMPL_SCHEMA) to make the edits and run verification. Stop if `done=false`.
   - **Phase 3 — Review:** run the bughunt pipeline (3 rapid scanners + 2 deep analysts → adversarial verify with 5 votes / 2-refute-kill / 20-verify cap, staged voting) IN PARALLEL with a single completeness check (COMPLETENESS_SCHEMA).
   - **Phase 4 — Fix:** if any confirmed bugs or completeness gaps, dispatch 1 fix agent (IMPL_SCHEMA).
   - **Phase 5 — PR:** dispatch 1 PR agent (PR_SCHEMA) — lint/typecheck, branch if on main, commit, push, open PR, attempt `mcp__github__subscribe_pr_activity`.
3. Print the final run summary in the skill's output format (PR URL, branch, plan/critique/review/fix stats).

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off in your org (`tengu_workflows_enabled` OFF), so neither the built-in `autopilot` nor custom `.claude/workflows/*.js` run.
