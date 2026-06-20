# 06 — Data Model & Canonical Model

Two parts: (A) the **D1 relational schema** (storage source of truth) and (B) the **canonical model** (the semantic hub all maps target). All boundaries are Zod-validated; the canonical types are the most important shared contract in the system.

---

## A. D1 schema (SQL DDL)

> Conventions: ids are prefixed ULIDs (`ptr_`, `con_`, `spc_`, `map_`, `gld_`, `crt_`, `txn_`, `drf_`, `hs_`). All tables carry `tenant_id` (default `'default'` in dev) and `created_at`/`updated_at` (unix ms). Large bodies live in R2; D1 stores refs + metadata + index.

```sql
-- Trading partners (the "other side")
CREATE TABLE partners (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  scac          TEXT,                       -- carrier code if applicable
  isa_qualifier TEXT,                       -- e.g. 'ZZ', '01'
  isa_id        TEXT,                       -- interchange sender/receiver id
  gs_id         TEXT,
  van           TEXT,                       -- VAN name or null
  contacts      TEXT,                       -- JSON [{name,email,role}]
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- A directional relationship + connectivity for a set of transaction sets
CREATE TABLE connections (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  partner_id      TEXT NOT NULL REFERENCES partners(id),
  direction       TEXT NOT NULL,            -- 'inbound' | 'outbound' (relative to us)
  transaction_set TEXT NOT NULL,            -- '204','210','211','214','990','997'
  x12_version     TEXT NOT NULL DEFAULT '004010',
  connectivity    TEXT NOT NULL,            -- JSON {type:'sftp'|'as2'|'van'|'api', config-ref}
  status          TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'certified'|'production'|'paused'|'retired'
  active_map_id   TEXT,                     -- current production map
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(partner_id, direction, transaction_set, x12_version, tenant_id)
);

-- The machine-readable spec derived from a companion guide + samples
CREATE TABLE specs (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'default',
  partner_id       TEXT NOT NULL REFERENCES partners(id),
  transaction_set  TEXT NOT NULL,
  x12_version      TEXT NOT NULL,
  source_guide_r2  TEXT,                    -- R2 key of raw guide
  sample_refs      TEXT,                    -- JSON [R2 keys of sample EDI]
  spec_json_r2     TEXT NOT NULL,           -- R2 key of the full Latch Spec JSON
  spec_hash        TEXT NOT NULL,           -- content hash (immutable identity)
  confidence       REAL,                    -- ingestor self-reported, per-field detail in spec_json
  deviations       TEXT,                    -- JSON: guide-vs-sample mismatches found
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- A compiled, versioned transform between a spec and the canonical model
CREATE TABLE maps (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL DEFAULT 'default',
  connection_id       TEXT NOT NULL REFERENCES connections(id),
  spec_id             TEXT NOT NULL REFERENCES specs(id),
  direction           TEXT NOT NULL,        -- 'inbound'|'outbound'
  transaction_set     TEXT NOT NULL,
  canonical_version   TEXT NOT NULL,        -- e.g. '1'
  rules_json_r2       TEXT NOT NULL,        -- R2 key: declarative transform rules
  compiled_hash       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'certified'|'production'|'retired'
  latest_cert_id      TEXT,                 -- REFERENCES certification_runs(id)
  parent_map_id       TEXT,                 -- if produced by a heal patch
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Synthesized golden-record corpus for a spec/map
CREATE TABLE golden_corpora (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'default',
  spec_id          TEXT NOT NULL REFERENCES specs(id),
  corpus_r2        TEXT NOT NULL,           -- R2 key: JSON array of {edi, expected_canonical, category}
  counts           TEXT NOT NULL,           -- JSON {valid,boundary,qualifier,loop,deviation,adversarial}
  corpus_hash      TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

-- A verification run that produces a certification
CREATE TABLE certification_runs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  map_id             TEXT NOT NULL REFERENCES maps(id),
  corpus_id          TEXT NOT NULL REFERENCES golden_corpora(id),
  passed             INTEGER NOT NULL,      -- 0/1 against the benchmark bar
  required_coverage  REAL NOT NULL,         -- 0..1 (target 1.0)
  qualifier_coverage REAL NOT NULL,         -- 0..1 (target 1.0)
  roundtrip_fidelity REAL NOT NULL,         -- 0..1 (target >= 0.999)
  adversarial_ok     REAL NOT NULL,         -- 0..1 graceful handling (target 1.0)
  field_results_r2   TEXT NOT NULL,         -- R2 key: per-field results for the visual report
  report_bundle_r2   TEXT,                  -- R2 key: rendered report bundle/share link source
  shadow             INTEGER NOT NULL DEFAULT 0, -- 1 if this was a self-heal shadow re-cert
  created_at         INTEGER NOT NULL
);

-- Live transactions (metadata/index; bodies in R2)
CREATE TABLE transactions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  connection_id      TEXT NOT NULL REFERENCES connections(id),
  map_id             TEXT,                  -- map version used
  direction          TEXT NOT NULL,
  transaction_set    TEXT NOT NULL,
  isa_control        TEXT, gs_control TEXT, st_control TEXT,
  raw_in_r2          TEXT, canonical_r2 TEXT, raw_out_r2 TEXT,
  status             TEXT NOT NULL,         -- 'received'|'transformed'|'delivered'|'ack_sent'|'error'
  error_detail       TEXT,
  ack_status         TEXT,                  -- 997 state
  received_at        INTEGER NOT NULL,
  processed_at       INTEGER
);

-- Drift detected on live traffic
CREATE TABLE drift_events (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  connection_id      TEXT NOT NULL REFERENCES connections(id),
  detected_from_txn  TEXT REFERENCES transactions(id),
  kind               TEXT NOT NULL,         -- 'new_segment'|'changed_qualifier'|'loop_change'|'structural'|'semantic_anomaly'
  detail             TEXT NOT NULL,         -- JSON description + evidence
  proposed_map_id    TEXT,                  -- patched map (draft) if proposed
  shadow_cert_id     TEXT,                  -- shadow re-cert run
  status             TEXT NOT NULL DEFAULT 'open', -- 'open'|'patched_shadow'|'auto_applied'|'awaiting_approval'|'applied'|'dismissed'
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER
);

-- Phase 3 bilateral handshake sessions
CREATE TABLE handshake_sessions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  partner_id         TEXT REFERENCES partners(id),
  role               TEXT NOT NULL,         -- 'initiator'|'responder'
  state              TEXT NOT NULL,         -- see 05 state machine
  manifest_r2        TEXT,                  -- signed certification manifest
  peer_key_id        TEXT,
  detail             TEXT,                  -- JSON: negotiated canonical version, flows, digests
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- The accreting Spec Library (normalized, deviation-aware) — the moat
CREATE TABLE spec_library (
  id               TEXT PRIMARY KEY,
  partner_signature TEXT NOT NULL,          -- normalized partner identity (ISA id/SCAC/name fingerprint)
  transaction_set  TEXT NOT NULL,
  x12_version      TEXT NOT NULL,
  canonical_spec_r2 TEXT NOT NULL,          -- normalized, anonymized spec
  proven_by_certs  INTEGER NOT NULL DEFAULT 0, -- count of passing certs referencing this shape
  last_seen        INTEGER NOT NULL,
  UNIQUE(partner_signature, transaction_set, x12_version)
);

CREATE INDEX idx_conn_partner   ON connections(partner_id);
CREATE INDEX idx_maps_conn      ON maps(connection_id, status);
CREATE INDEX idx_txn_conn_time  ON transactions(connection_id, received_at);
CREATE INDEX idx_drift_conn     ON drift_events(connection_id, status);
```

---

## B. The canonical model (semantic hub)

The canonical model is the **shared business-object representation** that every map targets. It is the reason "integrate once" is possible and the language the bilateral handshake agrees in. Keep it **lean, well-named, versioned (major version pinned per map), and faithful to freight reality**. TypeScript + Zod; this lives in `packages/canonical`.

```ts
// packages/canonical/src/types.ts  (illustrative — Zod schemas accompany each)

export type CanonicalVersion = "1";

export interface Party {
  role: "shipper" | "consignee" | "billTo" | "carrier" | "broker" | "thirdParty";
  name: string;
  idQualifier?: string;          // preserve source qualifier for round-trip fidelity
  id?: string;
  address?: Address;
  contact?: { name?: string; phone?: string; email?: string };
}

export interface Address {
  line1?: string; line2?: string; city?: string; state?: string;
  postalCode?: string; country?: string;
}

export interface Reference {            // generic qualified reference (BM, PO, etc.)
  qualifier: string;                    // e.g. 'BM' = BOL, 'PO' = purchase order
  value: string;
}

export interface Freight {
  pieces?: number; weight?: number; weightUom?: "L" | "K";
  class?: string; nmfc?: string; commodity?: string;
  hazmat?: boolean; volume?: number; pallets?: number;
}

export interface Stop {
  sequence: number;
  type: "pickup" | "delivery";
  party: Party;
  earliest?: string;  // ISO 8601
  latest?: string;
  references?: Reference[];
}

// 204
export interface Tender {
  kind: "Tender";
  canonicalVersion: CanonicalVersion;
  shipmentId: string;                  // partner shipment/BOL/load id
  scac?: string;
  purpose: "original" | "cancel" | "replace";
  stops: Stop[];
  freight: Freight[];
  references: Reference[];
  raw?: Record<string, unknown>;       // escape hatch: anything not yet modeled, for lossless round-trip
}

// 990
export interface TenderResponse {
  kind: "TenderResponse";
  canonicalVersion: CanonicalVersion;
  shipmentId: string;
  decision: "accept" | "decline";
  reason?: string;
}

// 211
export interface BOL {
  kind: "BOL";
  canonicalVersion: CanonicalVersion;
  bolNumber: string;
  shipper: Party; consignee: Party; billTo?: Party;
  freight: Freight[];
  references: Reference[];
  specialInstructions?: string;
}

// 214
export interface StatusEvent {
  kind: "StatusEvent";
  canonicalVersion: CanonicalVersion;
  shipmentId: string;
  statusCode: string;                  // mapped to a canonical enum + preserve raw
  statusDescription?: string;
  occurredAt: string;                  // ISO 8601
  location?: Address;
  reasonCode?: string;
}

// 210
export interface Invoice {
  kind: "Invoice";
  canonicalVersion: CanonicalVersion;
  invoiceNumber: string;
  shipmentId?: string;
  billTo: Party;
  charges: { code: string; description?: string; amount: number; }[];
  total: number; currency: string;
  weight?: Freight;
}

// 997
export interface Ack {
  kind: "Ack";
  canonicalVersion: CanonicalVersion;
  acknowledges: { groupControl: string; setCount: number; status: "accepted" | "rejected" | "partial"; };
  errors?: { segment?: string; element?: string; note: string }[];
}

export type CanonicalRecord =
  | Tender | TenderResponse | BOL | StatusEvent | Invoice | Ack;
```

### Canonical model design rules

1. **Round-trip fidelity over prettiness.** Preserve source qualifiers and a `raw` escape hatch so EDI → canonical → EDI is lossless. The Verification Engine enforces this; the model must make it possible.
2. **Lean and freight-true.** Model what the first six transaction sets need. Extend deliberately for retail/healthcare later (`13`) by adding record kinds, not by bloating existing ones.
3. **Versioned.** `canonicalVersion` is pinned per map and negotiated in the handshake. Major-version changes are explicit migrations, never silent.
4. **Enums with raw passthrough.** Map status codes/qualifiers to canonical enums *and* keep the raw code, so nothing is lost when a partner uses an unusual value.
5. **No partner-specific fields in canonical.** Partner idiosyncrasy lives in the map and the `raw` field, never in the shared model — otherwise the hub stops being a hub.
