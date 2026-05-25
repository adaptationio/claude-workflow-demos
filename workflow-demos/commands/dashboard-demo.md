---
description: Build a working dashboard from a plain-language request via a 5-phase subagent pipeline (Discover → Design → Implement → Verify → PR). Recreation of the built-in dashboard workflow. CREATES + commits files and opens a PR.
argument-hint: "<what to build>  (e.g. \"error-rate dashboard for the API service\")"
---

Run the **dashboard** skill recipe.

**Request (what to build):** $ARGUMENTS
(If empty, STOP — the dashboard needs a description. Report: "No dashboard description provided. Pass what to build as args.")

**Heads up — this command WRITES code.** Unlike `/review-branch-demo`, the dashboard workflow is not read-only: it creates dashboard file(s), may edit an index/nav file, commits, pushes, and opens a PR. Make sure you're on a branch where that's acceptable before running.

**Steps:**

1. Read the full recipe at `clawd/skills/dashboard/SKILL.md`.
2. Execute the 5-phase sequential pipeline end-to-end — each phase is ONE subagent returning strict JSON; thread each phase's output into the next. Stop early and surface blockers if a required phase fails:
   - **Phase 1 — Discover:** identify the dashboard framework (Grafana-as-code, Hex, Datadog JSON, Streamlit, React+charts, etc.), find an `examplePath` to pattern-match, list concrete data sources, decide `targetPath`. Build the shared `CONTEXT`. → `DISCOVER_SCHEMA`
   - **Phase 2 — Design:** lay out 6–12 panels (name, exact metric/query, viz type, why), headline numbers on top, rates/percentiles over raw counts, brief grid layout. → `DESIGN_SCHEMA`
   - **Phase 3 — Implement:** build the dashboard at `targetPath` using the framework, matching `examplePath` exactly; wire each panel to its data source; register in any index/nav file. → `IMPL_SCHEMA` (stop if `done` is false).
   - **Phase 4 — Verify:** validate every query/metric expression and render/lint the dashboard; if issues are found, dispatch a fix subagent. → `VERIFY_SCHEMA`
   - **Phase 5 — PR:** lint/format, commit, push, open a PR with the panel list and screenshot. → `PR_SCHEMA`
3. Print the final summary in the skill's output format (title, PR URL, branch, framework, target path, panels, files changed, verify status, fix notes).

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off fleet-wide (`tengu_workflows_enabled` OFF). See `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`.
