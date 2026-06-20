# 11 — Ideal Customer Profile

Build the MVP for the person in **Primary ICP**, not for a hypothetical enterprise. Everything in `02-prd` and `09-ux` is calibrated to them. The wedge — $0, same-day, self-serve, provably correct — is precisely the thing this buyer cannot get today.

## Primary ICP — the underserved regional carrier / broker / 3PL

| Attribute | Profile |
|---|---|
| **Who** | Asset-based regional carriers (LTL/TL), freight brokerages, and 3PLs |
| **Revenue** | **$10M–$250M** (the "too big to ignore EDI, too small to afford an EDI team") |
| **Trading partners** | Many and growing: interline/partner carriers, large shippers, load boards, retailers imposing mandates |
| **EDI capability** | **No dedicated EDI team.** One overworked ops/IT generalist, or an outsourced contractor, or the owner |
| **Systems** | A TMS like Carrier Logistics FACTS, McLeod, TMW, Tai, Turvo, Revenova; ERP on the back end |
| **Trigger** | Just survived (or is mid-) a TMS/ERP cutover that broke EDI, **or** a big partner just mandated EDI (204/214/210, or retail 850/810/856) on a deadline |
| **Pain** | Pairwise integrations they can't staff; multi-week partner cert loops; silent drift that becomes "missing deliveries," billing exceptions, and cash delay |
| **Budget reality** | **Cannot** stomach SPS/Cleo-grade services + analyst time + per-map fees for every partner |

**Why them, in order:**
1. **Highest pain-to-budget ratio in the market.** They feel enterprise-grade EDI pain on a small-business budget. Incumbents priced for the enterprise leave them stranded — exactly the gap the $0 wedge fills.
2. **Self-serve-able.** Small enough that one motivated operator can adopt without procurement, security review, or a steering committee.
3. **Existential failure mode.** For a thin-margin carrier, "deliveries went missing / billing broke after the cutover" is a cash event, not an inconvenience. Latch sells against catastrophe, which shortens the sale.
4. **Vast and underserved.** Thousands of these firms; no incumbent is courting them with a self-serve, correctness-first product.
5. **They seed the network.** Each one drags in big partners (the other side of the handshake) and accretes proven specs into the Spec Library (`01`, `05`).

> The founding design partner is a textbook instance of this ICP: a ~century-old regional LTL carrier with a national-partner estate, a recent TMS cutover that broke EDI into a "missing deliveries" crisis, and no EDI team to throw at it. Use them as proof case #1 (`12`).

## Buyer / champion / influencers

- **Economic buyer:** owner/operator, President, VP Ops, or COO at the smaller end; CIO/Controller as the firm grows.
- **Champion:** the **Overwhelmed Operator** (P1) or **Lone EDI Analyst** (P2) — whoever got burned by the cutover and is personally on the hook for partner connections.
- **Influencer:** the **Controller** (P3) — billing/cash pain makes them a fast internal ally.
- **Blocker (rare at this size):** IT security if AS2 certs/SFTP keys are involved — pre-empt with a clear security one-pager (handled in `04` security notes).

## Secondary / expansion ICPs (sequence after primary traction)

| Segment | Why | Notes |
|---|---|---|
| **E-commerce / CPG brands hit with retail EDI mandates** | Forced into 850/810/856/UCC-128 by a retailer with no EDI team | Big TAM, but retail set coverage (`13`) comes after the freight core (`10` M3+) |
| **SaaS TMS/WMS/OMS vendors** | Want to offer EDI without building it | Sell Latch as the **embedded engine** (`08`, `13`) — B2B2B distribution leverage |
| **3PLs onboarding shippers constantly** | Every new shipper is a new integration project | "Onboarding-as-a-service" (`13`); the self-serve + certification story is a direct fit |
| **Companies mid TMS/ERP migration** | The exact cutover pain, at the moment of maximum willingness | "Migration accelerator" (`13`) — re-certify the whole partner estate fast |

## Anti-ICP (do not chase early — it dilutes the wedge)

- **Large enterprises with entrenched Sterling/SPS/Boomi estates** and dedicated EDI teams. Long procurement, security reviews, incumbent inertia, and they don't feel the $0/self-serve wedge. Reach them later via **embedding** and **partnership**, not the bottom-up motion.
- **Companies with one or two stable partners and zero growth** — too little pain to switch.
- **Verticals requiring regulated message types out of the gate** (healthcare 837/835) — capable architecture, deliberate later entry (`13`).

## ICP-level targets (commitments)

| Target | Value | Why it matters to this ICP |
|---|---|---|
| **Setup cost** | **$0** | They have no budget for services/per-map fees; this is the door-opener |
| **Time-to-first-certified-connection** | **< 24 h** from signup; stretch same-hour | They're in crisis or on a deadline; speed *is* the value |
| **No specialist required** | a non-EDI operator certifies a connection unaided | They don't have a specialist; the product must not assume one |
| **Certification quality** | benchmark bar (`07`) | "Proven," not "probably" — because their failure mode is a cash event |
| **Self-heal** | drift caught before production failure | Directly kills the "missing deliveries after cutover" trauma |
| **Expansion** | grows from 1 → all their partners | Land on one painful connection, expand across the estate |

## Qualifying questions (for GTM / sales-assist)

1. Do you have a dedicated EDI person, or does it land on whoever's closest? *(No team → strong fit.)*
2. Have you had a partner connection break quietly and find out from a missed delivery or a billing dispute? *(Yes → acute pain.)*
3. Are you adding trading partners, or is a big partner pushing new transaction sets on a deadline? *(Yes → urgency.)*
4. Did you recently change (or are you changing) your TMS/ERP? *(Yes → maximum-pain window.)*
5. What did your last partner integration cost in time and dollars? *(Anchors the $0 wedge.)*
