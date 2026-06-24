// Hand-authored 990 → canonical TenderResponse map (M3.1). A legitimate human-authored
// MapArtifact (NOT LLM output) so the deterministic engine is unit-testable for a second
// transaction set independently of the AI mapgen path. Element semantics per the X12
// 004010 990 (Response to a Load Tender):
//   B1_02 = shipment identification number   B1_04 = reservation action code
//     reservation action: 'A' = reserved (accept), 'D' = decline
//   K1_01 = remarks (carrier's free-text decline reason, when present)
// Addresses are relative to the transaction-set BODY (segments strictly between ST/SE).

import { withCompiledHash, type MapArtifact } from '../map';

const map990Inbound: MapArtifact = {
  mapVersion: '990-tenderresponse.v1',
  direction: 'inbound',
  transactionSet: '990',
  x12Version: '004010',
  canonicalVersion: '1',
  recordKind: 'TenderResponse',
  rules: [
    { kind: 'const', path: 'kind', value: 'TenderResponse' },
    { kind: 'const', path: 'canonicalVersion', value: '1' },
    { kind: 'element', path: 'shipmentId', source: { tag: 'B1', occurrence: 0, element: 2 } },
    {
      kind: 'codemap',
      path: 'decision',
      source: { tag: 'B1', occurrence: 0, element: 4 },
      table: { A: 'accept', D: 'decline' },
      onMiss: 'unset',
    },
    { kind: 'element', path: 'reason', source: { tag: 'K1', occurrence: 0, element: 1 } },
  ],
};

/** The certified-shape 990 inbound map, with its deterministic content hash filled in. */
export const MAP_990_TENDERRESPONSE: MapArtifact = withCompiledHash(map990Inbound);
