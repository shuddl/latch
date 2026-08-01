---
name: workers-deploy-provisioning
description: Provision Cloudflare resources (D1/KV/R2/Queues/DOs), wire secrets, deploy the Latch api+web workers, and smoke-test the deployment. Trigger on "deploy", "provision", "wrangler deploy", "set up Cloudflare", "go to the dev subdomain", or any work making wrangler.toml real.
risk_level: HIGH
feasibility: FEASIBLE
parent_product: Latch
generated_by: product-forge-analyzer
---

# Cloudflare Provisioning & Deploy

## Problem Statement
Nothing runs anywhere. `apps/api/wrangler.toml` has `REPLACE_WITH_D1_ID` / `REPLACE_WITH_KV_ID`
placeholders; no queues/buckets exist; secrets are unset. Every other launch item queues behind
this. Risk is HIGH by *blast radius* (blocks all), not difficulty — the work is routine, so the
mitigation is making it scripted and idempotent rather than artisanal.

## Context
- **Dimension:** Infrastructure · **Complexity:** 4/10 · **Effort:** 1–2 days
- **Dependencies (user-provided, hard gate):** Cloudflare account access (house account
  `1d40ee303e35970bbd47a10f8ad7d466`, Workers **Paid** plan — DOs/queues require it),
  `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`. Zone `tp-freight.com` for `latch.tp-freight.com`.
- **Never commit real ids/secrets** — `wrangler.toml` keeps placeholders; real values flow via
  CI secrets / `.dev.vars` (gitignored). `CLAUDE.md §2.5`.

## Recommended Approach
One idempotent script (`scripts/provision.sh`) + CI deploy job.

### Implementation Steps
1. **Provision** (each `create` is skip-if-exists):
   `wrangler d1 create latch` · `wrangler kv namespace create LATCH_KV` ·
   `wrangler r2 bucket create latch` · `wrangler queues create txn-ingest txn-egress recert`.
2. **Bind:** inject the returned ids at deploy time — either `wrangler deploy --var`-style
   substitution (envsubst over `wrangler.toml` template) or `wrangler.toml` env-specific
   `[env.dev]` blocks populated from CI secrets. Do not hand-edit committed placeholders.
3. **Migrate:** `wrangler d1 migrations apply latch --remote` (migrations dir
   `infra/migrations`); seed the `default` tenant.
4. **Secrets:** `wrangler secret put ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL` optional).
5. **Deploy api:** `wrangler deploy` from `apps/api` (first deploy runs the DO migration
   `v1` → `ConnectionDO`, `HandshakeDO`). Deploy **web** via Workers Assets or Pages with
   `VITE_API_URL` pointing at the api route.
6. **Route/DNS:** `latch.tp-freight.com/*` → api worker (or workers.dev subdomain first).
7. **Smoke test** (scripted, `scripts/smoke.sh`): `GET /v1/health` 200 → create partner →
   connection → samples (fixture 214) → register map → certify (expect pass) → go-live →
   `POST /ingest` fixture → transaction visible → `GET /v1/handshake` bilateral happy path.
   Fail the deploy job if any step fails.
8. **CI/CD:** GitHub Actions `deploy.yml` on main-merge: test → provision(idempotent) →
   migrate → deploy → smoke. Store the account/token as repo secrets.

## Alternative Approaches
| Approach | Pros | Cons | When |
|---|---|---|---|
| Manual one-time provisioning | fastest first time | unreproducible, drift-prone | never for prod; ok for a throwaway spike |
| Terraform/Pulumi CF provider | full IaC | heavyweight for 6 resources | if resource count grows |
| Wrangler-only scripts (recommended) | matches repo tooling | shell-quality guards needed | now |

## Validation Criteria
- [ ] `scripts/provision.sh` run twice = no-op the second time (idempotent).
- [ ] Smoke script passes the full onboard→certify→golive→ingest loop on the deployed URL.
- [ ] A fresh clone + secrets can reach a working deploy with two commands.
- [ ] No real id/secret in git history (`git log -p | grep` audit).

## Failure Modes
| Failure | Detection | Recovery |
|---|---|---|
| DO migration mismatch (renamed classes) | deploy error `new_classes` | never rename exported DO classes; add `renamed_classes` migration if forced |
| Queue consumer not bound | ingest enqueues, nothing processes | smoke step 7 catches; check `[[queues.consumers]]` |
| D1 migrations drift vs local sqlite tests | runtime SQL errors | keep `0001_init.sql` the single source; smoke exercises every table |
| Free-plan account | DO/queue create fails | confirm Paid plan before starting (N3) |

## Go/No-Go
- **GO** when the API token + account are in hand. **NO-GO** without Paid plan → escalate to
  user; nothing to build around it.
