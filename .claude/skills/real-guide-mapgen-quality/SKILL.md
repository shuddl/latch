---
name: real-guide-mapgen-quality
description: Make LLM map-generation reliable on REAL companion guides — PDF ingestion, a PG-7 eval/regression harness in CI, confidence-surfacing, and a pass-rate improvement loop. Trigger on "real guide", "PDF guide", "mapgen quality", "eval set", "prompt regression", "onboarding failed to certify", PG-7 / OP-4.
risk_level: HIGH
feasibility: FEASIBLE
parent_product: Latch
generated_by: product-forge-analyzer
---

# Real-Guide Map-Gen Quality

## Problem Statement
The product promise is "drop the partner's companion guide → certified same day." Today the
LLM path (`ingestSpec` → `generateMap`) has only ever seen synthetic, standard-conformant
text guides; `ingestSpec` cannot even accept a PDF. **Correctness is NOT the risk** — the
Verification Engine gates every map, so a wrong map cannot reach production (the moat holds
structurally). The risk is **pass-rate**: real guides are messy PDFs full of partner
deviations, and if generated maps fail certification, "same day, $0 setup" silently becomes
"a support ticket." There is also no eval harness, so any prompt edit can regress quality
invisibly (PG-7).

## Context
- **Dimension:** AI/ML · **Complexity:** 7/10 · **Effort:** 3–5 days + iteration as guides arrive
- **Dependencies:** `ANTHROPIC_API_KEY` (user); real guides (OP-1 — partner-gated, but the
  harness must exist *before* they arrive); deploy for the R2 upload path.
- **Cost note:** build-time only (never hot path). Cache spec/map results by guide hash.

## Recommended Approach
Three layers: (A) PDF intake, (B) the eval harness, (C) the quality loop.

### A — PDF guide intake (OP-4)
1. `POST /v1/connections/:id/guide` accepts `application/pdf` (or multipart) up to the 5MB
   `LIMITS` bound → store raw in R2 (`guides/<tenant>/<connection>/<hash>.pdf`).
2. Pass the PDF to Claude via the API's **native PDF document blocks** (base64 document
   source) in `ingestSpec` — no OCR pipeline; the model reads tables/layout directly. Keep
   the existing text path for pasted guides.
3. Surface `ingestSpec`'s existing per-field confidence in the UI ("we read AT7-05 as the
   status date — low confidence, from page 12") — the guide-reference drill-down debt in 1.6.

### B — the eval harness (PG-7) — build now, seed synthetic, feed real later
1. `packages/mapgen/eval/`: cases of `{guide (text or pdf), samples[], expectedCanonical[]}`.
   Seed with the six synthetic sets; add a "messy" tier (reordered tables, typos, deviated
   qualifiers, scanned-style noise) generated once and frozen as fixtures.
2. Runner: guide → `ingestSpec` → `generateMap` → **run the real Verification Engine** →
   score = { certPassRate, dimension scores, field-level diff vs expectedCanonical,
   tokens+latency }. Emit a scoreboard JSON.
3. CI job (key-gated, runs when `ANTHROPIC_API_KEY` secret exists — e.g. nightly + on
   prompt-touching PRs): fail if pass-rate or any dimension drops vs the committed baseline
   scoreboard. This is the LLM equivalent of the injection harness.
4. Every real guide that ever fails onboarding gets anonymized and added as an eval case —
   failures become permanent regression tests (the Spec-Library flywheel, applied to evals).

### C — the quality loop
1. When a generated map fails certification, the failure report (shortfalls, per-record
   issues) is **fed back** into a single mapgen retry with the shortfalls in the prompt —
   one automatic repair round before surfacing to the user (bounded, deterministic retry).
2. Below-bar after retry → the UI shows the exact shortfalls (already built) + low-confidence
   fields; human confirms/corrects those fields only → re-certify. "Same day with two
   clicks" beats a false "zero-touch."
3. Track the funnel metric: guides dropped → certified-no-touch %, certified-after-retry %,
   needed-human %. This is THE product KPI; wire it into observability (5.2).

## Alternatives
| Approach | Pros | Cons | When |
|---|---|---|---|
| Native PDF blocks (recommended) | no OCR infra, reads tables | token cost on big guides | default |
| OCR → text → existing path | cheap rerun | loses table structure | fallback for scanned faxes |
| Human-in-loop-only mapping | always works | kills the product promise | never as default |

## Validation Criteria
- [ ] A seeded PDF guide onboards → certifies with zero code changes (synthetic tier green).
- [ ] Eval scoreboard committed; CI fails on regression vs baseline.
- [ ] Retry-with-shortfalls measurably lifts pass-rate on the messy tier (record the delta).
- [ ] First real guide (when it arrives): funnel metric captured end-to-end.

## Failure Modes
| Failure | Detection | Recovery |
|---|---|---|
| Prompt edit regresses quality | eval CI vs baseline | block merge; iterate on eval, not vibes |
| Huge guide blows token/size limits | intake 413 / API error | 5MB cap + page-range chunking of spec-relevant sections |
| Model drift on provider update | nightly eval drop | pin `ANTHROPIC_MODEL`; upgrade deliberately via eval |
| Cert passes but semantics wrong vs partner intent | partner reports post-live | that's drift-detection's job (M4, built); add case to evals |

## Go/No-Go
- **GO now** on A+B with synthetic tiers (key needed only to *run*, not to write).
- The **real-guide DoD** (M1's credibility gate) is only claimable after ≥1 real guide passes
  the funnel — never declare it on synthetics.
