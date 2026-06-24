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

- [ ] **1.1** `packages/spec` — Spec Ingestor for 214. Input: guide (PDF/text) + samples + set + version. Use Anthropic API to extract a `LatchSpec` (segments/elements/loops/qualifiers/usage), **using samples as ground truth** and flagging guide-vs-sample deviations. Validate output with Zod; mark per-field confidence; **never silently accept low-confidence fields.** Persist spec (R2 json + D1 row, hashed).
- [ ] **1.2** `packages/mapgen` — generate the **inbound 214 → canonical `StatusEvent`** map as **declarative rules** (data, not imperative code). Anthropic-assisted proposal; output a versioned `MapArtifact` with `compiled_hash`. Also generate the **outbound** direction (canonical → 214) for round-trip testing.
- [x] **1.3** `packages/transform` — deterministic engine: `toCanonical` and `fromCanonical` executing a `MapArtifact`. **No LLM.** Pure, typed, returns `TransformResult` (never throws into a hot path). Preserve raw qualifiers + `raw` escape hatch for fidelity.
- [x] **1.4** `packages/verify` — (a) **golden synthesis** from spec + samples covering valid/boundary/every-qualifier/every-loop/deviation/adversarial; (b) the **Verification Engine**: inject corpus through the map both directions, compare to expected, compute round-trip fidelity + coverage + adversarial-graceful, score vs the **benchmark bar** (`docs/07`). Persist `golden_corpora` + `certification_runs` + per-field results (R2).
- [ ] **1.5** `apps/api` — onboarding + certification endpoints (`docs/08`): create connection, upload guide/samples, `ingest`, `generate-map`, `certify`, get spec/map/certification. Async jobs (`/v1/jobs/:id`) + progress stream (SSE/WebSocket).
- [ ] **1.6** `apps/web` — the hero flow Screens 1–4 (`docs/09`): add partner → drop guide+samples → **live certification timeline** → the **visual certification report** (coverage heatmap, round-trip gauge, per-field drill-down with guide refs, adversarial panel). Use the `frontend-design` skill.
- [x] **1.7** Wire the **injection harness into CI** against `fixtures/` 214; PRs touching engine packages fail below bar.
- [ ] **DoD-1:** a non-EDI user uploads a real 214 guide + samples and gets a **green, benchmark-passing certification** visually — no manual mapping. Reproducible from a single command and from the UI.

## Milestone 2 — Live traffic + acks
- [ ] **2.1** `packages/connectivity` — SFTP adapter implementing `ConnectivityAdapter` (poll inbound → archive R2 → enqueue; outbound write). Secrets in `.dev.vars`/Cloudflare secrets.
- [ ] **2.2** `apps/pipeline` — `txn-ingest` consumer: parse → transform (pinned map version) → persist canonical (R2) + `transactions` row → emit **997**.
- [ ] **2.3** `ConnectionDO` — control-number sequencing + idempotency/duplicate detection.
- [ ] **2.4** API + UI: `go-live` (promote certified→production, guarded), transaction index/detail, **replay**.
- [ ] **DoD-2:** drop a real 214 on SFTP → parsed, transformed, persisted, 997 returned, visible in UI; replay works; duplicates ignored.

## Milestone 3 — Six sets + AS2
- [~] **3.1** Extend ingestor/mapgen/verify/transform to **204, 990, 211, 210, 997** (inbound+outbound as relevant; 204↔990 pairing; 210 invoice; 211 BOL). Add fixtures per set.
  - [x] **3.1a — 990 (TenderResponse), the second flat set.** Hand-authored `MAP_990_TENDERRESPONSE`, `buildCorpus990`, `fixtures/990`. Added a reusable **`codemap`** rule kind (forward-only EDI-code→canonical-enum via a declared table; write-back rides in the raw snapshot so round-trip stays byte-faithful) — the engine, the differential oracle, and the mapgen prompt all understand it. Added a **transaction-set registry** (`apps/api/src/transaction-sets.ts`) so maps/generate-map/certify/drift route by set instead of `=== '214'`. 990 onboards→certifies→goes-live→ingests end-to-end (API test). 111 tests green.
  - [ ] **3.1b — repeating-loop sets (204 Tender stops[]/freight[], 210 Invoice charges[], 211 BOL freight[]).** Needs a `loop` rule kind: map a repeating segment window to a canonical array, with byte-faithful round-trip (item i ↔ window i, overlay element write-backs onto the snapshot) and loop-aware differential-oracle coverage. 211 party loops (N1*SH/CN/BT) additionally want qualifier-filtered single-element addressing. Scope as its own PR — the loop write-back deserves dedicated golden tests.
- [ ] **3.2** AS2 adapter (sign/encrypt/MDN; encrypted cert material). VAN interconnect documented + stubbed.
- [ ] **3.3** Outbound generation paths (emit 990 for a 204; emit 214/210).
- [ ] **3.4** Spec Library: every passing cert normalizes + accretes a `spec_library` entry.
- [ ] **DoD-3:** all six sets onboard+certify; inbound 204→canonical `Tender` + certified outbound 990; AS2 round-trips with MDN; Spec Library populated.

## Milestone 4 — Self-Heal (recurring tier) ★
- [ ] **4.1** `packages/heal` — deterministic schema-drift detection vs certified spec + cheap-classify semantic anomaly (Workers AI), **non-blocking** in the pipeline. Open `drift_events`.
- [ ] **4.2** Patch proposal (Anthropic) → draft patched map → **shadow re-certification at full benchmark bar** (+ the new drift case).
- [ ] **4.3** Per-connection heal policy (auto-apply vs one-click approval); last-good map stays live until applied.
- [ ] **4.4** UX: drift timeline + approval flow + monthly health / "dollars protected" view (`docs/09`).
- [ ] **DoD-4:** inject a drifted file (new qualifier) → DriftEvent opens, patch proposed + passes shadow cert, auto-applies within policy (or waits for approval), timeline narrates it in plain English; live traffic never stalls.

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
