// packages/verify — golden corpus + certification types (docs/07).
//
// The benchmark bar is the unit of trust: a map may reach `production` ONLY if every
// dimension holds. These thresholds are docs/07 verbatim and must never be weakened.

import type { CanonicalRecord } from '@latch/canonical';
import type { ElementAddress, LoopSchema } from '@latch/edi-core';

export const BENCHMARK_BAR = {
  requiredSegmentCoverage: 1.0, // 100%
  qualifierCoverage: 1.0, // 100%
  loopCoverage: 1.0, // 100% of declared shapes
  roundTripFidelity: 0.999, // ≥ 99.9% element-level
  adversarialGraceful: 1.0, // 100% graceful
  deviationHandling: 1.0, // 100% of observed deviations
} as const;

export type GoldenCategory =
  | 'valid'
  | 'boundary'
  | 'qualifier'
  | 'loop'
  | 'deviation'
  | 'adversarial';

export interface GoldenRecord {
  name: string;
  category: GoldenCategory;
  /** Raw X12 input. */
  input: string;
  /** Adversarial/malformed cases must be rejected gracefully (a structured error). */
  expectGraceful?: boolean;
  /** Sample-confirmed anchor: the human-verified expected canonical (forward oracle). */
  expectedCanonical?: CanonicalRecord[];
  /** A partner sample: it MUST carry a confirmed `expectedCanonical` for the map to certify
   *  (docs/07 — otherwise the map would only be graded against its own interpretation). */
  requireAnchor?: boolean;
}

/** A coded element and the full set of qualifier codes the corpus must exercise. */
export interface QualifierTarget {
  tag: string;
  element: number; // 1-based element index (any occurrence counts)
  codes: string[];
}

export interface CorpusCoverage {
  /** Business segment tags the guide marks required (envelope is checked separately). */
  requiredSegments: string[];
  qualifiers: QualifierTarget[];
  /** Loop schema + the repetition counts (min/typical/max) the corpus must exercise. */
  loops: { schema: LoopSchema[]; shapes: number[] };
}

export interface GoldenCorpus {
  transactionSet: string;
  records: GoldenRecord[];
  coverage: CorpusCoverage;
  corpusHash?: string;
}

export interface DimensionScore {
  value: number;
  threshold: number;
  passed: boolean;
}

export interface RecordResult {
  name: string;
  category: GoldenCategory;
  /** Round-trip reproduced every populated element. */
  roundTrip: boolean;
  fidelity: number; // element-level [0,1]
  graceful?: boolean; // adversarial only
  forwardMatch?: boolean; // when an expectedCanonical anchor was provided
  differentialMatch?: boolean; // engine output agrees with independent address read
  /** A partner sample whose expected output nobody has confirmed yet — blocks certification. */
  unconfirmed?: boolean;
  issues: string[];
}

export interface CertificationResult {
  mapHash: string;
  corpusHash: string;
  passed: boolean;
  dimensions: Record<string, DimensionScore>;
  records: RecordResult[];
  /** Plain-English, per-field/qualifier/loop reasons the map fell short (docs/07). */
  shortfalls: string[];
}

/** Re-export for corpus authors who declare qualifier addresses structurally. */
export type { ElementAddress };
