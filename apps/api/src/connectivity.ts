// Bridge: drain a partner transport adapter through the deterministic ingest pipeline.
// The same `ingestInbound` path used by the HTTP `ingest` endpoint and the queue consumer
// runs here, so an SFTP/AS2 drop, a manual push, and a queued message are byte-identical
// downstream (parse → transform → persist → 997 → drift). Transport is pluggable; the
// pipeline is the one provably-correct path.

import { drainInbound, type ConnectivityAdapter, type DrainResult } from '@latch/connectivity';
import { LatchError } from '@latch/shared';
import { ingestInbound } from './ingest';
import type { Connection } from './domain';
import type { Store } from './store/store';

/**
 * Poll `adapter` and ingest every inbound file for a live connection. Returns which files
 * were processed vs. left for retry. Requires the connection to be in production with an
 * active (certified) map — the same gate the HTTP ingest endpoint enforces.
 */
export async function ingestFromAdapter(
  store: Store,
  tenantId: string,
  connection: Connection,
  adapter: ConnectivityAdapter,
): Promise<DrainResult> {
  if (connection.status !== 'production' || !connection.activeMapId) {
    throw new LatchError('CONFLICT', 'Connection is not live; certify and go live first.');
  }
  const artifact = await store.getMapArtifact(tenantId, connection.activeMapId);
  if (!artifact) throw new LatchError('INTERNAL', 'Active map artifact missing');
  const mapId = connection.activeMapId;

  return drainInbound(adapter, async (file) => {
    const result = await ingestInbound(store, tenantId, connection, mapId, artifact, file.content);
    // Send the 997 back out the same transport, closing the loop (best-effort: a send
    // failure is reported via the file staying un-acked, so the partner re-sends).
    if (result.ack) await adapter.send({ name: `997-${file.name}`, content: result.ack });
  });
}
