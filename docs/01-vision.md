# 01 — Vision & North Star

## The problem, stated plainly

Connecting two companies' systems over EDI is still a multi-week, specialist-driven, expensive project — and it silently breaks. A single trading-partner integration commonly runs **4–12 weeks elapsed** and **$15k–$50k** in services plus internal analyst time. The transaction-set numbers are standardized (a 204 is a load tender everywhere), but every partner's *companion guide* — the document that says which segments, elements, and qualifier codes they actually populate — is bespoke. N partners × M transaction sets = N×M hand-built maps. The spec lives in a PDF. An aging, scarce class of EDI analysts reads that PDF and hand-translates it into a translator's mapping logic. Then both sides run a multi-week certification ping-pong. Then a partner quietly changes a qualifier, your map breaks without an error, and you find out when invoices stop or deliveries go "missing."

## What's already solved (so we don't pretend otherwise)

By 2026, **AI-assisted map generation is table stakes.** AWS B2B Data Interchange generates mapping code from sample files with a per-mapping accuracy score. Orderful's Mosaic markets AI-native, "zero-mapping," self-healing integrations. Cleo auto-generates integration logic from historical maps and is pushing agentic exception handling. Chain.io ingests a spec file to generate inbound mappings. "AI mapper" is no longer a product — it's a feature everyone has.

## Why none of that is 50× — the actual cost drivers

1. **Map generation is ~a third of the pain.** Elapsed time is dominated by the *two-sided certification loop* (the partner's analyst tests on the partner's schedule), connectivity setup, the operational wiring downstream of the map, and the fact that real partners deviate from their own companion guides.
2. **The generated map is never trusted blind.** Every incumbent hands you an *accuracy score* and a human review step — because a 92%-correct map silently corrupts invoices and drops shipments. Provable correctness on messy real-world X12 is genuinely unsolved, so the human stays in the loop, which caps the speedup far short of 50×.
3. **Drift is unmonitored.** The integration is treated as a one-time project, not a living connection. Nobody is watching for the partner's next quiet change.

## The wedge: provable correctness

**Latch's defensible difference is proof, not generation.** We generate the map *and prove it correct* — by synthesizing a golden-record corpus from the partner's own companion guide and samples, injecting tested EDI through the map in both directions, and producing a **visual, benchmark-grade certification** that exercises every required segment, every qualifier, every loop, and adversarial/malformed cases — *before anything reaches production*. The certification report is a shareable artifact that replaces the human cert ping-pong with a single document both sides can sign off on.

Then we keep the connection alive: Latch monitors the live stream, detects drift, proposes a patch, **re-certifies it in shadow**, and either auto-applies it within policy or surfaces a one-click approval. The "missing deliveries" failure mode is designed out.

## The endgame: the bilateral handshake (the moat compounds)

The full 50× is a **two-sided, agent-to-agent onboarding protocol** — the EDI equivalent of a TLS handshake or an OAuth flow. When both partners are on Latch (or one is "Latch-aware"), their systems negotiate the connection autonomously: discover specs, agree the canonical mapping, **co-certify against shared golden records**, and go live in an afternoon with **cryptographic attestation that both sides agree** — no analyst on either side. See `05-handshake-protocol`.

This has a cold-start problem (both sides must participate), and we resolve it honestly: **every one-sided onboarding accretes a normalized partner spec into the Latch Spec Library.** When the other side of an already-known partner shows up, the bilateral handshake becomes instant because we already hold a proven spec. The network builds one onboarding at a time. The library — real-world specs *with their deviations*, each proven by injection — is the moat. It is not easily copied; it is earned transaction by transaction.

## The arc (how the product grows)

| Phase | Name | What it does | Why it matters |
|---|---|---|---|
| **1 — MVP** | **Certify** | One-sided self-serve: drop guide + samples → spec → maps → golden corpus → injection → **visual certification** → go-live. $0 setup. | Delivers the whole wedge to a single customer with a legacy partner. No cold-start. |
| **2 — Recurring** | **Self-Heal** | Monitor the live stream, detect drift, propose + shadow-certify a patch, auto-apply within policy. | The recurring-revenue engine. "Insurance against the cutover disaster." |
| **3 — Network** | **Handshake** | Bilateral agent-to-agent negotiation + co-certification + cryptographic attestation. | The 50× endgame and the compounding moat (the spec library / network). |

## What winning looks like (3-year picture)

- A regional carrier, brokerage, or e-commerce brand connects to a demanding new trading partner **the same afternoon they decide to**, for **$0**, with a **green certification** they can hand to the partner — no analyst, no VAN ticket, no six-week cert.
- The phrase "our EDI broke after the cutover" stops being said by Latch customers, because drift is caught and healed before it reaches production.
- Latch holds the largest library of **proven, deviation-aware** partner specs in freight — and increasingly in retail and beyond — which makes every new bilateral connection instant and makes Latch the default place to stand up any EDI relationship.

## Founder context (read once)

The founding insight and the first proof come from a live, painful regional-carrier TMS cutover that broke EDI with multiple national partners and turned into a "missing deliveries" crisis with cash consequences. That carrier is the natural **design partner and founding case study**: re-certify its entire partner estate in a day, and the before/after is the wedge made concrete (`12-gtm`). The current pain *is* the product thesis in miniature — the map was never the bottleneck, the cert loop and the unmonitored drift were.

## Anti-goals (what Latch is deliberately NOT)

- Not another full managed-EDI services shop (that's the friction we're killing).
- Not a general iPaaS. We are sharp on one job: stand up and keep alive a *provably correct* trading-partner connection.
- Not an LLM-in-the-loop transaction processor. The runtime is deterministic; AI is confined to build/heal time.
- Not a configuration sandbox. Defaults are correct; options are the exception.
