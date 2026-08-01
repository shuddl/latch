---
name: sftp-workers-transport
description: Stand up live SFTP transport for Latch — bridge-poller path (recommended first) or native SSH over cloudflare:sockets behind the existing SftpClient seam. Trigger on "SFTP", "SftpClient", "cloudflare sockets", "connect to the partner's server", "live inbound files", "R1 spike".
risk_level: HIGH
feasibility: CONDITIONAL
parent_product: Latch
generated_by: product-forge-analyzer
---

# SFTP Transport in/around Workers

## Problem Statement
Most freight partners drop EDI on SFTP. `packages/connectivity` has a fully-tested
`SftpAdapter` (list → read → archive → send) over an **injected `SftpClient` interface** —
but no concrete client exists. The uncertainty: workerd has raw TCP (`cloudflare:sockets`)
but **no native SSH**; a client means running the SSH2 transport + crypto in pure JS inside
a Worker (key exchange, cipher negotiation, SFTP subsystem framing). That is genuinely
uncertain — which is why this skill leads with a fallback that is *not* a compromise.

## Context
- **Dimension:** Integration · **Complexity:** 8/10 (native) / 4/10 (bridge)
- **Effort:** bridge 2–3d · native spike time-boxed 3d, full 5–10d
- **Dependencies:** deploy done; a live partner SFTP endpoint + creds (user gate) to prove
  either path. Credentials live in Cloudflare secrets referenced by `connectivity.secretRef`
  — never in D1 or git.
- **The seam is the strategy:** everything downstream (drainInbound → ingest pipeline → 997
  → drift) is already proven. Only `SftpClient` { list, read, rename/archive, write } is
  missing; both paths below implement or bypass exactly that.

## Recommended Approach — Path A: SFTP-bridge poller (ship this first)
A tiny out-of-Workers poller (Cloudflare **Container**, a $5 VM, or the partner's own cron)
that speaks battle-tested SSH and forwards into the already-working HTTP path:

1. Node script using `ssh2-sftp-client` (mature): poll `inbox/`, download files, `POST` each
   to `/v1/connections/:id/ingest` (auth header), then archive server-side to `processed/`
   with the same unique-suffix convention `SftpAdapter` uses.
2. Idempotency is already server-side (control-number dedup) — retries are safe.
3. Outbound: bridge polls `GET /v1/connections/:id/outbox` (the emit endpoint's queue) and
   uploads to the partner's `outbox/` — or skip until outbound send is needed.
4. Package as `apps/sftp-bridge/` (Dockerfile + one config file: host, keys, connection id,
   API token). Deployable on Cloudflare Containers when available in the account, else any VM.

This is proven technology end-to-end; the only new code is ~200 lines of glue.

## Path B: native `cloudflare:sockets` SSH client (time-boxed spike, then decide)
1. **Spike (3 days hard cap):** evaluate pure-JS SSH stacks in workerd — candidates:
   `ssh2`'s protocol core (Node-coupled, likely no), a WASM build of libssh2, or a minimal
   hand-rolled SSH2 transport using WebCrypto (curve25519-sha256 KEX, aes128-ctr, hmac-sha2) +
   SFTPv3 packet framing (only OPEN/READ/CLOSE/OPENDIR/READDIR/RENAME/WRITE needed).
2. Exit the spike with a working `list()` against a test server (e.g. `atmoz/sftp` docker) or
   a documented no-go. If go: implement `SocketsSftpClient implements SftpClient`, test
   against the docker server in CI (testcontainers or a CI service).
3. CPU-time note: KEX crypto within Workers CPU limits is fine for polling cadence; large
   file reads must stream in chunks.

## Alternatives
| Approach | Pros | Cons | When |
|---|---|---|---|
| A: bridge poller | proven, fast, zero workerd risk | one extra deployable | launch (recommended) |
| B: native sockets client | pure-CF stack, no sidecar | high novelty risk | after A works, as consolidation |
| Partner pushes to HTTPS | zero SFTP at all | partners rarely can | offer it, don't count on it |
| Managed MFT/VAN | offloads everything | cost, lock-in | if partner is VAN-only anyway |

## Validation Criteria
- [ ] A real fixture dropped on the partner (or test) server lands as a transaction with a
      997 back, archive moved, no duplicates on double-poll.
- [ ] Kill the poller mid-cycle → restart → no loss, no dupes (server-side dedup proof).
- [ ] Secrets only in CF secrets / bridge env; `secretRef` indirection respected.

## Failure Modes
| Failure | Detection | Recovery |
|---|---|---|
| Partner server cipher too old for chosen stack | connect fails at KEX | bridge path A (ssh2 supports legacy); log the verdict |
| Poll overlap double-ingest | dedup metrics | control-number dedup absorbs; add poller lockfile |
| Large file > Worker body limit | 413 on ingest | ingest cap is 5MB; chunk or raise for this path deliberately |

## Go/No-Go
- **GO on Path A** as soon as deploy + one endpoint exist. **Path B only after** A is live
  and the spike exits green — it is a cost-reduction, never the launch gate.
