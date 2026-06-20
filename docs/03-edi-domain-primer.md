# 03 — EDI Domain Primer

Read this before touching `edi-core`, `spec`, `mapgen`, or `verify`. It is the minimum domain grounding to build Latch correctly. It is intentionally practical, not exhaustive.

## What EDI actually is

EDI (Electronic Data Interchange) is structured, machine-to-machine exchange of business documents in a fixed format. In North American transportation and retail, the dominant standard is **ANSI ASC X12**. A document type is a **transaction set**, identified by a number (e.g. 204, 810). The same number means the same business document everywhere — but *which fields each partner populates and how* varies per partner, and that variance is the entire reason integration is hard.

## X12 anatomy (just enough)

An X12 interchange is plain text, segment-terminated, with delimited elements:

```
ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260618*1305*U*00401*000000001*0*P*>~
GS*SM*SENDERID*RECEIVERID*20260618*1305*1*X*004010~
ST*204*0001~
B2**SCAC**1234567**PP~
...segments...
SE*42*0001~
GE*1*1~
IEA*1*000000001~
```

- **ISA / IEA** — the interchange envelope (sender/receiver IDs + *qualifiers*, control number, version).
- **GS / GE** — a functional group (groups transaction sets of one type).
- **ST / SE** — a single transaction set (one document).
- **Segments** — lines beginning with a 2–3 char ID (`B2`, `N1`, `L11`...). Each segment is a list of **elements** separated by the element delimiter (commonly `*`). Segments end with a terminator (commonly `~`). A sub-element delimiter (commonly `>`) splits composite elements.
- **Loops** — repeating groups of segments (e.g. an `N1` party loop, an `S5` stop loop). Loop structure is positional and is the most common source of mapping bugs.
- **Qualifiers** — coded elements that say what an adjacent value *means* (e.g. an `N1` segment's entity-identifier code `SH` = shipper, `CN` = consignee; a reference qualifier `BM` = bill of lading number, `PO` = purchase order). **Qualifier handling is where maps quietly go wrong.**
- **Versions** — e.g. `004010`, `005010`. Sender and receiver must agree. Latch must detect and pin the version per spec.

## The transaction sets Latch handles first (transportation)

| Set | Name | Direction (typical) | Role |
|---|---|---|---|
| **204** | Motor Carrier Load Tender | shipper/broker/controlling carrier → carrier | "Here's a load/pickup — will you take it?" Feeds dispatch. |
| **990** | Response to a Load Tender | carrier → tenderer | Accept/decline a 204. Often required alongside 204. |
| **211** | Motor Carrier Bill of Lading | shipper/originator → carrier | BOL data: consignee, commodity, weight, class, pieces. (Note: standardly the BOL — not a "delivery notification," even when a partner labels it loosely.) |
| **214** | Transportation Carrier Shipment Status | carrier → interested party | Status/tracking incl. delivery events (status codes: `D1` delivered, `X1` arrived, `AF` departed, etc.). |
| **210** | Motor Carrier Freight Details & Invoice | carrier → bill-to | The freight bill / invoice. |
| **997** | Functional Acknowledgment | both | "I received your file." Confirms receipt of any group; must round-trip. |

Adjacent / retail sets to design the canonical model to accommodate later (do not build in Phase 1): **850** (PO), **810** (invoice), **856** (ASN/ship notice), **855/865** (PO ack), **846** (inventory), **940/945** (warehouse ship order/advice). Healthcare (**837/835/270/271**) is a regulated, higher-stakes future vertical — keep the architecture capable, build later with care.

## Companion guides — the bespoke part

A **companion guide** (a.k.a. implementation guide, mapping spec, EDI spec) is the partner-published document that constrains the standard to *their* usage: which segments are required/optional, which elements they populate, which qualifier codes they send/expect, loop repetition limits, envelope IDs/qualifiers, expected acknowledgments, and connectivity. **It is almost always a PDF** (sometimes DOCX or XLSX). It is human-readable, not machine-actionable. Reading it and translating it into a map is the slow, expensive, specialist step Latch automates. **Partners frequently deviate from their own guide in real traffic** — so Latch must learn from sample/real files too, not the guide alone.

## Connectivity (how files move)

- **VAN** (Value-Added Network) — a managed mailbox/interconnect network (e.g. legacy providers). Reliable, slow to provision, costs money.
- **AS2** — direct, signed, encrypted HTTP(S) transport with MDN receipts. Requires certificate exchange.
- **SFTP** — file drop/pickup over SSH. Simple, common with smaller partners.
- **API** — increasingly partners expose REST; "hybrid EDI/API" is a growing pattern Latch should bridge.

Latch's connectivity layer abstracts these behind one interface (`packages/connectivity`). For the MVP, implement **SFTP and AS2**; document and stub VAN interconnect.

## The certification ("cert") loop — the pain we kill

Standard practice to bring up a new connection: agree the spec → build the map → exchange test files in a non-production/cert environment → the partner reviews → fix → resend → exchange `997`s → run a **parallel run** (both old and new in production simultaneously) → cut over. Every round-trip has human latency **on both sides**, which is why elapsed time dwarfs the actual mapping effort. Latch replaces the human ping-pong with: (a) **golden-record synthesis** from the guide + samples, (b) **EDI injection** through the map with per-field proof, and (c) a **shareable visual certification artifact** the partner can sign off on, plus (Phase 3) agent-to-agent co-certification.

## Acknowledgments & control

- **997** must be generated for inbound groups and consumed for outbound groups; track control numbers.
- **990** is the business-level accept/decline for a 204 and is frequently required — treat it as part of the 204 connection, not optional.
- Some partners use **824** (Application Advice) for content-level errors; design for it, build later.
- Control-number sequencing (ISA/GS/ST) and duplicate detection are correctness-critical; persist and idempotently handle them.

## Why "just use AI to map it" is insufficient (the moat, in domain terms)

1. **Silent failure is catastrophic.** A wrong qualifier or a mis-counted loop doesn't error — it produces a structurally valid file with the wrong meaning, which corrupts invoices or drops shipments. Detecting this requires *semantic* verification (golden records), not syntax validation.
2. **Real traffic deviates from the guide.** The guide is necessary but not sufficient; you must learn the partner's actual behavior from samples and the live stream.
3. **Round-trip losslessness is the real test.** EDI → canonical → EDI must reproduce every populated element. This is the strongest automatic correctness signal and is the backbone of certification.
4. **Coverage must be complete, not sampled.** Every required segment and every qualifier in the guide must be exercised — partial coverage is how "it worked in testing" becomes a production outage.

## Glossary (quick)

- **SCAC** — Standard Carrier Alpha Code (carrier identifier).
- **PRO number** — carrier's shipment tracking number.
- **BOL** — Bill of Lading.
- **Qualifier** — coded element defining the meaning of an adjacent value.
- **Loop** — repeating segment group.
- **Companion/implementation guide** — partner's published constraint on the standard.
- **Cert / parallel run** — the test-and-cutover process for a new connection.
- **MDN** — Message Disposition Notification (AS2 receipt).
- **Canonical model** — Latch's internal business-object representation that all maps target (`06`).
- **Latch Spec** — the machine-readable representation Latch derives from a companion guide + samples (`06`).
