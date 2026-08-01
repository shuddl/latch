---
name: as2-workers-adapter
description: Deliver AS2 (S/MIME sign/encrypt + MDN) transport for Latch — decision framework first (partner transport reality, managed gateway vs native), then the native PKI.js-on-Workers build. Trigger on "AS2", "MDN", "S/MIME", "Drummond", "EDIINT", "partner wants AS2", task 3.2.
risk_level: CRITICAL
feasibility: CONDITIONAL
parent_product: Latch
generated_by: product-forge-analyzer
---

# AS2 Transport

## Problem Statement
AS2 (EDIINT over HTTPS: payload → S/MIME sign + encrypt → POST → signed MDN receipt) is the
enterprise-freight default. It is the **only ⚫ CRITICAL item**: interop is against
decades-old Drummond-certified stacks (Mendelson, OpenAS2, Cleo, IBM), and you cannot prove
interop without a live counterparty. Getting this wrong silently (bad MIC, wrong
canonicalization, async-MDN mismatch) means a partner "receives nothing" with no error on
our side. The mitigation is sequencing: **decide before building.**

## Context
- **Dimension:** Integration/Security · **Complexity:** 9/10
- **Effort:** managed-gateway integration 3–5d · native adapter 10–15d incl. interop
- **Dependencies:** deploy; our X.509 keypair + the partner's cert (exchange is a human
  step); a counterparty endpoint for interop tests. Cert material in CF secrets (encrypted),
  referenced by `secretRef` — never D1/git.

## Step 0 — the decision gate (do this before any code)
Ask the design partner what they actually run. Outcomes:
- **They're on a VAN** → no AS2 needed; VAN interconnect (usually SFTP/FTP to the VAN) rides
  the SFTP skill. **STOP here.**
- **They accept SFTP** → defer AS2 entirely to L2. **STOP here.**
- **They require AS2** → choose lane below.

## Lane 1 (launch lane): managed AS2 gateway
Terminate AS2 at a proven service, bridge to Latch over HTTPS:
1. Run **OpenAS2** (mature OSS, Drummond-tested lineage) on a small VM/container, or use a
   commercial MFT endpoint the partner already trusts.
2. Gateway inbox → forward payload to `POST /v1/connections/:id/ingest`; outbound: poll the
   outbox endpoint → gateway sends + handles MDN.
3. Latch stores the MDN message-id + MIC on the transaction row for the audit trail
   (add columns via migration; small).
This makes AS2 a config problem, not a crypto problem, and is the **recommended launch path**.

## Lane 2 (consolidation lane): native Workers adapter
Only after Lane 1 is live (or a partner test endpoint exists):
1. **Crypto:** PKI.js + ASN1.js run on WebCrypto and work in Workers — CMS SignedData
   (SHA-256 RSA) and EnvelopedData (AES-CBC/GCM + RSA-OAEP/PKCS1) cover S/MIME needs.
2. **Send:** MIME-assemble (application/edi-x12) → sign (multipart/signed, compute **MIC**
   over the canonicalized content) → encrypt → POST with AS2-From/AS2-To/Message-Id/
   Disposition-Notification-To headers → verify returned sync MDN signature + MIC match.
3. **Receive:** Worker route `/as2` → decrypt → verify signature → hand raw EDI to the
   ingest pipeline → return signed sync MDN (async MDN v2 only if a partner demands it).
4. **State:** per-partner cert/keys via secretRef; message-id dedup via existing idempotency;
   retry/backoff on the egress queue.
5. **Interop matrix:** test against OpenAS2 + Mendelson free client in CI (docker), then the
   real partner in a supervised window. CRLF canonicalization and MIC-over-what bugs are
   ~80% of real-world failures — golden-test them explicitly.

## Alternatives
| Approach | Pros | Cons | When |
|---|---|---|---|
| Managed gateway (Lane 1) | interop solved, fast | extra hop, some cost | launch |
| Native (Lane 2) | pure-CF, cheapest at scale | novelty + interop burden | post-launch consolidation |
| VAN only | zero AS2 | per-doc fees | partner already VAN'd |

## Validation Criteria
- [ ] Round-trip with OpenAS2 in CI: send → their MDN verifies; receive → our MDN accepted.
- [ ] MIC mismatch and bad-signature paths produce a *visible* failed transaction, never silence.
- [ ] Cert rotation runbook (expiry alerting) documented.
- [ ] Real-partner supervised exchange: 3 clean round-trips including one forced retransmit.

## Failure Modes
| Failure | Detection | Recovery |
|---|---|---|
| Silent MIC/canonicalization mismatch | partner MDN "failed/MIC-mismatch" or absence | interop goldens; log MIC inputs |
| Cert expiry | alert 30d ahead (ops skill) | rotation runbook |
| Async MDN never arrives | egress row stuck "sent-await-mdn" | timeout → alarm → retransmit policy |

## Go/No-Go
- **NO-GO on native** until Lane 1 (or SFTP) carries the first live partner. **GO Lane 1**
  when a partner names AS2 as required. Never let this item block L1 — it is L2 scope.
