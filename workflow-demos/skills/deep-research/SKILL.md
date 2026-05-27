---
name: deep-research
description: Multi-angle web research that decomposes a question into search angles, fetches and extracts claims from the best sources, then adversarially verifies each claim with a 3-vote majority before synthesizing a confidence-graded report. Dispatches a Scope agent, parallel angle-searchers, a URL-dedup + fetch/extract pipeline, 3 adversarial verifier votes per claim, and a final synthesizer. Use for "research X", "deep dive on X", "what's the evidence for X", "investigate this question", or the /deep-research-demo slash command. Faithful recreation of the Claude Code built-in `deep-research` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org).
---

# deep-research (skill)

## Purpose

Answer an open research question with high-signal, source-cited findings whose central claims have survived adversarial scrutiny. This is a recreation of Claude Code's built-in `deep-research` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

The built-in is itself ported from the bughunter architecture, swapping `git`/`grep` for `WebSearch`/`WebFetch`: a fan-out of finders, a budget-capped adversarial verify stage, then a semantic-dedup synthesizer.

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel([...])` | multiple Agent calls in ONE message (angle searchers, verifier votes) |
| `pipeline(Search → dedup → Fetch+Extract)` | manual staging — search all angles, dedup URLs in your head, then dispatch fetch/extract on survivors |
| `phase()` / `log()` | progress narration to the user |
| budget constants (`MAX_FETCH`, `MAX_VERIFY_CLAIMS`) | enforce the same caps yourself before dispatching the next stage |

Tradeoff vs native: we lose replay-safe determinism, the auto-respawning finder slots, and the `/workflows` run-history browser. We keep 100% of the research logic — decomposition, multi-angle search, source-quality grading, 3-vote adversarial verify, semantic-dedup synthesis.

## Inputs

- **question** (required): the research question, passed as `$ARGUMENTS`.
  - Empty → stop: "No research question provided."

## Budgets (verbatim from the built-in)

```
VOTES_PER_CLAIM     = 3   // adversarial verifier votes per surviving claim
REFUTATIONS_REQUIRED = 2  // ≥2 of 3 refutations kill a claim
MAX_FETCH           = 15  // cap on URLs fetched + extracted
MAX_VERIFY_CLAIMS   = 25  // cap on claims sent to verification
```

## Recipe

### Phase 0 — Scope (1 subagent, `SCOPE_SCHEMA`)

Dispatch ONE agent to decompose the question into complementary search angles. Strict JSON:

```json
{ "question": "...", "summary": "1-2 sentence decomposition strategy",
  "angles": [ { "label": "...", "query": "...", "rationale": "..." }, ... ] }   // 3–6 angles
```

Scope agent prompt (translated verbatim):

```
Decompose this research question into complementary search angles.

## Question
<QUESTION>

## Task
Generate 5 distinct web search queries that together cover the question from
different angles. Pick angles that suit the question's domain. Examples:
- broad/primary · academic/technical · recent news · contrarian/skeptical · practitioner/implementation
- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags
- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs

Make queries specific enough to surface high-signal results. Avoid redundancy.
Return: the question (verbatim or lightly normalized), a 1-2 sentence
decomposition strategy, and the angles.

Structured output only.
```

If the scope agent returns nothing → stop: "Scope agent returned no result — cannot decompose the research question."

`log`: `Decomposed into N angles: <labels>`.

### Phase 1 — Search (1 searcher per angle, dispatched IN PARALLEL, `SEARCH_SCHEMA`)

Dispatch all angle-searchers in a SINGLE message (one Agent call per angle, `subagent_type: general-purpose` with `WebSearch`). Each owns ONE angle and returns up to 6 ranked results. Strict JSON:

```json
{ "results": [ { "url": "...", "title": "...", "snippet": "...",
                 "relevance": "high|medium|low" }, ... ] }   // maxItems 6
```

Searcher prompt per angle:

```
## Web Searcher: <angle.label>

Research question: "<QUESTION>"

Your angle: **<angle.label>** — <angle.rationale>
Search query: <angle.query>

Run WebSearch for this angle. Return the up-to-6 most relevant results,
each with url, title, snippet, and a relevance grade (high/medium/low).
Prefer primary and authoritative sources. Structured output only.
```

### Phase 1.5 — URL dedup + budget (inline, no subagent)

Collect every result across all angles. This is the `pipeline` gluing step:

1. **Normalize** each URL: lowercase, strip leading `www.`, strip trailing `/` on the path, drop the scheme/query (`hostname+pathname`). Same normalized key = duplicate; keep the first, record the rest as `dupes`.
2. **Rank** survivors by `relevance` (high → medium → low).
3. **Budget**: take at most `MAX_FETCH = 15` URLs off the top. Anything beyond goes to `budgetDropped`.

### Phase 2 — Fetch + Extract (1 subagent per surviving URL, parallel batches, `EXTRACT_SCHEMA`)

For each of the ≤15 budgeted URLs, dispatch a fetch/extract subagent (`general-purpose` with `WebFetch`). It fetches the page, grades the source, and pulls up to 5 claims. Strict JSON:

```json
{ "sourceQuality": "primary|secondary|blog|forum|unreliable",
  "publishDate": "...",
  "claims": [ { "claim": "...", "quote": "verbatim supporting quote",
               "importance": "central|supporting|tangential" }, ... ] }   // maxItems 5
```

Fetch/extract prompt:

```
## Fetch + Extract

Research question: "<QUESTION>"
URL: <url>   (title: <title>)

1. WebFetch this URL.
2. Grade the source: primary | secondary | blog | forum | unreliable.
3. Note the publish date if available.
4. Extract up to 5 claims that bear on the research question. For each:
   - the claim (one sentence)
   - a verbatim supporting quote from the page
   - importance: central | supporting | tangential

Only extract claims the page actually supports. Structured output only.
```

Collect all extracted claims, tagging each with its source URL + sourceQuality. Sort so `central` claims from higher-quality sources are first; cap the set at `MAX_VERIFY_CLAIMS = 25` (record any overflow as `budgetDropped`).

### Phase 3 — Adversarial verify (3 votes per claim, `VERDICT_SCHEMA`)

For each budgeted claim, dispatch `VOTES_PER_CLAIM = 3` skeptical verifier subagents (parallel batch per claim, or batched across claims). Each voter's job is to REFUTE. **≥ `REFUTATIONS_REQUIRED = 2` of 3 refutations kill the claim.** Strict JSON per voter:

```json
{ "refuted": true|false, "evidence": "...", "confidence": "high|medium|low",
  "counterSource": "url of a refuting source, if found" }
```

Verifier prompt (per voter `v` of 3):

```
## Role: Adversarial Verifier (voter <v+1>/3)

Be SKEPTICAL. Try to REFUTE this claim. Find ANY reason it is not
well-supported. ≥2 refutations of 3 kill it.

## Claim
"<claim.claim>"
Cited quote: "<claim.quote>"
Source: <url> (graded <sourceQuality>)
Research question: "<QUESTION>"

## Checklist
1. Does an independent search corroborate or contradict this claim?
2. Is the cited source primary/authoritative, or a low-quality echo?
3. Is the quote taken out of context or misread?
4. Is the claim outdated, superseded, or true only under narrow conditions?
5. Can you find a credible counter-source? (return its url in counterSource)

**refuted=true** if: contradicted / unsupported / out of context / outdated / low-quality-only.
**refuted=false** ONLY if: corroborated, current, and material.
Default to refuted=true if uncertain.

Structured output only. Evidence MUST cite a source.
```

Tally per claim: `survives = refutedVotes < 2`. Split into `confirmed` (survives) and `killed`.

`log`: `Voting done: V voted → C confirmed, K killed`.

If `confirmed` is empty → report: "No claims survived 3-vote adversarial verification" (+ note `killed` and any `budgetDropped` worth a manual look).

### Phase 4 — Synthesize (1 subagent, `REPORT_SCHEMA`)

Hand the confirmed claims (with their best confirming evidence + vote tally) to ONE synthesizer agent. Strict JSON:

```json
{ "summary": "2-3 sentence answer to the question",
  "findings": [ { "claim": "...", "confidence": "high|medium|low",
                  "sources": ["url", ...], "evidence": "...", "vote": "2-1" }, ... ],
  "caveats": "what's uncertain or contested",
  "openQuestions": ["...", ...] }
```

Synthesizer prompt:

```
## Synthesis: semantic dedup + final research report

<C> claims survived 3-vote adversarial verification (votes shown as confirm-refute).
Semantic duplicates are likely (different sources, same underlying fact).

<for each confirmed claim: claim text · vote · sources · best confirming evidence>

## Instructions
1. Merge semantic duplicates (same fact from multiple sources → one finding, list all sources).
2. Order findings by confidence and centrality to the question.
3. Set each finding's confidence from the vote margin + source quality.
4. Write a 2-3 sentence summary that directly ANSWERS the question.
5. List caveats (contested / thin evidence) and open questions.

Structured output only.
```

## Output format

```
# Research: <question>

<2-3 sentence summary answering the question>

## Findings

### <claim> — confidence: high  (vote 3-0)
<evidence>. Sources: <url1>, <url2>

### <claim> — confidence: medium  (vote 2-1)
...

## Caveats
<what's contested or thin>

## Open questions
- ...

**Searched N angles · fetched F/15 sources · verified V claims · C confirmed, K killed (after semantic dedup: D findings).**
```

## Notes

- The 3-vote adversarial verify is the load-bearing part — it is what keeps low-quality echo-chamber claims out of the report. Do not skip it. `≥2 refutations kill`, default-to-refuted-on-uncertainty, exactly like the bughunter verifier it was ported from.
- Source-quality grading (`primary > secondary > blog > forum > unreliable`) feeds both the verify-budget sort AND the final confidence — prefer primary sources when slots are scarce.
- The built-in auto-respawns finder slots and overlaps find/verify with no barrier; the subagent version stages them (search → dedup → fetch → verify → synthesize). Same logic, slightly more sequential.
- Use `general-purpose` subagents (they need `WebSearch`/`WebFetch`); scope/synthesis can run inline if you prefer fewer dispatches.
- This is research-only — produce a report, change no files.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
