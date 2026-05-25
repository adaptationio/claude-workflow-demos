# Claude Code workflow-demos

**Subagent recreations of all 10 of Claude Code's built-in `/workflows` — runnable today, as skills + `/<name>-demo` slash commands.**

> ⚠️ **This is a DEMO / preview.** Claude Code v2.1.147 shipped a native **`Workflow` tool** with 10 built-in multi-agent workflows, gated behind a server-side feature flag that isn't broadly enabled yet. A workflow is just an orchestration recipe (parallel agent fan-out → adversarial verification → synthesis); the *tool* is gated, but the **Agent/Task subagent tools are not**. So this marketplace recreates each recipe with ordinary subagents — working now, for testing the ideas until native `/workflows` lands. When it does, prefer the native built-ins: they're deterministic and replay-safe; these demos are not.

## Install

```bash
claude plugin marketplace add adaptationio/claude-workflow-demos
claude plugin install workflow-demos@team-willie
```

Then invoke a command (e.g. `/review-branch-demo`) or just ask Claude to "use the bughunt-lite demo on this branch."

## The 10 demos

| Command | What it does |
|---|---|
| `/review-branch-demo` | 6-dimension review → adversarial verify → deduped report |
| `/bughunt-demo` | self-respawning finder fleet → multi-vote jury → synthesis |
| `/bughunt-lite-demo` | fixed finder fleet → multi-vote jury → synthesis (faster) |
| `/bugfix-demo` | reproduce → locate → fix → verify *(modifies code)* |
| `/autopilot-demo` | plan → 5 critics → implement → review → fix → PR *(modifies code)* |
| `/plan-hunter-demo` | 4 planning lenses → 4 judges → synthesized plan |
| `/deep-research-demo` | parallel search → fetch/extract → vote-verify → report |
| `/investigate-demo` | gather → hypothesize → refute → report |
| `/docs-demo` | discover → outline → write → verify → PR *(writes docs)* |
| `/dashboard-demo` | discover → design → implement → verify → PR *(creates files)* |

Commands that modify or create files run on the current branch — review the diff.

## How it works without the Workflow tool

| Native Workflow DSL | This plugin uses |
|---|---|
| `agent(prompt, {schema})` | the Agent tool; schema via "return strict JSON" |
| `parallel([...])` | multiple Agent calls in one message |
| `pipeline(stage1, stage2)` | manual staging |
| `phase()` / `log()` | progress narration |

**Tradeoff vs native:** no replay-safe determinism, no `/workflows` run-history browser. Keeps the full recipe logic — phases, parallel fan-out, adversarial verification, synthesis.

## Status

- `review-branch` and `bughunt-lite` have passed end-to-end tests on a planted-bug fixture (adversarial jury confirms real bugs and rejects bogus claims).
- All 10 recipes were translated faithfully from the built-in workflow sources.

## License

MIT. Built by Adaptation AI. Demo only — not the real `/workflows`.
