# review-branch — test run report

**Date:** 2026-05-25
**Scope:** `clawd/skills/review-branch/test/fixture.js` (35-line JS fixture with planted issues)
**Pipeline:** Phase 0 scope → Phase 1 (6 parallel reviewers) → Phase 2 (adversarial verify) → Phase 3 (synthesis)
**Result:** PASS — all planted issues caught + confirmed; zero false positives; zero hallucinated findings.

## Phase 1 — Review (6 reviewers, parallel)

| Dimension | Findings | Lines |
|---|---|---|
| Bugs | 3 high | 9, 14, 20 |
| Simplicity | 1 low | 28 |
| Architecture | 0 (correctly empty) | — |
| Dead Code | 1 low | 33 |
| Best Practices | 4 (overlap w/ bugs+simplicity) | 9, 14, 20, 28 |
| Existing Patterns | 0 (correctly empty) | — |

Architecture + patterns returning empty (instead of inventing findings) is the key signal the reviewers aren't noise generators. Dead-code finding (L33) independently corroborated by the editor's TypeScript LSP diagnostic.

## Phase 2 — Adversarial verify (5 distinct findings)

| File:line | Dimension | Verdict | Confidence |
|---|---|---|---|
| fixture.js:9 | bugs | confirmed | high |
| fixture.js:14 | bugs | confirmed | high |
| fixture.js:20 | bugs | confirmed | high |
| fixture.js:28 | simplicity | confirmed | high |
| fixture.js:33 | dead-code | confirmed | high |

5 confirmed, 0 rejected, 0 unclear. Each verifier explicitly attempted to reject (upstream validation? intentional? misread?) and could not.

## Phase 3 — Synthesized report (after dedup)

### High (3)
- `fixture.js:9` — **getLast off-by-one** — `arr[arr.length]` reads one past the last index → always `undefined`. Fix: `arr[arr.length - 1]`. [dims: bugs, best-practices]
- `fixture.js:14` — **processUser null-deref** — `user.profile.name.trim()` throws TypeError if any level is missing. Fix: `user?.profile?.name?.trim() ?? ''`. [dims: bugs, best-practices]
- `fixture.js:20` — **calculateTotal loop off-by-one** — `i <= items.length` reads `items[length].price` → TypeError. Fix: `i < items.length`. [dims: bugs, best-practices]

### Medium (0)
None.

### Low (2)
- `fixture.js:28` — **pointless IIFE** in `add()` — no closure/hoisting benefit. Fix: `return a + b;`. [dims: simplicity, best-practices]
- `fixture.js:33` — **dead constant** `UNUSED_LIMIT` — never referenced, not exported. Fix: remove. [dims: dead-code]

**Summary: 3 high, 0 medium, 2 low (after dedup). Reviewed 1 file, 5 findings verified, 0 rejected.**

## Conclusion

The subagent-based recreation reproduces the built-in `review-branch` behaviour faithfully: parallel multi-dimension review, adversarial false-positive filtering, and deduped severity-grouped synthesis — all without the gated `Workflow` tool. Cross-dimension duplicates (bugs/best-practices flagging the same lines) were correctly merged in synthesis.
