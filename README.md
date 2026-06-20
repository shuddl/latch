# Latch

**Two systems. One handshake. Zero integration cost.**

Latch turns a trading-partner EDI integration from a multi-week, specialist-driven, $15k–$50k project into a **self-serve, same-day, provably-correct** connection — for **$0 setup** — and then keeps it alive automatically.

The wedge is not "AI builds your map faster." That now exists (AWS B2B Data Interchange, Orderful Mosaic, Cleo, Chain.io). The wedge is **provable correctness**: everyone else hands you a generated map plus an *accuracy score* and a human review step. Latch generates the map **and proves it correct** by injecting tested EDI through it against golden records derived from the partner's own companion guide, producing a **visual, benchmark-grade certification** before anything touches production — then watches the live stream and **self-heals on drift** so a partner's quiet change never becomes "missing deliveries."

---

## What this repo is

This is the **build-ready document foundation** for Latch, written to be executed by Claude Code. Read `CLAUDE.md` first — it is the operating manual. Then read the docs in order.

> **North star for every document and every line of code:** *humorously simple.* If a doc, a screen, or an abstraction is not making the build or the product simpler, it is wrong. The hero flow is three steps: **drop a guide → watch it certify → click go-live.**

## How it's organized

```
latch/
├── README.md                       ← you are here
├── CLAUDE.md                       ← READ FIRST. How to build, principles, guardrails, build order.
├── TASKS.md                        ← sequenced, actionable backlog. Start at Milestone 0.
└── docs/
    ├── 01-vision.md                ← north star, the 50x thesis, the wedge, the moat, the arc
    ├── 02-prd.md                   ← personas, jobs, user stories, scope/non-goals, targets
    ├── 03-edi-domain-primer.md     ← X12 sets, the cert-loop problem, glossary (domain grounding)
    ├── 04-architecture.md          ← system design, components, Cloudflare-native stack, data flow
    ├── 05-handshake-protocol.md    ← THE novel core: the bilateral, self-certifying Latch Handshake
    ├── 06-data-model.md            ← D1 schema (SQL DDL) + the canonical semantic model
    ├── 07-verification-and-testing.md ← the Proof engine, EDI injection, golden records, self-healing
    ├── 08-api-and-interfaces.md    ← REST API, internal interfaces, connectivity adapters
    ├── 09-ux-and-visual-spec.md    ← the humorously-simple flows + the visual certification report
    ├── 10-roadmap-and-milestones.md ← phased build, MVP definition, demo checkpoints, DoD
    ├── 11-icp.md                   ← Ideal Customer Profile, segments, targets
    ├── 12-gtm-and-pricing.md       ← positioning, motion, channels, pricing/packaging, KPIs
    └── 13-adjacent-use-cases.md    ← where this generalizes (firewall, API bridge, embed, verticals)
```

## Planning & review (read before building)

- [`REVIEW.md`](./REVIEW.md) — document review: findings, risks, and decisions **noted for approval** (the vision docs are unchanged).
- [`LAUNCH-PLAN.md`](./LAUNCH-PLAN.md) — needs, sprints, and the four launch gates (L0→L4) through to GA.

## Quickstart for Claude Code

1. Read `CLAUDE.md` end to end. Internalize the principles and guardrails.
2. Read `docs/01` → `docs/13` in order. Build a mental model of the whole before writing code.
3. Open `TASKS.md`. Execute **Milestone 0** (repo scaffold + Cloudflare bindings + CI), then **Milestone 1** (the one-sided "certify a partner" MVP — the entire wedge in a single thin slice).
4. After each milestone, run the **Definition of Done** checklist (in `10-roadmap`) and stop for review.

## The three things to never get wrong

1. **Correctness is the product.** A 92%-correct map that silently corrupts an invoice is worse than no product. The Verification Engine (`docs/07`) is the moat, not a feature. Build it first and never weaken it.
2. **Deterministic at runtime, AI at build-time.** LLMs generate and heal maps. Compiled, deterministic transforms execute them. Never put an LLM in the per-transaction hot path. (Cost, latency, and — above all — repeatability.)
3. **One-sided value, bilateral endgame.** The MVP must deliver full value to a *single* customer who brings a legacy partner. The bilateral handshake (`docs/05`) is the network endgame, not the entry requirement. Do not build a product that requires both sides to adopt before anyone gets value.
