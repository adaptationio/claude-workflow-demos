---
name: plan-hunter
description: Generate an implementation plan for an idea by drafting it four ways in parallel (MVP-first, Risk-first, Dependency-first, User-first), having a panel of judges score every draft, then synthesizing the winner with the best grafts from the runners-up. Use for "make me a plan", "plan this feature/project", "how should I build X", "implementation plan for X", or the /plan-hunter-demo slash command. Faithful recreation of the Claude Code built-in `plan-hunter` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org).
---

# plan-hunter (skill)

## Purpose

Turn a rough idea into a single, act-on-it-now implementation plan — and beat the
single-shot quality ceiling by **drafting the plan four different ways, judging all
four, and synthesizing the best of them**. This is a recreation of Claude Code's
built-in `plan-hunter` workflow, rebuilt with the **Agent/Task subagent tools** so it
works today even though the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

The core bet is diversity-then-selection: four planners with deliberately *different*
priors explore different parts of the plan space, a judge panel ranks them on the same
rubric, and a synthesizer grafts the best ideas into one plan. Output is a plan, not code
— this skill never edits files.

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel(LENSES.map(...))` | multiple Agent calls in ONE message (4 planners, then 4 judges) |
| `pipeline` (Scope → Draft → Judge → Synthesize) | manual staging — finish each phase before dispatching the next |
| JS aggregation (`scores`, `ranked`, `winner`) | you do the score-averaging and sort yourself, in-context |
| `phase()` / `log()` | progress narration to the user |

Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history
browser. We keep 100% of the planning logic — four lenses, the judge panel, the
average-score scoreboard, and the graft-the-winner synthesis.

## Inputs

- **idea** (required): the thing to plan — a feature, project, refactor, migration, etc.
  - Empty → stop: `No idea provided. Pass the idea as the args parameter.`
  - Free-form prose is fine; the Scope phase normalizes vague wording.

## The four lenses

Every draft is written through exactly one lens (focus text lifted verbatim from the built-in):

| key | label | focus |
|---|---|---|
| `mvp` | MVP-first | What is the smallest thing that ships and delivers value? Phase the plan so each phase is independently shippable. Defer everything non-essential. |
| `risk` | Risk-first | What could go wrong? Identify the riskiest assumptions and unknowns. Structure the plan to de-risk early — spike the hard parts before committing. |
| `dep` | Dependency-first | What must exist before what? Build a dependency graph. Sequence work so nothing blocks on something not yet built. Surface hidden dependencies. |
| `user` | User-first | What does the end user actually need? Work backward from the user journey. Every task should trace to a user-visible outcome. |

## Recipe

### Phase 0 — Scope (1 subagent)

If the idea is empty → stop with `{ error: 'No idea provided. Pass the idea as the args parameter.' }`.

Dispatch ONE scope agent. It MUST return strict JSON matching `SCOPE_SCHEMA`:
`{ "idea": str, "constraints": [str], "goals": [str], "assumptions": [str], "openQuestions": [str] }`
(all five keys required; arrays may be empty).

Scope prompt (verbatim intent from the built-in):

```
Understand this idea and extract structure for planning.

## Idea
<IDEA>

## Task
1. Restate the idea clearly (normalize vague wording).
2. Extract explicit constraints mentioned. If none, leave empty.
3. Extract goals/success criteria. If implicit, infer reasonable ones.
4. Note assumptions you are making to fill gaps.
5. List open questions the user should answer for a tighter plan.

Keep everything concise. Structured output only.
```

If scope is skipped/empty → stop: `Scope skipped.`
Log: `Idea scoped: <N> goals, <M> constraints, <K> assumptions`.

Build a `CONTEXT` block reused by every planner and judge:

```
## Idea
<scope.idea>

## Goals
- goal1
- goal2

## Constraints
- constraint1            (or "(none stated)")

## Assumptions (made by scope)
- assumption1            (or "(none)")

## Open questions (from scope)
- openQuestion1          (or "(none)")
```

This carries `scope.assumptions` AND `scope.openQuestions` through to every planner, judge, and the synthesizer — so the synthesize step (which is told to "Open with any assumptions and open questions from scope") actually has them.

### Phase 1 — Draft (4 planners, dispatched IN PARALLEL)

Dispatch all 4 in a SINGLE message (4 Agent calls), one per lens. `subagent_type: general-purpose`.
Each MUST return strict JSON matching `DRAFT_SCHEMA`: `{ "plan": str, "risks": [str], "gaps": [str] }`.
Carry the lens `key`/`label` alongside each returned draft (the schema doesn't include them).

Each planner prompt = `CONTEXT` + the lens block:

```
## Your lens: <lens.label>
<lens.focus>

## Task
Write a complete implementation plan from the <lens.label> perspective.
- Use numbered phases/steps.
- Be concrete: file paths, commands, decisions to make.
- List risks: things that could derail this plan.
- List gaps: things this plan doesn't address.

Structured output only.
```

Keep only drafts that returned (filter nulls). If zero drafts survive → stop:
`{ error: 'All drafts skipped.', scope }`. Log: `<N> drafts ready`.

### Phase 2 — Judge (4 judges, dispatched IN PARALLEL)

Build a `draftsBlock` listing every surviving draft:

```
### <label> (key: <lens>)
<plan>

Risks: <risk1; risk2; ...>
Gaps: <gap1; gap2; ...>
```

…joined with `\n\n---\n\n`.

Dispatch 4 identical judge agents in ONE message (indices 0–3). Each MUST return strict
JSON matching `JUDGE_SCHEMA`: `{ "rankings": [ { "lens": str, "score": number, "rationale": str }, ... ] }`
with one entry per draft, using the exact `lens` key.

Judge prompt (verbatim intent) = `CONTEXT` +:

```
## Your task: rank these <N> plans

<draftsBlock>

## Scoring
Score each plan 1-10 on overall quality for THIS idea. Consider:
- Completeness (does it cover the goals?)
- Practicality (can this actually be executed?)
- Risk awareness (are the risks real and addressed?)
- Sequencing (does the order make sense?)

Return rankings for ALL plans. Use the 'lens' key exactly as shown.
Structured output only.
```

**Aggregate (you do this in-context, mirroring the JS):**

1. For each lens, accumulate `total` score, `votes` count, and `rationales[]` across all valid judges (ignore rankings for unknown lens keys).
2. `avgScore = votes > 0 ? total / votes : 0`. Keep full precision for sorting; round to 1 decimal place only for display.
3. Sort drafts by `avgScore` descending. Tie-break: higher `votes` count first; if still tied, lens order `mvp > risk > dep > user`. `winner = ranked[0]`, `runnersUp = ranked.slice(1)`.
4. Log: `Winner: <winner.label> (avg <winner.avgScore>/10)`.

### Phase 3 — Synthesize (1 subagent)

Dispatch ONE synthesizer agent. No strict schema — it returns the final plan as a
ready-to-act document (label `synthesize`).

Synthesize prompt = `CONTEXT` +:

```
## Winning plan: <winner.label> (avg score <winner.avgScore>/10 across <J> judges)

<winner.plan>

## Judge rationales
- <rationale1>
- <rationale2>

## Other plans (for grafting good ideas)
### <runnerUp.label> (<avgScore>/10)
<runnerUp.plan>
...

## Task
Produce the FINAL plan.
1. Start from the winning plan's structure.
2. Graft in any clearly-better ideas from the runners-up.
3. Incorporate the risks/gaps all plans surfaced.
4. Open with any assumptions and open questions from scope — the user should confirm these.

Write it as a document the user can act on immediately. No preamble.
```

## Output format

Print the synthesized plan as the primary deliverable, then a short run footer:

```
<the final synthesized implementation plan — open with assumptions + open questions to confirm>

---
**Winner: <label> (<avgScore>/10)**
Scoreboard: one `<lens> <avgScore>/10` entry per SURVIVING draft, joined by ` · ` (do NOT hardcode all four lenses — drafts can be filtered/dropped). E.g. `mvp 8.5/10 · risk 7.0/10 · user 6.5/10`.
Stats: <D> drafts, <J> judges, <agentCalls> agent calls.
```

Where `agentCalls = 1 (scope) + D (drafts) + J (judges) + 1 (synthesize)`. All `<avgScore>` values are displayed rounded to 1 decimal place.

## Notes

- The four lenses are the whole point — do NOT collapse them into one "balanced" planner.
  Diversity of priors is what gives the judge panel something to choose between.
- Judges are identical on purpose (4 votes over the same rubric) — averaging smooths out a
  single judge's bias. Use the exact `lens` key in rankings or the aggregation drops the vote.
- This skill is plan-only; it never edits files or runs build commands. (Contrast with
  `autopilot`, which builds.) Hand the synthesized plan to `/autopilot-demo` or a human to execute.
- For read-heavy scoping of an existing codebase, the scope/planner agents may `subagent_type: Explore`;
  for greenfield ideas `general-purpose` is fine.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
