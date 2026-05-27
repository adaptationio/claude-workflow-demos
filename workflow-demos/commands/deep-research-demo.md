---
description: Multi-angle, adversarially-verified web research on a question. Recreation of the built-in deep-research workflow via subagents — outputs a confidence-graded, source-cited report.
argument-hint: "<research question>"
---

Run the **deep-research** skill recipe.

**Question:** $ARGUMENTS
(If empty, stop and ask for a research question — there is nothing to research.)

**Steps:**

1. Read the full recipe at `${CLAUDE_PLUGIN_ROOT}/skills/deep-research/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 0 — Scope:** dispatch ONE agent to decompose the question into 3–6 complementary search angles (`SCOPE_SCHEMA`).
   - **Phase 1 — Search:** dispatch one searcher per angle IN PARALLEL via the Agent tool, each returning up to 6 ranked results (`SEARCH_SCHEMA`).
   - **Phase 1.5 — URL dedup + budget:** normalize and dedup URLs, rank by relevance, take the top `MAX_FETCH=15`.
   - **Phase 2 — Fetch + Extract:** for each surviving URL dispatch a fetch/extract subagent that grades source quality and pulls up to 5 claims (`EXTRACT_SCHEMA`); cap claims at `MAX_VERIFY_CLAIMS=25`.
   - **Phase 3 — Adversarial verify:** for each claim dispatch `VOTES_PER_CLAIM=3` skeptical verifiers whose job is to refute; `≥REFUTATIONS_REQUIRED=2` of 3 refutations kill the claim (`VERDICT_SCHEMA`).
   - **Phase 4 — Synthesize:** semantically dedup confirmed claims, grade confidence, and emit the report in the skill's output format (`REPORT_SCHEMA`).
3. Print the final confidence-graded, source-cited research report. Do not modify any files — this is research-only.

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off in your org (`tengu_workflows_enabled` OFF).
