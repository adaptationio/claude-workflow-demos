---
name: review-branch
description: Multi-dimension adversarial code review of a branch diff (or a specified path/diff-range). Dispatches 6 parallel reviewers (bugs, simplicity, architecture, dead-code, best-practices, existing-patterns), runs an adversarial verifier per finding to kill false positives, then synthesizes a deduped severity-grouped report. Use for "review this branch", "review my changes", "code review before PR", or the /review-branch-demo slash command. Faithful recreation of the Claude Code built-in `review-branch` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org).
---

# review-branch (skill)

## Purpose

Run a high-signal, low-false-positive code review over a set of changes. This is a recreation of Claude Code's built-in `review-branch` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel([...])` | multiple Agent calls in ONE message |
| `pipeline(stage1, stage2)` | manual staging — finish reviewers, then dispatch verifiers |
| `phase()` / `log()` | progress narration to the user |

Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history browser. We keep 100% of the review logic.

## Inputs

- **scope** (optional): a path (`src/foo.ts`), a git diff range (`HEAD~3...HEAD`), or empty.
  - Empty → default to the branch diff `origin/main...HEAD` (fall back to `main...HEAD` if no remote).
  - A path → review just that file/dir.
  - A diff range → review that range.

## Recipe

### Phase 0 — Scope (1 subagent OR inline bash)

Determine what to review and build a shared context header.

1. Resolve diff base: `git rev-parse origin/main` → fallback `main`. (Skip if scope is an explicit path.)
2. File list: `git diff <base>...HEAD --name-only` (or `ls`/`git ls-files` for an explicit path).
3. Stats: `git diff <base>...HEAD --stat`.
4. Read project-root `CLAUDE.md` if present; extract a <500-word summary of conventions/patterns/rules (empty string if none).
5. If zero files changed → stop: "No changes to review."

Build a `CONTEXT_HEADER` string reused by every reviewer/verifier:

```
<context>
## Diff base: <base>   (or "## Scope: <path>")
## Changed files (N)
  - file1
  - file2
## Stats
<git diff --stat output>
## Conventions (CLAUDE.md)
<summary, if any>
</context>
```

### Phase 1 — Review (6 reviewers, dispatched IN PARALLEL)

Dispatch all 6 in a SINGLE message (6 Agent calls). Each reviews ONE dimension only. `subagent_type: general-purpose`. Each MUST return strict JSON: `{ "findings": [ {file, line, severity, title, description, suggestion}, ... ] }` where `severity ∈ {high, medium, low}`. Empty findings is valid.

Each reviewer prompt = `CONTEXT_HEADER` + the role block below. Reviewers run `git diff <base>...HEAD` (or read the scoped path) themselves.

The 6 dimensions (focus text lifted verbatim from the built-in):

1. **Bugs** — correctness issues: null/undefined handling, off-by-one errors, race conditions, incorrect error handling, resource leaks (unclosed handles, unbounded caches), type confusion, logic errors. Be precise about WHY it's a bug — what input triggers it?
2. **Simplicity** — unnecessary complexity: over-engineering, premature abstraction, unnecessary indirection, overly clever code, redundant conditionals, configuration for hypothetical needs. Ask: can this be simpler without losing functionality?
3. **Architecture** — structural issues: tight coupling, poor cohesion, layering violations, misplaced responsibilities, leaky abstractions, modules doing too many things. Is each module/function doing one thing well?
4. **Dead Code** — unreachable or unused code: unused exports, unreachable branches, stale feature flags, commented-out code, debug leftovers, defensive checks for impossible states. Use grep/LSP to verify zero callers before flagging an export as dead.
5. **Best Practices** — hygiene: error handling patterns, type safety (avoid `any`, narrow types), async/await correctness (unhandled rejections, missing awaits), resource cleanup, naming clarity, avoiding common pitfalls.
6. **Existing Patterns** — consistency with existing codebase conventions. Grep for similar existing code and compare: does the new code follow the same patterns for state management, error handling, file layout, naming? Check CLAUDE.md rules. Flag divergence, not stylistic preference.

Reviewer ground rules (append to every reviewer prompt):
- Only report REAL issues in your category. No nitpicks, no style opinions unless they violate explicit project conventions.
- Each finding MUST cite a specific `file:line`.
- Be thorough but precise. Ten good findings beat fifty vague ones.
- Empty findings is a valid result if the code is clean in this dimension.

### Phase 2 — Adversarial verify (1 verifier per finding)

Collect all findings. Apply budget: **cap 25 verifications**, severity-sorted so HIGH always gets a slot; drop medium/low beyond budget (record them as "budget-dropped").

For each finding within budget, dispatch a verifier subagent (these can run in parallel batches). The verifier's PRIMARY job is to REJECT false positives. It MUST return strict JSON: `{ "verdict": "confirmed"|"rejected"|"unclear", "confidence": "high"|"medium"|"low", "reasoning": "..." }`.

Verifier prompt = `CONTEXT_HEADER` + (verbatim from built-in):

```
## Role: Adversarial Verifier
Your PRIMARY job is to REJECT false positives.

A reviewer claims this is a <dimension> issue:
File: <file>:<line>
Severity: <severity>
Claim: <title>
Their reasoning: <description>
Their suggested fix: <suggestion>

Your task:
1. Read <file> around line <line> (and `git diff <base>...HEAD -- <file>`).
2. Try HARD to find a reason this is NOT a real issue:
   - Is there code elsewhere that handles this case?
   - Is this intentional behavior (check comments, git blame, related tests)?
   - Is the reviewer misreading the code?
   - Is this theoretically possible but practically irrelevant?
3. Only confirm if the issue clearly survives scrutiny.

Reject freely. False positives waste human time. If unsure after
investigation, return 'unclear' — do NOT default to 'confirmed'.
```

### Phase 3 — Synthesize report (1 subagent OR inline)

1. Split findings into `confirmed` / `unclear` / `rejected`.
2. If `confirmed` is empty → report "No confirmed issues" (+ note any `unclear` worth a manual look).
3. Else, synthesize: **semantically dedup** (the same root cause flagged by two dimensions = ONE issue — combine descriptions), group by severity (high/medium/low), and for each give `file:line`, one-line title, brief description, suggested fix, and which dimension(s) flagged it.
4. End with a summary line: `N high, M medium, K low (after dedup)`.

## Output format

```
# Code Review — <scope>

## High (N)
- `file:line` — <title>
  <description>. Fix: <suggestion>  [dims: bugs, architecture]

## Medium (M)
...

## Low (K)
...

## Unclear (worth a manual look) — optional
...

**Summary: N high, M medium, K low (after dedup). Reviewed F files, V findings verified, R rejected.**
```

## Notes

- For read-only review, `subagent_type: Explore` is cheaper; for verify steps that may need git blame, `general-purpose` is fine.
- Keep reviewers scoped to ONE dimension — overlap is handled by the dedup step, not by broad reviewers.
- The adversarial verifier is the load-bearing part. Do not skip it; it is what makes the output trustworthy.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
