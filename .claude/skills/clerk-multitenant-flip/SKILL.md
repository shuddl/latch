---
name: clerk-multitenant-flip
description: Replace the X-Latch-Dev-Org dev header with Clerk auth and flip Latch to real multi-tenancy (orgs → tenant_id), with a cross-tenant isolation test suite. Trigger on "Clerk", "auth", "sign up", "multi-tenant", "tenant flip", "real users", task 5.1 — and ONLY on the user's explicit go-ahead (deliberately last per CLAUDE.md §2.3).
risk_level: HIGH
feasibility: FEASIBLE
parent_product: Latch
generated_by: product-forge-analyzer
---

# Clerk Auth + Multi-Tenant Flip

## Problem Statement
Identity is a trusted dev header. The flip to real auth is the single most security-sensitive
remaining change: after it, `tenant_id` decides whose freight data anyone can see. The good
news: tenancy was engineered from day 0 (every store method takes `tenantId`; spec-library
uses exact tenant-prefix matching, `_`-wildcard-proof). The risk is the flip itself — mapping
real identities to tenants correctly and proving isolation under real JWTs.

## Context
- **Dimension:** Security · **Complexity:** 6/10 · **Effort:** 2–4 days
- **Dependencies (gates):** deploy done; a Clerk application (user creates, provides keys);
  the user's explicit go-ahead — do **not** build unprompted; tenancy model decision
  (recommended default below) — this is open-Q #8 in `TASKS.md`.
- **Recommended tenancy default:** 1 Clerk **Organization** = 1 Latch tenant;
  `tenant_id` = Clerk org id (slug-safe). Personal accounts get an auto-created org.
  Roles: `admin` (everything) / `member` (no go-live, no drift-approve) — two roles max,
  resist a matrix (CLAUDE.md §1).

## Recommended Approach
Backend verifies Clerk JWTs stateless (JWKS via `jose` — Workers-compatible); frontend uses
`@clerk/clerk-react`. The dev header survives only in tests/dev via explicit env flag.

### Implementation Steps
1. **Env:** `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWKS_URL` (or issuer) as
   secrets; `LATCH_AUTH_MODE = 'clerk' | 'dev'` (dev only honored when
   `LATCH_DEV_DEFAULT_ORG` is set — prod deploy sets `clerk`).
2. **Middleware swap** (`apps/api/src/app.ts`): replace the header block with
   `Authorization: Bearer` verification — `jose.jwtVerify` against Clerk JWKS (cache keys in
   KV/memory), extract `org_id` claim → `tenantId`; 401 on missing/invalid, 403 when no org.
   Keep the seam injectable (`getAuth(env)`) exactly like `getStore`/`getLlm` so the 200+
   existing tests keep running under the dev authenticator.
3. **Roles:** map Clerk org role claim; guard `go-live`, `drift approve/dismiss`, handshake
   endpoints as `admin`.
4. **Frontend:** `ClerkProvider` + `SignIn`; api client sends the session token; org
   switcher in the topbar (Clerk component — no custom settings screen).
5. **Isolation test suite** (`apps/api/src/auth-isolation.test.ts`): two tenants seeded with
   partners/connections/maps/certs/transactions/drift/spec-library; for **every** GET/POST
   route, tenant B requests tenant A's resource ids → 404/403, never data. Table-driven so a
   new route fails the suite if unlisted.
6. **Webhooks (minimal):** Clerk `organization.deleted` → mark tenant retired (no cascade
   delete — audit trail is sacred).
7. **Share links (PG-8, immediately after):** signed, expiring token
   (`/v1/certifications/:id/share` → HMAC token, 30-day default, revocable via KV denylist)
   rendering a read-only report — the only unauthenticated read surface, deliberate.

## Alternatives
| Approach | Pros | Cons | When |
|---|---|---|---|
| Clerk (recommended, per docs) | orgs/roles out of the box, Workers-friendly | vendor dep | now |
| Cloudflare Access | zero code | not a product signup flow | internal-only phase |
| Hand-rolled JWT | no vendor | building auth is the anti-goal | never |

## Validation Criteria
- [ ] Isolation suite: 0 cross-tenant reads across every route (CI-enforced, table-driven).
- [ ] Dev header rejected when `LATCH_AUTH_MODE=clerk`.
- [ ] Existing 205 tests green unchanged (dev authenticator injected).
- [ ] Sign-up → org → onboard → certify → go-live works end-to-end on the deployed URL.
- [ ] Rate limiting now keys on real tenant ids (verify KV keys).

## Failure Modes
| Failure | Detection | Recovery |
|---|---|---|
| JWKS fetch outage | 401 spike | cache keys with TTL + stale-while-revalidate; alert |
| Wrong claim mapping (user id vs org id) | isolation suite | suite runs pre-merge |
| Token in URL leaks (share links) | — | tokens only in path for the share surface, marked no-index, revocable |

## Go/No-Go
- **GO** only on explicit user instruction + Clerk keys in hand. **NO-GO** while any
  pre-auth item (deploy) is missing — auth on an undeployed product is waste.
