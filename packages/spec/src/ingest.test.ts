import { describe, it, expect } from 'vitest';
import type { LlmClient } from '@latch/shared';
import { ingestSpec } from './index';

// A fake LlmClient returns canned structured output, so the ingestor's plumbing +
// Zod validation + confidence flagging are tested without a real model/key.
function fakeClient(payload: unknown): LlmClient {
  return { extractJson: async () => payload };
}

const SPEC_214 = {
  transactionSet: '214',
  x12Version: '004010',
  segments: [
    {
      tag: 'B10',
      required: true,
      elements: [
        { position: 2, name: 'Shipment ID', usage: 'required', confidence: 0.98 },
        { position: 3, name: 'SCAC', usage: 'optional', confidence: 0.9 },
      ],
    },
    {
      tag: 'AT7',
      required: true,
      elements: [
        { position: 1, name: 'Status code', usage: 'required', qualifierCodes: ['X1', 'AG', 'D1'], confidence: 0.95 },
        { position: 2, name: 'Reason code', usage: 'optional', confidence: 0.6 },
      ],
    },
  ],
  deviations: ['Guide marks AT7-02 optional, but every sample populates it'],
  confidence: 0.92,
};

describe('ingestSpec', () => {
  it('validates the model output into a Latch Spec and flags low-confidence fields', async () => {
    const { spec, lowConfidence } = await ingestSpec(fakeClient(SPEC_214), {
      transactionSet: '214',
      x12Version: '004010',
      samples: ['ISA*...~'],
    });
    expect(spec.transactionSet).toBe('214');
    expect(spec.segments.find((s) => s.tag === 'AT7')?.elements[0]?.qualifierCodes).toContain('X1');
    expect(spec.deviations.length).toBe(1);
    // AT7-02 confidence 0.6 < 0.75 → flagged.
    expect(lowConfidence).toContain('AT7-02 (Reason code)');
  });

  it('rejects invalid model output with a structured error', async () => {
    await expect(
      ingestSpec(fakeClient({ nonsense: true }), {
        transactionSet: '214',
        x12Version: '004010',
        samples: ['x'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('pins the caller-declared set/version over whatever the model says', async () => {
    const mislabeled = { ...SPEC_214, transactionSet: '999', x12Version: '005010' };
    const { spec } = await ingestSpec(fakeClient(mislabeled), {
      transactionSet: '214',
      x12Version: '004010',
      samples: ['x'],
    });
    expect(spec.transactionSet).toBe('214');
    expect(spec.x12Version).toBe('004010');
  });
});
