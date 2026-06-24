// Hand-authored 210 → canonical Invoice map (M3.1b). Exercises both repeating loops
// (charges) and qualifier-selected groups (bill-to party). Element semantics per the X12
// 004010 210 (Motor Carrier Freight Details and Invoice):
//   B3_02 = invoice number   B3_03 = shipment id   B3_07 = net amount due (total)
//   C3_01 = currency code
//   N1_01 = entity id code (BT = bill-to)   N1_02 = name   N1_03/04 = id qualifier / id
//   N3_01 = address line     N4_01..04 = city / state / postal / country
//   L1_04 = charge amount     L1_08 = special charge/allowance code   L1_12 = description
// Group/loop child addresses are RELATIVE to each window. Numeric fields use `cast`
// (forward-only; the source string rides in the snapshot for byte-faithful round-trip).

import { withCompiledHash, type MapArtifact } from '../map';

const map210Inbound: MapArtifact = {
  mapVersion: '210-invoice.v1',
  direction: 'inbound',
  transactionSet: '210',
  x12Version: '004010',
  canonicalVersion: '1',
  recordKind: 'Invoice',
  rules: [
    { kind: 'const', path: 'kind', value: 'Invoice' },
    { kind: 'const', path: 'canonicalVersion', value: '1' },
    { kind: 'element', path: 'invoiceNumber', source: { tag: 'B3', occurrence: 0, element: 2 } },
    { kind: 'element', path: 'shipmentId', source: { tag: 'B3', occurrence: 0, element: 3 } },
    { kind: 'element', path: 'total', source: { tag: 'B3', occurrence: 0, element: 7 }, cast: 'number' },
    { kind: 'element', path: 'currency', source: { tag: 'C3', occurrence: 0, element: 1 } },
    {
      kind: 'group',
      path: 'billTo',
      anchor: 'N1',
      match: { element: 1, equals: 'BT' },
      fields: [
        {
          kind: 'codemap',
          path: 'role',
          source: { tag: 'N1', occurrence: 0, element: 1 },
          table: { BT: 'billTo', SH: 'shipper', CN: 'consignee', CA: 'carrier' },
          onMiss: 'unset',
        },
        { kind: 'element', path: 'name', source: { tag: 'N1', occurrence: 0, element: 2 } },
        { kind: 'element', path: 'idQualifier', source: { tag: 'N1', occurrence: 0, element: 3 } },
        { kind: 'element', path: 'id', source: { tag: 'N1', occurrence: 0, element: 4 } },
        { kind: 'element', path: 'address.line1', source: { tag: 'N3', occurrence: 0, element: 1 } },
        { kind: 'element', path: 'address.city', source: { tag: 'N4', occurrence: 0, element: 1 } },
        { kind: 'element', path: 'address.state', source: { tag: 'N4', occurrence: 0, element: 2 } },
        { kind: 'element', path: 'address.postalCode', source: { tag: 'N4', occurrence: 0, element: 3 } },
        { kind: 'element', path: 'address.country', source: { tag: 'N4', occurrence: 0, element: 4 } },
      ],
    },
    {
      kind: 'loop',
      path: 'charges',
      anchor: 'L1',
      fields: [
        { kind: 'element', path: 'code', source: { tag: 'L1', occurrence: 0, element: 8 } },
        { kind: 'element', path: 'amount', source: { tag: 'L1', occurrence: 0, element: 4 }, cast: 'number' },
        { kind: 'element', path: 'description', source: { tag: 'L1', occurrence: 0, element: 12 } },
      ],
    },
  ],
};

/** The certified-shape 210 inbound map, with its deterministic content hash filled in. */
export const MAP_210_INVOICE: MapArtifact = withCompiledHash(map210Inbound);
