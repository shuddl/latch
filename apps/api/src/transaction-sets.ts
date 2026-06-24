// The transaction-set registry: the single place that ties a supported X12 transaction
// set to its canonical record kind, its hand-authored default map, and its golden-corpus
// builder. Adding a set is one entry here — the maps/generate-map/certify endpoints and
// the drift path all route through this table instead of scattering `=== '214'` checks.

import { MAP_214_STATUSEVENT, MAP_990_TENDERRESPONSE, type MapArtifact } from '@latch/transform';
import { buildCorpus214, buildCorpus990, type GoldenCorpus } from '@latch/verify';

export interface TransactionSetDef {
  /** Canonical record kind this set maps onto (the shared semantic hub). */
  recordKind: MapArtifact['recordKind'];
  /** Hand-authored map used as the default when no explicit/AI map is supplied. */
  defaultMap: MapArtifact;
  /** Build the golden corpus for certification from a known-parseable sample. */
  buildCorpus: (fixtureText: string) => GoldenCorpus;
}

export const TRANSACTION_SETS: Record<string, TransactionSetDef> = {
  '214': { recordKind: 'StatusEvent', defaultMap: MAP_214_STATUSEVENT, buildCorpus: buildCorpus214 },
  '990': { recordKind: 'TenderResponse', defaultMap: MAP_990_TENDERRESPONSE, buildCorpus: buildCorpus990 },
};

/** Lookup a supported transaction set, or `undefined` if Latch can't certify it yet. */
export function transactionSetDef(transactionSet: string): TransactionSetDef | undefined {
  // Own-property guard: `transactionSet` is connection-controlled and must not resolve
  // to an Object.prototype member (e.g. 'constructor') instead of a real registry entry.
  return Object.prototype.hasOwnProperty.call(TRANSACTION_SETS, transactionSet)
    ? TRANSACTION_SETS[transactionSet]
    : undefined;
}

/** Human-readable list of the currently supported sets, for error messages. */
export const SUPPORTED_TRANSACTION_SETS = Object.keys(TRANSACTION_SETS).join(', ');
