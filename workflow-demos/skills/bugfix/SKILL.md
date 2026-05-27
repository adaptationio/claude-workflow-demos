---
name: bugfix
description: End-to-end single-bug fix loop driven from a bug report (Reproduce → Root-cause → Fix → Regress → PR). Dispatches a strictly sequential chain of 5 subagents — write the smallest failing repro, trace to the minimal root cause, apply the minimal fix and re-run the repro, harden the repro into a permanent regression test and run the suite, then lint/typecheck/branch/commit/push and open a PR. Hard-gates between phases (no repro → stop; fix not done → stop). Use for "fix this bug", "reproduce and fix", "here's a bug report — fix it", or the /bugfix-demo slash command. MODIFIES code. Faithful recreation of the Claude Code built-in `bugfix` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org).
---

# bugfix (skill)

## Purpose

Take a single bug report and drive it all the way to an opened PR: reproduce it with a failing test, find the real root cause (not the first symptom), apply the minimal fix, lock it in with a permanent regression test, and ship a clean PR. This is a recreation of Claude Code's built-in `bugfix` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

Unlike `review-branch` / `bughunt` (read-only fan-out reviews), `bugfix` is a **linear build pipeline that MODIFIES code and opens a PR**. It is the autopilot family: each phase is a single subagent, run strictly in order, with hard gates between phases — a failed reproduce, an incomplete fix, or a skipped phase short-circuits the whole run.

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {label, schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `phase('Reproduce')` … `phase('PR')` | sequential staging — finish one phase, gate on its result, then dispatch the next |
| `pipeline`-style data flow (`repro` → `rc` → `fix` → `regress` → `pr`) | you carry each phase's structured result in-context and splice it into the next prompt (`REPRO_BLOCK`, root-cause block) |
| early `return { error }` / `return { summary, reproduced:false }` | hard gates — STOP and report; do NOT proceed to the next phase |
| `log()` | progress narration to the user |

There is **no `parallel()` in bugfix** — every phase depends on the prior one's output, so the whole thing is single-threaded by design. Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history browser. We keep 100% of the fix logic — the repro-first discipline, root-cause-not-symptom tracing, minimal fix, regression hardening, and the gates.

## Inputs

- **TASK** (required): the bug report / description. Free text — a symptom, a stack trace, a linked failing case, "X does Y when it should do Z".
  - Empty → STOP immediately: `{ error: 'No bug description provided. Pass the bug report as args.' }`.

## Schemas (verbatim from the built-in)

```
REPRO_SCHEMA      required: reproduced(bool), reproPath(str), expected(str), actual(str), notes(str)
                  optional: reproCommand(str)
ROOT_CAUSE_SCHEMA required: rootCause(str), culprit(str = "file:line of the minimal fault"), callers(str[])
                  optional: fixApproach(str)
IMPL_SCHEMA       required: done(bool), filesChanged(str[]), notes(str)
                  optional: blockers(str[])
REGRESS_SCHEMA    required: testPath(str), testPassed(bool), suitePassed(bool), notes(str)
PR_SCHEMA         required: branch(str), summary(str)
                  optional: prUrl(str|null — null when no remote is configured), lintPassed(bool), typecheckPassed(bool), notes(str)
```

## Recipe

Five phases, strictly sequential. Each is ONE subagent (`subagent_type: general-purpose` — every phase reads/writes files and runs commands). Gate after each phase; carry the structured result forward.

### Phase 1 — Reproduce (1 subagent, `REPRO_SCHEMA`)

`phase('Reproduce')`. Dispatch one agent (label `reproduce`, schema `REPRO_SCHEMA`). Prompt (verbatim intent):

```
Reproduce this bug with a failing test or script.

## Bug report
<TASK>

## Instructions
1. Read the relevant code and any linked traces/logs to understand the claimed behavior.
2. Write the SMALLEST failing test or standalone script that demonstrates the bug. Prefer a
   test in the existing test framework; fall back to a script if no framework fits.
3. Run it. Confirm it FAILS with the expected vs actual mismatch.
4. If you cannot reproduce after a genuine attempt, set reproduced=false and explain why in notes.

Do NOT fix the bug yet — only reproduce it.
```

**Gates:**
- Agent returned nothing → STOP: `{ error: 'Reproduce step skipped.' }`.
- `reproduced === false` → STOP: `{ summary: 'Could not reproduce the bug. ' + repro.notes, reproduced: false, repro }`.

On success: `log('Reproduced: <reproPath> (expected <expected>, got <actual>)')`, then build the shared **`REPRO_BLOCK`** reused by Phases 2–4:

```
## Bug report
<TASK>

## Repro
Path: <repro.reproPath>
Command: <repro.reproCommand>          # only if present
Expected: <repro.expected>
Actual: <repro.actual>
Notes: <repro.notes>
```

### Phase 2 — Root-cause (1 subagent, `ROOT_CAUSE_SCHEMA`)

`phase('Root-cause')`. Dispatch one agent (label `root-cause`, schema `ROOT_CAUSE_SCHEMA`). Prompt = `REPRO_BLOCK` +

```
## Instructions
Find the ROOT cause — not the first place the symptom appears.
1. Trace backwards from the failure point. Read the code paths the repro exercises.
2. Grep for callers and sibling code paths that touch the same state — note any that share the fault.
3. Identify the minimal culprit (file:line). Distinguish the root cause from downstream symptoms.
4. Propose the smallest fix approach that addresses the root cause, not a patch over the symptom.
```

**Gate:** agent returned nothing → STOP: `{ error: 'Root-cause step skipped.', repro }`.

On success: `log('Root cause: <culprit> — <rootCause>')`.

### Phase 3 — Fix (1 subagent, `IMPL_SCHEMA`) — MODIFIES CODE

`phase('Fix')`. Dispatch one agent (label `fix`, schema `IMPL_SCHEMA`). Prompt = `REPRO_BLOCK` +

```
## Root cause
<rc.rootCause>
Culprit: <rc.culprit>
Callers sharing the fault: <rc.callers joined by ", " | "(none)">
Approach: <rc.fixApproach | "(not specified)">

## Instructions
Apply the minimal fix at the root cause. Update sibling callers if they share the fault.
Re-run the repro (<repro.reproCommand>) — it MUST now pass.
Return done=false with blockers if the repro still fails after your fix.
```

**Gate:** agent returned nothing OR `done === false` → STOP:
`{ error: 'Fix incomplete.', repro, rootCause: rc, blockers: fix.blockers ?? ['skipped'] }`.

On success: `log('Fixed: <filesChanged.length> files changed')`.

### Phase 4 — Regress (1 subagent, `REGRESS_SCHEMA`) — MODIFIES CODE

`phase('Regress')`. Dispatch one agent (label `regress`, schema `REGRESS_SCHEMA`). Prompt = `REPRO_BLOCK` +

```
## Fix applied
<fix.notes>
Files changed: <fix.filesChanged joined by ", ">

## Instructions
1. Convert the repro at <repro.reproPath> into a permanent regression test in the right
   location for this codebase. If it is already a proper test, tighten the assertion and
   naming so it clearly describes the bug it guards against.
   If the repro was a scratch script (not already a committed test), move its logic into
   the permanent regression test and delete the scratch file — leave no untracked scratch behind.
2. Run the regression test — it must PASS.
3. Run the full test suite for the touched module(s) — flag any new failures.
Return testPassed and suitePassed honestly.
```

**Gate:** agent returned nothing → STOP: `{ error: 'Regression step skipped.', repro, rootCause: rc, fix }`.

On success: `log('Regression test: <testPath> (test PASS|FAIL, suite PASS|FAIL)')`. Note: a `suitePassed === false` does NOT stop the run — it is carried into the PR phase as a warning to investigate before merge.

### Phase 5 — PR (1 subagent, `PR_SCHEMA`) — MODIFIES GIT / OPENS PR

`phase('PR')`. Dispatch one agent (label `pr`, schema `PR_SCHEMA`). Prompt:

```
Finalize and open a PR for this bug fix.

## Bug
<TASK>

## Root cause
<rc.rootCause> (at <rc.culprit>)

## Regression test
<regress.testPath>
NOTE: suite had failures — investigate before merging: <regress.notes>   # only if suitePassed === false

## Instructions
1. Run lint and typecheck. Fix any failures.
2. If on main, create a kebab-case branch from the bug.
3. Check for a git remote (`git remote` — empty output means none is configured).
   - If a remote EXISTS: commit with a clear message referencing the symptom and root cause,
     push, and open a PR. Include the repro steps and regression test path in the PR body.
   - If NO remote: skip `git push` and `gh pr create`. Commit locally on the branch, set
     prUrl=null, and note in the summary "PR step incomplete — no remote; branch + commit are local."
4. Return prUrl (null if no remote), branch, and a 2-3 sentence summary.
```

No hard gate after PR — it's the last phase. If the PR agent returns nothing, fall back to reporting the fix that was applied.

### Final return

```
summary:        <pr.summary | "PR step incomplete. Fix applied: " + fix.notes>
prUrl:          <pr.prUrl | null>
branch:         <pr.branch | null>
reproduced:     true
rootCause:      { summary: <rc.rootCause>, culprit: <rc.culprit> }
regressionTest: <regress.testPath>
testPassed:     <regress.testPassed>
suitePassed:    <regress.suitePassed>
```

## Output format

```
# Bug Fix — <one-line bug summary>

**Status:** PR opened ✅  (or: Could not reproduce / Fix incomplete / blocked)

## Reproduced
`<reproPath>` — expected `<expected>`, got `<actual>`.
Command: `<reproCommand>`

## Root cause
`<culprit>` — <rootCause>
Callers sharing the fault: <callers | none>

## Fix
<N> files changed: <filesChanged>. <fix.notes>

## Regression test
`<testPath>` — test <PASS|FAIL>, suite <PASS|FAIL>.
<suite-failure warning, if any>

## PR
<prUrl>  (branch `<branch>`)
<2-3 sentence summary>

**Summary: reproduced → root cause at <culprit> → <N> files fixed → regression test <PASS|FAIL>, suite <PASS|FAIL> → PR <opened|incomplete>.**
```

If an early gate fired, emit only the phases that ran plus the stop reason (e.g. "Could not reproduce: <notes>").

## Notes

- **Repro-first is load-bearing.** Phase 1 must produce a test/script that actually FAILS before any code is touched — no green-to-green "fix". If it can't reproduce, the run STOPS; you do not get to guess at a fix.
- **Root cause, not symptom.** Phase 2's whole job is to trace past the first place the error surfaces to the minimal fault, and to flag sibling callers sharing it so Phase 3 fixes them too.
- **Hard gates, single thread.** There is no parallelism — each phase consumes the prior phase's structured result. A skipped/failed Reproduce, Root-cause, Fix, or Regress agent short-circuits the run with a precise `error`/`summary`. Do not paper over a gate to keep going.
- **`suitePassed === false` is a warning, not a stop** — it flows into the PR body so a human investigates failing neighbours before merge; the PR still opens.
- This workflow MODIFIES code and git state (Phases 3–5: edits, branch, commit, push, PR). Run it on a branch you can push, on a bug you actually want fixed. Contrast with `/review-branch-demo` and `/bughunt-demo`, which are read-only.
- All phases use `subagent_type: general-purpose` — every phase runs commands and/or edits files; `Explore` is too narrow.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
