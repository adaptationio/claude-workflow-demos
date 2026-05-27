# workflow-demos

**Subagent recreations of all 10 Claude Code built-in workflows — as skills + `/<name>-demo` slash commands.**

> ⚠️ **This is a DEMO.** It is a preview/stand-in for Claude Code's upcoming native **`/workflows`** feature, which is **coming soon**. These demos exist purely to **test the ideas now**, while the real `/workflows` tool is still gated off. When `/workflows` is fully enabled, switch to the native built-ins — they are deterministic and replay-safe; these demos are not. Treat anything here as experimental.

## What this is

Claude Code v2.1.147 shipped a native **`Workflow` tool** + `/workflows` command with 10 built-in workflows for deterministic multi-agent orchestration. That tool is gated behind a server-side feature flag (`tengu_workflows_enabled`) that **may not be enabled for your org yet** — until it is, neither the built-in nor custom `.js` workflows can run.

A workflow, though, is just an **orchestration recipe** — phases of parallel agent fan-out, adversarial verification, and synthesis. The *Workflow tool* is gated, but the **Agent/Task subagent tools are not**. So this plugin recreates each built-in recipe as a **skill** (read-and-follow `SKILL.md`) plus a **`/<name>-demo` slash command** that drives the same logic through ordinary subagents — working **today**.

## The 10 demos

| Command | Skill | What it does |
|---|---|---|
| `/review-branch-demo` | review-branch | 6-dimension review → adversarial verify → deduped report |
| `/bughunt-demo` | bughunt | self-respawning finder fleet → multi-vote jury → synthesis |
| `/bughunt-lite-demo` | bughunt-lite | fixed finder fleet → multi-vote jury → synthesis (faster) |
| `/bugfix-demo` | bugfix | reproduce → locate → fix → verify (⚠ modifies code) |
| `/autopilot-demo` | autopilot | plan → 5 critics → implement → review → fix → PR (⚠ modifies code) |
| `/plan-hunter-demo` | plan-hunter | 4 planning lenses → 4 judges → synthesized plan |
| `/deep-research-demo` | deep-research | parallel search → fetch/extract → vote-verify → report |
| `/investigate-demo` | investigate | gather → hypothesize → refute → report |
| `/docs-demo` | docs | discover → outline → write → verify → PR (⚠ writes docs) |
| `/dashboard-demo` | dashboard | discover → design → implement → verify → PR (⚠ creates files) |

Commands marked ⚠ modify or create files — run them on a clean branch and review the diff.

## How it works (without the Workflow tool)

| Native Workflow DSL | This plugin uses |
|---|---|
| `agent(prompt, {schema})` | the Agent tool; schema enforced via "return strict JSON" |
| `parallel([...])` | multiple Agent calls in one message |
| `pipeline(stage1, stage2)` | manual staging |
| `phase()` / `log()` | progress narration |

**Tradeoff vs native:** we lose replay-safe determinism and the `/workflows` run-history browser. We keep the full recipe logic — phases, parallel fan-out, adversarial verification, synthesis.

## Status / testing

- `review-branch` — full end-to-end test passed (planted-bug fixture: 5/5 caught + confirmed, 0 false positives).
- `bughunt-lite` — end-to-end test passed (finders caught all planted issues; adversarial jury confirmed the real bug and **killed** a deliberately bogus claim).
- All 10 — structural validation passed; recipes translated faithfully from the cached built-in sources.

## Install

```
claude plugin marketplace add adaptationio/claude-workflow-demos
claude plugin install workflow-demos@team-willie
```

Then invoke any `/<name>-demo` command, or just ask Claude to "use the bughunt-lite demo on this branch."

## Provenance

Recipes were translated faithfully from Claude Code's built-in workflow sources (the `Workflow` tool's bundled recipes, Claude Code v2.1.147+). Each skill documents its own phases, schemas, and budgets inline — no external files required.

---

*Demo only — not the real `/workflows`. For testing ideas until the native feature lands.*
