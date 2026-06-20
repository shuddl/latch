# 13 — Adjacent Use Cases

The core (provably-correct, self-serve, self-healing trading-partner connections) generalizes. These are deliberate expansion vectors, not Phase-1 scope. Each reuses the same spine — **canonical model + Verification Engine + Spec Library** — which is exactly why they're cheap to reach once the core exists. Sequenced roughly by proximity to the core.

## 1. EDI firewall / observability (lowest-friction entry)
**What:** Latch sits **inline or passively alongside** an existing translator and just *watches* — certifying every change, catching drift, scoring health — without the customer ripping out their current EDI stack.
**Why it's powerful:** removes the switching-cost objection. "Don't replace anything — just let us watch your EDI and tell you the moment a partner drifts." It's **EDI insurance**, and it's the softest possible first sale to a cautious buyer. Naturally upsells into full certification + self-heal.
**Reuses:** drift detection (`07` heal), the Spec Library, the visual health report. **Effort:** low — it's the heal/verify engine pointed at a mirror of live traffic.

## 2. API ↔ EDI bridge
**What:** expose any legacy partner's EDI as a clean REST/JSON API (and accept JSON, emit EDI) via the canonical model. Serves API-native companies forced to talk to EDI-only partners — the "hybrid EDI/API" pattern that's rising industry-wide.
**Why:** a whole class of modern shippers/brands/SaaS would rather never see X12. Latch's canonical model already *is* that clean interface; this is largely a packaging + endpoint exposure of capability the core builds.
**Reuses:** the canonical model (`06`), the transform engine, the connectivity `api` adapter (`08`). **Effort:** low–medium.

## 3. Embedded EDI engine for TMS/WMS/OMS (B2B2B distribution)
**What:** SaaS platforms embed Latch so *their* customers get instant, certified EDI without the platform building it. White-labeled certification report; scoped API tokens.
**Why:** the highest-leverage distribution channel — one integration, many downstream customers, and it reaches the Anti-ICP (`11`) enterprises indirectly. Turns competitors-adjacent platforms into resellers.
**Reuses:** the `/v1` API (`08`) with token scoping + white-labeling; the same engine. **Effort:** medium (permissioning, theming, SLAs) — *designed for* in `08`, not a re-architecture.

## 4. Onboarding-as-a-service for 3PLs
**What:** 3PLs onboard new shippers constantly; each is a fresh integration project. Latch makes every new shipper a same-day, self-serve, certified connection — productized as the 3PL's onboarding workflow.
**Why:** directly converts the core wedge into a repeatable workflow for a segment whose entire business is onboarding. High expansion (many connections per account).
**Reuses:** the whole core, framed as a multi-connection workflow + a 3PL-branded report. **Effort:** low (it's the core, packaged).

## 5. Compliance & benchmark certification artifact
**What:** the certification report as a **compliance/audit artifact** — chargeback defense (retail), audit evidence, partner SLAs, or a procurement requirement ("connections must be Latch-certified"). The signed handshake manifest (`05`) is a tamper-evident attestation between organizations.
**Why:** turns the proof into a standalone, sellable artifact and a potential industry standard ("Latch-certified" as a trust mark). Deepens the moat (the proof becomes the currency).
**Reuses:** the Verification Engine output (`07`) + handshake attestation (`05`). **Effort:** low–medium (formatting, signing, retention).

## 6. The Spec Library as a data product
**What:** the accreting, normalized, **deviation-aware** library of real-world partner specs (anonymized) — a reference dataset and benchmark. Think "the authoritative map of how partners *actually* implement X12, not how their guides claim they do."
**Why:** a unique, hard-to-copy data asset earned transaction by transaction. Powers instant onboarding, benchmarking, and (carefully, anonymized) potentially a sellable industry dataset. The compounding moat (`01`, `05`).
**Reuses:** `spec_library` (`06`) + every passing certification. **Effort:** low to accrete; medium to productize. **Handle privacy/anonymization carefully.**

## 7. Verticals beyond freight
The Verification-Engine wedge applies anywhere EDI correctness matters and silent failure is costly:

| Vertical | Sets | Notes |
|---|---|---|
| **Retail / supply chain** | 850 (PO), 810 (invoice), 856 (ASN), 855/865 (PO ack), 846 (inventory), UCC-128 labels | Largest adjacent TAM; chargeback pain mirrors freight's "missing deliveries." Extend canonical model with retail record kinds (`06`). |
| **Warehouse / 3PL** | 940 (ship order), 945 (ship advice), 947 (inventory adjustment) | Natural neighbor to the freight core. |
| **Healthcare** | 837 (claim), 835 (remittance), 270/271 (eligibility) | High stakes, **regulated (HIPAA)** — keep the architecture capable, enter deliberately with compliance work. Not an early move. |
| **Insurance / financial** | various X12 + EDIFACT | Long-horizon; same correctness thesis. |

**Rule:** extend by adding **canonical record kinds and new specs**, never by bloating the freight model (`06` design rule 2). The engine is vertical-agnostic; the canonical model grows in well-bounded increments.

## 8. Migration accelerator (the founding pain, productized)
**What:** companies migrating TMS/ERP (the exact cutover that breaks EDI) use Latch to **re-certify their entire partner estate fast** — turning a multi-month, high-risk EDI re-integration into a days-long certified cutover. Sell it as **cutover insurance**.
**Why:** it's literally the founding story (`01`, `12`) generalized into a repeatable offer, sold at the moment of maximum willingness to pay (`11` trigger). Strong wedge for the Anti-ICP too — even enterprises feel acute, time-boxed pain during a migration.
**Reuses:** the whole core, run in bulk across an estate, with a migration dashboard. **Effort:** low (packaging + bulk orchestration).

---

## Sequencing guidance

- **Nearest-term, lowest-effort, highest-leverage:** #1 (firewall/observability), #4 (3PL onboarding), #8 (migration accelerator) — all are the core *repackaged*, sellable as soon as the core (M1–M4) exists.
- **Medium-term distribution leverage:** #3 (embed) and #2 (API bridge) — designed-for in `08`, unlock big channels.
- **Moat-deepening, opportunistic:** #5 (compliance artifact) and #6 (spec library data product).
- **Deliberate, later, larger TAM:** #7 (verticals) — retail first, healthcare with care.

Do **not** let adjacency tempt scope creep in Phases 1–2. The discipline that makes all eight cheap later is building the core spine — canonical model, Verification Engine, Spec Library — cleanly first.
