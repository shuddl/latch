// Hand-authored 204 → canonical Tender map (M3.1b). A legitimate human-authored
// MapArtifact (NOT LLM output) that exercises the engine's repeating-loop support for a
// real freight set. Element semantics per the X12 004010 204 (Motor Carrier Load Tender):
//   B2_02  = SCAC                         B2_04  = shipment identification number
//   B2A_01 = purpose (00 original, 01 cancel, 04 change/replace)
//   L11_01 = reference value              L11_02 = reference qualifier
//   S5_01  = stop sequence number         S5_02  = stop reason (CL/LD load → pickup, CU/UL unload → delivery)
//   N1_01  = entity id code (SH/CN/BT…)   N1_02 = name   N1_03 = id qualifier   N1_04 = id
//   N3_01  = address line                 N4_01..04 = city / state / postal / country
//   AT8_02 = weight unit (L/K)            AT8_03 = weight   AT8_04 = lading quantity (pieces)
// Loop/child addresses are RELATIVE to each loop window (occurrence restarts per window).

import { withCompiledHash, type MapArtifact } from '../map';

const map204Inbound: MapArtifact = {
  mapVersion: '204-tender.v1',
  direction: 'inbound',
  transactionSet: '204',
  x12Version: '004010',
  canonicalVersion: '1',
  recordKind: 'Tender',
  rules: [
    { kind: 'const', path: 'kind', value: 'Tender' },
    { kind: 'const', path: 'canonicalVersion', value: '1' },
    { kind: 'element', path: 'shipmentId', source: { tag: 'B2', occurrence: 0, element: 4 } },
    { kind: 'element', path: 'scac', source: { tag: 'B2', occurrence: 0, element: 2 } },
    {
      kind: 'codemap',
      path: 'purpose',
      source: { tag: 'B2A', occurrence: 0, element: 1 },
      table: { '00': 'original', '01': 'cancel', '04': 'replace' },
      onMiss: 'unset',
    },
    {
      kind: 'loop',
      path: 'stops',
      anchor: 'S5',
      fields: [
        { kind: 'element', path: 'sequence', source: { tag: 'S5', occurrence: 0, element: 1 }, cast: 'number' },
        {
          kind: 'codemap',
          path: 'type',
          source: { tag: 'S5', occurrence: 0, element: 2 },
          table: { CL: 'pickup', LD: 'pickup', PL: 'pickup', CU: 'delivery', UL: 'delivery', PU: 'delivery' },
          onMiss: 'unset',
        },
        {
          kind: 'codemap',
          path: 'party.role',
          source: { tag: 'N1', occurrence: 0, element: 1 },
          table: { SH: 'shipper', CN: 'consignee', BT: 'billTo', CA: 'carrier', BR: 'broker' },
          onMiss: 'unset',
        },
        { kind: 'element', path: 'party.name', source: { tag: 'N1', occurrence: 0, element: 2 } },
        { kind: 'element', path: 'party.idQualifier', source: { tag: 'N1', occurrence: 0, element: 3 } },
        { kind: 'element', path: 'party.id', source: { tag: 'N1', occurrence: 0, element: 4 } },
        { kind: 'element', path: 'party.address.line1', source: { tag: 'N3', occurrence: 0, element: 1 } },
        { kind: 'element', path: 'party.address.city', source: { tag: 'N4', occurrence: 0, element: 1 } },
        { kind: 'element', path: 'party.address.state', source: { tag: 'N4', occurrence: 0, element: 2 } },
        { kind: 'element', path: 'party.address.postalCode', source: { tag: 'N4', occurrence: 0, element: 3 } },
        { kind: 'element', path: 'party.address.country', source: { tag: 'N4', occurrence: 0, element: 4 } },
      ],
    },
    {
      kind: 'loop',
      path: 'freight',
      anchor: 'AT8',
      fields: [
        { kind: 'element', path: 'weight', source: { tag: 'AT8', occurrence: 0, element: 3 }, cast: 'number' },
        { kind: 'element', path: 'weightUom', source: { tag: 'AT8', occurrence: 0, element: 2 } },
        { kind: 'element', path: 'pieces', source: { tag: 'AT8', occurrence: 0, element: 4 }, cast: 'number' },
      ],
    },
    {
      kind: 'loop',
      path: 'references',
      anchor: 'L11',
      fields: [
        { kind: 'element', path: 'value', source: { tag: 'L11', occurrence: 0, element: 1 } },
        { kind: 'element', path: 'qualifier', source: { tag: 'L11', occurrence: 0, element: 2 } },
      ],
    },
  ],
};

/** The certified-shape 204 inbound map, with its deterministic content hash filled in. */
export const MAP_204_TENDER: MapArtifact = withCompiledHash(map204Inbound);
