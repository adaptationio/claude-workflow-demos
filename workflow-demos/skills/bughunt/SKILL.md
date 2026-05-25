---
name: bughunt
description: Adversarial bug hunt over a branch diff (or a specified path/diff-range). Runs a self-respawning finder fleet (rapid surface scanners + deep analysts) that dispatches bug candidates the moment they're found, verifies each candidate with a 5-vote pigeonhole adversarial jury (≥2 refutations kill it), and synthesizes a semantically-deduped, severity-ranked report. Terminates on a deep-finder dry streak. Use for "hunt for bugs", "find bugs in my branch", "bug hunt", "adversarial bug review", or the /bughunt-demo slash command. Faithful recreation of the Claude Code built-in `bughunt` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled is OFF fleet-wide).
---

# bughunt (skill)

## Purpose

Hunt for **real, reachable, new** bugs in a set of changes with a very low false-positive rate. This is a recreation of Claude Code's built-in `bughunt` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even though the native `Workflow` tool is gated off (`tengu_workflows_enabled` is OFF for all our Anthropic orgs — see `wiki/control/runs/2026-05-24-workflows-activation/account-status.md`).

Unlike `review-branch` (a fixed 6-dimension review), `bughunt` is **dynamic**: a fleet of finders self-respawns, biasing breadth early (rapid scanners) and depth later (deep analysts), and stops itself once deep passes go dry. Every surviving candidate then faces a 5-vote adversarial jury whose job is to **refute**.

Source of truth for the recipe: `wiki/concepts/cache/claude-code-workflows-builtin/bughunt.js`.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel([...])` | multiple Agent calls in ONE message |
| `pipeline(stageA, stageB)` | manual staging — finder result → harvest → fire verifiers |
| self-respawning `slot()` | after a finder returns, decide the next role and dispatch again until `bugFindingDone` |
| `phase()` / `log()` | progress narration to the user |
| shared `seen`/`verifySlots`/`dryStreak` state | you hold this state in-context between dispatches (single-threaded — every mutation is atomic for you) |

Tradeoff vs native: we lose replay-safe determinism, the `FLEET_SIZE`-way true concurrency (you serialize batches), and the `/workflows` run-history browser. We keep 100% of the hunt logic — role assignment, budget, dedup, dry-streak, pigeonhole voting, semantic dedup.

## Inputs

- **scope** (optional): a path (`src/foo.ts`), a git diff range (`HEAD~3...HEAD`), or empty.
  - Empty → default to the branch diff `origin/main...HEAD` (fall back to `main...HEAD` if no remote).
  - A path → hunt just that file/dir.
  - A diff range → hunt that range.

## Tuning constants (verbatim from the built-in)

```
FLEET_SIZE          = 5    # concurrent finder slots (serialize into batches if needed)
VOTES_PER_BUG       = 5    # adversarial jurors per candidate
REFUTATIONS_REQUIRED = 2   # ≥2 refutations kill a candidate
MAX_VERIFY          = 20   # verify-budget slots (critical/high bypass the cap)
DRY_STREAK_LIMIT    = 3    # 3 consecutive dry deep passes → stop finding
```

## Recipe

### Phase 0 — Scope (1 subagent OR inline bash)

Discover what to hunt and build a shared context header. Schema `SCOPE_SCHEMA`: `{ diffBase: string, files: string[], summary: string, conventions?: string }` (required: `diffBase`, `files`, `summary`).

The scope agent (prompt verbatim intent):

1. **Diff base:** run `git rev-parse origin/main`, fallback to `main`. Return whichever exists. (Skip if scope is an explicit path.)
2. **Changed files:** `git diff --name-only <diffBase>...HEAD`.
3. **Summarize** what changed in one paragraph.
4. **Conventions:** find `CLAUDE.md` files (root + parent dirs of changed files); extract relevant conventions.
5. Structured output only.

Early exits:
- Scope agent failed → `{ summary: "Scope skipped.", bugs: [], stats: {} }`.
- `files.length === 0` → `{ summary: "No changes on branch vs <diffBase>.", bugs: [], stats: {} }`.

Then `log("<N> files changed vs <diffBase>")` and build the small shared header (each finder/verifier runs its own `git diff`):

```
## Branch scope (<diffBase>...HEAD)
Changed files (N):
  - file1
  - file2

## What changed
<summary>

## Conventions (CLAUDE.md)
<conventions, or "(none)">

```

### Phase 1 — Find (self-respawning fleet of 5 slots)

Hold this shared state across the whole find phase:
- `seen` — Map of `dedupKey → {finder, title}`.
- `naiveDupes`, `budgetDropped` — dropped-candidate lists.
- `verifyJobs` — verifications fired so far (do NOT await them here).
- `verifySlots = MAX_VERIFY` (20), `rapidSpawned = 0`, `deepSpawned = 0`, `dryStreak = 0`, `bugFindingDone = false`.

`dedupKey(b)` = `b.file + ":" + (b.line != null ? Math.round(b.line/5)*5 : "x")` (line bucketed to the nearest 5).
`sevRank` = `{critical:0, high:1, medium:2, low:3, nit:4}`.

Run **FLEET_SIZE (5)** slots. Each slot repeats: pick the next role → dispatch a finder → harvest → fire verifications → respawn, until `decideNextRole()` returns null. You may dispatch slots in parallel batches (multiple Agent calls in one message); just keep the shared-state mutations ordered.

**Role assignment** (`decideNextRole`, the Python `decide_agent_type`):
- If `bugFindingDone` → null (slot ends).
- If `rapidSpawned < 3` → `{type:"rapid", idx: rapidSpawned++}` (label `rapid-<idx>`).
- Else → `{type:"deep", idx: deepSpawned++}` (label `deep-<idx>`). Deep finders run until the dry streak hits.

Each finder returns `BUGS_SCHEMA`: `{ bugs: [ {file, line?, title, description, severity, category?}, ... ] }` (required per bug: `file`, `title`, `description`, `severity`). `severity ∈ {critical, high, medium, low, nit}`. `category ∈ {logic, security, performance, convention, correctness, resource-leak, race, other}`.

Pass each finder the current `skipKeys = Array.from(seen.keys())` so it avoids re-finding known locations.

**Rapid Surface Scanner** prompt (`rapidPrompt(idx, skipKeys)`) = `CONTEXT_HEADER` +

```
## Role: Rapid Surface Scanner (rapid-<idx>)

Quickly scan the changes. Report obvious issues. Do NOT deep-dive.

## Look for
**P1** CLAUDE.md violations · **P2** Logic errors (copy-paste, wrong conditions, null derefs) · **P3** Resource issues (unbounded growth, missing await)

## Instructions
1. Run 'git diff <diffBase>...HEAD' to see the changes.
2. Read changed files as needed for surrounding context.
3. Report 5-12 bugs. Breadth > depth. OK to be wrong.
4. Bias toward the <first|middle|last> third of the file list.   # = ["first third","middle third","last third"][idx % 3]
5. SKIP these locations (already found): <skipKeys>   # only if skipKeys non-empty

Structured output only.
```

**Deep Analyst** prompt (`deepPrompt(idx, skipKeys)`) = `CONTEXT_HEADER` +

```
## Role: Deep Analyst (deep-<idx>)

Find subtle bugs requiring deep analysis.

## Process
Run 'git diff <diffBase>...HEAD' · Read full files · Grep callers of modified functions · Trace callees · Trace data flow

## Look for
Invariant violations · Races · State mutation · Edge cases (empty/null/concurrent)

## Instructions
Pick <the most significant change | a DIFFERENT subsystem from prior deep passes>. Go DEEP. Return 1-3 high-confidence findings.
SKIP these locations (already found): <skipKeys>   # only if skipKeys non-empty

Structured output only.
```
(idx === 0 → "the most significant change"; else → "a DIFFERENT subsystem from prior deep passes".)

**Harvest** each finder result (`harvest(result, role)`):
1. If result is null/failed: if role is `deep`, `dryStreak++`; if `dryStreak >= 3` set `bugFindingDone = true`. Return [] (no novel bugs).
2. Sort `result.bugs` by `sevRank` (severity-first so high-priority bugs claim budget slots).
3. For each bug, compute `dedupKey`:
   - If `seen.has(key)` → push to `naiveDupes` (record `finder`, `dupOf`), skip.
   - Else if `verifySlots <= 0 && sevRank[severity] >= 2` (medium/low/nit only — critical/high always pass) → push to `budgetDropped`, skip.
   - Else → `seen.set(key, {finder, title})`, `verifySlots--`, add to `novel`.
4. If role is `deep`: `dryStreak = novel.length > 0 ? 0 : dryStreak + 1`; if `dryStreak >= 3` → `bugFindingDone = true`.
5. `log("<label>: <raw> raw → <novel> novel" + (deep ? " (dryStreak=<n>)" : ""))`.

**Fire verification immediately** for each novel bug (push `verifyBug(bug)` into `verifyJobs`) — do NOT await — then respawn the slot. Find and verify overlap; there is no barrier until synthesis.

### Phase 2 — Verify (5-vote pigeonhole adversarial jury per candidate)

Each `verifyBug(bug)` runs up to `VOTES_PER_BUG` (5) adversarial verifiers, each returning `VERDICT_SCHEMA`: `{ refuted: boolean, evidence: string, confidence: "high"|"medium"|"low", severity? }` (required: `refuted`, `evidence`, `confidence`). Evidence MUST cite `file:line`.

**Pigeonhole optimization** — vote in two waves:
1. Dispatch votes **0 and 1** in parallel. If both refute (refuted-count `>= REFUTATIONS_REQUIRED` = 2) → **early kill**: `log('<short> "<title>": 0-2 ✗ (early kill)')`, return `{bug, verdicts, refutedVotes, survives:false}`. Skip the other 3.
2. Otherwise dispatch votes **2, 3, 4** in parallel. Combine all 5. `r = refuted count`; `survives = r < 2`. `log('<short> "<title>": <r̄>-<r> <✓|✗>')` where `r̄ = total - r`.

**Verifier prompt** (`verifyPrompt(bug, v)`) = `CONTEXT_HEADER` +

```
## Role: Adversarial Verifier (voter <v+1>/5)

Be SKEPTICAL. Try to REFUTE. Find ANY reason this is not a real bug. ≥2 refutations of 5 kill it.

## Candidate
File: <bug.file>[:<bug.line>]
Title: <bug.title>
Severity: <bug.severity>
Description: <bug.description>

## Checklist
1. Run 'git diff <diffBase>...HEAD -- <bug.file>' and read the file — does the issue exist?
2. Check callers — reachable? Preconditions guaranteed?
3. Check handling — validation/error handling elsewhere?
4. Conventions — intentional per CLAUDE.md (above)?
5. Git history — pre-existing ≠ new bug. Already fixed/reverted?

**refuted=true** if: not reachable / handled elsewhere / intentional / pre-existing / wrong.
**refuted=false** ONLY if: real, reachable, new, material.
Default to refuted=true if uncertain.

Structured output only. Evidence MUST cite file:line.
```

**Drain:** once finding stops (dry streak), `log("Dry-streak hit. <seen.size> unique bugs found. Draining <verifyJobs.length> verifications...")`, then await all `verifyJobs`. Split into `confirmed` (`survives`) and `killed` (`!survives`). `log("Voting done: <V> voted → <C> confirmed, <K> killed · <naiveDupes> naive-dupes · <budgetDropped> budget-dropped")`.

**Early return if nothing confirmed:**
```
summary: "Clean. <V> voted, all killed by 5-vote adversarial. <deepSpawned> deep finders ran before dry-streak."
bugs: []
killed: [{file, title, vote: "<r̄>-<r>"}, ...]
stats: {rapidSpawned, deepSpawned, voted, confirmed:0, killed, naiveDupes, budgetDropped}
```

### Phase 3 — Synthesize (semantic dedup + final report, 1 subagent)

`bestEvidence(r)` = among the non-refuted verdicts, the one with the best `confidence` (confRank `{high:0,medium:1,low:2}`); fallback `{evidence:"(no confirming verdict)", confidence:"low"}`.

Build a `block` of all `confirmed` candidates:
```
### [<i>] <title> (<severity>, <finder>)
Vote: <r̄>-<r> · File: <file>[:<line>]
<description>
Evidence (<confidence>): <evidence>
```

Synthesis agent returns `REPORT_SCHEMA`: `{ summary: string, bugs: [ {file, line?, title, description, severity, vote, evidence}, ... ] }` (required per bug: `file, title, description, severity, vote, evidence`).

Synthesis prompt:
```
## Synthesis: semantic dedup + final report

<C> bugs survived adversarial verification. Semantic duplicates are likely (naive dedup only caught file:line matches).

<block>

## Instructions
1. Identify semantic duplicates (same root cause, different location/wording). Merge into one entry.
2. Order by severity: critical → high → medium → low → nit.
3. Tighten titles/descriptions. Pick the best evidence per bug.
4. Write a 2-3 sentence summary.

Structured output only.
```

Final return:
```
summary: <reportResult.summary>
bugs:    <reportResult.bugs>
killed:  [{file, title, vote}, ...]
stats: {
  rapidSpawned, deepSpawned, voted,
  confirmed, killed, afterSemanticDedup,
  naiveDupes, budgetDropped,
  agentCalls: 1 + (rapidSpawned + deepSpawned) + Σ(verdicts per voted bug) + 1,
}
```

## Output format

```
# Bug Hunt — <scope>

<2-3 sentence summary>

## Critical (N)
- `file:line` — <title>   (vote A-B, finder: deep-1)
  <description>. Evidence (<confidence>): <evidence>

## High (M)
...

## Medium / Low / Nit
...

## Killed by adversarial jury (optional, for transparency)
- `file:title` — vote A-B

**Stats: <rapidSpawned> rapid + <deepSpawned> deep finders · <voted> verified → <confirmed> confirmed, <killed> killed · <afterSemanticDedup> after semantic dedup · <naiveDupes> naive-dupes, <budgetDropped> budget-dropped · ~<agentCalls> agent calls.**
```

## Notes

- The **adversarial jury is the load-bearing part** — verifiers default to `refuted=true` when uncertain, and 2 of 5 refutations kill a candidate. This is what keeps false positives down. Do not skip or soften it.
- **Pigeonhole the votes**: 2 first, 3 more only if undecided. Most weak candidates die after 2 votes, saving ~3 agent calls each.
- **Fire-and-respawn**: verify candidates the instant a finder returns them; respawn the finder slot immediately. Finding and verifying overlap — only synthesis is a barrier.
- **Dry-streak is the stop signal**, not a fixed count: deep analysts run until 3 consecutive passes find nothing novel. Rapid scanners are capped at 3 (one per file-list third).
- Budget (`MAX_VERIFY=20`) protects you from a flood of low-severity candidates; critical/high always bypass it. Sort by severity before spending slots.
- For read-only hunts, `subagent_type: Explore` is cheaper for finders/verifiers; use `general-purpose` where git blame/history is needed.
- Provenance + the other 9 built-ins: `wiki/concepts/cache/claude-code-workflows-builtin/bughunt.js`, concept page [[claude-code-workflows]], cheatsheet [[workflows-and-goals-cheatsheet]].
