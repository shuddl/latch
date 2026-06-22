import { describe, it, expect } from 'vitest';
import { mapArtifactSchema } from '@latch/transform';
import { createVerifier, type GoldenCorpus } from './index';

const sample = (status: string, bol: string) =>
  'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260618*1305*U*00401*000000001*0*P*>~' +
  'GS*QM*SHIPPERID*CARRIERID*20260618*1305*1*X*004010~' +
  'ST*214*0001~' +
  'B10*4938294*0510938*SCAC~' +
  `L11*${bol}*BM~` +
  'LX*1~' +
  `AT7*${status}*NS***20260618*1300*LT~` +
  'MS1*MEMPHIS*TN*US~' +
  'SE*7*0001~' +
  'GE*1*1~' +
  'IEA*1*000000001~';

const MAP = mapArtifactSchema.parse({
  id: 'map_demo_214_inbound',
  transactionSet: '214',
  direction: 'inbound',
  canonicalVersion: '1',
  recordKind: 'StatusEvent',
  rules: [
    { kind: 'scalar', path: 'shipmentId', segment: 'B10', element: 2 },
    { kind: 'scalar', path: 'statusCode', segment: 'AT7', element: 1 },
    { kind: 'scalar', path: 'reasonCode', segment: 'AT7', element: 2 },
    { kind: 'datetime', path: 'occurredAt', segment: 'AT7', dateElement: 5, timeElement: 6 },
    { kind: 'references', path: 'references', segment: 'L11', valueElement: 1, qualifierElement: 2 },
    { kind: 'scalar', path: 'location.city', segment: 'MS1', element: 1 },
    { kind: 'scalar', path: 'location.state', segment: 'MS1', element: 2 },
    { kind: 'scalar', path: 'location.country', segment: 'MS1', element: 3 },
  ],
});

const CORPUS: GoldenCorpus = {
  requiredSegments: ['B10', 'AT7', 'MS1', 'L11'],
  requiredQualifiers: ['BM'],
  cases: [
    {
      id: 'valid-delivered',
      category: 'valid',
      edi: sample('X1', 'BOL12345'),
      expected: { shipmentId: '0510938', statusCode: 'X1' },
    },
    {
      id: 'valid-arrived',
      category: 'valid',
      edi: sample('AG', 'BOL99999'),
      expected: { shipmentId: '0510938', statusCode: 'AG' },
    },
    { id: 'adversarial-garbage', category: 'adversarial', edi: 'this is not EDI', expectError: true },
  ],
};

describe('verify — the Proof', () => {
  const verifier = createVerifier();

  it('certifies a correct map at the benchmark bar', () => {
    const result = verifier.certify(MAP, CORPUS);
    expect(result.requiredCoverage).toBe(1);
    expect(result.qualifierCoverage).toBe(1);
    expect(result.roundtripFidelity).toBeGreaterThanOrEqual(0.999);
    expect(result.adversarialOk).toBe(1);
    expect(result.semanticAccuracy).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.cases.find((c) => c.id === 'adversarial-garbage')?.passed).toBe(true);
  });

  it('fails a semantically wrong map even when round-trip is lossless (why B1 matters)', () => {
    // shipmentId reads B10-01 instead of B10-02. The inverse writes back to the same
    // element, so round-trip stays lossless — only the expected-canonical oracle catches it.
    const brokenMap = mapArtifactSchema.parse({
      ...MAP,
      rules: MAP.rules.map((r) =>
        r.kind === 'scalar' && r.path === 'shipmentId' ? { ...r, element: 1 } : r,
      ),
    });
    const result = verifier.certify(brokenMap, CORPUS);
    expect(result.roundtripFidelity).toBeGreaterThanOrEqual(0.999); // round-trip can't see it
    expect(result.semanticAccuracy).toBeLessThan(1); // the oracle does
    expect(result.passed).toBe(false);
  });
});
