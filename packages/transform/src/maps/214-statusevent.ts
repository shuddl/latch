// Hand-authored 214 → canonical StatusEvent map (M1.3). This is a legitimate,
// human-authored MapArtifact (NOT LLM output) that lets the deterministic engine be
// fully unit-tested independently of the AI mapgen path. Element semantics are per the
// X12 004010 214 (Transportation Carrier Shipment Status):
//   B10_02 = shipper-assigned shipment id   B10_03 = SCAC
//   AT7_01 = status code  AT7_02 = reason code  AT7_05 = date  AT7_06 = time  AT7_07 = time qualifier
//   MS1_01 = city  MS1_02 = state  MS1_03 = country
// Addresses are relative to the transaction-set BODY (segments strictly between ST/SE).

import { withCompiledHash, type MapArtifact } from '../map';

const map214Inbound: MapArtifact = {
  mapVersion: '214-statusevent.v1',
  direction: 'inbound',
  transactionSet: '214',
  x12Version: '004010',
  canonicalVersion: '1',
  recordKind: 'StatusEvent',
  rules: [
    { kind: 'const', path: 'kind', value: 'StatusEvent' },
    { kind: 'const', path: 'canonicalVersion', value: '1' },
    { kind: 'element', path: 'shipmentId', source: { tag: 'B10', occurrence: 0, element: 2 } },
    { kind: 'element', path: 'statusCode', source: { tag: 'AT7', occurrence: 0, element: 1 } },
    { kind: 'element', path: 'reasonCode', source: { tag: 'AT7', occurrence: 0, element: 2 } },
    { kind: 'element', path: 'location.city', source: { tag: 'MS1', occurrence: 0, element: 1 } },
    { kind: 'element', path: 'location.state', source: { tag: 'MS1', occurrence: 0, element: 2 } },
    { kind: 'element', path: 'location.country', source: { tag: 'MS1', occurrence: 0, element: 3 } },
    {
      kind: 'derived',
      path: 'occurredAt',
      transform: 'dateTimeToIso',
      inputs: [
        { tag: 'AT7', occurrence: 0, element: 5 },
        { tag: 'AT7', occurrence: 0, element: 6 },
      ],
    },
  ],
};

/** The certified-shape 214 inbound map, with its deterministic content hash filled in. */
export const MAP_214_STATUSEVENT: MapArtifact = withCompiledHash(map214Inbound);
