// Hand-authored 211 golden corpus (M3.1b). The real sample fixture is the ground-truth
// anchor (forward oracle); the synthetic record drops the optional bill-to (exercising the
// "absent group stays unset" oracle path) and carries two lading lines (freight loop ×2).
// Realistic per the X12 004010 211 (Motor Carrier Bill of Lading). NOT LLM-generated.

import { bolSchema, type CanonicalRecord } from '@latch/canonical';
import type { GoldenCorpus, GoldenRecord } from '../types';

const ISA =
  'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260623*1430*U*00401*000000030*0*P*>~';
const GS = 'GS*BL*SHIPPERID*CARRIERID*20260623*1430*30*X*004010~';
const GE_IEA = 'GE*1*30~IEA*1*000000030~';

/** Wrap a transaction-set body (ST…SE inclusive) in the shared interchange envelope. */
const wrap = (body: string): string => ISA + GS + body + GE_IEA;

// Synthetic: no bill-to party (optional group absent → must stay unset), two lading lines
// (freight loop shape ×2). Internally consistent (SE count = 16).
const REC_NO_BILLTO_TWO_LINES = wrap(
  'ST*211*0002~BOL*SCAC*PP*BOL77002*20260623*1500~L11*BOL77002*BM~' +
    'N1*SH*GAMMA SHIP*93*GAM01~N3*5 FIR LN~N4*RENO*NV*89501*US~' +
    'N1*CN*DELTA RECV*93*DEL01~N3*6 ELM ST~N4*BOISE*ID*83701*US~' +
    'AT1*1~AT2*10*PLT*G*5000*L*70~AT4*WIDGETS~AT1*2~AT2*20*PLT*G*8000*L*85~AT4*GADGETS~SE*16*0002~',
);

// Adversarial: not X12 at all.
const ADV_NOT_EDI = 'this is definitely not an EDI interchange';
// Adversarial: truncated ISA (shorter than the fixed 106-char header).
const ADV_TRUNCATED_ISA = 'ISA*00*too short~GS*BL~ST*211*0001~SE*2*0001~';
// Adversarial: a well-formed interchange whose SE segment count is wrong.
const ADV_SE_MISMATCH = wrap(
  'ST*211*0009~BOL*SCAC*PP*BOL9*20260623*1430~N1*SH*X*93*Y~N3*Z~N4*A*B*C*US~N1*CN*W*93*V~N3*U~N4*T*S*R*US~AT1*1~AT2*1*PLT*G*1*L*70~SE*99*0009~',
);

/**
 * Build the 211 corpus. `fixtureText` is the real anonymized sample (fixtures/211),
 * passed in so the corpus is tied to the on-disk fixture used by CI.
 */
export function buildCorpus211(fixtureText: string): GoldenCorpus {
  const fixtureExpected: CanonicalRecord[] = [
    bolSchema.parse({
      kind: 'BOL',
      canonicalVersion: '1',
      bolNumber: 'BOL77001',
      shipper: {
        role: 'shipper',
        name: 'ACME SHIPPING CO',
        idQualifier: '93',
        id: 'ACME01',
        address: { line1: '100 MAIN ST', city: 'CHICAGO', state: 'IL', postalCode: '60601', country: 'US' },
      },
      consignee: {
        role: 'consignee',
        name: 'BETA RECEIVING',
        idQualifier: '93',
        id: 'BETA01',
        address: { line1: '200 OAK AVE', city: 'DALLAS', state: 'TX', postalCode: '75201', country: 'US' },
      },
      billTo: {
        role: 'billTo',
        name: 'PAYER LOGISTICS',
        idQualifier: '93',
        id: 'PAY01',
        address: { line1: '900 DOCK RD', city: 'MEMPHIS', state: 'TN', postalCode: '38101', country: 'US' },
      },
      freight: [{ pieces: 40, weight: 15000, weightUom: 'L', class: '70', commodity: 'PALLETIZED CONSUMER GOODS' }],
      references: [
        { qualifier: 'BM', value: 'BOL77001' },
        { qualifier: 'PO', value: 'PO99001' },
      ],
    }),
  ];

  const records: GoldenRecord[] = [
    { name: 'fixture-211-001 (real, SH+CN+BT, 1 line)', category: 'valid', input: fixtureText, expectedCanonical: fixtureExpected },
    { name: 'synthetic no-billTo, 2 lading lines', category: 'loop', input: REC_NO_BILLTO_TWO_LINES },
    { name: 'adversarial: not EDI', category: 'adversarial', input: ADV_NOT_EDI, expectGraceful: true },
    { name: 'adversarial: truncated ISA', category: 'adversarial', input: ADV_TRUNCATED_ISA, expectGraceful: true },
    { name: 'adversarial: SE count mismatch', category: 'adversarial', input: ADV_SE_MISMATCH, expectGraceful: true },
  ];

  return {
    transactionSet: '211',
    records,
    coverage: {
      requiredSegments: ['BOL', 'N1', 'N3', 'N4', 'AT1', 'AT2', 'L11'],
      qualifiers: [{ tag: 'N1', element: 1, codes: ['SH', 'CN', 'BT'] }],
      loops: { schema: [{ name: 'AT1', start: 'AT1', terminators: ['SE'] }], shapes: [1, 2] },
    },
  };
}
