---
description: Document a feature/API/subject end-to-end (Discover → Outline → Write → Verify → PR). Recreation of the built-in docs workflow via subagents. WRITES docs + opens a PR.
argument-hint: "<subject to document>  (feature, path, API/CLI surface — required)"
---

Run the **docs** skill recipe.

**Subject:** $ARGUMENTS
(Required. If empty, stop: "No subject provided. Pass what to document as args.")

⚠️ **This workflow WRITES and UPDATES documentation files and opens a PR** — Phase 3 (Write) creates/updates the doc (and may touch nav/index files), and Phase 5 (PR) commits + pushes. (Contrast with `/review-branch-demo`, which is read-only.) Make sure you are on a branch you can push.

**Steps:**

1. Read the full recipe at `${CLAUDE_PLUGIN_ROOT}/skills/docs/SKILL.md`.
2. Execute it end-to-end as a strict sequential pipeline (no parallelism — each stage consumes the prior stage's JSON):
   - **Phase 1 — Discover:** 1 agent (DISCOVER_SCHEMA) maps the public surface (file:symbol), finds existing docs, picks the `targetPath`, and identifies audience + conventions. Build the shared `CONTEXT` block. Stop if skipped.
   - **Phase 2 — Outline:** 1 agent (OUTLINE_SCHEMA) drafts a lean section outline matching sibling docs. Stop if skipped.
   - **Phase 3 — Write:** 1 agent (IMPL_SCHEMA) WRITES the doc at `targetPath` with REAL code examples, preserving unrelated sections and updating nav/index if needed. Stop if `done=false`.
   - **Phase 4 — Verify:** 1 agent (VERIFY_SCHEMA) runs/typechecks every example, resolves every link, and spot-checks 3 behavior claims against the surface. ONLY if `issues` is non-empty, dispatch 1 fix agent (IMPL_SCHEMA).
   - **Phase 5 — PR:** 1 agent (PR_SCHEMA) lints the doc files, commits, pushes, and opens the PR; returns URL, branch, and a 2-3 sentence summary.
3. Print the final run summary in the skill's output format (PR URL, branch, target path, files changed, outline headings, verify stats, fix notes).

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off in your org (`tengu_workflows_enabled` OFF), so neither the built-in `docs` workflow nor custom `.claude/workflows/*.js` run.
