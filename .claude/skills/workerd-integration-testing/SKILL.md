---
name: workerd-integration-testing
description: Add real-Workers-runtime (workerd) integration tests for the Durable Objects, queue consumer, and two-DO handshake orchestration using @cloudflare/vitest-pool-workers. Trigger on "workerd test", "miniflare", "integration test the DO", "test the queue consumer", "vitest-pool-workers".
risk_level: HIGH
feasibility: FEASIBLE
parent_product: Latch
generated_by: product-forge-analyzer
---

# workerd Integration Testing

## Problem Statement
The two-DO handshake orchestration (`orchestrateBilateral` over `DurableObjectPeer`), the
`ConnectionDO` sequencer, and the `txn-ingest` queue consumer are proven only against
in-memory stand-ins (`MemoryStorage`, in-process peers, direct function calls). workerd's
real semantics — DO input gates, storage transactions, `stub.fetch` routing, queue batching
`ack()`/`retry()`, `nodejs_compat` surface — are close to the mocks but not identical. The
first place a divergence would surface today is production. This skill closes that gap in CI.

## Context
- **Dimension:** Infrastructure/QA · **Complexity:** 5/10 · **Effort:** 1–2 days
- **Dependencies:** none (runs locally/CI; no account needed). Do **before** first deploy.
- **Key constraint:** the existing 205 unit tests run under plain vitest + `node:sqlite`;
  keep them untouched. Integration tests are a **separate vitest project** (workers pool
  cannot run node-specific tests and vice-versa).

## Recommended Approach
`@cloudflare/vitest-pool-workers` (the successor to raw Miniflare) with a dedicated
`vitest.workers.config.ts` in `apps/api`, pointing at `wrangler.toml` for bindings.

### Implementation Steps
1. `pnpm add -D @cloudflare/vitest-pool-workers wrangler` (workspace `apps/api`).
2. `apps/api/vitest.workers.config.ts`: `defineWorkersConfig` with
   `poolOptions.workers.wrangler.configPath` → a **test** wrangler config (same bindings,
   local resources); include only `src/**/*.wtest.ts`. Root `vitest.config` must exclude
   `*.wtest.ts`; add `test:workers` script and a CI step.
3. **DO tests** (`connection.wtest.ts`, `handshake.wtest.ts`): use
   `env.CONNECTION_DO.get(idFromName(...))` real stubs —
   - sequencer: two `Promise.all` bursts of `POST /allocate` → all control numbers unique
     (real input-gate/transaction semantics, the thing MemoryStorage can't prove);
   - handshake: run the full bilateral orchestration through two **real** `HandshakeDO`
     stubs (seed maps via the store bound to local D1/R2) → co-signed manifest; then eviction
     realism: `state.storage` persistence across stub re-gets.
4. **Queue test** (`ingest.wtest.ts`): call the exported `queue()` handler with a synthetic
   `MessageBatch` (or producer-bind if supported) against local D1/R2 → transaction row +
   canonical in R2 + 997 emitted; `retry()` path on a poisoned message.
5. **App smoke** (`app.wtest.ts`): `SELF.fetch` the worker end-to-end: onboard → certify →
   go-live → ingest, all on real local bindings (this doubles as the pre-deploy smoke logic).
6. Apply local D1 migrations in test setup (`applyD1Migrations` helper from the pool docs).

## Alternative Approaches
| Approach | Pros | Cons | When |
|---|---|---|---|
| vitest-pool-workers (recommended) | real workerd, binding-faithful, CI-friendly | node APIs unavailable in tests | default |
| `wrangler dev` + HTTP tests | closest to prod | slow, flaky port mgmt in CI | pre-deploy smoke only |
| unstable_dev API | scriptable | deprecated-ish, awkward DO access | avoid |

## Validation Criteria
- [ ] Concurrency test proves unique control numbers under a 20-parallel allocate burst.
- [ ] Bilateral handshake over two real DO stubs → countersigned manifest, hash-identical to
      the in-memory driver's result for the same fixtures.
- [ ] Queue consumer test covers ack, retry, and missing-map ack paths.
- [ ] CI runs both pools; unit suite still green and untouched.

## Failure Modes
| Failure | Detection | Recovery |
|---|---|---|
| `node:` imports leak into worker-pool tests | pool compile error | keep fixture-loading in setup files; pass strings in |
| DO storage transaction API mismatch vs `SeqStorage` seam | type error in wtest | adjust seam, not the DO |
| Local D1 schema drift | SQL errors in wtest | single migrations dir, applied in setup |

## Go/No-Go
- **GO** immediately — no external gate. **This is the highest-value pre-deploy item.**
- **PIVOT:** if pool tooling fights the monorepo, fall back to `wrangler dev` + the smoke
  script for the same coverage, and record the debt.
