// The control-plane persistence boundary. Everything is tenant-scoped: the tenantId
// is the first argument of every method and the only way to reach a tenant's data, so
// isolation is enforced here, not sprinkled across handlers. Two implementations:
// InMemoryStore (tests/dev) and D1R2Store (production) — handlers depend only on this.

import type { MapArtifact } from '@latch/transform';
import type { CertificationResult } from '@latch/verify';
import type { CanonicalRecord } from '@latch/canonical';
import type {
  Certification,
  Connection,
  CreateConnectionData,
  CreatePartnerData,
  Direction,
  MapRecord,
  Partner,
  Transaction,
  TransactionStatus,
} from '../domain';

export type { CreatePartnerData, CreateConnectionData };

export interface CreateMapData {
  connectionId: string;
  transactionSet: string;
  direction: Direction;
  canonicalVersion: string;
  compiledHash: string;
  artifact: MapArtifact;
}

export interface CreateCertificationData {
  mapId: string;
  connectionId: string;
  result: CertificationResult;
}

export interface ControlNumbers {
  isa?: string;
  gs?: string;
  st?: string;
}

export interface CreateTransactionData {
  connectionId: string;
  mapId?: string;
  direction: Direction;
  transactionSet: string;
  controls: ControlNumbers;
  status: TransactionStatus;
  errorDetail?: string;
  ackStatus?: string;
  rawIn: string;
  canonical?: CanonicalRecord[];
  rawOut?: string;
}

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface Store {
  // Partners
  createPartner(tenantId: string, data: CreatePartnerData): Promise<Partner>;
  getPartner(tenantId: string, id: string): Promise<Partner | null>;
  listPartners(tenantId: string): Promise<Partner[]>;

  // Connections
  createConnection(tenantId: string, data: CreateConnectionData): Promise<Connection>;
  getConnection(tenantId: string, id: string): Promise<Connection | null>;
  listConnections(tenantId: string, filter?: { partnerId?: string; status?: string }): Promise<Connection[]>;
  updateConnection(
    tenantId: string,
    id: string,
    patch: Partial<Pick<Connection, 'status' | 'activeMapId' | 'connectivity'>>,
  ): Promise<Connection | null>;

  // Samples (raw EDI text the operator dropped in)
  addSamples(tenantId: string, connectionId: string, samples: string[]): Promise<number>;
  getSamples(tenantId: string, connectionId: string): Promise<string[]>;

  // Maps (record metadata + the declarative artifact blob)
  createMap(tenantId: string, data: CreateMapData): Promise<MapRecord>;
  getMap(tenantId: string, id: string): Promise<MapRecord | null>;
  getMapArtifact(tenantId: string, id: string): Promise<MapArtifact | null>;
  listMapsByConnection(tenantId: string, connectionId: string): Promise<MapRecord[]>;
  updateMap(
    tenantId: string,
    id: string,
    patch: Partial<Pick<MapRecord, 'status' | 'latestCertId'>>,
  ): Promise<MapRecord | null>;

  // Certifications (headline row + the full result blob for the report)
  createCertification(tenantId: string, data: CreateCertificationData): Promise<Certification>;
  getCertification(tenantId: string, id: string): Promise<Certification | null>;
  getCertificationResult(tenantId: string, id: string): Promise<CertificationResult | null>;

  // Transactions (live traffic; bodies as blobs)
  createTransaction(tenantId: string, data: CreateTransactionData): Promise<Transaction>;
  getTransaction(tenantId: string, id: string): Promise<Transaction | null>;
  listTransactions(tenantId: string, connectionId: string, limit?: number): Promise<Transaction[]>;
  findTransactionByControls(
    tenantId: string,
    connectionId: string,
    controls: ControlNumbers,
  ): Promise<Transaction | null>;
  getTransactionRawIn(tenantId: string, id: string): Promise<string | null>;
  getTransactionCanonical(tenantId: string, id: string): Promise<CanonicalRecord[] | null>;

  // Idempotency (mutating requests with an Idempotency-Key)
  getIdempotent(tenantId: string, key: string): Promise<IdempotentResponse | null>;
  putIdempotent(tenantId: string, key: string, value: IdempotentResponse): Promise<void>;
}

export type Clock = () => number;
