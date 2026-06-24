// The Latch Spec: the machine-readable representation of a partner's EDI usage,
// derived from a companion guide + sample files (docs/03, docs/06). It is the
// build-time artifact the Map Generator targets and the drift detector baselines
// against. Zod is the contract; the model's output is validated against it.

import { z } from 'zod';

export const specUsageSchema = z.enum(['required', 'optional', 'situational']);

export const specElementSchema = z.object({
  position: z.number().int().min(1), // 1-based element position within the segment
  name: z.string(),
  usage: specUsageSchema,
  /** When this element carries a qualifier code set, the codes the partner uses. */
  qualifierCodes: z.array(z.string()).optional(),
  /** Per-field ingestor confidence [0,1]; low-confidence fields are surfaced, never hidden. */
  confidence: z.number().min(0).max(1).default(1),
});
export type SpecElement = z.infer<typeof specElementSchema>;

export const specSegmentSchema = z.object({
  tag: z.string(),
  name: z.string().optional(),
  required: z.boolean(),
  maxUse: z.number().int().positive().optional(),
  elements: z.array(specElementSchema),
});
export type SpecSegment = z.infer<typeof specSegmentSchema>;

export const latchSpecSchema = z.object({
  transactionSet: z.string(),
  x12Version: z.string(),
  segments: z.array(specSegmentSchema),
  /** Where the guide and the real sample files disagree — learned, not ignored (docs/03). */
  deviations: z.array(z.string()).default([]),
  /** Overall ingestor confidence [0,1]. */
  confidence: z.number().min(0).max(1).default(1),
});
export type LatchSpec = z.infer<typeof latchSpecSchema>;

/** Fields below this confidence are flagged for human review, never silently accepted. */
export const LOW_CONFIDENCE = 0.75;

export function lowConfidenceFields(spec: LatchSpec): string[] {
  const flagged: string[] = [];
  for (const seg of spec.segments) {
    for (const el of seg.elements) {
      if (el.confidence < LOW_CONFIDENCE) {
        flagged.push(`${seg.tag}-${String(el.position).padStart(2, '0')} (${el.name})`);
      }
    }
  }
  return flagged;
}
