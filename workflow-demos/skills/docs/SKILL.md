---
name: docs
description: 'Document a feature, API, or subject end-to-end — discover the public surface, outline, write the docs, verify examples/links, and open a PR. Dispatches a 5-stage subagent pipeline (Discover → Outline → Write → Verify → PR) where Write CREATES/UPDATES documentation files and PR commits + pushes them. Use for "document this", "write docs for X", "add documentation", "update the README/docs for this feature", or the /docs-demo slash command. Faithful recreation of the Claude Code built-in `docs` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org). NOTE: this skill WRITES files and opens a PR; it is not read-only.'
---

# docs (skill)

## Purpose

Produce accurate, convention-matching documentation for a subject the user names — a feature, an API surface, a CLI, a config area — and land it as a PR. This is a recreation of Claude Code's built-in `docs` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

Unlike `review-branch` (read-only), this skill **writes and updates documentation files** and opens a PR. Treat it as a build loop for docs.

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `pipeline` (sequential `await agent(...)`) | manual staging — each phase consumes the prior phase's JSON before the next dispatch |
| conditional `if (issues.length > 0) await agent(...)` | dispatch the Verify:fix subagent ONLY when Verify returns a non-empty `issues` array |
| `phase()` / `log()` | progress narration to the user |
| early `return { error }` guards | stop the pipeline and report when a stage is skipped or `done=false` |

This recipe is a strict **pipeline** (no parallelism) — each of the 5 stages depends on the previous one's structured output. Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history browser. We keep 100% of the doc-authoring logic.

## Inputs

- **subject** (required): what to document — a feature name, a path, an API/CLI surface, or a free-text description.
  - Empty → stop immediately: `"No subject provided. Pass what to document as args."`

## Recipe

A single sequential pipeline. Each `agent(...)` below = one subagent dispatch (`subagent_type: general-purpose`) that MUST return strict JSON matching the named schema. Carry the structured result forward; build the shared `CONTEXT` block after Discover and reuse it.

### Schemas (return strict JSON; lifted from the built-in)

```
DISCOVER_SCHEMA  (required: surface, existingDocs, targetPath, audience, conventions)
  surface:      string[]   // file:symbol entries that make up the public surface
  existingDocs: string[]
  targetPath:   string     // where the new/updated doc should live
  audience:     string
  conventions:  string     // tone, format, and structure conventions from sibling docs

OUTLINE_SCHEMA  (required: title, sections)
  title:    string
  sections: { heading: string, covers: string }[]

IMPL_SCHEMA  (required: done, filesChanged, notes)        // used by Write AND Verify:fix
  done:         boolean
  filesChanged: string[]
  notes:        string
  blockers:     string[]   // optional

VERIFY_SCHEMA  (required: examplesOk, linksOk, accurate, issues)
  examplesOk: boolean
  linksOk:    boolean
  accurate:   boolean
  issues:     string[]

PR_SCHEMA  (required: prUrl, branch, summary)
  prUrl:   string
  branch:  string
  summary: string
  notes:   string   // optional
```

### Phase 1 — Discover (1 subagent → DISCOVER_SCHEMA)

`phase('Discover')`. Dispatch one agent with the subject:

```
Discover what needs documenting and where it should live.

## Subject
<TASK>

## Instructions
1. Grep/read the code to map the public surface: exported functions, types, CLI flags,
   config keys — whatever a user of this feature touches. List as file:symbol.
2. Find existing docs for this or adjacent features (README, docs/, CLAUDE.md, mdx).
   Note their location, format, and tone.
3. Decide the target path: update an existing doc if one covers this area, otherwise
   pick a path that matches the existing doc layout.
4. Identify the audience (end user, API consumer, contributor) and the conventions to follow.
```

If the agent returns nothing → stop: `"Discover step skipped."`
`log('Surface: <N> items, target: <targetPath> (<audience>)')`.

Build the shared `CONTEXT` block (reused by Outline and Write):

```
## Subject
<TASK>

## Surface
- <surface[0]>
- <surface[1]>
  ...

## Target
<targetPath> (audience: <audience>)

## Conventions
<conventions>
```

### Phase 2 — Outline (1 subagent → OUTLINE_SCHEMA)

`phase('Outline')`. Dispatch one agent = `CONTEXT` + the instruction block:

```
## Instructions
Draft a section outline for <targetPath>.
Match the structure of sibling docs. Cover: what it is, when to use it, how to use it
(with at least one runnable example), key options/API, and gotchas. Keep it lean —
no section that does not earn its place.
```

If nothing returned → stop: `"Outline step skipped."` (carry `discover` in the report).
`log('Outline: <N> sections')`.

### Phase 3 — Write (1 subagent → IMPL_SCHEMA) — WRITES FILES

`phase('Write')`. Dispatch one agent = `CONTEXT` + the rendered outline + existing-docs list + instructions:

```
## Outline
1. <heading> — <covers>
2. <heading> — <covers>
   ...

## Existing docs to reference
<existingDocs joined by ", "  — or "(none)">

## Instructions
Write the documentation at <targetPath> following the outline.
- Code examples must be REAL — copy from working code or tests, not invented.
- Match the tone and format of sibling docs.
- If updating an existing file, preserve unrelated sections.
- Update any nav/index files if the doc layout requires it.
```

If the agent returns nothing OR `done=false` → stop: `"Write incomplete."` (carry `discover`, `outline`, and `blockers`).
`log('Wrote: <filesChanged joined by ", ">')`.

### Phase 4 — Verify (1 subagent → VERIFY_SCHEMA; + conditional 1 fix subagent → IMPL_SCHEMA)

`phase('Verify')`. Dispatch one verifier over the files just written:

```
Verify the documentation just written.

Files: <filesChanged joined by ", ">

## Instructions
1. Extract every code example and run/compile it (or typecheck it). Flag any that fail.
2. Check every relative link and cross-reference resolves to a real file or anchor.
3. Spot-check accuracy: pick 3 claims about behavior and verify them against the code at
   - <surface[0]>
   - <surface[1]>
     ... (first 5 surface entries)
4. List concrete issues found (empty if clean).
```

`issues = verify.issues` (or `[]` if the verifier returned nothing).
`log('Verify: examples <OK|FAIL>, links <OK|FAIL>, <N> issues')`.

**Conditional fix** — ONLY if `issues.length > 0`, dispatch one fix subagent (label `verify:fix`, phase `Verify`, IMPL_SCHEMA):

```
Fix these documentation issues:
1. <issue>
2. <issue>
   ...

Files: <filesChanged joined by ", ">
```

`fixNotes = fixed.notes` (or `(fix skipped)`); if no fix was needed, `fixNotes = '(clean)'`.

### Phase 5 — PR (1 subagent → PR_SCHEMA) — COMMITS + PUSHES

`phase('PR')`. Dispatch one agent:

```
Open a PR for this documentation change.

## Subject
<TASK>

Files: <filesChanged joined by ", ">

## Instructions
1. Run lint/format on the doc files if the repo has a docs linter.
2. Commit, push, open a PR. Summarize what was documented and why.
3. Return PR URL, branch, and a 2-3 sentence summary.
```

## Output format

Return the run summary (mirrors the built-in's return object):

```
# Docs — <subject>

**Summary:** <pr.summary>   (or "PR step incomplete. Docs written to <filesChanged>.")
- PR: <prUrl>            (null if PR step incomplete)
- Branch: <branch>       (null if PR step incomplete)
- Target path: <targetPath>
- Files changed: <filesChanged>
- Outline: <section headings>
- Verify: examples <examplesOk>, links <linksOk>, <issues count> issues
- Fix notes: <fixNotes>
```

## Notes

- This skill is a **pure pipeline** — 5 stages, run strictly in order, no parallelism. Do not batch the agents; each one needs the prior one's JSON.
- **6 subagent dispatches max:** Discover, Outline, Write, Verify, (conditional) Verify:fix, PR. The fix dispatch fires only when Verify surfaces issues.
- **It writes files.** Phase 3 creates/updates docs and may touch nav/index files; Phase 5 commits and pushes. Be on a branch you can push.
- Each early-return guard (Discover skipped / Outline skipped / Write incomplete) stops the pipeline and reports what was gathered so far — do not push past a failed stage.
- Code examples must be REAL (copied from working code/tests), and the Verify stage is load-bearing: it actually runs/typechecks examples and resolves links. Do not skip it.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
