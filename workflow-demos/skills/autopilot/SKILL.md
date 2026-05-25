---
name: autopilot
description: 'End-to-end "task → merged PR" build loop driven by subagents. Takes a task description and runs Plan (draft + 5 parallel critics + harden) → Implement → Review (3 rapid + 2 deep bughunters + adversarial verify, parallel with a completeness check) → Fix → PR. Use for "autopilot this", "build this feature end to end", "implement and open a PR for X", "drive this task to a PR", or the /autopilot-demo slash command. Faithful recreation of the Claude Code built-in `autopilot` workflow using subagents — works WITHOUT the gated Workflow tool (`tengu_workflows_enabled` is OFF fleet-wide). NOTE: this MODIFIES code (it is a build workflow, not review-only).'
---

# autopilot (skill)

## Purpose

Drive a single task description all the way from "what to build" to "PR opened" without hand-holding. This is a recreation of Claude Code's built-in `autopilot` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even though the native `Workflow` tool is gated off (`tengu_workflows_enabled` is OFF for all our Anthropic orgs — see `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`).

Unlike `review-branch` (read-only), autopilot **writes code, runs verification, and opens a pull request**. Treat it as a build loop, not an audit.

Source of truth for the recipe: `wiki/concepts/cache/claude-code-workflows-builtin/autopilot.js`.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel([...])` | multiple Agent calls in ONE message (e.g. the 5 plan critics, the verifier votes) |
| `pipeline(items, map, reduce)` | manual staging — produce finder bugs, then feed survivors into the verify reduce step |
| `Promise.all([...])` | run two independent sub-flows together (the bughunt pipeline and the completeness check) |
| `phase()` / `log()` | progress narration to the user |

Tradeoff vs native: we lose replay-safe determinism (`resumeFromRunId`) and the `/workflows` run-history browser. We keep 100% of the build logic, schemas, and budgets.

## Inputs

- **task** (required): a concrete task description — the thing to build/fix/change. Passed as `$ARGUMENTS`.
  - If empty → stop: "No task provided. Pass the task description as args."

## Schemas

Each subagent returns strict JSON. These are the schemas lifted from the built-in:

- **PLAN_SCHEMA** — `{ summary: string, files: string[], steps: string[], risks: string[], reuse?: string[] (existing utilities/functions to reuse, file:line), verification?: string }`. Required: `summary, files, steps, risks`.
- **CRITIQUE_SCHEMA** — `{ verdict: "PASS"|"REVISE", holes: [{ issue: string, severity: "blocker"|"major"|"minor", suggestion?: string }] }`. Required: `verdict, holes`.
- **IMPL_SCHEMA** — `{ done: boolean, filesChanged: string[], notes: string, blockers?: string[] }`. Required: `done, filesChanged, notes`.
- **BUGS_SCHEMA** — `{ bugs: [{ file: string, line?: number, title: string, description: string, severity: "critical"|"high"|"medium"|"low"|"nit" }] }`. Required: `bugs`.
- **VERDICT_SCHEMA** — `{ refuted: boolean, evidence: string }`. Required: `refuted, evidence`.
- **COMPLETENESS_SCHEMA** — `{ covered: boolean, gaps: [{ what: string, where: string }] }`. Required: `covered, gaps`.
- **PR_SCHEMA** — `{ prUrl: string, branch: string, summary: string (2-3 sentence summary of what changed and why), lintPassed?: boolean, typecheckPassed?: boolean, autoFixSubscribed?: boolean, notes?: string }`. Required: `prUrl, branch, summary`.

## Recipe

### Phase 1 — Plan

**1a. Draft (1 subagent, `plan:draft`, PLAN_SCHEMA).** Dispatch ONE agent to scope the task and draft an implementation plan. Prompt (verbatim intent from built-in):

> Scope this task against the codebase and draft an implementation plan.
>
> ## Task
> `<TASK>`
>
> ## Instructions
> 1. Explore — find relevant files, existing patterns, utilities to reuse. Actively search for existing functions and utilities that can be reused; avoid proposing new code when suitable implementations already exist.
> 2. Read CLAUDE.md at project root and in parent dirs of relevant files.
> 3. Draft a concrete plan: files to touch, what edits, in what order.
> 4. Call out existing code to reuse with file:line.
> 5. List risks and describe verification (test command, manual check).
>
> Be concrete — file paths and function names, not vague intentions.

If the draft is skipped/empty → stop with `{ error: 'Plan draft skipped.' }`. Else `log('Draft: <N> files, <M> steps')` and build a `PLAN_BLOCK` string (Task + summary + Files + numbered Steps + Reuse + Risks + Verification) reused by the critics.

**1b. Critique (5 critics, dispatched IN PARALLEL, `plan:critic-<key>`, CRITIQUE_SCHEMA).** Dispatch all 5 in a SINGLE message. Each reviews ONE angle ONLY (focus text lifted verbatim):

1. **scope** — Is the plan over- or under-scoped vs the ask? Does it do more than needed, or miss part of the request? Is this a spot fix where the underlying problem should be addressed more broadly, or the right-sized change?
2. **simplicity** — Could this be simpler? Unnecessary abstractions, files that do not need touching, steps that could merge. What is the minimal diff?
3. **reuse** — Does it call out existing code to reuse with file paths? Grep for similar utilities — is it reinventing something that exists? Does the approach match how neighboring code does similar things?
4. **verification** — Are the test/verify steps concrete enough to catch a regression? Is there a runnable command, or is it hand-wavy?
5. **correctness** — Will this plan actually solve the stated problem? Trace the logic — does the proposed change address the root cause? Grep for other code paths with the same pattern — are there sibling call sites that need the same fix?

Critic prompt = `PLAN_BLOCK` + the angle/lens + (verbatim):

> ## Instructions
> Review this plan from the `<key>` angle ONLY. Other reviewers cover the rest.
> Read the actual files it references. Verify claims against the codebase.
> Verdict PASS if the plan is good enough to proceed from your angle.
> Verdict REVISE with concrete holes otherwise — 'step 3 will not work because X', not 'might have issues'.
> Severity: blocker = plan will fail; major = works but poorly; minor = nit.

Collect `holes` (each tagged with its critic key). `needsRevise` = any critic returned `verdict === 'REVISE'`. `log('<H> holes (<B> blockers), REVISE|PASS')`.

**1c. Harden (1 subagent, conditional, `plan:harden`, PLAN_SCHEMA).** If `needsRevise` is false → the draft IS the final plan (skip this step). Else dispatch ONE agent to revise:

> `<PLAN_BLOCK>`
> ## Critique (`<H>` holes from 5 critics)
> - [`<severity>`, `<critic>`] `<issue>` → `<suggestion>`
> ...
>
> ## Instructions
> Revise the plan. Blockers MUST be resolved. Majors addressed or explicitly acknowledged as tradeoffs. Minors optional. Output the revised plan in the same schema.

If hardening is skipped → stop with `{ error: 'Plan hardening skipped.', draft, holes }`.

### Phase 2 — Implement

**1 subagent (`implement`, IMPL_SCHEMA).** Build a `HARDENED_BLOCK` from the final plan (same shape as PLAN_BLOCK). Dispatch ONE agent to execute:

> `<HARDENED_BLOCK>`
> ## Instructions
> Execute this plan. Make the edits. Run the verification step.
> Adapt if you hit something the plan missed — but note it.
> Return done=false with blockers if you cannot proceed.

If `impl` is missing OR `impl.done === false` → stop with `{ error: 'Implementation incomplete.', plan, blockers }`. Else `log('Implemented: <N> files changed')`.

### Phase 3 — Review (bughunt-lite + completeness, run together)

Budgets/constants (verbatim): `VOTES = 5`, `REFUTE_KILL = 2`, `MAX_VERIFY = 20`. Severity rank `critical<high<medium<low<nit`. Dedup key = `<file>:<round(line/5)*5>`. Shared diff instruction:

> Run `git diff $(git merge-base HEAD origin/main)` to see all changes (committed + uncommitted). If origin/main doesn't exist, try `main` or `origin/HEAD`.

Run TWO independent sub-flows TOGETHER (built-in `Promise.all`):

**3a. Bughunt pipeline** — 5 finders, then verify the survivors.

Finders (`BUGS_SCHEMA`, dispatch as a staged pipeline):
- **3× rapid scanner** (`rapid-0/1/2`, biased to first / middle / last third): "Quick surface scan. Report 5-10 obvious issues: logic errors, null derefs, CLAUDE.md violations, missing awaits. Breadth over depth. Bias toward the `<first|middle|last>` third of the diff. Structured output only."
- **2× deep analyst** (`deep-0/1`): "Find subtle issues. Read full files, grep callers, trace data flow. Invariant violations, races, edge cases (empty/null/concurrent). Pick `<the most significant change | a DIFFERENT area>`. 1-3 findings. Structured output only."

Pipeline reduce step: for each finder result, severity-sort its bugs, then keep only NOVEL bugs (dedup by key, AND drop medium/low/nit once `MAX_VERIFY` slots are exhausted — high/critical always keep a slot). Decrement the slot counter as you admit each novel bug. Then verify each admitted bug.

Per-bug adversarial verify (`verifyBug`, `VERDICT_SCHEMA`) — **staged voting to save budget**:
1. Dispatch votes **0 and 1 in parallel**. If ≥`REFUTE_KILL` (2) refute → bug dies immediately (`survives: false`), skip the remaining votes.
2. Otherwise dispatch votes **2, 3, 4 in parallel**. Count total refutes across all 5; `survives = refutes < REFUTE_KILL`.

Verifier prompt (`v<n>:<file>`, verbatim):

> ## Adversarial verifier `<v+1>`/5
> Be SKEPTICAL. Try to REFUTE. ≥2 refutes kill it.
>
> **Candidate:** `<file>:<line>` — `<title>`
> `<description>`
>
> `<DIFF_INSTR>` Read the file. Check callers, error handling, conventions.
> refuted=true if: unreachable, handled, intentional, pre-existing, wrong.
> refuted=false ONLY if real, new, material. Default refuted=true when uncertain.
> Evidence must cite file:line.

**3b. Completeness check** (1 subagent, `review:completeness`, COMPLETENESS_SCHEMA) — runs in PARALLEL with 3a (it is independent of diff-local findings):

> ## Completeness check
>
> ## Original task
> `<TASK>`
>
> ## Plan that was executed
> `<plan.summary>`
> Files planned: `<plan.files>`
>
> ## Instructions
> `<DIFF_INSTR>`
> Compare the diff against the task. Did the implementation cover everything?
> Look for: callers that should have been updated, tests that should exist, docs/types that should have changed, parts of the ask that were missed.
> covered=true if the task is fully addressed. Otherwise list concrete gaps with file paths.

Collect: `voted` = all verified bugs, `confirmed` = those that `survives`, `gaps` = completeness gaps if `covered === false`. `log('Review: <voted> voted → <confirmed> confirmed, <gaps> completeness gaps')`.

### Phase 4 — Fix (conditional)

`fixNotes = '(clean — no fixes needed)'` by default. If `confirmed.length > 0 || gaps.length > 0` → dispatch ONE agent (`fix`, IMPL_SCHEMA):

> Address confirmed review findings.
>
> ## Bugs (`<N>`, survived adversarial verify)
> 1. [`<severity>`] `<file>:<line>` — `<title>`
>    `<description>`
> ...
>
> ## Completeness gaps (`<M>`)
> 1. `<what>` (at `<where>`)
> ...
>
> ## Instructions
> Fix each item. If one turns out to be a false positive, note why and skip. Summarize what you changed.

`fixNotes` = `(fix skipped)` if skipped; `INCOMPLETE — <blockers>. <notes>` if `done === false`; else `fixResult.notes`.

### Phase 5 — PR

**1 subagent (`pr`, PR_SCHEMA).** Dispatch ONE agent to finalize and open the PR:

> Finalize and open a PR.
>
> ## Task
> `<TASK>`
>
> ## What was done
> `<plan.summary>`
>
> ## Instructions
> 1. Run lint and typecheck. Fix any failures.
> 2. If on main, create a kebab-case branch from the task.
> 3. Commit with a clear message. Push. Open a PR (use template if present). Assign reviewers based on CODEOWNERS or recent git blame against the base branch for the touched files.
> 4. After the PR is created, enable auto-fix by calling the `mcp__github__subscribe_pr_activity` tool with `{owner, repo, pullNumber}` parsed from the PR URL. This subscribes the session to CI failures and review comments so they can be addressed automatically. Set autoFixSubscribed=true if the call succeeds. If that tool is not available in this environment, skip this step and set autoFixSubscribed=false.
> 5. Return the PR URL, branch name, autoFixSubscribed, and a 2-3 sentence summary of what changed and why.

## Output format

Return the run summary (built-in's final return object):

```
# Autopilot — <task one-liner>

**PR:** <prUrl>  (branch: <branch>, auto-fix subscribed: <yes|no|n/a>)

**Summary:** <2-3 sentence summary of what changed and why>

## Plan
<plan.summary>
Files: <plan.files>

## Critique
<H> holes (<B> blockers)

## Review
<voted> voted → <confirmed> confirmed, <gaps> completeness gaps

## Fix
<fixNotes>
```

If the PR step is incomplete, `summary` falls back to `'PR step incomplete. ' + (impl.notes || plan.summary)` and `prUrl/branch` are null.

## Notes

- **This workflow MODIFIES code and opens a PR.** It is the opposite of `review-branch` (read-only). Run it on a task you actually want built, on a branch you can push.
- Phase 1's plan critics and Phase 3's verifier votes are the load-bearing parallelism — dispatch them as multiple Agent calls in a single message, not sequentially.
- The staged verify (vote 0+1, then 2+3+4 only if not already killed) is a budget optimization from the built-in — preserve it to avoid spending all 5 votes on bugs that die in the first round.
- The completeness check runs concurrently with the bughunt because it depends only on the diff-vs-task comparison, not on the bug findings.
- `mcp__github__subscribe_pr_activity` may not exist in this environment — that is expected; the PR agent should set `autoFixSubscribed=false` and continue.
- For finder/critic subagents, `subagent_type: general-purpose` (they grep, read files, and may need git). The implement/fix/PR agents must be able to edit and run commands.
- Provenance + the other 9 built-ins: `wiki/concepts/cache/claude-code-workflows-builtin/autopilot.js`, concept page [[claude-code-workflows]], cheatsheet [[workflows-and-goals-cheatsheet]].
