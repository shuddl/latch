# Security Policy

Latch processes trading-partner EDI, which routinely contains **personally identifiable
information** (driver names, contact details, addresses) and **commercially sensitive data**
(rates, freight charges, shipment contents). Security is a product requirement, not an
afterthought. This document is the working baseline; sections marked _(planned)_ are
tracked in `TASKS.md` and hardened in Milestone 5 before any real partner data is onboarded.

## Reporting a vulnerability

Email **security@tp-freight.com** with a description, reproduction steps, and impact. Do
not open public issues for security reports. We aim to acknowledge within 2 business days.
Please give us a reasonable window to remediate before any public disclosure.

## Data classification

| Class | Examples | Handling |
|---|---|---|
| Secret | API tokens, signing keys, VAN/AS2/SFTP credentials | Cloudflare Secrets / `.dev.vars` (gitignored). **Never** committed. Repo ships `.dev.vars.example` only. |
| Sensitive (PII + commercial) | Raw inbound/outbound EDI, canonical records, certification artifacts | Encrypted at rest (R2/D1). Tenant-scoped. Access audited. |
| Internal | Specs, maps, drift events | Tenant-scoped. |
| Public | Marketing docs, this file | — |

## Secrets management

- Secrets live in Cloudflare Secrets (production) or `.dev.vars` (local, gitignored).
- Bindings are declared in `wrangler.toml`; **no** account ids, zone names, or credentials
  are inlined in source.
- CI scans changed files for accidentally-committed secrets before merge.
- **Secret-rotation runbook** _(planned, M5)_: documented rotation for signing keys and
  partner connectivity credentials, with zero-downtime cutover.

## Tenant isolation

- Every stored record is scoped by `tenant_id`. Until Clerk lands (M5, per `CLAUDE.md §2.3`),
  identity is a dev stub (`X-Latch-Dev-Org`, regex-guarded) and **must not** be exposed to
  untrusted networks.
- Cross-tenant isolation tests are a release gate for the auth milestone (M5).

## Auditability & retention

- Per `CLAUDE.md §6`, every transaction persists raw inbound, canonical form, raw outbound,
  and acks to R2 + D1, and is replayable through any historical map version.
- **R2 lifecycle / retention policy** _(planned, M5)_: explicit retention windows per data
  class, with deletion honored on tenant offboarding.

## Determinism & supply chain

- No LLM runs in the per-message hot path (`CLAUDE.md §2.2`); runtime transforms are
  compiled, deterministic TypeScript. This bounds the blast radius of prompt/model changes.
- New dependencies are checked against the GitHub Advisory Database before adoption; we
  favor zero-prod-dependency, Workers-native code (see the `edi-core` decision in `TASKS.md`).

## Scope

This policy covers the Latch monorepo and its deployed Cloudflare Workers. It will be
expanded with HIPAA/BAA posture if and when healthcare EDI sets (837/835/270/271) are
added (V2, `docs/13`).
