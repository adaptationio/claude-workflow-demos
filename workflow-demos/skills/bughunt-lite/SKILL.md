---
name: bughunt-lite
description: 'Fast, fixed-fleet bug hunt over a branch diff (or a specified path/diff-range). Dispatches a FIXED fleet of 5 finders (3 rapid surface scanners + 2 deep analysts) in parallel, runs 5-voter adversarial verification per candidate (2 refutations kill a bug; early-kill after the first 2 votes), naively dedups by file:line, then synthesizes a semantically-deduped, severity-grouped report. Lighter and faster than the full `bughunt`: no self-respawning slots, no dry-streak loop, no skip-key feedback — just one fixed wave of finders. Use for "quick bug hunt", "bughunt-lite", "fast bug scan of my branch", "hunt bugs before PR (light)", or the /bughunt-lite-demo slash command. Faithful recreation of the Claude Code built-in `bughunt-lite` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org).'
---

# bughunt-lite (skill)

## Purpose

Run a fast, breadth-first bug hunt over a set of changes and emit only the bugs that survive adversarial verification. This is a recreation of Claude Code's built-in `bughunt-lite` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

Faithfully translated from Claude Code's built-in workflow recipe.

**How it differs from `bughunt` (the full version):** `bughunt-lite` dispatches ONE fixed wave of 5 finders (3 rapid + 2 deep) and stops. The full `bughunt` runs self-respawning slots that keep spawning deep analysts (passing already-found locations as skip-keys) until a dry streak of 3 empty deep passes, overlapping find-and-verify with no barrier. Lite trades that adaptive depth for speed and predictable cost. Both share the same schemas, the 5-voter ≥2-refutation verification with 2-vote early-kill, the 20-verification budget, and the semantic-dedup synthesis.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel([...])` | multiple Agent calls in ONE message |
| `pipeline(items, stage1, stage2)` | manual staging — finders complete, harvest/dedup as they land, then verify |
| `phase()` / `log()` | progress narration to the user |

Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history browser. We keep 100% of the bug-hunt logic — the fixed fleet, the pigeonhole voting, the budget, and the synthesis.

## Inputs

- **scope** (optional): a path (`src/foo.ts`), a git diff range (`HEAD~3...HEAD`), or empty.
  - Empty → default to the branch diff base: `git rev-parse --verify origin/main 2>/dev/null || git rev-parse --verify main`, reviewed as `<base>...HEAD`.
  - A path → hunt just that file/dir.
  - A diff range → hunt that range.
  - On a no-remote repo, passing an explicit diff range (`HEAD~3...HEAD`) or a bare branch name is the recommended input — base auto-resolution falls back to local `main` but an explicit range avoids any ambiguity.

## Constants (verbatim from the built-in)

```
VOTES_PER_BUG       = 5     # adversarial voters per candidate bug
REFUTATIONS_REQUIRED = 2    # ≥2 refutations of 5 kill a bug
MAX_VERIFY          = 20    # total verification budget (slots)
```

Severity rank for budget/sort: `critical(0) < high(1) < medium(2) < low(3) < nit(4)`. Confidence rank for picking best evidence: `high(0) < medium(1) < low(2)`.

## Schemas (subagents MUST return strict JSON matching these)

- **SCOPE_SCHEMA** — `{ diffBase: string, files: string[], summary: string, conventions?: string }` (required: diffBase, files, summary).
- **BUGS_SCHEMA** — `{ bugs: [ { file: string, line?: number, title: string, description: string, severity: critical|high|medium|low|nit, category?: logic|security|performance|convention|correctness|resource-leak|race|other } ] }` (required per bug: file, title, description, severity).
- **VERDICT_SCHEMA** — `{ refuted: boolean, evidence: string, confidence: high|medium|low, severity?: critical|high|medium|low|nit }` (required: refuted, evidence, confidence).
- **REPORT_SCHEMA** — `{ summary: string, bugs: [ { file, line?, title, description, severity, vote: string, evidence: string, finder?: string } ] }` (required per bug: file, title, description, severity, vote, evidence). `finder` = finder id (optional).

## Recipe

### Phase 0 — Scope (1 subagent OR inline bash)

Discover the scope of changes on the current branch for a bug hunt. Return SCOPE_SCHEMA only.

1. Diff base: `git rev-parse --verify origin/main 2>/dev/null || git rev-parse --verify main` (no remote → resolves to local `main` without hard-erroring). (Skip if scope is an explicit path/range.)
2. Changed files: `git diff --name-only <diffBase>...HEAD`.
3. Summarize what changed in one paragraph.
4. Find CLAUDE.md files (root + parent dirs of changed files) and extract relevant conventions (empty string if none).

Guards:
- If scope is skipped/fails → stop: "Scope skipped."
- If `files.length === 0` → stop: "No changes on branch vs `<diffBase>`."
- Else `log(N + " files changed vs " + diffBase)`.

Build the `SCOPE_BLOCK` string reused by every finder/verifier prompt (small — each agent runs `git diff` itself to read the actual changes):

```
## Scope
Diff base: <diffBase>
Changed files (N):
  - file1
  - file2

## What changed
<summary>

## Conventions (CLAUDE.md)
<conventions, or "(none)">
```

### Phase 1 — Find (FIXED fleet of 5, dispatched IN PARALLEL)

Dispatch all 5 finders in a SINGLE message. The fleet is FIXED — exactly `[rapid 0, rapid 1, rapid 2, deep 0, deep 1]`. `subagent_type: general-purpose` (or `Explore` for read-only speed). Each returns BUGS_SCHEMA; empty `bugs` is valid.

Each finder prompt = `SCOPE_BLOCK` + the role block below.

**Rapid Surface Scanner (×3, idx 0/1/2)** — verbatim intent:
> ## Rapid Surface Scanner (idx+1/3)
> Quickly scan the change set. Report obvious issues. Do NOT deep-dive.
> ## Look for
> **P1** CLAUDE.md violations · **P2** Logic errors (copy-paste, wrong conditions, null derefs) · **P3** Resource (unbounded growth, missing await)
> ## Instructions
> 1. Run `git diff <diffBase>...HEAD`
> 2. Read changed files as needed
> 3. Report 5-12 bugs. Breadth > depth. OK to be wrong.
> 4. Bias toward the [first third / middle third / last third][idx] of files.
> Structured output only.

**Deep Analyst (×2, idx 0/1)** — verbatim intent:
> ## Deep Analyst (idx+1/2)
> Find subtle bugs requiring deep analysis.
> ## Process
> Run `git diff <diffBase>...HEAD` · Read full files · Grep callers of modified functions · Trace callees · Trace data flow
> ## Look for
> Invariant violations · Races · State mutation · Edge cases (empty/null/concurrent)
> Pick [idx 0: the most significant change | idx 1: a DIFFERENT subsystem]. Go DEEP. 1-3 findings.
> Structured output only.

> **Note (executor):** `idx+1/3`, `idx+1/2`, `[first third / middle third / last third][idx]`, and `[idx 0: … | idx 1: …]` above are TEMPLATES — interpolate the concrete `idx` value (e.g. rapid idx 0 → "Rapid Surface Scanner (1/3)" biased to the "first third"). Do NOT emit `idx` verbatim into the finder prompt.

### Phase 1.5 — Harvest + naive dedup (inline, as finders land)

In the built-in this is the `pipeline()` mid-stage that runs per finder result. Accumulate shared state across finders:

1. Sort each finder's bugs by severity (so high-priority bugs claim budget slots first).
2. For each bug compute `dedupKey = file + ":" + (line != null ? round(line/5)*5 : "x")` (5-line bucket).
   - If `seen` already has the key → record as a **naive dupe** (with `dupOf`), drop.
   - Else if `verifySlots <= 0` AND `severity >= medium` → record as **budget-dropped**, drop. (critical/high always pass even at budget.)
   - Else → mark `seen`, decrement `verifySlots` (start at `MAX_VERIFY = 20`), keep as **novel**.
3. `log` when a finder's novel count < its raw count (how many were filtered).
4. Pass each novel bug straight into Phase 2 verification.

### Phase 2 — Adversarial verify (pigeonhole 5-voter, ≥2 refutations kill)

For each novel bug, run `verifyBug`. The verifier's PRIMARY job is to REFUTE. Pigeonhole optimization to save votes:

1. Dispatch voters **0 and 1 in parallel**. If BOTH refute (`refutedVotes >= 2`) → **early kill**, skip the remaining 3 votes. `log('<file> "<title>": 0-2 ✗ (early kill)')`.
2. Otherwise dispatch voters **2, 3, 4 in parallel**. Combine all 5 verdicts. `survives = refutedVotes < 2`. `log('<file> "<title>": <confirms>-<refutes> <✓|✗>')`.

Each voter prompt = `SCOPE_BLOCK` + (verbatim from built-in):

```
## Adversarial Verifier (voter v+1/5)
Be SKEPTICAL. Try to REFUTE. Find ANY reason this is not a real bug.
≥2 refutations of 5 kill it.

## Candidate
File: <file>[:<line>]
Title: <title>
Severity: <severity>
Description: <description>

## Checklist
1. Run `git diff <diffBase>...HEAD -- <file>` and read the file — does the issue exist?
2. Check callers — reachable? Preconditions guaranteed?
3. Check handling — validation/error handling elsewhere?
4. Conventions — intentional per CLAUDE.md (above)?
5. Git history — pre-existing ≠ new bug. Already fixed/reverted?

**refuted=true** if: not reachable / handled / intentional / pre-existing / wrong.
**refuted=false** ONLY if: real, reachable, new, material.
Default to refuted=true if uncertain.

Structured output only. Evidence MUST cite file:line.
```

After all verifications drain: `confirmed = survives`, `killed = !survives`.
`log("Pipeline done: V voted → C confirmed, K killed · D naive dupes · B budget-dropped")`.

If `confirmed` is empty → stop with a clean report: "Clean. V voted, all killed. D naive dupes filtered pre-verify." Include the `killed` list with vote tallies (`<confirms>-<refutes>`).

### Phase 3 — Synthesize (1 subagent, semantic dedup)

Build a `block` listing each confirmed bug with its index, title, severity, finder, vote tally (`<confirms>-<refutes>`), `file:line`, description, and best evidence (the confirming verdict with highest confidence). Then dispatch one synthesis agent returning REPORT_SCHEMA:

```
## Synthesis: semantic dedup + final report
C bugs survived adversarial verification. Semantic duplicates are likely
(naive dedup only caught file:line matches).

<block>

## Instructions
1. Identify semantic duplicates (same root cause, different location/wording). Merge into one entry.
2. Order by severity: critical → high → medium → low → nit
3. Tighten titles/descriptions. Best evidence per bug.
4. 2-3 sentence summary.
Structured output only.
```

## Output format

```
# Bug Hunt (lite) — <scope>

<2-3 sentence summary>

## Critical (N)
- `file:line` — <title>  (vote 5-0)
  <description>. Evidence: <evidence>

## High (N)
...

## Medium / Low / Nit
...

## Killed (refuted by adversarial verification) — optional
- `file:title` (vote 1-4)

**Stats: V voted → C confirmed, K killed · A after semantic dedup · D naive dupes · B budget-dropped. Fleet: 3 rapid + 2 deep. Agent calls: ~<1 + 5 + sum(verdicts) + 1>.**
```

## Notes

- The fleet is FIXED at 5 (`[rapid×3, deep×2]`) — that fixed wave is exactly what makes this "lite". Do NOT add a respawn loop; that's the full `bughunt`.
- `Explore` subagents are cheaper for read-only finding/verifying; `general-purpose` is fine where git blame/history is needed.
- The pigeonhole early-kill (2 votes → if both refute, skip 3) is the cost optimization that keeps lite cheap — preserve it.
- The adversarial verifier is the load-bearing part. Do not skip it; it is what makes the output trustworthy. Default-to-refuted on uncertainty is intentional.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
