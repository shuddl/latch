# 02 — Product Requirements

## Personas

**P1 — The Overwhelmed Operator (primary).** Ops/IT generalist or owner-operator at a $10M–$250M carrier, brokerage, 3PL, or e-commerce brand. Wears five hats. Got burned by a TMS/ERP cutover or a big partner's EDI mandate. Cannot read X12 fluently and shouldn't have to. Wants the connection to *just work* and to stop being blindsided. **Success = a green certification and a quiet inbox.**

**P2 — The Lone EDI Analyst.** The one person (or outsourced contractor) who actually knows X12 at the company. Drowning in pairwise maps and partner cert cycles. Latch is a force-multiplier: it does the grunt translation and proves it; they supervise by exception. **Success = 10× their throughput without lowering quality.**

**P3 — The Controller / Finance Lead.** Feels EDI failure as billing exceptions, disputes, and cash delay. Cares that invoices (210/810) are correct and that delivery proof (214/POD) flows. **Success = clean billing, no manual rekey, no surprises.**

**P4 — The Partner's EDI Developer (counterparty).** On the other side of the cert loop (e.g. a national carrier's EDI dev). Today they spend weeks ping-ponging test files. With Latch, they receive a certification artifact to review, or — Phase 3 — their system handshakes with ours. **Success = drastically less of their time spent onboarding us.**

**P5 — The Embedding Vendor (adjacent).** A TMS/WMS/OMS SaaS company whose customers demand EDI. Embeds Latch as the EDI engine. **Success = ship EDI to their customers without building it.**

## Jobs to be done

- *"When a partner requires EDI, help me connect — today, myself, for free, and prove it's right."*
- *"When a partner changes something, catch it and fix it before it costs me money."*
- *"When I onboard many partners, make each one trivial and consistent."*
- *"When finance/ops asks 'is the connection healthy?', show them, visually, in one screen."*

## User stories (by phase)

### Phase 1 — Certify (MVP)
- As **P1**, I drop a companion guide (PDF/DOCX/XLSX) and 1–N sample EDI files, and Latch tells me which transaction sets it found and what it will build — in plain English.
- As **P1**, I watch a live progress view as Latch parses the spec, generates maps, synthesizes a test corpus, and injects it — and I get a **visual certification report** with a clear pass/fail and a coverage/confidence breakdown.
- As **P2**, I can open any mapped field and see *why* it mapped that way, the source guide reference, and the round-trip result — and override it, which re-runs certification.
- As **P1**, when certification is green, I click **Go live** and Latch begins processing real transactions over my existing connectivity.
- As **P1**, I can share a read-only certification link with the partner instead of running a cert ping-pong.

### Phase 2 — Self-Heal (recurring tier)
- As **P1**, Latch watches my live stream and, when a partner drifts, shows me exactly what changed, the patch it proposes, and the shadow re-certification result.
- As **P1**, within a policy I set, Latch auto-applies a high-confidence patch and tells me after the fact; otherwise it holds for my one-click approval.
- As **P3**, I get a monthly health view per connection: volume, exceptions, drift events caught, dollars protected.

### Phase 3 — Handshake (network)
- As **P1**, if my partner is also on Latch (or Latch-aware), I click **Connect via Latch** and the two systems negotiate, co-certify, and go live the same day — no file exchange, no analyst.
- As **P4**, I receive a signed certification manifest attesting both sides agree on the mapping and the golden-record results.

## Scope & non-goals

| In scope (Phase 1) | Explicitly NOT in Phase 1 |
|---|---|
| X12 transportation sets first: **204, 210, 211, 214, 990, 997** | EDIFACT, healthcare (837/835), retail breadth (later verticals) |
| Companion-guide ingestion (PDF/DOCX/XLSX/text) + sample EDI | Auth/SSO/RBAC (deployment gate — see CLAUDE.md §2.3) |
| Bidirectional maps to the canonical model | Billing/payments system (manual for first design partners) |
| Golden-record synthesis + EDI injection + visual certification | Multi-tenant org/team management (single-tenant dev first) |
| Connectivity: **SFTP + AS2** (VAN interconnect documented, stubbed) | Full VAN reseller relationships |
| Self-serve onboarding, $0 setup | The bilateral handshake (Phase 3) — design it now, build it later |

## Success metrics & targets (these are commitments, not aspirations)

| Metric | Target | Definition |
|---|---|---|
| **Setup cost** | **$0** | No professional services, no per-map fee. Self-serve onboarding is free. This is a positioning weapon. |
| **Time-to-certified** | **< 1 business day**; stretch **< 1 hour** for known sets | From "guide uploaded" to "green certification." |
| **Certification quality (the benchmark bar)** | See below | "EDI injection tested, performed, proven." |
| **Required-segment coverage** | **100%** | Every required segment/element in the guide is exercised by the corpus. |
| **Round-trip fidelity** | **≥ 99.9%** element-level | EDI → canonical → EDI reproduces every populated element losslessly. |
| **Qualifier coverage** | **100%** of qualifiers named in the guide | Each is exercised at least once. |
| **Adversarial handling** | **100% graceful** | Malformed/edge inputs are rejected or flagged, never silently mis-mapped. |
| **Self-heal MTTR** | auto **< 15 min**; supervised **< 4 hr** | Drift detected → patch certified → applied. |
| **Drift caught pre-production** | **100%** of detectable schema/qualifier drift | No detectable drift reaches a production failure. |
| **Visual** | every cert and every heal renders as a shareable visual artifact | Not optional. |
| **Activation (GTM)** | first certified connection within **24 h** of signup | The PLG north-star activation event. |

**The benchmark bar, precisely:** a map may be promoted to `production` only if its latest certification run shows 100% required-segment coverage, ≥99.9% element-level round-trip fidelity, 100% qualifier coverage, and 0 silent mis-maps on the adversarial set. Anything below bar stays `draft` and shows the operator exactly which fields fell short and why. See `07-verification-and-testing`.

## Constraints & assumptions

- **Connectivity reuse is the fast path.** Most target customers already have a VAN/AS2/SFTP pipe for their working transaction sets; Latch reuses it. New connectivity is the slower case and is handled but not assumed.
- **The partner is legacy and won't change** (Phase 1). All adaptation happens on our side.
- **Deterministic runtime / AI build-time** (CLAUDE.md §2.2) is a product requirement, not just an engineering one — it's what makes certification meaningful and repeatable.
