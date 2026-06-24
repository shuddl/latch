// Production Store: metadata in D1, large/immutable blobs in R2, idempotency in KV
// (docs/04). Faithful to infra/migrations/0001_init.sql. Tenant-scoped on every query.
//
// The schema models the full pipeline (spec → corpus → cert), so to persist a directly
// registered map / on-the-fly corpus we create the parent `specs` and `golden_corpora`
// rows the foreign keys require — keeping the relational graph honest rather than
// loosening constraints. Integration-tested against the real migration (d1r2.test.ts).

import { newId } from '@latch/shared';
import type { MapArtifact } from '@latch/transform';
import type { CertificationResult } from '@latch/verify';
import type { CanonicalRecord } from '@latch/canonical';
import type {
  Certification,
  Connection,
  Connectivity,
  DriftEvent,
  DriftStatus,
  MapRecord,
  Partner,
  Transaction,
} from '../domain';
import type {
  Clock,
  ControlNumbers,
  CreateCertificationData,
  CreateConnectionData,
  CreateDriftEventData,
  CreateMapData,
  CreatePartnerData,
  CreateTransactionData,
  IdempotentResponse,
  Store,
} from './store';

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));
const optStr = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const num = (v: unknown): number => Number(v ?? 0);

export class D1R2Store implements Store {
  constructor(
    private readonly db: D1Database,
    private readonly r2: R2Bucket,
    private readonly kv: KVNamespace,
    private readonly now: Clock = () => Date.now(),
  ) {}

  // ── R2 helpers ─────────────────────────────────────────────────────────────
  private async putJson(key: string, value: unknown): Promise<string> {
    await this.r2.put(key, JSON.stringify(value));
    return key;
  }
  private async getJson<T>(key: string): Promise<T | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as T;
  }

  // ── Partners ─────────────────────────────────────────────────────────────────
  async createPartner(tenantId: string, data: CreatePartnerData): Promise<Partner> {
    const ts = this.now();
    const partner: Partner = { id: newId('partner'), tenantId, createdAt: ts, updatedAt: ts, ...data };
    await this.db
      .prepare(
        `INSERT INTO partners (id, tenant_id, name, scac, isa_qualifier, isa_id, gs_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        partner.id,
        tenantId,
        partner.name,
        partner.scac ?? null,
        partner.isaQualifier ?? null,
        partner.isaId ?? null,
        partner.gsId ?? null,
        ts,
        ts,
      )
      .run();
    return partner;
  }
  private rowToPartner(r: Row): Partner {
    return {
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      name: str(r['name']),
      ...(optStr(r['scac']) ? { scac: str(r['scac']) } : {}),
      ...(optStr(r['isa_qualifier']) ? { isaQualifier: str(r['isa_qualifier']) } : {}),
      ...(optStr(r['isa_id']) ? { isaId: str(r['isa_id']) } : {}),
      ...(optStr(r['gs_id']) ? { gsId: str(r['gs_id']) } : {}),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
    };
  }
  async getPartner(tenantId: string, id: string): Promise<Partner | null> {
    const r = await this.db
      .prepare(`SELECT * FROM partners WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    return r ? this.rowToPartner(r) : null;
  }
  async listPartners(tenantId: string): Promise<Partner[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM partners WHERE tenant_id = ? ORDER BY created_at`)
      .bind(tenantId)
      .all<Row>();
    return results.map((r) => this.rowToPartner(r));
  }

  // ── Connections ──────────────────────────────────────────────────────────────
  async createConnection(tenantId: string, data: CreateConnectionData): Promise<Connection> {
    const ts = this.now();
    const conn: Connection = {
      id: newId('connection'),
      tenantId,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
      ...data,
    };
    await this.db
      .prepare(
        `INSERT INTO connections (id, tenant_id, partner_id, direction, transaction_set, x12_version, connectivity, status, active_map_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        conn.id,
        tenantId,
        conn.partnerId,
        conn.direction,
        conn.transactionSet,
        conn.x12Version,
        JSON.stringify(conn.connectivity),
        conn.status,
        null,
        ts,
        ts,
      )
      .run();
    return conn;
  }
  private rowToConnection(r: Row): Connection {
    return {
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      partnerId: str(r['partner_id']),
      direction: str(r['direction']) as Connection['direction'],
      transactionSet: str(r['transaction_set']),
      x12Version: str(r['x12_version']),
      connectivity: JSON.parse(str(r['connectivity'])) as Connectivity,
      status: str(r['status']) as Connection['status'],
      ...(optStr(r['active_map_id']) ? { activeMapId: str(r['active_map_id']) } : {}),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
    };
  }
  async getConnection(tenantId: string, id: string): Promise<Connection | null> {
    const r = await this.db
      .prepare(`SELECT * FROM connections WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    return r ? this.rowToConnection(r) : null;
  }
  async listConnections(
    tenantId: string,
    filter?: { partnerId?: string; status?: string },
  ): Promise<Connection[]> {
    const clauses = ['tenant_id = ?'];
    const binds: unknown[] = [tenantId];
    if (filter?.partnerId) {
      clauses.push('partner_id = ?');
      binds.push(filter.partnerId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      binds.push(filter.status);
    }
    const { results } = await this.db
      .prepare(`SELECT * FROM connections WHERE ${clauses.join(' AND ')} ORDER BY created_at`)
      .bind(...binds)
      .all<Row>();
    return results.map((r) => this.rowToConnection(r));
  }
  async updateConnection(
    tenantId: string,
    id: string,
    patch: Partial<Pick<Connection, 'status' | 'activeMapId' | 'connectivity'>>,
  ): Promise<Connection | null> {
    const existing = await this.getConnection(tenantId, id);
    if (!existing) return null;
    const next: Connection = { ...existing, ...patch, updatedAt: this.now() };
    await this.db
      .prepare(
        `UPDATE connections SET status = ?, active_map_id = ?, connectivity = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(
        next.status,
        next.activeMapId ?? null,
        JSON.stringify(next.connectivity),
        next.updatedAt,
        id,
        tenantId,
      )
      .run();
    return next;
  }

  // ── Samples (R2 object per connection) ───────────────────────────────────────
  private sampleKey(tenantId: string, connectionId: string): string {
    return `samples/${tenantId}/${connectionId}.json`;
  }
  async addSamples(tenantId: string, connectionId: string, samples: string[]): Promise<number> {
    const key = this.sampleKey(tenantId, connectionId);
    const current = (await this.getJson<string[]>(key)) ?? [];
    const next = [...current, ...samples];
    await this.putJson(key, next);
    return next.length;
  }
  async getSamples(tenantId: string, connectionId: string): Promise<string[]> {
    return (await this.getJson<string[]>(this.sampleKey(tenantId, connectionId))) ?? [];
  }

  // ── Maps (+ the synthetic spec the FK requires) ──────────────────────────────
  async createMap(tenantId: string, data: CreateMapData): Promise<MapRecord> {
    const ts = this.now();
    const conn = await this.getConnection(tenantId, data.connectionId);
    if (!conn) throw new Error(`createMap: unknown connection ${data.connectionId}`);

    // A map must reference a spec (schema FK). For a directly-registered map we record a
    // minimal spec capturing the set/version; the spec ingestor (M1.1) will supersede it.
    // The spec + map rows are written atomically (db.batch) so a failure can't orphan a spec.
    const specId = newId('spec');
    const specKey = `specs/${tenantId}/${specId}.json`;
    const id = newId('map');
    const rulesKey = `maps/${tenantId}/${id}.json`;
    await this.putJson(specKey, { source: 'manual-map-registration', transactionSet: data.transactionSet });
    await this.putJson(rulesKey, data.artifact);

    const specStmt = this.db
      .prepare(
        `INSERT INTO specs (id, tenant_id, partner_id, transaction_set, x12_version, spec_json_r2, spec_hash, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(specId, tenantId, conn.partnerId, data.transactionSet, conn.x12Version, specKey, data.compiledHash, ts, ts);
    const mapStmt = this.db
      .prepare(
        `INSERT INTO maps (id, tenant_id, connection_id, spec_id, direction, transaction_set, canonical_version, rules_json_r2, compiled_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        data.connectionId,
        specId,
        data.direction,
        data.transactionSet,
        data.canonicalVersion,
        rulesKey,
        data.compiledHash,
        ts,
        ts,
      );
    await this.db.batch([specStmt, mapStmt]);

    return {
      id,
      tenantId,
      connectionId: data.connectionId,
      transactionSet: data.transactionSet,
      direction: data.direction,
      canonicalVersion: data.canonicalVersion,
      compiledHash: data.compiledHash,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    };
  }
  private rowToMap(r: Row): MapRecord {
    return {
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      connectionId: str(r['connection_id']),
      transactionSet: str(r['transaction_set']),
      direction: str(r['direction']) as MapRecord['direction'],
      canonicalVersion: str(r['canonical_version']),
      compiledHash: str(r['compiled_hash']),
      status: str(r['status']) as MapRecord['status'],
      ...(optStr(r['latest_cert_id']) ? { latestCertId: str(r['latest_cert_id']) } : {}),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
    };
  }
  async getMap(tenantId: string, id: string): Promise<MapRecord | null> {
    const r = await this.db
      .prepare(`SELECT * FROM maps WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    return r ? this.rowToMap(r) : null;
  }
  async getMapArtifact(tenantId: string, id: string): Promise<MapArtifact | null> {
    const r = await this.db
      .prepare(`SELECT rules_json_r2 FROM maps WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    if (!r) return null;
    return this.getJson<MapArtifact>(str(r['rules_json_r2']));
  }
  async listMapsByConnection(tenantId: string, connectionId: string): Promise<MapRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM maps WHERE tenant_id = ? AND connection_id = ? ORDER BY created_at`)
      .bind(tenantId, connectionId)
      .all<Row>();
    return results.map((r) => this.rowToMap(r));
  }
  async updateMap(
    tenantId: string,
    id: string,
    patch: Partial<Pick<MapRecord, 'status' | 'latestCertId'>>,
  ): Promise<MapRecord | null> {
    const existing = await this.getMap(tenantId, id);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: this.now() };
    await this.db
      .prepare(`UPDATE maps SET status = ?, latest_cert_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(next.status, next.latestCertId ?? null, next.updatedAt, id, tenantId)
      .run();
    return next;
  }

  // ── Certifications (+ the synthetic golden_corpora the FK requires) ──────────
  async createCertification(
    tenantId: string,
    data: CreateCertificationData,
  ): Promise<Certification> {
    const ts = this.now();
    const map = await this.getMapRow(tenantId, data.mapId);
    if (!map) throw new Error(`createCertification: unknown map ${data.mapId}`);
    const specId = str(map['spec_id']);

    // Persist the corpus the cert was run against (schema FK on certification_runs).
    // Corpus + cert rows are written atomically (db.batch) — no orphaned corpus on failure.
    const corpusId = newId('golden');
    const corpusKey = `corpora/${tenantId}/${corpusId}.json`;
    const id = newId('cert');
    const resultKey = `certs/${tenantId}/${id}.json`;
    await this.putJson(corpusKey, { corpusHash: data.result.corpusHash });
    await this.putJson(resultKey, data.result);
    const d = data.result.dimensions;

    const corpusStmt = this.db
      .prepare(
        `INSERT INTO golden_corpora (id, tenant_id, spec_id, corpus_r2, counts, corpus_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(corpusId, tenantId, specId, corpusKey, JSON.stringify({}), data.result.corpusHash, ts);
    const certStmt = this.db
      .prepare(
        `INSERT INTO certification_runs (id, tenant_id, map_id, corpus_id, passed, required_coverage, qualifier_coverage, roundtrip_fidelity, adversarial_ok, field_results_r2, shadow, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        id,
        tenantId,
        data.mapId,
        corpusId,
        data.result.passed ? 1 : 0,
        d['requiredSegmentCoverage']?.value ?? 0,
        d['qualifierCoverage']?.value ?? 0,
        d['roundTripFidelity']?.value ?? 0,
        d['adversarialGraceful']?.value ?? 0,
        resultKey,
        ts,
      );
    await this.db.batch([corpusStmt, certStmt]);

    return this.assembleCertification(id, tenantId, data, ts);
  }
  private assembleCertification(
    id: string,
    tenantId: string,
    data: CreateCertificationData,
    ts: number,
  ): Certification {
    const d = data.result.dimensions;
    return {
      id,
      tenantId,
      mapId: data.mapId,
      connectionId: data.connectionId,
      passed: data.result.passed,
      requiredCoverage: d['requiredSegmentCoverage']?.value ?? 0,
      qualifierCoverage: d['qualifierCoverage']?.value ?? 0,
      loopCoverage: d['loopCoverage']?.value ?? 0,
      roundtripFidelity: d['roundTripFidelity']?.value ?? 0,
      adversarialOk: d['adversarialGraceful']?.value ?? 0,
      deviationHandling: d['deviationHandling']?.value ?? 0,
      shortfalls: data.result.shortfalls,
      mapHash: data.result.mapHash,
      corpusHash: data.result.corpusHash,
      createdAt: ts,
    };
  }
  private async getMapRow(tenantId: string, id: string): Promise<Row | null> {
    return this.db
      .prepare(`SELECT * FROM maps WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
  }
  async getCertification(tenantId: string, id: string): Promise<Certification | null> {
    const r = await this.db
      .prepare(`SELECT cr.*, m.connection_id AS connection_id FROM certification_runs cr
                JOIN maps m ON m.id = cr.map_id AND m.tenant_id = cr.tenant_id
                WHERE cr.id = ? AND cr.tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    if (!r) return null;
    const full = await this.getJson<CertificationResult>(str(r['field_results_r2']));
    return {
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      mapId: str(r['map_id']),
      connectionId: str(r['connection_id']),
      passed: num(r['passed']) === 1,
      requiredCoverage: num(r['required_coverage']),
      qualifierCoverage: num(r['qualifier_coverage']),
      loopCoverage: full?.dimensions?.['loopCoverage']?.value ?? 0,
      roundtripFidelity: num(r['roundtrip_fidelity']),
      adversarialOk: num(r['adversarial_ok']),
      deviationHandling: full?.dimensions?.['deviationHandling']?.value ?? 0,
      shortfalls: full?.shortfalls ?? [],
      mapHash: full?.mapHash ?? '',
      corpusHash: str(r['corpus_id']) ? (full?.corpusHash ?? '') : '',
      createdAt: num(r['created_at']),
    };
  }
  async getCertificationResult(tenantId: string, id: string): Promise<CertificationResult | null> {
    const r = await this.db
      .prepare(`SELECT field_results_r2 FROM certification_runs WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    if (!r) return null;
    return this.getJson<CertificationResult>(str(r['field_results_r2']));
  }

  // ── Transactions (metadata in D1, bodies in R2) ──────────────────────────────
  async createTransaction(tenantId: string, data: CreateTransactionData): Promise<Transaction> {
    const ts = this.now();
    const id = newId('transaction');
    const rawInKey = `txn/${tenantId}/${id}/in.edi`;
    await this.r2.put(rawInKey, data.rawIn);
    let canonicalKey: string | null = null;
    if (data.canonical) {
      canonicalKey = `txn/${tenantId}/${id}/canonical.json`;
      await this.putJson(canonicalKey, data.canonical);
    }
    let rawOutKey: string | null = null;
    if (data.rawOut) {
      rawOutKey = `txn/${tenantId}/${id}/out.edi`;
      await this.r2.put(rawOutKey, data.rawOut);
    }
    const processedAt = data.status === 'received' ? null : ts;
    await this.db
      .prepare(
        `INSERT INTO transactions (id, tenant_id, connection_id, map_id, direction, transaction_set, isa_control, gs_control, st_control, raw_in_r2, canonical_r2, raw_out_r2, status, error_detail, ack_status, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        data.connectionId,
        data.mapId ?? null,
        data.direction,
        data.transactionSet,
        data.controls.isa ?? null,
        data.controls.gs ?? null,
        data.controls.st ?? null,
        rawInKey,
        canonicalKey,
        rawOutKey,
        data.status,
        data.errorDetail ?? null,
        data.ackStatus ?? null,
        ts,
        processedAt,
      )
      .run();
    return this.rowToTransaction({
      id,
      tenant_id: tenantId,
      connection_id: data.connectionId,
      map_id: data.mapId ?? null,
      direction: data.direction,
      transaction_set: data.transactionSet,
      isa_control: data.controls.isa ?? null,
      gs_control: data.controls.gs ?? null,
      st_control: data.controls.st ?? null,
      status: data.status,
      error_detail: data.errorDetail ?? null,
      ack_status: data.ackStatus ?? null,
      received_at: ts,
      processed_at: processedAt,
    });
  }
  private rowToTransaction(r: Row): Transaction {
    return {
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      connectionId: str(r['connection_id']),
      ...(optStr(r['map_id']) ? { mapId: str(r['map_id']) } : {}),
      direction: str(r['direction']) as Transaction['direction'],
      transactionSet: str(r['transaction_set']),
      ...(optStr(r['isa_control']) ? { isaControl: str(r['isa_control']) } : {}),
      ...(optStr(r['gs_control']) ? { gsControl: str(r['gs_control']) } : {}),
      ...(optStr(r['st_control']) ? { stControl: str(r['st_control']) } : {}),
      status: str(r['status']) as Transaction['status'],
      ...(optStr(r['error_detail']) ? { errorDetail: str(r['error_detail']) } : {}),
      ...(optStr(r['ack_status']) ? { ackStatus: str(r['ack_status']) } : {}),
      receivedAt: num(r['received_at']),
      ...(r['processed_at'] != null ? { processedAt: num(r['processed_at']) } : {}),
    };
  }
  async getTransaction(tenantId: string, id: string): Promise<Transaction | null> {
    const r = await this.db
      .prepare(`SELECT * FROM transactions WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    return r ? this.rowToTransaction(r) : null;
  }
  async listTransactions(tenantId: string, connectionId: string, limit = 100): Promise<Transaction[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM transactions WHERE tenant_id = ? AND connection_id = ? ORDER BY received_at DESC LIMIT ?`,
      )
      .bind(tenantId, connectionId, limit)
      .all<Row>();
    return results.map((r) => this.rowToTransaction(r));
  }
  async findTransactionByControls(
    tenantId: string,
    connectionId: string,
    controls: ControlNumbers,
  ): Promise<Transaction | null> {
    // IFNULL so NULL control numbers compare equal (NULL = NULL is NULL in SQL).
    const r = await this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE tenant_id = ? AND connection_id = ?
           AND IFNULL(isa_control,'') = ? AND IFNULL(gs_control,'') = ? AND IFNULL(st_control,'') = ?
         LIMIT 1`,
      )
      .bind(tenantId, connectionId, controls.isa ?? '', controls.gs ?? '', controls.st ?? '')
      .first<Row>();
    return r ? this.rowToTransaction(r) : null;
  }
  async getTransactionRawIn(tenantId: string, id: string): Promise<string | null> {
    const r = await this.db
      .prepare(`SELECT raw_in_r2 FROM transactions WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    if (!r) return null;
    const obj = await this.r2.get(str(r['raw_in_r2']));
    return obj ? obj.text() : null;
  }
  async getTransactionCanonical(tenantId: string, id: string): Promise<CanonicalRecord[] | null> {
    const r = await this.db
      .prepare(`SELECT canonical_r2 FROM transactions WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    if (!r || !optStr(r['canonical_r2'])) return null;
    return this.getJson<CanonicalRecord[]>(str(r['canonical_r2']));
  }

  // ── Drift events (self-heal) ─────────────────────────────────────────────────
  async createDriftEvent(tenantId: string, data: CreateDriftEventData): Promise<DriftEvent> {
    const ts = this.now();
    const id = newId('drift');
    await this.db
      .prepare(
        `INSERT INTO drift_events (id, tenant_id, connection_id, detected_from_txn, kind, detail, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        data.connectionId,
        data.detectedFromTxn ?? null,
        data.kind,
        data.detail,
        data.status,
        ts,
        data.resolvedAt ?? null,
      )
      .run();
    return this.rowToDrift({
      id,
      tenant_id: tenantId,
      connection_id: data.connectionId,
      detected_from_txn: data.detectedFromTxn ?? null,
      kind: data.kind,
      detail: data.detail,
      status: data.status,
      created_at: ts,
      resolved_at: data.resolvedAt ?? null,
    });
  }
  private rowToDrift(r: Row): DriftEvent {
    return {
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      connectionId: str(r['connection_id']),
      ...(optStr(r['detected_from_txn']) ? { detectedFromTxn: str(r['detected_from_txn']) } : {}),
      kind: str(r['kind']),
      detail: str(r['detail']),
      status: str(r['status']) as DriftStatus,
      createdAt: num(r['created_at']),
      ...(r['resolved_at'] != null ? { resolvedAt: num(r['resolved_at']) } : {}),
    };
  }
  async getDriftEvent(tenantId: string, id: string): Promise<DriftEvent | null> {
    const r = await this.db
      .prepare(`SELECT * FROM drift_events WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<Row>();
    return r ? this.rowToDrift(r) : null;
  }
  async listDriftEvents(tenantId: string, connectionId: string): Promise<DriftEvent[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM drift_events WHERE tenant_id = ? AND connection_id = ? ORDER BY created_at DESC`)
      .bind(tenantId, connectionId)
      .all<Row>();
    return results.map((r) => this.rowToDrift(r));
  }
  async updateDriftEvent(
    tenantId: string,
    id: string,
    patch: { status: DriftStatus; resolvedAt?: number },
  ): Promise<DriftEvent | null> {
    const existing = await this.getDriftEvent(tenantId, id);
    if (!existing) return null;
    const resolvedAt = patch.resolvedAt ?? existing.resolvedAt ?? null;
    await this.db
      .prepare(`UPDATE drift_events SET status = ?, resolved_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(patch.status, resolvedAt, id, tenantId)
      .run();
    return { ...existing, status: patch.status, ...(resolvedAt != null ? { resolvedAt } : {}) };
  }

  // ── Idempotency (KV) ─────────────────────────────────────────────────────────
  async getIdempotent(tenantId: string, key: string): Promise<IdempotentResponse | null> {
    const v = await this.kv.get(`idem:${tenantId}:${key}`);
    return v ? (JSON.parse(v) as IdempotentResponse) : null;
  }
  async putIdempotent(tenantId: string, key: string, value: IdempotentResponse): Promise<void> {
    await this.kv.put(`idem:${tenantId}:${key}`, JSON.stringify(value));
  }
}
