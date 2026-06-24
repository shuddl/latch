// In-memory Store — used by tests and `wrangler dev` without a database. Tenant data
// lives under a per-tenant bucket so cross-tenant reads are structurally impossible.

import { newId } from '@latch/shared';
import type { MapArtifact } from '@latch/transform';
import type { CertificationResult } from '@latch/verify';
import type { CanonicalRecord } from '@latch/canonical';
import type { Certification, Connection, DriftEvent, DriftStatus, MapRecord, Partner, Transaction } from '../domain';
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

interface TxnBlobs {
  rawIn: string;
  canonical?: CanonicalRecord[];
  rawOut?: string;
}

interface TenantData {
  partners: Map<string, Partner>;
  connections: Map<string, Connection>;
  samples: Map<string, string[]>; // connectionId → raw EDI
  maps: Map<string, MapRecord>;
  artifacts: Map<string, MapArtifact>; // mapId → artifact
  certifications: Map<string, Certification>;
  certResults: Map<string, CertificationResult>; // certId → full result
  transactions: Map<string, Transaction>;
  txnBlobs: Map<string, TxnBlobs>; // txnId → raw/canonical/out
  drift: Map<string, DriftEvent>;
  idempotency: Map<string, IdempotentResponse>;
}

function emptyTenant(): TenantData {
  return {
    partners: new Map(),
    connections: new Map(),
    samples: new Map(),
    maps: new Map(),
    artifacts: new Map(),
    certifications: new Map(),
    certResults: new Map(),
    transactions: new Map(),
    txnBlobs: new Map(),
    drift: new Map(),
    idempotency: new Map(),
  };
}

// Defensive clone so callers can't mutate stored records by reference.
function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryStore implements Store {
  private readonly tenants = new Map<string, TenantData>();
  constructor(private readonly now: Clock = () => Date.now()) {}

  private t(tenantId: string): TenantData {
    let data = this.tenants.get(tenantId);
    if (!data) {
      data = emptyTenant();
      this.tenants.set(tenantId, data);
    }
    return data;
  }

  async createPartner(tenantId: string, data: CreatePartnerData): Promise<Partner> {
    const ts = this.now();
    const partner: Partner = { id: newId('partner'), tenantId, createdAt: ts, updatedAt: ts, ...data };
    this.t(tenantId).partners.set(partner.id, partner);
    return clone(partner);
  }
  async getPartner(tenantId: string, id: string): Promise<Partner | null> {
    return clone(this.t(tenantId).partners.get(id) ?? null);
  }
  async listPartners(tenantId: string): Promise<Partner[]> {
    return [...this.t(tenantId).partners.values()].map(clone);
  }

  async createConnection(tenantId: string, data: CreateConnectionData): Promise<Connection> {
    const ts = this.now();
    const connection: Connection = {
      id: newId('connection'),
      tenantId,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
      ...data,
    };
    this.t(tenantId).connections.set(connection.id, connection);
    return clone(connection);
  }
  async getConnection(tenantId: string, id: string): Promise<Connection | null> {
    return clone(this.t(tenantId).connections.get(id) ?? null);
  }
  async listConnections(
    tenantId: string,
    filter?: { partnerId?: string; status?: string },
  ): Promise<Connection[]> {
    return [...this.t(tenantId).connections.values()]
      .filter((c) => (filter?.partnerId ? c.partnerId === filter.partnerId : true))
      .filter((c) => (filter?.status ? c.status === filter.status : true))
      .map(clone);
  }
  async updateConnection(
    tenantId: string,
    id: string,
    patch: Partial<Pick<Connection, 'status' | 'activeMapId' | 'connectivity'>>,
  ): Promise<Connection | null> {
    const existing = this.t(tenantId).connections.get(id);
    if (!existing) return null;
    const updated: Connection = { ...existing, ...patch, updatedAt: this.now() };
    this.t(tenantId).connections.set(id, updated);
    return clone(updated);
  }

  async addSamples(tenantId: string, connectionId: string, samples: string[]): Promise<number> {
    const map = this.t(tenantId).samples;
    const current = map.get(connectionId) ?? [];
    const next = [...current, ...samples];
    map.set(connectionId, next);
    return next.length;
  }
  async getSamples(tenantId: string, connectionId: string): Promise<string[]> {
    return [...(this.t(tenantId).samples.get(connectionId) ?? [])];
  }

  async createMap(tenantId: string, data: CreateMapData): Promise<MapRecord> {
    const ts = this.now();
    const record: MapRecord = {
      id: newId('map'),
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
    this.t(tenantId).maps.set(record.id, record);
    this.t(tenantId).artifacts.set(record.id, clone(data.artifact));
    return clone(record);
  }
  async getMap(tenantId: string, id: string): Promise<MapRecord | null> {
    return clone(this.t(tenantId).maps.get(id) ?? null);
  }
  async getMapArtifact(tenantId: string, id: string): Promise<MapArtifact | null> {
    return clone(this.t(tenantId).artifacts.get(id) ?? null);
  }
  async listMapsByConnection(tenantId: string, connectionId: string): Promise<MapRecord[]> {
    return [...this.t(tenantId).maps.values()]
      .filter((m) => m.connectionId === connectionId)
      .map(clone);
  }
  async updateMap(
    tenantId: string,
    id: string,
    patch: Partial<Pick<MapRecord, 'status' | 'latestCertId'>>,
  ): Promise<MapRecord | null> {
    const existing = this.t(tenantId).maps.get(id);
    if (!existing) return null;
    const updated: MapRecord = { ...existing, ...patch, updatedAt: this.now() };
    this.t(tenantId).maps.set(id, updated);
    return clone(updated);
  }

  async createCertification(
    tenantId: string,
    data: CreateCertificationData,
  ): Promise<Certification> {
    const ts = this.now();
    const d = data.result.dimensions;
    const cert: Certification = {
      id: newId('cert'),
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
    this.t(tenantId).certifications.set(cert.id, cert);
    this.t(tenantId).certResults.set(cert.id, clone(data.result));
    return clone(cert);
  }
  async getCertification(tenantId: string, id: string): Promise<Certification | null> {
    return clone(this.t(tenantId).certifications.get(id) ?? null);
  }
  async getCertificationResult(tenantId: string, id: string): Promise<CertificationResult | null> {
    return clone(this.t(tenantId).certResults.get(id) ?? null);
  }

  async createTransaction(tenantId: string, data: CreateTransactionData): Promise<Transaction> {
    const ts = this.now();
    const txn: Transaction = {
      id: newId('transaction'),
      tenantId,
      connectionId: data.connectionId,
      ...(data.mapId ? { mapId: data.mapId } : {}),
      direction: data.direction,
      transactionSet: data.transactionSet,
      ...(data.controls.isa ? { isaControl: data.controls.isa } : {}),
      ...(data.controls.gs ? { gsControl: data.controls.gs } : {}),
      ...(data.controls.st ? { stControl: data.controls.st } : {}),
      status: data.status,
      ...(data.errorDetail ? { errorDetail: data.errorDetail } : {}),
      ...(data.ackStatus ? { ackStatus: data.ackStatus } : {}),
      receivedAt: ts,
      ...(data.status === 'received' ? {} : { processedAt: ts }),
    };
    this.t(tenantId).transactions.set(txn.id, txn);
    this.t(tenantId).txnBlobs.set(txn.id, {
      rawIn: data.rawIn,
      ...(data.canonical ? { canonical: data.canonical } : {}),
      ...(data.rawOut ? { rawOut: data.rawOut } : {}),
    });
    return clone(txn);
  }
  async getTransaction(tenantId: string, id: string): Promise<Transaction | null> {
    return clone(this.t(tenantId).transactions.get(id) ?? null);
  }
  async listTransactions(tenantId: string, connectionId: string, limit = 100): Promise<Transaction[]> {
    return [...this.t(tenantId).transactions.values()]
      .filter((t) => t.connectionId === connectionId)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit)
      .map(clone);
  }
  async findTransactionByControls(
    tenantId: string,
    connectionId: string,
    controls: ControlNumbers,
  ): Promise<Transaction | null> {
    const match = [...this.t(tenantId).transactions.values()].find(
      (t) =>
        t.connectionId === connectionId &&
        t.isaControl === controls.isa &&
        t.gsControl === controls.gs &&
        t.stControl === controls.st,
    );
    return clone(match ?? null);
  }
  async getTransactionRawIn(tenantId: string, id: string): Promise<string | null> {
    return this.t(tenantId).txnBlobs.get(id)?.rawIn ?? null;
  }
  async getTransactionCanonical(tenantId: string, id: string): Promise<CanonicalRecord[] | null> {
    return clone(this.t(tenantId).txnBlobs.get(id)?.canonical ?? null);
  }

  async createDriftEvent(tenantId: string, data: CreateDriftEventData): Promise<DriftEvent> {
    const event: DriftEvent = {
      id: newId('drift'),
      tenantId,
      connectionId: data.connectionId,
      ...(data.detectedFromTxn ? { detectedFromTxn: data.detectedFromTxn } : {}),
      kind: data.kind,
      detail: data.detail,
      status: data.status,
      createdAt: this.now(),
      ...(data.resolvedAt ? { resolvedAt: data.resolvedAt } : {}),
    };
    this.t(tenantId).drift.set(event.id, event);
    return clone(event);
  }
  async getDriftEvent(tenantId: string, id: string): Promise<DriftEvent | null> {
    return clone(this.t(tenantId).drift.get(id) ?? null);
  }
  async listDriftEvents(tenantId: string, connectionId: string): Promise<DriftEvent[]> {
    return [...this.t(tenantId).drift.values()]
      .filter((d) => d.connectionId === connectionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }
  async updateDriftEvent(
    tenantId: string,
    id: string,
    patch: { status: DriftStatus; resolvedAt?: number },
  ): Promise<DriftEvent | null> {
    const existing = this.t(tenantId).drift.get(id);
    if (!existing) return null;
    const updated: DriftEvent = {
      ...existing,
      status: patch.status,
      ...(patch.resolvedAt ? { resolvedAt: patch.resolvedAt } : {}),
    };
    this.t(tenantId).drift.set(id, updated);
    return clone(updated);
  }

  async getIdempotent(tenantId: string, key: string): Promise<IdempotentResponse | null> {
    return clone(this.t(tenantId).idempotency.get(key) ?? null);
  }
  async putIdempotent(tenantId: string, key: string, value: IdempotentResponse): Promise<void> {
    this.t(tenantId).idempotency.set(key, clone(value));
  }
}
