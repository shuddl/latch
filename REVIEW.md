# Document Review — Findings for Approval

**Reviewer:** Claude Code · **Date:** 2026-06-20 · **Scope:** `CLAUDE.md`, `README.md`, `TASKS.md`, `docs/01`–`docs/13`, `.dev.vars.example`

> **How to read this:** Nothing in the numbered vision docs (`01`–`13`) was changed. Per the instruction "iterate as needed but … note all for approval," every issue below is **noted, not silently applied**. Each item has a severity, a recommendation, and a clear **Needs your call?** flag. Approve, amend, or reject item-by-item. The companion file `LAUNCH-PLAN.md` turns the approved items into sprints.

---

## Verdict

The foundation is **strong, internally coherent, and genuinely build-ready.** The thesis (proof, not generation), the build-time-AI / deterministic-runtime split, the canonical-hub architecture, the milestone ordering (214 first, auth last, self-heal before handshake), and the humorously-simple hero flow are consistent across all 13 docs and the task backlog. This is not a deck dressed up as a spec; it is executable.

The findings below are the gaps that stand between "executable on paper" and "shipping without a nasty surprise." There is exactly **one conceptual blocker** (B1 — the verification oracle), a short list of **technical risks to de-risk in M0**, a set of **decisions only you can make**, and the usual crop of **gaps and consistency nits**. None of them invalidate the plan; all of them are cheaper to resolve now than in code.

Severity legend: **🔴 Blocker** (resolve before building the affected module) · **🟠 Decision** (your call; has a sensible default) · **🟡 Gap** (clarify; I have an assumption) · **⚪ Nit** (consistency/polish).

---

## A. The one conceptual blocker

### B1 🔴 — The verification oracle: what is "expected canonical" graded against? `docs/07`
`07` says spec-derived golden cases have an **expected canonical output "computed deterministically from the spec, not by the model."** But the spec→canonical computation *is the mapping under test*. If the same spec interpretation produces both the map and the "expected" answer, the engine is grading the map against itself — a tautology that can pass a wrong map. Sample-derived cases are fine (a human confirms the expected output once, `07` step 1). Spec-derived cases are the exposure.

**Recommendation (needs approval):** treat the Proof as **three independent oracles**, not one:
1. **Human-confirmed anchors** — the operator confirms expected canonical for the sample/real files (already specified). These are the ground truth.
2. **Property/invariant oracle** — for spec-synthesized cases, assert *invariants* that don't depend on the map's own logic: round-trip losslessness (EDI→canonical→EDI reproduces every populated element), required-segment presence, qualifier-preservation, value-range conformance, loop-cardinality conformance. A map can't satisfy round-trip losslessness while silently dropping/mis-tagging a qualifier — this is the strongest *map-independent* signal and `07` already leans on it.
3. **Differential check (optional, high-value)** — generate the expected canonical with a *separate, simpler* deterministic spec-walker that is **not** the production map (e.g. a structural "every element at its guide-declared path → its declared canonical target" walker). Disagreement between the two implementations is a defect signal. This is the honest way to get a map-independent "expected" value.

**Net:** "100% coverage + 100% round-trip + 0 silent adversarial mis-maps" is a sound bar **only if** at least the invariant oracle (2) is in place; the differential oracle (3) is what lets us claim "proven" on spec-only cases with no human in the loop. **This is the single most important design decision in the product and should be settled before M1.4.** → *Needs your call.*

---

## B. Technical risks to de-risk in M0 (spikes, not decisions)

### R1 🔴 — Connectivity inside Workers (SFTP / AS2) is the top execution risk. `docs/03`,`04`,`08`
- **SFTP** needs a long-lived SSH session. The Workers runtime is request-scoped and historically had no raw TCP; `cloudflare:sockets` now offers TCP, but a working **SSH/SFTP client in the Workers runtime is non-trivial** and may not exist off-the-shelf. Plausible fallbacks: a queue-driven poller on a Cron tick using the socket API, a thin sidecar (a container/VM the Worker drives), or a partner-side push to an AS2/HTTPS endpoint we *do* control.
- **AS2** is an HTTPS endpoint (easy) wrapped around **S/MIME / PKCS#7 sign-encrypt-MDN** crypto. WebCrypto covers primitives but not the CMS envelope; needs a vetted lib that runs in the Workers runtime.

**Recommendation:** add an **M0 connectivity spike** (timeboxed) that proves one inbound + one outbound path end-to-end in the real runtime *before* M2 commits to SFTP. If neither SFTP-in-Worker nor AS2-in-Worker is clean, the architecture absorbs a small sidecar behind the existing `ConnectivityAdapter` interface — which is exactly why `08` put that interface there. No vision change; just verify the assumption early. → *De-risk, no approval needed.*

### R2 🟡 — Companion-guide ingestion: use Claude's native document input, don't build a PDF stack. `docs/04`,`08`
`08`'s `SpecIngestor.ingest` accepts a `Blob` guide. **PDF text extraction inside a Worker is heavy and error-prone.** The Anthropic API accepts **PDFs natively as document blocks** — pass the guide straight to Claude, no PDF library. DOCX/XLSX still need lightweight extraction (or convert-to-PDF/text upstream). **Recommendation:** Ingestor sends PDFs to Claude directly; handle DOCX/XLSX via a small extractor; document the path in `spec`. → *Assumption stated; flag if you disagree.*

### R3 🟠 Decision — Platform plan & cost ceiling. `docs/04`
Queues, Durable Objects, scheduled Cron, and inbound AS2 all require the **Workers Paid plan**, and build/heal-time **Anthropic API** usage is a real recurring cost (every ingest + mapgen + heal proposal). **Recommendation:** confirm account `1d40…d466` is on Workers Paid, and set a build-time AI budget/alert. Add a token-cost line to the KPIs. → *Needs your call (confirm plan + budget).*

---

## C. Decisions only you can make

| # | Sev | Item | Doc | Recommendation (default) |
|---|---|---|---|---|
| D1 | 🟡 | **Self-heal auto-apply default policy** (open Q #3) | `07`,`10` | Auto-apply **only** patches that *add* handling for new optional data **and** pass 100% in shadow; require one-click approval for any change to existing field semantics. Conservative by design. |
| D2 | 🟡 | **`frontend-design` skill availability** | `CLAUDE.md §3`,`09` | The skill is referenced as mandatory but **is not present in this environment.** Confirm it will be provided; otherwise we define a small design-token set (mono + restrained-accent, per `09`) ourselves and proceed. |
| D3 | 🟡 | **Product name "Latch"** (open Q #6) | `TASKS.md` | Keep "Latch" until told otherwise; it's a one-pass rename if you change it. |
| D4 | 🟡 | **First *live* flow for the carrier design partner** | `02`,`10`,`11` | M1 builds **inbound 214** (engine-proving, lowest risk — correct). But a *carrier* design partner **emits** 214 and 210 (outbound). Confirm M2's first real connection: inbound 214 from a partner, or outbound 214/210 the carrier sends. Both maps get built either way; this only sets which live direction we light up first. |
| D5 | 🟡 | **Spec Library data-handling & anonymization policy** | `06`,`13` #6 | The library accretes real partner specs. Before M3 turns on accretion, define what "normalized/anonymized" means contractually and technically (no partner-identifying values, opt-in posture). Needed for trust and for the `13` data-product path. |
| D6 | ⚪ | **"Dollars protected" methodology** | `07`,`09`,`12` | It's a headline GTM number with no formula. Default: `Σ(value of shipments/invoices on transactions that the caught drift would have corrupted)`, estimated from transaction value × affected-volume. Define before M4 UX. |

---

## D. External dependencies / "needs" (these gate phases, not code)

| # | Need | Gates | Owner | Notes |
|---|---|---|---|---|
| N1 | **Real companion guides + sample EDI** (design partner's R&L 214/204/210/211) | Credible M1; real goldens | Spencer | This is open-Q #2, elevated to a **hard dependency**. Until it lands, M1 runs on anonymized synthetic fixtures — which proves the engine but **not** the wedge claim on real-world mess. Acquire as early as possible. |
| N2 | **Design-partner commitment** (named, in-writing) for the founding case study | L1/L3 (`12`) | Spencer | The entire GTM proof engine rests on this one named carrier. |
| N3 | **Cloudflare Workers Paid plan** on account `1d40…d466` + Anthropic API key | M0 deploy onward | Spencer | See R3. Key already slotted in `.dev.vars.example`. |
| N4 | **Connectivity reuse confirmation** (open Q #5) | M2 | Spencer | Can the partner's existing VAN/AS2/SFTP pipe be reused, or is new provisioning needed? Changes M2 effort materially. |
| N5 | **Pricing validation** (open Q #4) | L3 (paid tier) | Spencer | The model is set (`12`); the price points need 2–3 ICP-adjacent conversations before the paid launch. |

---

## E. Consistency notes & smaller gaps (low-cost clarifications)

| # | Sev | Item | Doc | Note / recommendation |
|---|---|---|---|---|
| E1 | ⚪ | **"Never inline the account id" vs. account id inlined** | `CLAUDE.md §3`,`.dev.vars.example`,`10` | The account ID `1d40…d466` is printed in the docs while the guardrail says "never inline in source." Account IDs are **not secrets** (they're config, not credentials), so this is fine — but state that explicitly so no one treats it as a leak. *Secrets* (API keys, signing keys, AS2/SFTP creds) must stay in `.dev.vars`. **Fixed in this PR:** `.gitignore` did not ignore `.dev.vars` — now it does. |
| E2 | 🟡 | **Control-number authority: DO vs KV** | `04` | `04` puts control-number sequences in **KV with D1 backstop** *and* in **`ConnectionDO`**. For strict per-partner sequencing the single-threaded **DO must be authoritative**; KV is cache only. Recommend stating DO-authoritative to avoid a race. |
| E3 | 🟡 | **997 generation needs the parse outcome** | `03`,`04`,`10` | A correct 997 encodes accepted/rejected groups+segments. The pipeline must feed `TransformResult` errors into 997 construction. Make the parse-result→997 linkage explicit in M2.2. |
| E4 | 🟡 | **Canonical multi-stop freight linkage** | `06` | `Tender.freight: Freight[]` has no association to `Stop[]`. Multi-stop 204s can lose which freight belongs to which stop → round-trip fidelity risk. Not an M1 issue (214 has no stops); **add stop↔freight linkage before 204 lands in M3.** |
| E5 | 🟡 | **LLM build steps aren't reproducible** | `04`,`07` | Runtime is deterministic (correct) and the *cert* is replayable by hash (correct). But re-running `mapgen`/`ingest` can yield different artifacts. That's acceptable — the cert is the gate — but say so plainly, and add an **LLM eval/regression set** (a handful of guides with known-good specs/maps) so prompt edits don't silently regress quality. Add to M1. |
| E6 | 🟡 | **Share links are public + unauthenticated** | `08` | `GET /v1/share/:token` is public by design (good — replaces the cert ping-pong). Ensure tokens are high-entropy, revocable, and optionally expiring; the report must not leak partner-identifying internals beyond what's intended. |
| E7 | ⚪ | **Outbound 214 round-trip in M1 vs. "214 is inbound" framing** | `02`,`10` | M1 correctly builds *both* directions (round-trip needs it) while `02` frames 214 as inbound. No contradiction — just note the outbound map in M1 exists for verification, not yet for live emission (that's M2/M3). |
| E8 | ⚪ | **No license/contributing/security policy in repo** | repo | Foundation has `LICENSE` only. Before any external contributor or design-partner data, add a short `SECURITY.md` (how partner data is handled) — pairs with the `04` security one-pager the ICP blocker (`11`) expects. |

---

## F. What I changed in this PR (only safe, non-vision edits)

1. Landed the build-package foundation into the repo (`CLAUDE.md`, `README.md`, `TASKS.md`, `docs/01`–`13`, `.dev.vars.example`) — previously the repo held only a stub README.
2. **`.gitignore`:** added a Latch block that ignores `.dev.vars` (and Node/Wrangler/Turbo artifacts) while keeping `.dev.vars.example` tracked. This closes a real secret-leak gap (E1).
3. Added this `REVIEW.md` and the `LAUNCH-PLAN.md`. **No numbered vision doc was edited.**

---

## G. Recommended disposition

- **Settle B1 (oracle) and confirm N1 (real guides) + N3 (CF plan) before M1 build starts.** Everything else can proceed under the stated defaults and be ratified in-flight.
- The proposed defaults for D1–D6 and the E-series clarifications are safe to adopt as-is unless you say otherwise; they'll be applied as `// LATCH-ASSUMPTION:` notes in code and reflected in `TASKS.md` open-questions as they're resolved.

→ Continue to **`LAUNCH-PLAN.md`** for needs, sprints, and the phases through launch.

---

## H. Automated review disposition (PR #1, gemini-code-assist)

The bot raised 5 items, all on the `06` schema + `.dev.vars.example`. Disposition: the four schema items are sound and are **applied to the executable migration** (`infra/migrations/0001_init.sql`), not to Spencer's illustrative `docs/06` DDL — the doc stays the source narrative; the migration is the artifact. The account-ID item is declined with rationale.

| Bot item | Verdict | Action |
|---|---|---|
| `last_seen` → `last_seen_at` (timestamp-naming consistency) | Adopt | Renamed in migration. |
| Composite index `(connection_id, isa_control, gs_control, st_control)` on `transactions` | Adopt | Critical for 997-linking + duplicate detection at volume; added as `idx_txn_control`. |
| `partners` `UNIQUE(id, tenant_id)` | Adopt | Enables composite FKs for tenant isolation. |
| `connections` composite FK `(partner_id, tenant_id) → partners(id, tenant_id)` | Adopt | Defense-in-depth tenant isolation; applied across the child hierarchy (`specs`, `maps`, `connections`, …). App-level tenant scoping remains primary; FKs are a backstop. `PRAGMA foreign_keys=ON`. |
| Remove Cloudflare Account ID from `.dev.vars.example` | **Decline** | Intentional (CLAUDE.md §3): it's the single **house** account, not a generic OSS template, and an account ID is **config, not a credential** (see E1). Leaving it in the template is a deliberate convenience. Real secrets stay out of the example. |
