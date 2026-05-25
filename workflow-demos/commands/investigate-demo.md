---
description: Evidence-first root-cause investigation of an incident/error/bug. Gathers facts, generates 3 competing hypotheses in parallel, adversarially refutes them, then reports the root cause. Recreation of the built-in investigate workflow via subagents.
argument-hint: "<incident | error | failing behaviour | \"why is X happening\">"
---

Run the **investigate** skill recipe.

**Incident:** $ARGUMENTS
(If empty, stop and report: "No incident description provided. Pass the incident, error, or question as args.")

**Steps:**

1. Read the full recipe at `clawd/skills/investigate/SKILL.md`.
2. Execute it end-to-end:
   - **Phase 1 — Gather:** dispatch ONE evidence-gathering subagent (facts only, no theory). Return strict JSON `GATHER_SCHEMA`. Build the shared `EVIDENCE_BLOCK`. Stop early if nothing was gathered.
   - **Phase 2 — Hypothesize:** dispatch the 3 fixed-angle hypothesizers (recent-change, data-edge-case, infra-timing) IN PARALLEL via the Agent tool, each proposing ONE root-cause hypothesis with mechanism + testable predictions (JSON `HYPOTHESIS_SCHEMA`).
   - **Phase 3 — Verify:** for each hypothesis dispatch an adversarial refuter (IN PARALLEL) whose job is to REFUTE it against the evidence. Partition into survived / refuted (JSON `VERDICT_SCHEMA`).
   - **Phase 4 — Report:** dispatch ONE report-writer that picks the surviving root cause (or synthesizes a low-confidence one if none survived) and emits summary, root cause, suggested fix, confidence, and next steps (JSON `REPORT_SCHEMA`).
3. Print the final root-cause report in the skill's output format. Do NOT apply the fix — this is an investigation report only; acting on the fix is a separate human-gated step.

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off fleet-wide (`tengu_workflows_enabled` OFF). See `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`.
