-- 0001_init.sql — Latch D1 schema (docs/06 §A)
--
-- This is the EXECUTABLE schema. docs/06 is the narrative source of truth; this
-- migration is the artifact and incorporates the PR #1 review improvements
-- (see REVIEW.md §H):
--   • last_seen -> last_seen_at (timestamp-naming consistency)
--   • composite index on transaction control numbers (997-link / dup-detect perf)
--   • UNIQUE(id, tenant_id) on parents + composite FKs (tenant-isolation backstop)
-- App-level tenant scoping remains primary; FKs are defense-in-depth.

PRAGMA foreign_keys = ON;

-- Tenants (single-tenant in dev; `default` seeded). Multi-tenant is a switch (docs/04).
CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
INSERT INTO tenants (id, name, created_at) VALUES ('default', 'Default (dev)', 0);

-- Trading partners (the "other side")
CREATE TABLE partners (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  name          TEXT NOT NULL,
  scac          TEXT,
  isa_qualifier TEXT,
  isa_id        TEXT,
  gs_id         TEXT,
  van           TEXT,
  contacts      TEXT,                       -- JSON [{name,email,role}]
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(id, tenant_id)                     -- enables composite FKs (tenant isolation)
);

-- A directional relationship + connectivity for a transaction set
CREATE TABLE connections (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  partner_id      TEXT NOT NULL,
  direction       TEXT NOT NULL,            -- 'inbound' | 'outbound' (relative to us)
  transaction_set TEXT NOT NULL,            -- '204','210','211','214','990','997'
  x12_version     TEXT NOT NULL DEFAULT '004010',
  connectivity    TEXT NOT NULL,            -- JSON {type:'sftp'|'as2'|'van'|'api', config-ref}
  status          TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'certified'|'production'|'paused'|'retired'
  active_map_id   TEXT,                     -- soft ref to current production map
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(partner_id, direction, transaction_set, x12_version, tenant_id),
  UNIQUE(id, tenant_id),
  FOREIGN KEY (partner_id, tenant_id) REFERENCES partners(id, tenant_id)
);

-- The machine-readable spec derived from a companion guide + samples
CREATE TABLE specs (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  partner_id       TEXT NOT NULL,
  transaction_set  TEXT NOT NULL,
  x12_version      TEXT NOT NULL,
  source_guide_r2  TEXT,
  sample_refs      TEXT,                    -- JSON [R2 keys]
  spec_json_r2     TEXT NOT NULL,
  spec_hash        TEXT NOT NULL,
  confidence       REAL,
  deviations       TEXT,                    -- JSON
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(id, tenant_id),
  FOREIGN KEY (partner_id, tenant_id) REFERENCES partners(id, tenant_id)
);

-- A compiled, versioned transform between a spec and the canonical model
CREATE TABLE maps (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  connection_id       TEXT NOT NULL,
  spec_id             TEXT NOT NULL,
  direction           TEXT NOT NULL,        -- 'inbound'|'outbound'
  transaction_set     TEXT NOT NULL,
  canonical_version   TEXT NOT NULL,
  rules_json_r2       TEXT NOT NULL,
  compiled_hash       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'certified'|'production'|'retired'
  latest_cert_id      TEXT,                 -- soft ref
  parent_map_id       TEXT,                 -- soft ref (heal lineage)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(id, tenant_id),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES connections(id, tenant_id),
  FOREIGN KEY (spec_id, tenant_id) REFERENCES specs(id, tenant_id)
);

-- Synthesized golden-record corpus for a spec/map
CREATE TABLE golden_corpora (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  spec_id          TEXT NOT NULL,
  corpus_r2        TEXT NOT NULL,           -- JSON array of {edi, expected_canonical, category}
  counts           TEXT NOT NULL,           -- JSON {valid,boundary,qualifier,loop,deviation,adversarial}
  corpus_hash      TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE(id, tenant_id),
  FOREIGN KEY (spec_id, tenant_id) REFERENCES specs(id, tenant_id)
);

-- A verification run that produces a certification
CREATE TABLE certification_runs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  map_id             TEXT NOT NULL,
  corpus_id          TEXT NOT NULL,
  passed             INTEGER NOT NULL,      -- 0/1 vs benchmark bar
  required_coverage  REAL NOT NULL,
  qualifier_coverage REAL NOT NULL,
  roundtrip_fidelity REAL NOT NULL,
  adversarial_ok     REAL NOT NULL,
  field_results_r2   TEXT NOT NULL,
  report_bundle_r2   TEXT,
  shadow             INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (map_id, tenant_id) REFERENCES maps(id, tenant_id),
  FOREIGN KEY (corpus_id, tenant_id) REFERENCES golden_corpora(id, tenant_id)
);

-- Live transactions (metadata/index; bodies in R2)
CREATE TABLE transactions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  connection_id      TEXT NOT NULL,
  map_id             TEXT,                  -- map version used (soft ref)
  direction          TEXT NOT NULL,
  transaction_set    TEXT NOT NULL,
  isa_control        TEXT,
  gs_control         TEXT,
  st_control         TEXT,
  raw_in_r2          TEXT,
  canonical_r2       TEXT,
  raw_out_r2         TEXT,
  status             TEXT NOT NULL,         -- 'received'|'transformed'|'delivered'|'ack_sent'|'error'
  error_detail       TEXT,
  ack_status         TEXT,
  received_at        INTEGER NOT NULL,
  processed_at       INTEGER,
  FOREIGN KEY (connection_id, tenant_id) REFERENCES connections(id, tenant_id)
);

-- Drift detected on live traffic
CREATE TABLE drift_events (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  connection_id      TEXT NOT NULL,
  detected_from_txn  TEXT,                  -- soft ref to transactions(id)
  kind               TEXT NOT NULL,         -- 'new_segment'|'changed_qualifier'|'loop_change'|'structural'|'semantic_anomaly'
  detail             TEXT NOT NULL,         -- JSON
  proposed_map_id    TEXT,                  -- soft ref
  shadow_cert_id     TEXT,                  -- soft ref
  status             TEXT NOT NULL DEFAULT 'open', -- 'open'|'patched_shadow'|'auto_applied'|'awaiting_approval'|'applied'|'dismissed'
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER,
  FOREIGN KEY (connection_id, tenant_id) REFERENCES connections(id, tenant_id)
);

-- Phase 3 bilateral handshake sessions
CREATE TABLE handshake_sessions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  partner_id         TEXT,
  role               TEXT NOT NULL,         -- 'initiator'|'responder'
  state              TEXT NOT NULL,         -- docs/05 state machine
  manifest_r2        TEXT,
  peer_key_id        TEXT,
  detail             TEXT,                  -- JSON
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (partner_id, tenant_id) REFERENCES partners(id, tenant_id)
);

-- The accreting Spec Library (normalized, deviation-aware) — the moat.
-- Cross-tenant by design (anonymized); not tenant-scoped. See REVIEW.md D5 for
-- the anonymization policy that must be set before accretion turns on (M3).
CREATE TABLE spec_library (
  id                TEXT PRIMARY KEY,
  partner_signature TEXT NOT NULL,          -- normalized partner identity fingerprint
  transaction_set   TEXT NOT NULL,
  x12_version       TEXT NOT NULL,
  canonical_spec_r2 TEXT NOT NULL,
  proven_by_certs   INTEGER NOT NULL DEFAULT 0,
  last_seen_at      INTEGER NOT NULL,       -- renamed from last_seen (REVIEW.md §H)
  UNIQUE(partner_signature, transaction_set, x12_version)
);

CREATE INDEX idx_conn_partner   ON connections(partner_id);
CREATE INDEX idx_maps_conn      ON maps(connection_id, status);
CREATE INDEX idx_txn_conn_time  ON transactions(connection_id, received_at);
CREATE INDEX idx_drift_conn     ON drift_events(connection_id, status);
-- Control-number lookup for 997 acknowledgment linking + duplicate detection (REVIEW.md §H)
CREATE INDEX idx_txn_control    ON transactions(connection_id, isa_control, gs_control, st_control);
