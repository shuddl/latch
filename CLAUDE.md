# CLAUDE.md — Operating Manual

This file is read automatically by Claude Code. It governs how you build Latch. Read it fully before writing any code.

---

## 0. Mission in one paragraph

Build Latch: a Cloudflare-native platform that lets one company connect to a trading partner's EDI **without a human integration project**. The user drops in the partner's companion guide and a few sample files; Latch parses the spec, generates bidirectional maps to a canonical model, synthesizes a golden-record test corpus, **injects tested EDI through the map and proves it correct**, renders a **visual certification report**, and goes live — same day, $0 setup. Then it monitors the live stream and **self-heals** when the partner drifts. The endgame is a bilateral, agent-to-agent handshake where both partners' systems negotiate and co-certify a connection in an afternoon. You are building the one-sided MVP first; the bilateral handshake is the network endgame.

---

## 1. The prime directive: humorously simple

Optimize relentlessly for simplicity — in the product, the code, and these docs.

- The product's hero flow is **three steps**: drop a guide → watch it certify → click go-live. Never add a fourth step to the happy path.
- Prefer boring, proven technology over clever abstractions. Fewer moving parts wins.
- If you are about to build a configuration screen, a settings page, or an options matrix — stop. Ask whether the default could just be correct.
- A junior engineer should be able to read any module and understand it in one sitting. If they can't, simplify.
- These docs serve the build. If a doc is slowing you down or is ambiguous, note the gap in `TASKS.md` under "Doc gaps" and proceed with the most sensible interpretation — **state the assumption in code comments and the PR description.** Do not stall.

## 2. Non-negotiable guardrails

1. **Correctness is the product.** The Verification Engine (`docs/07`) is the moat. Build it in Milestone 1, not later. Never ship a map to "production" status that has not passed certification. A wrong map is an existential failure, not a bug.
2. **Deterministic runtime, AI at build-time only.** LLMs (Anthropic API) generate maps, interpret guides, and propose heals. **Compiled, deterministic TypeScript transforms execute every transaction.** No LLM in the per-message hot path — ever. This is for repeatability first, cost/latency second.
3. **Auth is a deployment gate, not a build gate.** Do **not** build authentication before the MVP is functionally complete. Stub identity with a dev header/middleware. Integrate Clerk in the week before real users arrive (there is a dedicated late-stage task). Building auth early is a known anti-pattern here — do not do it.
4. **Don't reinvent the X12 parser.** Before writing a parser, evaluate battle-tested libraries (e.g. `node-x12`, `x12-parser`, Stedi's open EDI tooling / EDI-as-JSON, `@stedi/edi-...`). Wrap the best one behind a thin internal interface (`packages/edi-core`) so it can be swapped. Only hand-roll if nothing fits, and document why.
5. **Secrets never get committed.** API tokens, signing keys, VAN/AS2 credentials → Cloudflare secrets / `.dev.vars` (gitignored). The repo ships `.dev.vars.example` only.
6. **Every transaction is auditable and replayable.** Persist raw inbound, canonical form, raw outbound, and acks to R2 + D1. You must be able to replay any historical transaction through any map version. Logistics money and freight depend on this.
7. **Ship vertical slices.** Each milestone is demoable end-to-end, not a horizontal layer. A thin slice that certifies one real `214` beats a complete-but-disconnected parser.

## 3. Stack (decided — do not re-litigate without a documented reason)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Cloudflare Workers** (TypeScript) | Edge, cheap, the proven house stack |
| Relational store | **Cloudflare D1** (SQLite) | partners, connections, specs, maps, certs, runs, transactions |
| Cache / config / flags | **Cloudflare KV** | feature flags, hot config, idempotency keys |
| Object store | **Cloudflare R2** | raw companion guides, EDI archives, cert artifacts, golden corpora |
| Async / throughput | **Cloudflare Queues** | transaction processing pipeline |
| Scheduled work | **Cron Triggers** | drift sweeps, re-cert, housekeeping |
| Per-entity state | **Durable Objects** | per-connection session, per-handshake negotiation state, rate control |
| AI (build/heal time) | **Anthropic API (Claude)** | guide parsing, map generation, drift interpretation, verification reasoning |
| AI (cheap classify) | **Workers AI** (optional) | low-cost segment/anomaly classification where a small model suffices |
| Frontend | **React + Vite on Cloudflare Pages/Assets** | the visual control plane + certification reports |
| Monorepo | **pnpm workspaces + Turborepo** | `apps/*`, `packages/*` |
| Lang/quality | TypeScript strict, ESLint, Prettier, Vitest, Zod for all boundaries | |
| IaC/deploy | **Wrangler** | `wrangler.toml` per worker; bindings declared, not hardcoded |

**Deployment account (house Cloudflare account):** `1d40ee303e35970bbd47a10f8ad7d466`. Existing zone `tp-freight.com` available for a subdomain (e.g. `latch.tp-freight.com`) during development. Put this in `wrangler.toml` / `.dev.vars`, never inline in source.

**Frontend visual work:** when building any UI, first load the `frontend-design` skill and follow its design-token and styling guidance. The product must look benchmark-grade (`docs/09`). Highly visual is a hard requirement, not a nicety.

## 4. Repo layout to create (Milestone 0)

```
latch/
├── apps/
│   ├── api/                 # Cloudflare Worker: REST API + control plane
│   ├── pipeline/            # Cloudflare Worker: queue consumer (transaction processing)
│   └── web/                 # React/Vite control plane + certification UI
├── packages/
│   ├── edi-core/            # X12 parse/serialize behind a thin interface (wraps a vetted lib)
│   ├── canonical/           # the canonical model types + Zod schemas (docs/06, 07)
│   ├── spec/                # Latch Spec types + the Spec Ingestor (guide → machine-readable spec)
│   ├── mapgen/              # build-time map generation (LLM-assisted) → compiled transforms
│   ├── transform/           # the deterministic runtime transform engine
│   ├── verify/              # the Proof: golden-record synthesis + injection + scoring
│   ├── heal/                # drift detection + patch proposal + shadow re-cert
│   ├── handshake/           # Phase 3 bilateral negotiation + attestation
│   ├── connectivity/        # AS2 / SFTP / VAN / API adapters
│   └── shared/              # config, logging, errors, Zod helpers, ids
├── docs/                    # the documents in this package
├── fixtures/                # real & synthetic EDI, sample companion guides (for tests/goldens)
├── TASKS.md
└── CLAUDE.md
```

## 5. Definition of Done (applies to every task)

A task is done only when **all** of these are true:

- [ ] TypeScript strict passes; no `any` at module boundaries (use Zod-validated types).
- [ ] Unit tests written and passing (Vitest). Verification-engine code requires golden-corpus tests.
- [ ] The vertical slice is demoable from the UI or a single CLI command.
- [ ] Errors are typed, logged with context, and surfaced to the user as plain English (never a stack trace).
- [ ] No secrets, no hardcoded account/connection values; bindings declared in `wrangler.toml`.
- [ ] A short note in the PR description: what was assumed, what was deferred, what to verify.
- [ ] For anything touching maps or transforms: a certification run passes at the benchmark bar (`docs/07`).

## 6. How to use the docs

- `01-vision` / `02-prd` — *why* and *what*. Re-read when a tradeoff is unclear; the vision breaks ties.
- `03-edi-domain-primer` — *the domain*. Read before touching `edi-core`, `spec`, or `mapgen`.
- `04-architecture` / `06-data-model` / `08-api` — *the shape of the system*. Your structural source of truth.
- `05-handshake-protocol` / `07-verification` — *the hard, novel parts*. The defensible IP. Spend your best thinking here.
- `09-ux-and-visual` — *the experience*. The product is judged on this and on correctness, nothing else.
- `10-roadmap` — *the order*. Don't build out of order; each milestone unlocks the next.
- `11-icp` / `12-gtm` / `13-adjacent` — *who and how*. Build the MVP for the ICP in `11`, not for a hypothetical enterprise.

## 7. When you're unsure

State the assumption, make the simplest reversible choice, leave a `// LATCH-ASSUMPTION:` comment, and keep moving. Log open questions in `TASKS.md` under "Doc gaps / open questions." Velocity with reversibility beats stalling. "I don't know yet, here's my assumption" is an acceptable and expected state.
