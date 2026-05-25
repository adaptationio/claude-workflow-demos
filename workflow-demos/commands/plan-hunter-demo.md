---
description: Generate an implementation plan for an idea by drafting it four ways (MVP / Risk / Dependency / User-first), judging all four, and synthesizing the winner. Recreation of the built-in plan-hunter workflow via subagents. Plan-only — never edits code.
argument-hint: "<idea to plan>  (what to build/refactor/migrate — required)"
---

Run the **plan-hunter** skill recipe.

**Idea:** $ARGUMENTS
(Required. If empty, stop: "No idea provided. Pass the idea as the args parameter.")

This produces an **implementation plan**, not code — it never edits files or runs builds. Hand the result to `/autopilot-demo` or a human to execute.

**Steps:**

1. Read the full recipe at `clawd/skills/plan-hunter/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 0 — Scope:** dispatch 1 scope agent (SCOPE_SCHEMA) to restate the idea, extract goals/constraints/assumptions/open-questions, and build the shared `CONTEXT` block. Stop if no idea or scope is skipped.
   - **Phase 1 — Draft:** dispatch the 4 lens planners (MVP-first, Risk-first, Dependency-first, User-first) IN PARALLEL via the Agent tool, each returning strict JSON (DRAFT_SCHEMA: plan + risks + gaps).
   - **Phase 2 — Judge:** dispatch 4 judges IN PARALLEL (JUDGE_SCHEMA: rankings of all drafts, 1–10), then aggregate scores in-context — average each lens's votes, sort descending, pick the winner + runners-up.
   - **Phase 3 — Synthesize:** dispatch 1 synthesizer agent that starts from the winner, grafts the best ideas from the runners-up, folds in all surfaced risks/gaps, and opens with the assumptions + open questions to confirm.
3. Print the final synthesized plan, then the run footer (winner, scoreboard across the 4 lenses, and stats: drafts / judges / agent calls) in the skill's output format.

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off fleet-wide (`tengu_workflows_enabled` OFF), so neither the built-in `plan-hunter` nor custom `.claude/workflows/*.js` run. See `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`.
