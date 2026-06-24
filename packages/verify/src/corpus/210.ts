// Hand-authored 210 golden corpus (M3.1b). The real sample fixture is the ground-truth
// anchor (forward oracle); synthetic records extend charge-loop and boundary coverage and
// exercise adversarial graceful-rejection. Realistic per the X12 004010 210 (Motor Carrier
// Freight Details and Invoice). NOT LLM-generated — deterministic inputs.

import { invoiceSchema, type CanonicalRecord } from '@latch/canonical';
import type { GoldenCorpus, GoldenRecord } from '../types';

const ISA =
  'ISA*00*          *00*          *ZZ*CARRIERID      *ZZ*SHIPPERID      *260622*1750*U*00401*000000020*0*P*>~';
const GS = 'GS*IM*CARRIERID*SHIPPERID*20260622*1750*20*X*004010~';
const GE_IEA = 'GE*1*20~IEA*1*000000020~';

/** Wrap a transaction-set body (ST…SE inclusive) in the shared interchange envelope. */
const wrap = (body: string): string => ISA + GS + body + GE_IEA;

// Boundary: a single-charge invoice — exercises charge-loop shape ×1.
const REC_ONE_CHARGE = wrap(
  'ST*210*0002~B3**INV55002*SHIP44002*PP**20260622*500.00***SCAC~C3*USD~' +
    'N1*BT*SOLO PAYER*93*SOLO1~N3*1 WAY~N4*RENO*NV*89501*US~L1*1**FR*500.00****400~SE*8*0002~',
);

// Adversarial: not X12 at all.
const ADV_NOT_EDI = 'this is definitely not an EDI interchange';
// Adversarial: truncated ISA (shorter than the fixed 106-char header).
const ADV_TRUNCATED_ISA = 'ISA*00*too short~GS*IM~ST*210*0001~SE*2*0001~';
// Adversarial: a well-formed interchange whose SE segment count is wrong.
const ADV_SE_MISMATCH = wrap('ST*210*0009~B3**INV9*SHIP9*PP**20260622*1.00***SCAC~N1*BT*X*93*Y~L1*1**FR*1.00****400~SE*99*0009~');

/**
 * Build the 210 corpus. `fixtureText` is the real anonymized sample (fixtures/210),
 * passed in so the corpus is tied to the on-disk fixture used by CI.
 */
export function buildCorpus210(fixtureText: string): GoldenCorpus {
  const fixtureExpected: CanonicalRecord[] = [
    invoiceSchema.parse({
      kind: 'Invoice',
      canonicalVersion: '1',
      invoiceNumber: 'INV55001',
      shipmentId: 'SHIP44001',
      total: 1750.5,
      currency: 'USD',
      billTo: {
        role: 'billTo',
        name: 'PAYER LOGISTICS',
        idQualifier: '93',
        id: 'PAY01',
        address: { line1: '900 DOCK RD', city: 'MEMPHIS', state: 'TN', postalCode: '38101', country: 'US' },
      },
      charges: [
        { code: '400', amount: 1500 },
        { code: 'FUE', amount: 250.5 },
      ],
    }),
  ];

  const records: GoldenRecord[] = [
    { name: 'fixture-210-001 (real, 2-charge invoice)', category: 'valid', input: fixtureText, expectedCanonical: fixtureExpected },
    { name: 'synthetic 1-charge invoice', category: 'loop', input: REC_ONE_CHARGE },
    { name: 'adversarial: not EDI', category: 'adversarial', input: ADV_NOT_EDI, expectGraceful: true },
    { name: 'adversarial: truncated ISA', category: 'adversarial', input: ADV_TRUNCATED_ISA, expectGraceful: true },
    { name: 'adversarial: SE count mismatch', category: 'adversarial', input: ADV_SE_MISMATCH, expectGraceful: true },
  ];

  return {
    transactionSet: '210',
    records,
    coverage: {
      requiredSegments: ['B3', 'C3', 'N1', 'N4', 'L1'],
      qualifiers: [{ tag: 'N1', element: 1, codes: ['BT'] }],
      loops: { schema: [{ name: 'L1', start: 'L1', terminators: ['SE'] }], shapes: [1, 2] },
    },
  };
}
