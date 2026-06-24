// Inbound orchestration: dedup by control numbers → deterministic processInbound →
// persist the transaction (raw in, canonical, 997 out). Shared by the API `ingest`
// endpoint (API/webhook transport) and the queue consumer, so live traffic and a
// manual push take the exact same path.

import { processInbound } from '@latch/pipeline';
import type { MapArtifact } from '@latch/transform';
import type { Connection } from './domain';
import type { Store } from './store/store';

export interface IngestResult {
  transaction: Awaited<ReturnType<Store['createTransaction']>>;
  duplicate: boolean;
  ack: string;
  ackStatus: 'accepted' | 'rejected';
}

export async function ingestInbound(
  store: Store,
  tenantId: string,
  connection: Connection,
  mapId: string,
  artifact: MapArtifact,
  raw: string,
): Promise<IngestResult> {
  const outcome = processInbound(raw, artifact);

  // Duplicate detection on control numbers (only when the interchange parsed and
  // carries an ISA control number — unparseable inputs have none to dedup on).
  if (outcome.controls.isa) {
    const existing = await store.findTransactionByControls(tenantId, connection.id, outcome.controls);
    if (existing) {
      return { transaction: existing, duplicate: true, ack: outcome.ack, ackStatus: outcome.ackStatus };
    }
  }

  const transaction = await store.createTransaction(tenantId, {
    connectionId: connection.id,
    mapId,
    direction: connection.direction,
    transactionSet: outcome.transactionSet,
    controls: outcome.controls,
    status: outcome.status,
    ...(outcome.error ? { errorDetail: outcome.error } : {}),
    ackStatus: outcome.ackStatus,
    rawIn: raw,
    ...(outcome.canonical ? { canonical: outcome.canonical } : {}),
    ...(outcome.ack ? { rawOut: outcome.ack } : {}),
  });

  return { transaction, duplicate: false, ack: outcome.ack, ackStatus: outcome.ackStatus };
}
