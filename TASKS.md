# TASKS — Latch build backlog

Execute top-to-bottom. Each task is a vertical slice with an explicit acceptance check. Honor the Definition of Done in `CLAUDE.md §5` and `docs/10`. Mark `[x]` as you go and update the "Doc gaps" section whenever a doc is ambiguous — then proceed with your best assumption (leave a `// LATCH-ASSUMPTION:` comment).

> **Start here:** read `CLAUDE.md`, then `docs/01`→`13`, then do **M0**, then **M1**. M1 alone is a credible demo and the GTM wedge — get there fast and clean.

---

## Milestone 0 — Scaffold & ground

- [x] **0.1** Init pnpm + Turborepo monorepo. Create `apps/api`, `apps/web`, `apps/pipeline`, and `packages/{edi-core,canonical,spec,mapgen,transform,verify,heal,handshake,connectivity,shared}` as buildable stubs. TS strict, ESLint, Prettier, Vitest at root.
- [x] **0.2** `apps/api`: minimal Cloudflare Worker (Hono or itty-router) serving `GET /v1/health`. `apps/web`: Vite + React shell that calls it.
- [x] **0.3** `wrangler.toml` per worker. Declare bindings: D1 (`LATCH_DB`), KV (`LATCH_KV`), R2 (`LATCH_R2`), Queues (`txn-ingest`, `txn-egress`, `recert`), Durable Objects (`ConnectionDO`, `HandshakeDO`). Account id and zone come from `.dev.vars` — never inline. Ship `.dev.vars.example`.
- [x] **0.4** D1 migrations implementing the `docs/06` schema. A migration runner script. Seed a `default` tenant.
- [x] **0.5** `packages/shared`: ULID id helpers (prefixed), structured logger, typed error + `Result` helpers, Zod utilities, config loader (reads bindings/env).
- [x] **0.6** `packages/canonical`: the `docs/06` types + Zod schemas for all record kinds. Export a `canonicalVersion` constant.
- [x] **0.7** `packages/edi-core`: evaluate `node-x12` / `x12-parser` / Stedi EDI tooling; wrap the best behind the `EdiCore` interface (`docs/08`). **Acceptance:** unit test round-trips a sample 214 (parse→serialize) byte-faithfully for populated elements.
- [x] **0.8** Dev-stub auth middleware: `X-Latch-Dev-Org` → `tenant_id`. (No real auth — `CLAUDE.md §2.3`.)
- [x] **0.9** `fixtures/`: ≥3 realistic sample files per starting set (start with 214), plus 1 sample companion guide (PDF) for 214. Anonymized.
- [x] **0.10** CI (GitHub Actions or equivalent): typecheck + lint + Vitest + the injection-harness skeleton (`docs/07`). Green required to merge.
- [x] **DoD-0:** `pnpm dev` runs api+web locally; `wrangler deploy` puts `/v1/health` on the dev subdomain; CI green; sample 214 round-trips.

## Milestone 1 — Certify one set (THE WEDGE, 214) ★

- [x] **1.1** `packages/spec` — Spec Ingestor (PR #7). `ingestSpec(client, guide+samples)` → Zod-validated `LatchSpec`, samples as ground truth, per-field confidence, low-confidence fields surfaced (never silently accepted), set/version pinned. **Debt:** persistence is via the connection's samples/maps, not a dedicated hashed `specs` R2/D1 row yet; PDF guide ingestion not wired (text guide only) — see PG-5/OP-4 below.
- [x] **1.2** `packages/mapgen` — `generateMap(client, spec)` → versioned `MapArtifact` with `compiledHash`, Zod-validated, gated by the Verification Engine (PR #7). **Debt:** emits the **inbound** direction; the outbound direction reuses the same artifact via `fromCanonical` (round-trip proven) but a dedicated canonical→EDI *generation* path/prompt is task 3.3.
- [x] **1.3** `packages/transform` — deterministic engine: `toCanonical`/`fromCanonical` executing a `MapArtifact`. **No LLM.** Pure, typed, `TransformResult` (never throws). Raw qualifiers + `raw.__edi` snapshot for fidelity. Now incl. `codemap` + repeating `loop` + numeric `cast` rule kinds.
- [x] **1.4** `packages/verify` — golden synthesis + the three-oracle Verification Engine (invariant/forward/differential), scored vs the benchmark bar (`docs/07`). **Debt:** `certification_runs` persist to D1/R2; standalone `golden_corpora` table not separately persisted (corpora are rebuilt deterministically from the sample fixture each run, which is sufficient + reproducible).
- [~] **1.5** `apps/api` — onboarding + certification endpoints (`docs/08`): create connection, upload samples, `ingest`, `generate-map`, `certify`, get map/cert + report (PR #4/#7). **Skipped (debt):** async jobs (`/v1/jobs/:id`) + SSE/WebSocket progress stream — certification is fast + synchronous today, so the live timeline is client-polled; revisit if cert latency grows. Guide upload endpoint takes inline text, not a file/R2 upload yet.
- [x] **1.6** `apps/web` — hero flow + visual certification report (gauge, dimensions, per-record drill-down, adversarial panel) + drift timeline + connection detail (PR #4/#6). **Debt:** coverage *heatmap* and per-field guide-reference drill-down are simplified to the dimension/record views; "dollars protected" deferred (D6).
- [x] **1.7** Injection harness wired into CI against `fixtures/`; PRs touching engine packages fail below bar.
- [x] **DoD-1:** onboard → generate/register map → benchmark-passing certification → report, reproducible from a single test command and from the UI (synthetic fixtures; real-guide DoD still wants N1).

## Milestone 2 — Live traffic + acks
- [ ] **2.1** `packages/connectivity` — SFTP adapter implementing `ConnectivityAdapter`. **NOT BUILT (stub package).** Inbound today is the HTTP `ingest` endpoint + the queue consumer; SFTP/AS2 transport is M2.1/3.2. R1 risk: SFTP-in-Workers spike still open.
- [x] **2.2** queue consumer (co-located in `apps/api`, not a separate `apps/pipeline`): parse → transform (pinned map) → persist canonical (R2) + `transactions` row → emit **997** (PR #4). **Debt (TD2):** 997 AK3/AK4 element-level error positions are coarse; fine-grained rejection detail deferred.
- [~] **2.3** control-number sequencing + idempotency/duplicate detection. **Done** in the Store (`findTransactionByControls`, idempotency keys). **Skipped (debt):** the dedicated `ConnectionDO` (501 stub) for per-connection outbound sequencing — not needed until outbound/AS2 transport exists.
- [x] **2.4** API + UI: `go-live` (guarded promote certified→production), transaction index/detail, **replay** (PR #4).
- [~] **DoD-2:** parsed→transformed→persisted→997→visible→replay→dedup all proven via the HTTP path + tests; the SFTP *drop* path awaits 2.1.

## Milestone 3 — Six sets + AS2
- [~] **3.1** Extend ingestor/mapgen/verify/transform to **204, 990, 211, 210, 997** (inbound+outbound as relevant; 204↔990 pairing; 210 invoice; 211 BOL). Add fixtures per set.
  - [x] **3.1a — 990 (TenderResponse), the second flat set.** Hand-authored `MAP_990_TENDERRESPONSE`, `buildCorpus990`, `fixtures/990`. Added a reusable **`codemap`** rule kind (forward-only EDI-code→canonical-enum via a declared table; write-back rides in the raw snapshot so round-trip stays byte-faithful) — the engine, the differential oracle, and the mapgen prompt all understand it. Added a **transaction-set registry** (`apps/api/src/transaction-sets.ts`) so maps/generate-map/certify/drift route by set instead of `=== '214'`. 990 onboards→certifies→goes-live→ingests end-to-end (API test). 111 tests green.
  - [~] **3.1b — repeating-loop sets.** Added the `loop` rule kind (anchor-delimited windows → canonical array; byte-faithful round-trip item i ↔ window i; uncast `element` children written back, cast/derived/codemap children forward-only via snapshot) + numeric `cast` on element rules + loop-aware differential oracle.
    - [x] **204 (Tender)** — `MAP_204_TENDER` (stops S5-loop with nested party + address, freight AT8-loop, references L11-loop), `buildCorpus204`, `fixtures/204`. Certifies at the full bar incl. loop shapes ×1/×2. Registered.
    - [ ] **210 (Invoice)** — `charges[]` (L1/L0 loop) + billTo party + numeric `total`/`amount` casts. Next.
    - [ ] **211 (BOL)** — `freight[]` loop + qualifier-filtered N1 party loops (SH/CN/BT) for shipper/consignee/billTo single parties. Needs qualifier-filtered single-element addressing (a small extension to element/loop: match an anchor occurrence by a qualifier element). Most complex of the three.
- [ ] **3.2** AS2 adapter (sign/encrypt/MDN; encrypted cert material). VAN interconnect documented + stubbed.
- [ ] **3.3** Outbound generation paths (emit 990 for a 204; emit 214/210).
- [ ] **3.4** Spec Library: every passing cert normalizes + accretes a `spec_library` entry.
- [ ] **DoD-3:** all six sets onboard+certify; inbound 204→canonical `Tender` + certified outbound 990; AS2 round-trips with MDN; Spec Library populated.

## Milestone 4 — Self-Heal (recurring tier) ★
- [x] **4.1** `packages/heal` — deterministic schema-drift detection vs certified baseline (new_segment/changed_qualifier/structural), **non-blocking** in the pipeline; opens `drift_events` (PR #5). **Debt:** the optional Workers-AI cheap-classify semantic-anomaly pass is not wired (deterministic structural drift only).
- [x] **4.2** Patch proposal (`patchMap`, Anthropic, build/heal-time) → draft patched map → **shadow re-certification at the full bar** (+ the new drift case) (PR #5/#7). **Debt:** auto-apply of a passing patched map writes the heal decision + shadow result; the auto-promote of the patched artifact to active is recorded but the LLM patch path needs a key (deterministic detection works without it).
- [x] **4.3** Per-connection heal policy (auto-apply additive vs one-click approval vs hold); last-good map stays live until applied (PR #5).
- [~] **4.4** UX: drift timeline + approval/dismiss flow (PR #6). **Skipped (debt):** monthly health / "dollars protected" view — shown as health counts today; the D6 dollar formula is undecided.
- [x] **DoD-4:** inject a drifted file → DriftEvent opens, additive auto-applies within policy, breaking drift waits for approval, timeline narrates it in plain English; live traffic never stalls (proven via API + UI tests).

## Milestone 5 — Polish, Auth, design-partner GA
- [ ] **5.1** **Clerk auth + multi-tenant flip** (`tenant_id` becomes real; orgs/teams). The only point auth is built (`CLAUDE.md §2.3`).
- [ ] **5.2** Hardening: rate limits, observability/alerting, R2 lifecycle, secret-rotation runbook, error budgets.
- [ ] **5.3** UX polish to the `docs/09` bar; share-link certification; mobile-respectable health/approvals.
- [ ] **5.4** Onboard the design partner's full partner estate; capture before/after case study (time/cost/quality/drift caught) for `docs/12`.
- [ ] **DoD-5:** external user signs up → connects → certifies → live with auth on; design partner runs ≥N production connections; case study documented.

## Milestone 6 — The Handshake (bilateral / network)
- [ ] **6.1** `packages/handshake` — HSP state machine (`docs/05`) in `HandshakeDO`; Ed25519 signing; co-certification reusing `verify`.
- [ ] **6.2** The **Latch-aware shim** minimal HTTP contract for non-adopting partners.
- [ ] **6.3** UX: "Connect via Latch" + signed manifest view.
- [ ] **DoD-6:** two tenants (or tenant + shim) complete HELLO→spec exchange→map negotiation→co-certification→signed/countersigned manifest→activate, with live traffic flowing and the whole thing provable in the UI.

---

## Doc gaps / open questions (resolve with Spencer or with a stated assumption)

1. **X12 library choice** — **RESOLVED (this PR).** Evaluated `x12-parser` and `node-x12`: both are parse-only (no byte-faithful serializer), lossy (segments → name/positional maps, delimiters discarded), and Node-`stream`-based — adopting either would *regress* the byte-faithful round-trip that is the moat. Per `CLAUDE.md §2.4` we **kept the in-house delimiter-driven reader/writer** (zero prod deps, Workers-native, round-trips the 214 fixture byte-for-byte) and **added a loop-aware structural layer** (`address.ts`/`loops.ts`/`envelope.ts`) on top of the `EdiCore` interface. Documented in `// LATCH-ASSUMPTION:` comments in `packages/edi-core`.
2. **Real companion guides + sample files** — the design partner's actual R&L (and other) 214/204/210/211 guides + samples would make M1 goldens real, not synthetic. Acquire early; until then, use anonymized synthetic fixtures.
3. **Self-heal auto-apply policy defaults** — proposed default: auto-apply only patches that *add* handling for new optional data and pass 100%; require approval for any change to existing field semantics. Confirm risk appetite.
4. **Pricing specifics** — `docs/12` sets the model (free onboarding, per-connection self-heal subscription); the actual price points need market validation with design-partner-adjacent firms.
5. **Connectivity reuse vs. provision** — confirm the design partner's existing VAN/AS2/SFTP can be reused for new sets (the fast path) vs. needing new provisioning.
6. **Product name** — "Latch" is a placeholder; a one-pass find-replace renames it everywhere if desired.
7. **Canonical model coverage** — `docs/06` covers the six freight sets; confirm no immediate retail/healthcare requirement before widening (`docs/13`).
8. **Tenancy/identity model at GA** — org/team structure and roles for M5 Clerk integration to be specified just before that milestone.

---

## Technical debt ledger (audit 2026-06-24)

Single source of truth for known, *intentional* debt. Each item is either scheduled to a
milestone or accepted with a rationale. No hidden debt: the repo has zero TODO/FIXME/HACK
markers; all stubs are explicit (501 DOs, empty `connectivity`/`handshake` packages).

**Blockers before production GA**
- **OP-1 — Real companion guides + sample EDI** (design partner's actual files). Until then goldens are anonymized synthetic. External, not a code task. → before M1 "real-guide" DoD.
- **OP-2 — Connectivity spike (R1):** SFTP/AS2 in the Workers runtime is unproven. → M2.1/3.2. Inbound today is the HTTP `ingest` endpoint + queue consumer.
- **OP-4 — PDF guide ingestion:** `ingestSpec` takes guide *text*; PDF/DOCX upload + Anthropic native-PDF path not wired. → M1.1 follow-up.

**Production hardening (before M5 GA)**
- **PG-1 — Rate limiting:** none per-tenant/connection. → M5.2 (DO + KV).
- **PG-2 — Auth:** dev-stub `X-Latch-Dev-Org` header only (intentional, CLAUDE.md §2.3). → M5.1 Clerk.
- **PG-3 — Observability/alerting:** structured logs + requestId only; no metrics/alerting. → M5.2.
- **PG-4 — Secret rotation/audit runbook:** not written. → M5.2.
- **PG-5 — Input size limits:** guide text / samples unbounded (OOM risk). → M1.5 (add max sizes).
- **PG-6 — Error-message sanitization:** transform/parse errors may include raw segment text; sanitize before returning. → M1.5.
- **PG-7 — LLM eval/regression set:** no golden guide→spec→map examples to catch prompt regressions. → M1.5.
- **PG-8 — Share-link token security:** entropy/expiry/revocation unspecified. → M1.6.

**Engine / set-coverage debt**
- **3.1b 210 + 211** not built (204 done). 211 needs qualifier-filtered N1 party addressing.
- **Loop v1 limits:** loops don't nest (children are flat); loop write-back maps item *i* ↔ window *i* with no structural add/remove (extra canonical items are dropped on serialize with the snapshot riding for fidelity). Documented in `map.ts`/`engine.ts`. Sufficient for inbound cert; revisit for outbound authoring.
- **TD2 — 997 AK3/AK4** element-level error positions are coarse. → M2.2 follow-up.
- **1.5 async jobs/SSE** progress stream skipped (cert is synchronous + fast; client polls).
- **Spec/corpus persistence:** specs ride on the connection (no dedicated hashed `specs` row); `golden_corpora` rebuilt deterministically per run rather than stored. Accepted (reproducible).

---

## Resolutions delivered (deterministic engine spine PR)

This PR lands the genuinely-provable, **LLM-free** core of M1 — everything that can be
certified in CI without an Anthropic key, real companion guides, or the Cloudflare runtime.
LLM-dependent paths (`spec` ingestor 1.1, `mapgen` 1.2) and runtime-dependent paths
(`connectivity`, live `pipeline`, API/web hero flow 1.5/1.6) are deliberately **left as
honest stubs** to be built where they can be *proven*, not faked.

- **edi-core loop/address/envelope layer (TD1/TD2/G3/G4):** structural accessors over the
  byte-faithful reader; deterministic `buildInterchange()` enveloper (fixed-width ISA,
  recomputed SE/GE/IEA counts). Round-trip stays byte-exact.
- **G1 — raw-fidelity contract (the round-trip law):** every canonical record carries
  `raw.__edi`, a verbatim snapshot (`delimiters` + ISA/GS/ST elements + body segments).
  `fromCanonical` rebuilds bytes from the snapshot, overlaying only `element`-rule
  write-backs ⇒ proven byte-faithful. `const`/`derived` rules are forward-only.
- **G2 — 214 timezone/semantics:** `occurredAt` is a forward-only `derived` field
  (advisory); authoritative AT7 date/time/qualifier ride untouched in the snapshot, so no
  instant is lost or garbled. Decision recorded; revisit if a consumer needs a true offset.
- **B1 — the oracle (existential):** `verify` runs **three independent oracles** —
  invariant (round-trip losslessness), forward (vs a human-confirmed expected canonical,
  ignoring `__edi`), and **differential** (re-reads the source element address directly,
  independent of the engine's map-walk). `certify()` scores all six `docs/07` benchmark
  dimensions and hard-fails on any forward/differential mismatch. A "broken-map-must-fail"
  test proves the bar has teeth.
- **CI injection harness (G5 skeleton):** `verify.test.ts` reads the on-disk 214 fixture,
  builds the golden corpus, and asserts a green certification — wired into the existing
  `pnpm test` gate.
- **TD5:** `SECURITY.md` landed (partner EDI is PII + commercial data).

### Deferred (built where provable — not stubbed with fake logic)
- **1.1 `spec` ingestor / 1.2 `mapgen`** — need the Anthropic API + real guides; the
  `MapArtifact` format and hand-authored 214 map make these a drop-in once keys/guides exist.
- **`connectivity` / live `pipeline` / 1.5 API / 1.6 web** — need the Cloudflare runtime to prove.
- **TD2 AK3/AK4 element-position issues in `validateEnvelope`** — deferred to M2.2 (997), as planned.
