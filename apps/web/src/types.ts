// API response shapes the UI renders. CertificationResult is the engine's own type —
// the report renders exactly what the Proof produced, no reinterpretation.

import type { CertificationResult } from '@latch/verify';

export type { CertificationResult };

export interface Partner {
  id: string;
  name: string;
  scac?: string;
}

export type ConnectionStatus = 'draft' | 'certified' | 'production' | 'paused' | 'retired';

export interface Connection {
  id: string;
  partnerId: string;
  direction: 'inbound' | 'outbound';
  transactionSet: string;
  x12Version: string;
  status: ConnectionStatus;
  activeMapId?: string;
}

export interface MapRecord {
  id: string;
  connectionId: string;
  transactionSet: string;
  status: 'draft' | 'certified' | 'production' | 'retired';
  latestCertId?: string;
}

export interface Certification {
  id: string;
  mapId: string;
  connectionId: string;
  passed: boolean;
  requiredCoverage: number;
  qualifierCoverage: number;
  loopCoverage: number;
  roundtripFidelity: number;
  adversarialOk: number;
  deviationHandling: number;
  shortfalls: string[];
  mapHash: string;
  corpusHash: string;
  createdAt: number;
}

export interface CertificationReportData {
  certification: Certification;
  result: CertificationResult | null;
}

export type TransactionStatus = 'received' | 'transformed' | 'delivered' | 'ack_sent' | 'error';

export interface Transaction {
  id: string;
  connectionId: string;
  direction: 'inbound' | 'outbound';
  transactionSet: string;
  status: TransactionStatus;
  ackStatus?: string;
  isaControl?: string;
  gsControl?: string;
  stControl?: string;
  errorDetail?: string;
  receivedAt: number;
  processedAt?: number;
}
