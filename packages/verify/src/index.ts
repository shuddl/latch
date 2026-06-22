// packages/verify — the Verification Engine (the Proof). docs/07.
// Injects a golden corpus through the compiled map in BOTH directions, scores
// coverage / round-trip fidelity / graceful adversarial handling against the
// benchmark bar, and emits a per-case result set for the visual report.
//
// The engine, not the model, is the gate. It is deterministic and replayable:
// the same (map, corpus) always yields the same result.

import { createEdiCore, type EdiInterchange } from '@latch/edi-core';
import { createTransformEngine, type MapArtifact } from '@latch/transform';
import type { StatusEvent } from '@latch/canonical';

export type GoldenCategory =
  | 'valid'
  | 'boundary'
  | 'qualifier'
  | 'loop'
  | 'deviation'
  | 'adversarial';

export interface GoldenCase {
  id: string;
  category: GoldenCategory;
  edi: string;
  /** Adversarial/malformed cases must be gracefully rejected, never silently mapped. */
  expectError?: boolean;
  /**
   * Expected canonical values by dot-path (e.g. { shipmentId: '0510938' }). This is
   * the independent oracle (B1): round-trip invariants alone cannot catch a semantic
   * mis-bind (reading B10-01 vs B10-02) because the inverse writes back symmetrically.
   * Anchors come from human-confirmed samples and the differential spec-walker.
   */
  expected?: Record<string, unknown>;
}

export interface GoldenCorpus {
  requiredSegments: string[];
  requiredQualifiers: string[];
  cases: GoldenCase[];
}

export interface CaseResult {
  id: string;
  category: GoldenCategory;
  passed: boolean;
  detail: string;
}

export interface CertificationResult {
  passed: boolean; // meets the benchmark bar (docs/07)
  requiredCoverage: number; // 0..1, target 1.0
  qualifierCoverage: number; // 0..1, target 1.0
  roundtripFidelity: number; // 0..1, target >= 0.999
  adversarialOk: number; // 0..1, target 1.0
  semanticAccuracy: number; // 0..1, target 1.0 — output matches the expected-canonical oracle
  cases: CaseResult[];
}

// The benchmark bar — a map reaches `production` only if ALL hold (docs/07, docs/02).
const BAR = { required: 1, qualifier: 1, roundtrip: 0.999, adversarial: 1, semantic: 1 } as const;

function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, k) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[k];
    return undefined;
  }, source);
}

/** Element-level round-trip fidelity between the original and the rebuilt interchange. */
function fidelity(original: EdiInterchange, rebuilt: EdiInterchange): { matched: number; total: number } {
  let matched = 0;
  let total = 0;
  const n = Math.max(original.segments.length, rebuilt.segments.length);
  for (let i = 0; i < n; i++) {
    const a = original.segments[i];
    const b = rebuilt.segments[i];
    const els = Math.max(a?.elements.length ?? 0, b?.elements.length ?? 0);
    // The tag is a populated token too.
    total += 1;
    if (a && b && a.tag === b.tag) matched += 1;
    for (let j = 0; j < els; j++) {
      const av = a?.elements[j] ?? '';
      if (av === '') continue; // only score populated source elements
      total += 1;
      if (av === (b?.elements[j] ?? '')) matched += 1;
    }
  }
  return { matched, total };
}

export interface Verifier {
  certify(map: MapArtifact, corpus: GoldenCorpus): CertificationResult;
}

export function createVerifier(): Verifier {
  const edi = createEdiCore();
  const tf = createTransformEngine();

  return {
    certify(map: MapArtifact, corpus: GoldenCorpus): CertificationResult {
      const cases: CaseResult[] = [];
      const segmentsSeen = new Set<string>();
      const qualifiersSeen = new Set<string>();
      let fidMatched = 0;
      let fidTotal = 0;
      let advTotal = 0;
      let advOk = 0;
      let semTotal = 0;
      let semOk = 0;

      for (const c of corpus.cases) {
        const parsed = edi.parse(c.edi);

        if (c.expectError) {
          advTotal += 1;
          const gracefully = !parsed.ok || !tf.toCanonical(map, parsed.value).ok;
          if (gracefully) advOk += 1;
          cases.push({
            id: c.id,
            category: c.category,
            passed: gracefully,
            detail: gracefully
              ? 'Malformed input rejected with a reason (never silently mapped)'
              : 'Malformed input was accepted — silent mis-map risk',
          });
          continue;
        }

        if (!parsed.ok) {
          cases.push({ id: c.id, category: c.category, passed: false, detail: 'Parse failed' });
          continue;
        }
        for (const s of parsed.value.segments) segmentsSeen.add(s.tag);

        const toCanon = tf.toCanonical(map, parsed.value);
        if (!toCanon.ok) {
          cases.push({ id: c.id, category: c.category, passed: false, detail: 'Transform failed' });
          continue;
        }
        const rec = toCanon.value[0];
        if (rec?.kind === 'StatusEvent') {
          for (const r of (rec as StatusEvent).references ?? []) qualifiersSeen.add(r.qualifier);
        }

        // Independent oracle (B1): output must match the expected-canonical anchor.
        let semanticOk = true;
        const mismatches: string[] = [];
        if (c.expected) {
          for (const [path, want] of Object.entries(c.expected)) {
            const got = getPath(rec, path);
            const eq = JSON.stringify(got) === JSON.stringify(want);
            if (!eq) {
              semanticOk = false;
              mismatches.push(`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
            }
          }
          semTotal += 1;
          if (semanticOk) semOk += 1;
        }

        const back = tf.fromCanonical(map, toCanon.value);
        if (!back.ok) {
          cases.push({ id: c.id, category: c.category, passed: false, detail: 'Inverse transform failed' });
          continue;
        }
        const f = fidelity(parsed.value, back.value);
        fidMatched += f.matched;
        fidTotal += f.total;
        const lossless = f.matched === f.total;
        const passed = lossless && semanticOk;
        cases.push({
          id: c.id,
          category: c.category,
          passed,
          detail: !semanticOk
            ? `Wrong mapping → ${mismatches.join('; ')}`
            : lossless
              ? 'Round-trip lossless + matches expected canonical'
              : `Round-trip lost ${f.total - f.matched}/${f.total} elements`,
        });
      }

      const covered = (needed: string[], seen: Set<string>) =>
        needed.length === 0 ? 1 : needed.filter((x) => seen.has(x)).length / needed.length;

      const requiredCoverage = covered(corpus.requiredSegments, segmentsSeen);
      const qualifierCoverage = covered(corpus.requiredQualifiers, qualifiersSeen);
      const roundtripFidelity = fidTotal === 0 ? 1 : fidMatched / fidTotal;
      const adversarialOk = advTotal === 0 ? 1 : advOk / advTotal;
      const semanticAccuracy = semTotal === 0 ? 1 : semOk / semTotal;

      const passed =
        requiredCoverage >= BAR.required &&
        qualifierCoverage >= BAR.qualifier &&
        roundtripFidelity >= BAR.roundtrip &&
        adversarialOk >= BAR.adversarial &&
        semanticAccuracy >= BAR.semantic;

      return {
        passed,
        requiredCoverage,
        qualifierCoverage,
        roundtripFidelity,
        adversarialOk,
        semanticAccuracy,
        cases,
      };
    },
  };
}
