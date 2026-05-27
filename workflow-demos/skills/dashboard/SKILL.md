---
name: dashboard
description: Build a working dashboard from a plain-language request by running a 5-phase pipeline — Discover the dashboard stack + data sources, Design the panels, Implement the dashboard file(s), Verify queries render, then open a PR. Each phase is one subagent returning strict JSON. Use for "build a dashboard for X", "make a Grafana/Hex/Streamlit/React dashboard", "add a metrics dashboard", "dashboard the <data>", or the /dashboard-demo slash command. Faithful recreation of the Claude Code built-in `dashboard` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org). This skill CREATES and commits files.
---

# dashboard (skill)

## Purpose

Turn a plain-language request ("build a dashboard for our error rates") into a real, committed dashboard. This is a recreation of Claude Code's built-in `dashboard` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

Unlike `review-branch` (read-only, parallel), this workflow is a **sequential pipeline that WRITES code**: it discovers the stack, designs panels, implements the dashboard, verifies it, and opens a PR. It modifies the repo.

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `pipeline` (phases run in order, each reads the prior's output) | manual staging — finish one phase, thread its JSON into the next phase's prompt |
| `phase('Discover')` / `log(...)` | progress narration to the user |
| early-return on `!disc` / `!impl.done` | stop the pipeline and report the partial result + blockers |

Note: every phase here is a SINGLE subagent (no `parallel()` in this workflow). The dependency chain is strict — Design needs Discover's framework/data, Implement needs Design's panels, etc.

Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history browser. We keep 100% of the build logic.

## Inputs

- **TASK** (required): a plain-language description of the dashboard to build.
  - Empty → stop immediately: `"No dashboard description provided. Pass what to build as args."`

## Recipe

The pipeline has 5 phases, each a single `general-purpose` subagent that returns strict JSON. Thread each phase's output into the next. If a phase's required output is missing, STOP and report the partial result.

### Phase 1 — Discover

`phase('Discover')`. One subagent. Returns JSON matching `DISCOVER_SCHEMA`:
`{ dataSources: string[], framework: string, examplePath: string|null, targetPath: string, conventions?: string }`
(required: `dataSources`, `framework`, `targetPath`; `examplePath` may be null)

Prompt (translated from the built-in):

```
Discover the dashboard stack and available data for this request.

## Request
<TASK>

## Instructions
1. Identify the dashboard framework this repo uses: Grafana-as-code, Hex, Datadog JSON,
   Streamlit, a React page with a charting library, or similar. Grep for existing dashboards.
2. Find an existing dashboard file to pattern-match against (examplePath).
   If no dashboard framework or existing dashboard exists (greenfield repo), choose a
   zero-install stack (e.g. a standalone HTML file + Chart.js via CDN) and set examplePath to null.
3. List concrete data sources relevant to the request: table names, metric names, API
   endpoints, or log queries. Verify they exist where possible.
4. Decide where the new dashboard file(s) should live (targetPath) and note conventions.
```

If no result → stop: `"Discover step skipped."`
Log: `Framework: <framework>, <N> data sources, target: <targetPath>`.

Build a `CONTEXT` string reused by Design + Implement:

```
## Request
<TASK>

## Framework
<framework> (pattern: <examplePath>)

## Data sources
- <dataSource1>
- <dataSource2>

## Conventions
<conventions, or "(none noted)">
```

### Phase 2 — Design

`phase('Design')`. One subagent. Prompt = `CONTEXT` + the design block. Returns JSON matching `DESIGN_SCHEMA`:
`{ title: string, panels: [{ name, metric, viz, why? }], layout?: string }`
(required: `title`, `panels`; each panel requires `name`, `metric`, `viz`)

Design block (translated from the built-in):

```
## Instructions
Design the dashboard. For each panel specify: name, the exact metric/query expression,
visualization type, and a one-line reason it earns a spot.

Best practices:
- Top row = the headline numbers (what is the state right now). Below = breakdowns and trends.
- Prefer rates and percentiles over raw counts. Pair every latency panel with a volume panel.
- Every panel should answer a question someone would actually ask. Cut anything that does not.
- 6-12 panels is usually right. More than that and nothing gets looked at.
Describe layout as a brief grid spec.
```

If no result → stop: `"Design step skipped."` (return the discover result alongside).
Log: `Design: <N> panels`.

### Phase 3 — Implement

`phase('Implement')`. One subagent. Prompt = `CONTEXT` + the design (title, layout, numbered panel list `N. <name> [<viz>] — <metric>`) + the implement block. Returns JSON matching `IMPL_SCHEMA`:
`{ done: boolean, filesChanged: string[], notes: string, blockers?: string[] }`
(required: `done`, `filesChanged`, `notes`)

Implement block (translated from the built-in):

```
## Instructions
Implement the dashboard at <targetPath> using <framework>.
Match the structure of <examplePath> exactly — same JSON schema, component
patterns, or DSL. Wire up each panel to its data source.
Register the dashboard in any index/nav file the framework requires (no-op for a standalone file).
```

If no result OR `done !== true` → stop: `"Implementation incomplete."` (return discover + design + `impl.blockers`).
Log: `Implemented: <N> files`.

### Phase 4 — Verify (with optional fix)

`phase('Verify')`. One subagent. Returns JSON matching `VERIFY_SCHEMA`:
`{ queriesOk: boolean, rendered: boolean, screenshotPath?: string, issues: string[] }`
(required: `queriesOk`, `rendered`, `issues`)

Verify block (translated from the built-in):

```
Verify the dashboard.

Files: <impl.filesChanged>
Framework: <framework>

## Instructions
1. Dry-run or validate every query/metric expression — confirm syntax and that the
   referenced tables/metrics exist. Set queriesOk accordingly.
2. If the framework supports local rendering, render the dashboard and screenshot it.
   Otherwise validate the file against its schema/linter. Set rendered accordingly.
3. List concrete issues (empty if clean).
```

Log: `Verify: queries <OK|FAIL>, rendered <yes|no>, <N> issues`.

**Fix sub-step** — if `issues` is non-empty, dispatch ONE more subagent (`label: verify:fix`, still phase `Verify`) returning `IMPL_SCHEMA`:

```
Fix these dashboard issues:
1. <issue1>
2. <issue2>

Files: <impl.filesChanged>
```

Record its `notes` as `fixNotes` (else `fixNotes = "(clean)"`).

### Phase 5 — PR

`phase('PR')`. One subagent. Returns JSON matching `PR_SCHEMA`:
`{ prUrl: string, branch: string, summary: string, notes?: string }`
(required: `prUrl`, `branch`, `summary`)

PR block (translated from the built-in):

```
Open a PR for this dashboard.

## Request
<TASK>

Files: <impl.filesChanged>
<Screenshot: <screenshotPath>  — only if verify produced one>

## Instructions
1. Run any repo lint/format on the dashboard files.
2. Create a branch (e.g. `dashboard/<subject>`) before committing.
3. Commit. If no git remote is configured, skip `git push`/`gh pr create`, commit locally,
   and return `prUrl: null` with a note. Otherwise push and open a PR. Include the panel
   list and screenshot (if any) in the body.
4. Return PR URL (or null), branch, and a 2-3 sentence summary.
```

## Output format

Return a final object/summary (translated from the built-in's return value):

```
# Dashboard built — <design.title>

**Summary:** <pr.summary>   (or "PR step incomplete. Dashboard at <targetPath>")

- **PR:** <prUrl>           (null if PR step incomplete)
- **Branch:** <branch>
- **Framework:** <framework>
- **Target path:** <targetPath>
- **Panels (<N>):** <panel names, comma-separated>
- **Files changed:** <filesChanged>
- **Verify:** queries <OK|FAIL>, rendered <yes|no>, screenshot <path|none>
- **Fix notes:** <fixNotes>
```

## Notes

- **This skill writes and commits code.** It is NOT read-only like `review-branch`. It creates dashboard file(s) at `targetPath`, may touch an index/nav file, commits, pushes, and opens a PR. Confirm scope before running on a shared branch.
- The pipeline is strictly sequential — never dispatch the 5 phases in parallel; each depends on the prior phase's JSON. Early-stop and surface blockers if Discover, Design, or Implement fail to return their required fields.
- Implementation MUST pattern-match `examplePath` exactly (same JSON schema / component patterns / DSL). The Discover phase earns its keep here — a good `examplePath` is what makes Implement land cleanly.
- The Verify phase is load-bearing: validate every query/metric against real tables before opening the PR. The optional fix sub-step closes the loop on any issues it finds.
- `subagent_type: general-purpose` for all phases (they grep, write files, run linters, and open PRs). Verify may render + screenshot via Playwright when the framework supports it.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
