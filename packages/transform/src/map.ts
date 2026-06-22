// packages/transform — map representation (docs/04: "a versioned, declarative
// transform spec (data) + a deterministic interpreter"). Rules are data so they are
// easy to diff, certify, patch (self-heal) and attest. mapgen (M1.2) produces these;
// this package executes them deterministically with NO LLM in the path.

import { z } from 'zod';

// Each rule binds one canonical location to one EDI location. Element indexes are
// 1-based positions after the segment tag (B10-02 → segment 'B10', element 2).
export const scalarRuleSchema = z.object({
  kind: z.literal('scalar'),
  path: z.string(), // canonical path, e.g. 'shipmentId' | 'scac' | 'location.city'
  segment: z.string(), // 'B10'
  element: z.number().int().min(1),
  occurrence: z.number().int().min(1).default(1),
});

// Combine an X12 date (CCYYMMDD) + time (HHMM) into an ISO-8601 string, reversibly.
export const datetimeRuleSchema = z.object({
  kind: z.literal('datetime'),
  path: z.string(), // 'occurredAt'
  segment: z.string(), // 'AT7'
  dateElement: z.number().int().min(1),
  timeElement: z.number().int().min(1),
  occurrence: z.number().int().min(1).default(1),
});

// Collect every occurrence of a segment into a qualified Reference[] (e.g. L11 loop).
export const referencesRuleSchema = z.object({
  kind: z.literal('references'),
  path: z.string(), // 'references'
  segment: z.string(), // 'L11'
  valueElement: z.number().int().min(1),
  qualifierElement: z.number().int().min(1),
});

export const ruleSchema = z.discriminatedUnion('kind', [
  scalarRuleSchema,
  datetimeRuleSchema,
  referencesRuleSchema,
]);
export type Rule = z.infer<typeof ruleSchema>;

export const mapArtifactSchema = z.object({
  id: z.string(),
  transactionSet: z.string(), // '214'
  direction: z.enum(['inbound', 'outbound']),
  canonicalVersion: z.literal('1'),
  recordKind: z.literal('StatusEvent'), // widened as more sets land (M3)
  rules: z.array(ruleSchema),
});
export type MapArtifact = z.infer<typeof mapArtifactSchema>;
