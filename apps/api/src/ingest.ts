// Inbound orchestration: dedup by control numbers → deterministic processInbound →
// persist the transaction → (when the partner drifts) detect it, shadow re-certify,
// and open a self-heal event. Shared by the API `ingest` endpoint and the queue
// consumer, so live traffic and a manual push take the exact same path.

import { processInbound } from '@latch/pipeline';
import { createEdiCore } from '@latch/edi-core';
import { buildBaseline, decideHeal, detectDrift, driftCase, shadowReCertify } from '@latch/heal';
import type { MapArtifact } from '@latch/transform';
import type { Connection, DriftEvent, DriftStatus } from './domain';
import type { Store } from './store/store';
import { transactionSetDef } from './transaction-sets';
import { connectionCorpus, loadSamples } from './samples';

const edi = createEdiCore();

export interface IngestResult {
  transaction: Awaited<ReturnType<Store['createTransaction']>>;
  duplicate: boolean;
  ack: string;
  ackStatus: 'accepted' | 'rejected';
  drift?: DriftEvent;
}

const STATUS_FOR: Record<string, DriftStatus> = {
  auto_applied: 'auto_applied',
  awaiting_approval: 'awaiting_approval',
  hold: 'open',
};

// Detect drift vs the certified samples; if found, shadow re-certify and record a
// self-heal event with the policy decision. Deterministic; runs for any supported set.
async function detectAndRecordDrift(
  store: Store,
  tenantId: string,
  connection: Connection,
  artifact: MapArtifact,
  raw: string,
  txnId: string,
): Promise<DriftEvent | undefined> {
  const def = transactionSetDef(connection.transactionSet);
  if (!def) return undefined;
  const samples = await loadSamples(store, tenantId, connection.id);
  if (samples.length === 0) return undefined;

  // The baseline is built only from samples we KNOW parse.
  const parsed = samples.flatMap((s) => {
    const result = edi.parse(s.input);
    return result.ok ? [result.value] : [];
  });
  const live = edi.parse(raw);
  if (parsed.length === 0 || !live.ok) return undefined;

  const findings = detectDrift(buildBaseline(parsed), live.value);
  if (findings.length === 0) return undefined;

  // Shadow re-certify against the SAME corpus the map was certified on (every sample +
  // its confirmed expected output), plus the drift case.
  const shadow = shadowReCertify(artifact, connectionCorpus(def, samples), driftCase(`drift-${txnId}`, raw));
  const decision = decideHeal(findings, shadow);

  return store.createDriftEvent(tenantId, {
    connectionId: connection.id,
    detectedFromTxn: txnId,
    kind: findings[0]!.kind,
    detail: JSON.stringify({ findings, decision, shadowPassed: shadow.passed }),
    status: STATUS_FOR[decision] ?? 'open',
    ...(decision === 'auto_applied' ? { resolvedAt: Date.now() } : {}),
  });
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

  // Drift detection is best-effort: it must never fail the core transaction.
  let drift: DriftEvent | undefined;
  if (outcome.status === 'transformed') {
    try {
      drift = await detectAndRecordDrift(store, tenantId, connection, artifact, raw, transaction.id);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'drift detection failed (non-fatal)', error: String(err) }));
    }
  }

  return {
    transaction,
    duplicate: false,
    ack: outcome.ack,
    ackStatus: outcome.ackStatus,
    ...(drift ? { drift } : {}),
  };
}
