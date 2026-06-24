// Hand-authored 204 golden corpus (M3.1b). The real sample fixture is the ground-truth
// anchor (forward oracle); synthetic records extend loop-shape, qualifier, and boundary
// coverage and exercise adversarial graceful-rejection. All values are realistic per the
// X12 004010 204 (Motor Carrier Load Tender). NOT LLM-generated — deterministic inputs.

import { tenderSchema, type CanonicalRecord } from '@latch/canonical';
import type { GoldenCorpus, GoldenRecord } from '../types';

const ISA =
  'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260620*0900*U*00401*000000010*0*P*>~';
const GS = 'GS*SM*SHIPPERID*CARRIERID*20260620*0900*10*X*004010~';
const GE_IEA = 'GE*1*10~IEA*1*000000010~';

/** Wrap a transaction-set body (ST…SE inclusive) in the shared interchange envelope. */
const wrap = (body: string): string => ISA + GS + body + GE_IEA;

// Synthetic: a single-stop cancel tender — exercises loop shape ×1, B2A purpose '01',
// and keeps the interchange internally consistent for a byte-faithful round-trip.
const REC_CANCEL_1STOP = wrap(
  'ST*204*0002~B2**SCAC**SHIPXYZ999**PP~B2A*01~L11*CANCELME*OW~S5*1*CL~' +
    'N1*SH*GAMMA CORP*93*GAM01~N3*5 FIR LN~N4*RENO*NV*89501*US~AT8*G*L*8000*20~SE*10*0002~',
);

// Adversarial: not X12 at all.
const ADV_NOT_EDI = 'this is definitely not an EDI interchange';
// Adversarial: truncated ISA (shorter than the fixed 106-char header).
const ADV_TRUNCATED_ISA = 'ISA*00*too short~GS*SM~ST*204*0001~SE*2*0001~';
// Adversarial: a well-formed interchange whose SE segment count is wrong.
const ADV_SE_MISMATCH = wrap('ST*204*0009~B2**SCAC**SHIP9*PP~B2A*00~S5*1*CL~N1*SH*X*93*Y~SE*99*0009~');

/**
 * Build the 204 corpus. `fixtureText` is the real anonymized sample (fixtures/204),
 * passed in so the corpus is tied to the on-disk fixture used by CI.
 */
export function buildCorpus204(fixtureText: string): GoldenCorpus {
  const fixtureExpected: CanonicalRecord[] = [
    tenderSchema.parse({
      kind: 'Tender',
      canonicalVersion: '1',
      shipmentId: 'SHIPABC123',
      scac: 'SCAC',
      purpose: 'original',
      stops: [
        {
          sequence: 1,
          type: 'pickup',
          party: {
            role: 'shipper',
            name: 'ACME SHIPPING CO',
            idQualifier: '93',
            id: 'ACME01',
            address: { line1: '100 MAIN ST', city: 'CHICAGO', state: 'IL', postalCode: '60601', country: 'US' },
          },
        },
        {
          sequence: 2,
          type: 'delivery',
          party: {
            role: 'consignee',
            name: 'BETA RECEIVING',
            idQualifier: '93',
            id: 'BETA01',
            address: { line1: '200 OAK AVE', city: 'DALLAS', state: 'TX', postalCode: '75201', country: 'US' },
          },
        },
      ],
      freight: [
        { weight: 15000, weightUom: 'L', pieces: 40 },
        { weight: 15000, weightUom: 'L', pieces: 40 },
      ],
      references: [{ qualifier: 'OW', value: 'ORDER789' }],
    }),
  ];

  const records: GoldenRecord[] = [
    { name: 'fixture-204-001 (real, 2-stop original)', category: 'valid', input: fixtureText, expectedCanonical: fixtureExpected },
    { name: 'synthetic 1-stop cancel', category: 'loop', input: REC_CANCEL_1STOP },
    { name: 'adversarial: not EDI', category: 'adversarial', input: ADV_NOT_EDI, expectGraceful: true },
    { name: 'adversarial: truncated ISA', category: 'adversarial', input: ADV_TRUNCATED_ISA, expectGraceful: true },
    { name: 'adversarial: SE count mismatch', category: 'adversarial', input: ADV_SE_MISMATCH, expectGraceful: true },
  ];

  return {
    transactionSet: '204',
    records,
    coverage: {
      requiredSegments: ['B2', 'B2A', 'S5', 'N1', 'N4', 'AT8', 'L11'],
      qualifiers: [
        { tag: 'B2A', element: 1, codes: ['00', '01'] },
        { tag: 'S5', element: 2, codes: ['CL', 'CU'] },
        { tag: 'N1', element: 1, codes: ['SH', 'CN'] },
      ],
      loops: { schema: [{ name: 'S5', start: 'S5', terminators: ['SE'] }], shapes: [1, 2] },
    },
  };
}
