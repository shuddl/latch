# 08 — API & Interfaces

The external REST API (control plane, consumed by `apps/web` and embedding vendors), the key internal package interfaces, and the connectivity adapter contract. Keep the API small and obvious — the product is humorously simple, and so is its surface.

## Conventions

- Base: `/v1`. JSON in/out. All inputs validated with Zod; all outputs typed.
- Auth: **dev-stub now** (an `X-Latch-Dev-Org` header resolves to a tenant); Clerk-issued bearer tokens later (CLAUDE.md §2.3). The API shape does not change when auth lands.
- Errors: `{ "error": { "code": "...", "message": "plain English", "detail"?: {...} } }`. Never leak stack traces.
- Idempotency: mutating calls accept `Idempotency-Key`.
- Long jobs (ingest/generate/certify) are **async**: return `202` + a `job` you poll, and stream progress over SSE/WebSocket for the live UI.

## REST endpoints

### Partners & connections
```
POST   /v1/partners                      Create a partner
GET    /v1/partners                       List partners
GET    /v1/partners/:id                   Get a partner

POST   /v1/connections                    Create a connection (partner, direction, set, connectivity)
GET    /v1/connections                     List (filter by partner/status)
GET    /v1/connections/:id                Get connection + active map + latest cert summary
PATCH  /v1/connections/:id                Update connectivity / status / heal policy
POST   /v1/connections/:id/go-live        Promote certified map → production (guarded by passing cert)
POST   /v1/connections/:id/pause          Pause processing
```

### Onboarding (the hero flow)
```
POST   /v1/connections/:id/guide          Upload companion guide (multipart) → R2; returns upload ref
POST   /v1/connections/:id/samples        Upload sample EDI file(s) → R2
POST   /v1/connections/:id/ingest         Start Spec Ingestor → returns { jobId }   (202)
GET    /v1/specs/:id                       Get the parsed Latch Spec (+ confidence, deviations)
PATCH  /v1/specs/:id                       Operator correction to a spec field → bumps version
POST   /v1/connections/:id/generate-map   Generate map(s) from spec → { jobId }     (202)
GET    /v1/maps/:id                         Get a map (rules summary, status, latest cert)
PATCH  /v1/maps/:id                         Override a mapping rule → re-cert required
```

### Certification (the proof)
```
POST   /v1/maps/:id/certify               Synthesize corpus (if needed) + inject + score → { jobId } (202)
GET    /v1/certifications/:id             Get a certification run (headline metrics + per-field results ref)
GET    /v1/certifications/:id/report      Get the visual report bundle / data for rendering
POST   /v1/certifications/:id/share       Create a read-only share link for the partner
GET    /v1/share/:token                    Public read-only certification view (no auth)
```

### Live traffic & health
```
GET    /v1/connections/:id/transactions   Paged transaction index (status, acks, errors)
GET    /v1/transactions/:id                One transaction (links to raw/canonical/out in R2)
POST   /v1/transactions/:id/replay         Replay a transaction through current/specified map
GET    /v1/connections/:id/health         Volume, exceptions, drift events, "dollars protected"
```

### Self-healing (Phase 2)
```
GET    /v1/connections/:id/drift          List drift events (status, proposed patch, shadow cert)
GET    /v1/drift/:id                        Drift event detail (what changed, evidence, proposed patch)
POST   /v1/drift/:id/approve              Approve + apply a proposed patch (one click)
POST   /v1/drift/:id/dismiss              Dismiss
PATCH  /v1/connections/:id/heal-policy    Set auto-apply policy thresholds
```

### Handshake (Phase 3)
```
POST   /v1/handshake                      Initiate a bilateral handshake with a partner endpoint
GET    /v1/handshake/:id                   Session state (see 05 state machine)
POST   /v1/hsp                            HSP message endpoint (Latch-to-Latch / Latch-aware shim)
GET    /v1/handshake/:id/manifest         Signed certification manifest
```

### Jobs (async)
```
GET    /v1/jobs/:id                        Job status/result for ingest/generate/certify
GET    /v1/jobs/:id/stream                 SSE/WebSocket progress for the live UI
```

## Example payloads

Create a connection:
```jsonc
POST /v1/connections
{
  "partnerId": "ptr_01H...",
  "direction": "inbound",
  "transactionSet": "204",
  "x12Version": "004010",
  "connectivity": { "type": "sftp", "host": "...", "path": "/in", "secretRef": "sftp_rl_in" }
}
```

Certification result (headline):
```jsonc
GET /v1/certifications/crt_01H...
{
  "id": "crt_01H...",
  "mapId": "map_01H...",
  "passed": true,
  "requiredCoverage": 1.0,
  "qualifierCoverage": 1.0,
  "roundtripFidelity": 0.9997,
  "adversarialOk": 1.0,
  "fieldResultsRef": "r2://certs/crt_01H.../fields.json",
  "shareUrl": null
}
```

## Internal package interfaces (stable contracts)

```ts
// packages/edi-core — wraps a vetted X12 lib behind this thin interface (swappable)
export interface EdiCore {
  parse(raw: string): EdiInterchange;                 // structured, loop-aware
  serialize(doc: EdiInterchange): string;
  validateEnvelope(doc: EdiInterchange): EnvelopeIssue[];
}

// packages/spec — Spec Ingestor
export interface SpecIngestor {
  ingest(input: {
    guide?: Blob; guideText?: string; samples: string[]; transactionSet: string; x12Version: string;
  }): Promise<LatchSpec>;                              // includes per-field confidence + deviations
}

// packages/mapgen — build-time map generation
export interface MapGenerator {
  generate(spec: LatchSpec, direction: "inbound" | "outbound", canonicalVersion: string): Promise<MapArtifact>;
  patch(map: MapArtifact, drift: DriftEvent): Promise<MapArtifact>;   // self-heal proposal
}

// packages/transform — deterministic runtime engine (NO LLM)
export interface TransformEngine {
  toCanonical(map: MapArtifact, doc: EdiInterchange): TransformResult<CanonicalRecord[]>;
  fromCanonical(map: MapArtifact, records: CanonicalRecord[]): TransformResult<EdiInterchange>;
}

// packages/verify — golden synthesis + the Proof
export interface Verifier {
  synthesize(spec: LatchSpec, samples: string[]): Promise<GoldenCorpus>;
  certify(map: MapArtifact, corpus: GoldenCorpus): Promise<CertificationResult>; // scores vs benchmark bar
}

// packages/heal — drift
export interface Healer {
  detect(connectionId: string, txn: EdiInterchange, certifiedSpec: LatchSpec): DriftEvent | null;
  proposeAndShadowCertify(drift: DriftEvent): Promise<{ patchedMap: MapArtifact; cert: CertificationResult }>;
}

// packages/connectivity — one interface, many transports
export interface ConnectivityAdapter {
  type: "sftp" | "as2" | "van" | "api";
  receive(): AsyncIterable<InboundFile>;     // poll/stream inbound
  send(file: OutboundFile): Promise<SendReceipt>;  // includes MDN/ack handling per transport
}

// TransformResult is explicit about partial/error — never throws into the hot path
export type TransformResult<T> =
  | { ok: true; value: T; warnings: Issue[] }
  | { ok: false; errors: Issue[] };          // structured, surfaced to user as plain English
```

## Connectivity adapter notes (MVP)

- **SFTP:** poll an inbound path on a Cron/DO schedule; archive to R2; enqueue. Outbound: write to the partner's pickup path; track delivery.
- **AS2:** an HTTPS endpoint (Worker) receiving AS2 messages; verify signature, decrypt, return MDN; archive + enqueue. Outbound: sign/encrypt, POST, await MDN. Certificate material in encrypted secrets.
- **VAN:** documented + stubbed for MVP (interconnect varies by VAN); implement post-MVP behind the same interface.
- **API:** generic webhook-in / REST-out bridge for partners exposing JSON — pairs with the canonical model to deliver the "EDI↔API bridge" adjacent use case (`13`).

## Embedding API (adjacent — `13`)

Expose a minimal, key-scoped subset (`/v1/connections`, `/onboard`, `/certify`, `/transactions`) so a TMS/WMS vendor can embed Latch as their EDI engine. Same endpoints, scoped tokens, white-labelable certification report. Design the API so this is a permissioning concern, not a re-architecture.
