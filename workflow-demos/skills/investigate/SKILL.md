---
name: investigate
description: Structured root-cause investigation of an incident, error, bug, or "why is X happening" question. Gathers evidence first (no theorizing), then generates 3 competing hypotheses in PARALLEL from distinct angles (recent-change, data-edge-case, infra-timing), runs an adversarial refutation pass per hypothesis to kill the ones that don't fit the evidence, then synthesizes a root-cause report with a concrete fix and confidence level. Use for "investigate this error", "why is this failing", "root cause this incident", "debug X", or the /investigate-demo slash command. Faithful recreation of the Claude Code built-in `investigate` workflow using subagents — works WITHOUT the gated Workflow tool (tengu_workflows_enabled may be gated off in your org).
---

# investigate (skill)

## Purpose

Run a disciplined, evidence-first root-cause investigation over an incident, error, failing test, or "why is X happening" question. This is a recreation of Claude Code's built-in `investigate` workflow, rebuilt with the **Agent/Task subagent tools** so it works today even when the native `Workflow` tool is unavailable (e.g. the `tengu_workflows_enabled` flag is off in your org).

The method is the load-bearing part: separate **observation** from **theory**, generate **competing** hypotheses, then **try to refute** them rather than confirm a favorite. Surviving hypotheses earn the root-cause claim.

Faithfully translated from Claude Code's built-in workflow recipe.

## Why it works without the Workflow tool

The Workflow DSL maps directly onto subagent dispatch:

| Built-in DSL | This skill uses |
|---|---|
| `agent(prompt, {schema})` | **Agent tool** — instruct the subagent to return strict JSON matching the schema |
| `parallel([...])` | multiple Agent calls in ONE message |
| `pipeline` / sequential `await` | manual staging — finish a phase before starting the next |
| `phase()` / `log()` | progress narration to the user |

Tradeoff vs native: we lose replay-safe determinism and the `/workflows` run-history browser. We keep 100% of the investigation logic — the gather/hypothesize/refute/report loop, the 3 fixed angles, and every JSON schema.

## Inputs

- **task** (required): the incident, error, failing behaviour, or question to investigate. May reference logs, traces, stack traces, file paths, or a reproduction.
  - If empty → stop: "No incident description provided. Pass the incident, error, or question as args."

## Schemas

These are translated verbatim from the built-in `.js`. Every subagent MUST return strict JSON matching its schema.

**GATHER_SCHEMA** (required: `timeline`, `evidence`, `scope`):
```json
{
  "timeline": "string — what happened, in order",
  "evidence": ["string — concrete observations with file:line or log refs"],
  "scope": "string — what is affected and what is not",
  "reproSteps": "string — optional, minimal repro if reproducible"
}
```

**HYPOTHESIS_SCHEMA** (required: `hypothesis`, `mechanism`, `predicts`):
```json
{
  "hypothesis": "string — one-sentence root cause claim",
  "mechanism": "string — how this cause produces the observed symptom",
  "predicts": ["string — testable predictions if this is true"],
  "suspectCode": "string — file:line if applicable (optional)"
}
```

**VERDICT_SCHEMA** (required: `refuted`, `evidence`):
```json
{
  "refuted": true,
  "evidence": "string — must cite file:line or a specific observation number"
}
```

**REPORT_SCHEMA** (required: `summary`, `rootCause`, `suggestedFix`, `nextSteps`):
```json
{
  "summary": "string",
  "rootCause": "string",
  "suggestedFix": "string",
  "nextSteps": ["string"],
  "confidence": "high | medium | low"
}
```

## Recipe

### Phase 1 — Gather (1 subagent)

Dispatch ONE evidence-gathering subagent. It collects facts ONLY — no conclusions. Returns JSON matching `GATHER_SCHEMA`. If the gather step yields nothing → stop: "Gather step skipped."

Gatherer prompt (verbatim from the built-in):

```
Gather evidence for this investigation. Do NOT theorize yet — just collect facts.

## Incident
<TASK>

## Instructions
1. Read any referenced logs, traces, error messages, or files. Pull out concrete
   observations — quote exact lines with their source.
2. Establish a timeline: what happened first, what followed.
3. Establish scope: what is broken, what still works, when it started.
4. If reproducible, note the minimal repro steps.

Stick to observations. No conclusions.
```

Then `log('Gathered N pieces of evidence')` and build the `EVIDENCE_BLOCK` string reused by every later subagent:

```
## Incident
<TASK>

## Timeline
<gather.timeline>

## Scope
<gather.scope>

## Evidence
1. <evidence[0]>
2. <evidence[1]>
...

## Repro            (only if gather.reproSteps present)
<gather.reproSteps>
```

### Phase 2 — Hypothesize (3 subagents, dispatched IN PARALLEL)

Dispatch all 3 in a SINGLE message (3 Agent calls). Each takes ONE fixed angle and proposes exactly ONE concrete root-cause hypothesis. Each returns JSON matching `HYPOTHESIS_SCHEMA`. `subagent_type: general-purpose` (they read code).

The 3 angles (key + lens verbatim from the built-in):

1. **recent-change** — "Assume a recent code or config change caused this. Check git log, recent deploys, flag flips."
2. **data-edge-case** — "Assume the code is fine and a particular input, state, or environment value triggered a latent edge case."
3. **infra-timing** — "Assume a race, timeout, resource limit, dependency outage, or ordering issue — not the application logic itself."

Each hypothesizer prompt = `EVIDENCE_BLOCK` + the angle block + this instruction (verbatim):

```
## Your angle: <key>
<lens>

## Instructions
Propose ONE concrete root-cause hypothesis from this angle. Read the relevant code.
Explain the mechanism — how this cause produces every observation relevant to the symptom in the evidence list (incidental observations unrelated to the symptom need not be explained).
List 2-3 testable predictions: things that would be true if and only if this hypothesis holds.
```

Tag each returned hypothesis with its `angle`. Drop any that came back empty. If zero hypotheses → stop: "No hypotheses generated." Then `log('N hypotheses: recent-change, data-edge-case, infra-timing')`.

### Phase 3 — Verify (1 adversarial refuter per surviving hypothesis, IN PARALLEL)

For each hypothesis, dispatch a refuter subagent (run them in parallel). Its job is to REFUTE, not confirm. Returns JSON matching `VERDICT_SCHEMA`. Attach the verdict back onto its hypothesis.

Refuter prompt = `EVIDENCE_BLOCK` + the hypothesis-under-test block + this instruction (verbatim):

```
## Hypothesis under test (<angle>)
<hypothesis>

Mechanism: <mechanism>
Predictions: <pred1>; <pred2>; <pred3>
Suspect: <suspectCode>        (only if present)

## Instructions
Try to REFUTE this hypothesis. Check each prediction against the codebase and evidence.
Look for evidence the hypothesis CANNOT explain.
refuted=true if any prediction fails or any evidence contradicts the mechanism.
refuted=false ONLY if every prediction checks out and nothing contradicts it.
Evidence must cite file:line or a specific observation number.
```

Partition results:
- **survived** = verdict present AND `refuted === false`
- **refuted** = verdict present AND `refuted === true`

Then `log('Verify: S survived, R refuted')`.

### Phase 4 — Report (1 subagent)

Dispatch ONE report-writer subagent. Returns JSON matching `REPORT_SCHEMA`. If it returns nothing → emit a partial result (gather + survived + refuted).

Build a `survivedBlock` (one `###` entry per surviving hypothesis: hypothesis + angle, mechanism, suspect if any, verifier evidence) or `(none survived — all hypotheses refuted)`. Build a `refutedBlock` (one bullet per refuted hypothesis with its refutation evidence).

Report prompt = this header + `EVIDENCE_BLOCK` + the two blocks + a branch-selected instruction (verbatim from the built-in):

```
Write the root-cause report.

<EVIDENCE_BLOCK>

## Surviving hypotheses (S)
<survivedBlock>

## Refuted hypotheses (R)
<refutedBlock or "(none)">

## Instructions
<branch — pick exactly one based on survivor count:>
  - S == 1 → "One hypothesis survived — that is the root cause. "
  - S  > 1 → "Multiple hypotheses survived — pick the one that best explains ALL evidence, or note they may compound. "
  - S == 0 → "No hypothesis survived — synthesize the most likely cause from what was learned during refutation, with low confidence. "
Write: a 2-3 sentence summary, the root cause, a concrete suggested fix (file:line where
possible), confidence level, and next steps (further verification, monitoring, follow-ups).
```

Confidence defaults if the report omits it: `S==1 → high`, `S>1 → medium`, `S==0 → low`.

## Output format

Render the final `REPORT_SCHEMA` object as Markdown:

```
# Investigation — <one-line incident>

**Summary:** <summary>

## Root cause
<rootCause>   (confidence: <high|medium|low>)

## Suggested fix
<suggestedFix>   (file:line where possible)

## Next steps
- <step 1>
- <step 2>

## Hypotheses
**Survived (<S>):**
- <angle> — <hypothesis>  (suspect: <file:line or none>)

**Refuted (<R>):**
- <angle> — <hypothesis> — refuted: <verifier evidence>

## Evidence
1. <evidence[0]>
2. <evidence[1]>
...
```

## Notes

- This is **investigation only** — produce a report, do not apply the fix. Acting on the fix is a separate, human-gated step.
- Keep Phase 1 strictly observational. If the gatherer starts theorizing, the parallel hypothesis phase loses its independence — that is the whole point of the split.
- The 3 angles are fixed and complementary on purpose (code vs data vs infra). Don't collapse them or add a 4th — the built-in uses exactly these three.
- The refutation pass is the load-bearing part. A hypothesis that "sounds right" but survives no adversarial check is worthless. Default to `refuted=true` when a prediction fails; only `refuted=false` when every prediction holds.
- For read-heavy gather/refute work, `subagent_type: Explore` is cheaper; use `general-purpose` where git blame or broader code reading is needed.
- Provenance: faithfully translated from Claude Code's built-in workflow. This plugin is a demo/preview of the upcoming native `/workflows` feature — it works today via standard Agent/Task subagents.
