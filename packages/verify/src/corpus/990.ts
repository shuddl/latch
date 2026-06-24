// Hand-authored 990 golden corpus (M3.1). The real sample fixture is the ground-truth
// anchor (forward oracle); synthetic records extend qualifier/boundary coverage and
// exercise adversarial graceful-rejection. All values are realistic per the X12 004010
// 990 (Response to a Load Tender). NOT LLM-generated — deterministic test inputs.

import { tenderResponseSchema, type CanonicalRecord } from '@latch/canonical';
import type { GoldenCorpus, GoldenRecord } from '../types';

const ISA =
  'ISA*00*          *00*          *ZZ*CARRIERID      *ZZ*SHIPPERID      *260618*1310*U*00401*000000002*0*P*>~';
const GS = 'GS*GF*CARRIERID*SHIPPERID*20260618*1310*2*X*004010~';
const GE_IEA = 'GE*1*2~IEA*1*000000002~';

/** Wrap a transaction-set body (ST…SE inclusive) in the shared interchange envelope. */
const wrap = (body: string): string => ISA + GS + body + GE_IEA;

// Synthetic: declined (D) tender with a free-text remark — exercises the B1_04=D
// qualifier and the optional K1 reason element.
const REC_DECLINE = wrap('ST*990*0002~B1*SCAC*SHIP78002*20260618*D~K1*NO CAPACITY ON LANE~SE*4*0002~');

// Boundary: minimal valid 990 — B1 only, accepted, no remarks.
const REC_MINIMAL = wrap('ST*990*0003~B1*SCAC*SHIP78003*20260618*A~SE*3*0003~');

// Adversarial: not X12 at all.
const ADV_NOT_EDI = 'this is definitely not an EDI interchange';
// Adversarial: truncated ISA (shorter than the fixed 106-char header).
const ADV_TRUNCATED_ISA = 'ISA*00*too short~GS*GF~ST*990*0001~SE*2*0001~';
// Adversarial: a well-formed interchange whose SE segment count is wrong.
const ADV_SE_MISMATCH = wrap('ST*990*0009~B1*SCAC*SHIP78009*20260618*A~SE*99*0009~');

/**
 * Build the 990 corpus. `fixtureText` is the real anonymized sample (fixtures/990),
 * passed in so the corpus is tied to the on-disk fixture used by CI.
 */
export function buildCorpus990(fixtureText: string): GoldenCorpus {
  const fixtureExpected: CanonicalRecord[] = [
    tenderResponseSchema.parse({
      kind: 'TenderResponse',
      canonicalVersion: '1',
      shipmentId: 'SHIP78001',
      decision: 'accept',
    }),
  ];
  const declineExpected: CanonicalRecord[] = [
    tenderResponseSchema.parse({
      kind: 'TenderResponse',
      canonicalVersion: '1',
      shipmentId: 'SHIP78002',
      decision: 'decline',
      reason: 'NO CAPACITY ON LANE',
    }),
  ];

  const records: GoldenRecord[] = [
    { name: 'fixture-990-001 (real, accepted A)', category: 'valid', input: fixtureText, expectedCanonical: fixtureExpected },
    { name: 'synthetic declined (D) with reason', category: 'qualifier', input: REC_DECLINE, expectedCanonical: declineExpected },
    { name: 'minimal valid 990', category: 'boundary', input: REC_MINIMAL },
    { name: 'adversarial: not EDI', category: 'adversarial', input: ADV_NOT_EDI, expectGraceful: true },
    { name: 'adversarial: truncated ISA', category: 'adversarial', input: ADV_TRUNCATED_ISA, expectGraceful: true },
    { name: 'adversarial: SE count mismatch', category: 'adversarial', input: ADV_SE_MISMATCH, expectGraceful: true },
  ];

  return {
    transactionSet: '990',
    records,
    coverage: {
      requiredSegments: ['B1'],
      qualifiers: [{ tag: 'B1', element: 4, codes: ['A', 'D'] }],
      // 990 carries no required repeating loop in the canonical TenderResponse.
      loops: { schema: [], shapes: [] },
    },
  };
}
