// Hand-authored 214 golden corpus (M1.4). The real sample fixture is the ground-truth
// anchor (forward oracle); the synthetic records extend qualifier/loop/boundary coverage
// and exercise adversarial graceful-rejection. All values are realistic per the X12
// 004010 214. NOT LLM-generated — these are deterministic test inputs.

import { statusEventSchema, type CanonicalRecord } from '@latch/canonical';
import type { GoldenCorpus, GoldenRecord } from '../types';

const ISA =
  'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260618*1305*U*00401*000000001*0*P*>~';
const GS = 'GS*QM*SHIPPERID*CARRIERID*20260618*1305*1*X*004010~';
const GE_IEA = 'GE*1*1~IEA*1*000000001~';

/** Wrap a transaction-set body (ST…SE inclusive) in the shared interchange envelope. */
const wrap = (body: string): string => ISA + GS + body + GE_IEA;

// Synthetic: carrier departed (AF) — exercises a second status qualifier + a new location.
const REC_AF = wrap(
  'ST*214*0002~B10*5001*PRO222*SCAC~LX*1~AT7*AF*NS***20260619*0800*LT~MS1*DALLAS*TX*US~SE*6*0002~',
);

// Synthetic: delivered (D1) with TWO LX status loops — exercises loop shape ×2.
const REC_D1_TWO_LOOPS = wrap(
  'ST*214*0003~B10*5002*PRO333*SCAC~LX*1~AT7*X3*NS***20260620*0700*LT~LX*2~AT7*D1*NS***20260620*1500*LT~MS1*ATLANTA*GA*US~SE*8*0003~',
);

// Boundary: minimal valid 214 — no optional MS1/L11 segments.
const REC_MINIMAL = wrap('ST*214*0004~B10*6001*MIN1*SCAC~LX*1~AT7*X1*NS***20260621*0900*LT~SE*5*0004~');

// Adversarial: not X12 at all.
const ADV_NOT_EDI = 'this is definitely not an EDI interchange';
// Adversarial: truncated ISA (shorter than the fixed 106-char header).
const ADV_TRUNCATED_ISA = 'ISA*00*too short~GS*QM~ST*214*0001~SE*2*0001~';
// Adversarial: a well-formed interchange whose SE segment count is wrong.
const ADV_SE_MISMATCH = wrap(
  'ST*214*0009~B10*4938294*0510938*SCAC~L11*BOL12345*BM~LX*1~AT7*X1*NS***20260618*1300*LT~MS1*MEMPHIS*TN*US~SE*99*0009~',
);

/**
 * Build the 214 corpus. `fixtureText` is the real anonymized sample (fixtures/214),
 * passed in so the corpus is tied to the on-disk fixture used by CI.
 */
export function buildCorpus214(fixtureText: string): GoldenCorpus {
  const fixtureExpected: CanonicalRecord[] = [
    statusEventSchema.parse({
      kind: 'StatusEvent',
      canonicalVersion: '1',
      shipmentId: '0510938',
      statusCode: 'X1',
      reasonCode: 'NS',
      occurredAt: '2026-06-18T13:00:00',
      location: { city: 'MEMPHIS', state: 'TN', country: 'US' },
    }),
  ];

  const records: GoldenRecord[] = [
    { name: 'fixture-214-001 (real, arrived X1)', category: 'valid', input: fixtureText, expectedCanonical: fixtureExpected },
    { name: 'synthetic departed (AF)', category: 'qualifier', input: REC_AF },
    { name: 'synthetic delivered (D1), two LX loops', category: 'loop', input: REC_D1_TWO_LOOPS },
    { name: 'minimal valid 214', category: 'boundary', input: REC_MINIMAL },
    { name: 'adversarial: not EDI', category: 'adversarial', input: ADV_NOT_EDI, expectGraceful: true },
    { name: 'adversarial: truncated ISA', category: 'adversarial', input: ADV_TRUNCATED_ISA, expectGraceful: true },
    { name: 'adversarial: SE count mismatch', category: 'adversarial', input: ADV_SE_MISMATCH, expectGraceful: true },
  ];

  return {
    transactionSet: '214',
    records,
    coverage: {
      requiredSegments: ['B10', 'LX', 'AT7'],
      qualifiers: [{ tag: 'AT7', element: 1, codes: ['X1', 'AF', 'D1'] }],
      loops: { schema: [{ name: 'LX', start: 'LX', terminators: ['SE'] }], shapes: [1, 2] },
    },
  };
}
