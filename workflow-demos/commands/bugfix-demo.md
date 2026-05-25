---
description: Reproduce, fix, and verify a single reported bug via subagents. Recreation of the built-in bugfix workflow (native Workflow tool is gated off fleet-wide).
argument-hint: "<bug description | issue # | failing test>"
---

Run the **bugfix** skill recipe.

**Bug to fix:** $ARGUMENTS
(If empty, ask for the bug report / failing test / issue reference before proceeding.)

**Steps:**

1. Read the full recipe at `clawd/skills/bugfix/SKILL.md`.
2. Execute it end-to-end through its phases (reproduce → locate root cause → fix → verify), dispatching the subagents the skill prescribes via the Agent tool.
3. Surface the final result: root cause, the fix applied, and the verification evidence (e.g. the failing test now passing with exit code in the transcript).

⚠️ **This workflow MODIFIES code** — unlike the read-only review/hunt demos, bugfix edits files to apply the fix. Work on a clean branch and review the diff before committing.

Note: this is the subagent-based recreation; the native `Workflow` tool is gated off fleet-wide (`tengu_workflows_enabled` OFF). See `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`.
