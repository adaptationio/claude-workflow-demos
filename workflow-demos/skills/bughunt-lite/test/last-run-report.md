# bughunt-lite — test run report

**Date:** 2026-05-25
**Scope:** `clawd/skills/review-branch/test/fixture.js` (shared planted-bug fixture)
**Method:** subagents read `clawd/skills/bughunt-lite/SKILL.md` and executed their roles (authentic "is the skill followable?" test).
**Result:** PASS — finders caught all planted issues; adversarial jury correctly *discriminated* (confirmed real, killed bogus).

## Find phase (rapid + deep finders)
Both finders read the skill, adopted their role + schema, and reported the same 5 issues:
- L9 getLast off-by-one (high), L14 processUser null-deref (high), L20 calculateTotal loop off-by-one (high), L28 pointless IIFE (low), L33 dead `UNUSED_LIMIT` (low).

## Verify phase — adversarial jury (3 voters/claim; ≥2 refutations kills; scaled from skill's 5 for test cost)

| Claim | Votes | Outcome |
|---|---|---|
| L9 getLast off-by-one (REAL) | confirm / confirm / confirm | **survives** (0 refutations) |
| L35 "module.exports memory leak" (BOGUS, planted) | refute / refute / refute | **killed** (3 ≥ 2 refutations) |

The jury's value is discrimination: it confirmed a genuine bug **and** rejected a confident-sounding fabricated claim (correctly explaining require() caching + that holding a fixed set of export refs is not unbounded growth). This is the distinctive bughunt machinery vs review-branch's single verifier.

## Conclusion
bughunt-lite works end-to-end via subagents: parallel finders → multi-vote adversarial jury (confirm-survive / refute-kill) → synthesis. Confirms the subagent-recreation pattern generalizes beyond review-branch, including the multi-vote pigeonhole verification.
