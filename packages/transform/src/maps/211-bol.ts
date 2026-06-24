// Hand-authored 211 → canonical BOL map (M3.1b). Element semantics per the X12 004010
// 211 (Motor Carrier Bill of Lading), cross-verified against the standard (Stedi X12
// dictionary + implementation guides):
//   BOL_01 = carrier SCAC   BOL_03 = shipper-assigned Bill of Lading number
//   N1 loop: N1_01 = entity id code (SH shipper / CN consignee / BT bill-to),
//            N1_02 = name, N1_03 = id qualifier, N1_04 = id; N3_01 = street; N4_01..04 = city/state/postal/country
//   AT1 loop (lading line): AT2_01 = lading quantity (pieces), AT2_04 = weight, AT2_05 = weight unit (L/K),
//            AT2_06 = NMFC class; AT4_01 = commodity description
//   L11: L11_01 = reference value, L11_02 = reference qualifier (value-first, unlike N9/REF)
// Parties are qualifier-selected single objects (group); lading lines and references repeat (loop).

import { withCompiledHash, type MapArtifact } from '../map';
import type { ChildRule } from '../map';

// Each party (shipper/consignee/billTo) is the same N1/N3/N4 shape, differing only by the
// N1_01 qualifier the group selects on. Factor the child rules to keep the three identical.
const partyFields: ChildRule[] = [
  {
    kind: 'codemap',
    path: 'role',
    source: { tag: 'N1', occurrence: 0, element: 1 },
    table: { SH: 'shipper', CN: 'consignee', BT: 'billTo', CA: 'carrier', BR: 'broker' },
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
];

const map211Inbound: MapArtifact = {
  mapVersion: '211-bol.v1',
  direction: 'inbound',
  transactionSet: '211',
  x12Version: '004010',
  canonicalVersion: '1',
  recordKind: 'BOL',
  rules: [
    { kind: 'const', path: 'kind', value: 'BOL' },
    { kind: 'const', path: 'canonicalVersion', value: '1' },
    { kind: 'element', path: 'bolNumber', source: { tag: 'BOL', occurrence: 0, element: 3 } },
    { kind: 'group', path: 'shipper', anchor: 'N1', match: { element: 1, equals: 'SH' }, fields: partyFields },
    { kind: 'group', path: 'consignee', anchor: 'N1', match: { element: 1, equals: 'CN' }, fields: partyFields },
    { kind: 'group', path: 'billTo', anchor: 'N1', match: { element: 1, equals: 'BT' }, fields: partyFields },
    {
      kind: 'loop',
      path: 'freight',
      anchor: 'AT1',
      fields: [
        { kind: 'element', path: 'pieces', source: { tag: 'AT2', occurrence: 0, element: 1 }, cast: 'number' },
        { kind: 'element', path: 'weight', source: { tag: 'AT2', occurrence: 0, element: 4 }, cast: 'number' },
        { kind: 'element', path: 'weightUom', source: { tag: 'AT2', occurrence: 0, element: 5 } },
        { kind: 'element', path: 'class', source: { tag: 'AT2', occurrence: 0, element: 6 } },
        { kind: 'element', path: 'commodity', source: { tag: 'AT4', occurrence: 0, element: 1 } },
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

/** The certified-shape 211 inbound map, with its deterministic content hash filled in. */
export const MAP_211_BOL: MapArtifact = withCompiledHash(map211Inbound);
