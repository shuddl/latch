// The Verification Engine (docs/07): inject the corpus through the compiled map, run the
// oracles, compute coverage, and score against the benchmark bar. Deterministic and
// replayable: same (mapHash, corpusHash) → same result. The engine, not the model, is
// the gate. Returns a structured result; never throws.

import { createEdiCore, loopCardinality, type EdiInterchange } from '@latch/edi-core';
import { computeCompiledHash, type MapArtifact } from '@latch/transform';
import {
  BENCHMARK_BAR,
  type CertificationResult,
  type DimensionScore,
  type GoldenCorpus,
  type RecordResult,
} from './types';
import { roundTripOracle, forwardOracle, differentialOracle, adversarialOracle } from './oracle';

const edi = createEdiCore();

function stableStringify(value: unknown, depth = 0): string {
  if (depth > 50) return '"[max-depth]"'; // guard against pathological/cyclic inputs
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], depth + 1)}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function computeCorpusHash(corpus: GoldenCorpus): string {
  const identity: Record<string, unknown> = { ...corpus };
  delete identity['corpusHash'];
  return `corpus_${fnv1a(stableStringify(identity))}`;
}

function dim(value: number, threshold: number): DimensionScore {
  // Use a small epsilon so 0.999 thresholds aren't tripped by float noise.
  return { value, threshold, passed: value + 1e-9 >= threshold };
}

function bodySegmentTags(input: string): { ok: true; tags: Set<string>; doc: EdiInterchange } | { ok: false } {
  const parsed = edi.parse(input);
  if (!parsed.ok) return { ok: false };
  return { ok: true, tags: new Set(parsed.value.segments.map((s) => s.tag)), doc: parsed.value };
}

/** Run certification: inject the corpus through `map`, score vs the benchmark bar. */
export function certify(map: MapArtifact, corpus: GoldenCorpus): CertificationResult {
  const mapHash = map.compiledHash ?? computeCompiledHash(map);
  const corpusHash = corpus.corpusHash ?? computeCorpusHash(corpus);
  const records: RecordResult[] = [];
  const shortfalls: string[] = [];

  const nonAdversarial = corpus.records.filter((r) => r.category !== 'adversarial');
  const adversarial = corpus.records.filter((r) => r.category === 'adversarial');

  // ----- per-record oracles -----
  let fidelitySum = 0;
  let fidelityCount = 0;
  for (const rec of nonAdversarial) {
    const rt = roundTripOracle(map, rec.input);
    const issues = [...rt.issues];
    let forwardMatch: boolean | undefined;

    const diff = differentialOracle(map, rec.input);
    const differentialMatch = diff.match;
    if (!diff.match) issues.push(...diff.issues);

    if (rec.expectedCanonical) {
      const fwd = forwardOracle(map, rec.input, rec.expectedCanonical);
      forwardMatch = fwd.match;
      if (!fwd.match) issues.push(...fwd.issues);
    }

    fidelitySum += rt.fidelity;
    fidelityCount += 1;
    const result: RecordResult = {
      name: rec.name,
      category: rec.category,
      roundTrip: rt.ok,
      fidelity: rt.fidelity,
      issues,
    };
    if (forwardMatch !== undefined) result.forwardMatch = forwardMatch;
    if (differentialMatch !== undefined) result.differentialMatch = differentialMatch;
    records.push(result);
    if (issues.length > 0) shortfalls.push(`${rec.name}: ${issues.join('; ')}`);
  }

  let gracefulCount = 0;
  for (const rec of adversarial) {
    const adv = adversarialOracle(map, rec.input);
    if (adv.graceful) gracefulCount += 1;
    else shortfalls.push(`${rec.name}: ${adv.issues.join('; ')}`);
    records.push({ name: rec.name, category: rec.category, roundTrip: false, fidelity: 0, graceful: adv.graceful, issues: adv.issues });
  }

  // ----- coverage -----
  const parsedNonAdv = nonAdversarial.map((r) => ({ rec: r, parsed: bodySegmentTags(r.input) }));

  // Required-segment coverage: each required tag present in ≥1 non-adversarial record.
  const reqMissing: string[] = [];
  for (const tag of corpus.coverage.requiredSegments) {
    const present = parsedNonAdv.some((p) => p.parsed.ok && p.parsed.tags.has(tag));
    if (!present) reqMissing.push(tag);
  }
  const reqCoverage = corpus.coverage.requiredSegments.length === 0
    ? 1
    : (corpus.coverage.requiredSegments.length - reqMissing.length) / corpus.coverage.requiredSegments.length;
  for (const tag of reqMissing) shortfalls.push(`Required segment ${tag} is never exercised by the corpus`);

  // Qualifier coverage: each declared code observed at its (tag,element) somewhere.
  let qualTargets = 0;
  let qualHit = 0;
  for (const q of corpus.coverage.qualifiers) {
    for (const code of q.codes) {
      qualTargets += 1;
      const hit = parsedNonAdv.some((p) => {
        if (!p.parsed.ok) return false;
        return p.parsed.doc.segments.some((s) => s.tag === q.tag && s.elements[q.element - 1] === code);
      });
      if (hit) qualHit += 1;
      else shortfalls.push(`Qualifier ${q.tag}_${q.element}=${code} is never exercised`);
    }
  }
  const qualCoverage = qualTargets === 0 ? 1 : qualHit / qualTargets;

  // Loop coverage: each declared shape (repetition count) observed.
  const shapesSeen = new Set<number>();
  for (const p of parsedNonAdv) {
    if (!p.parsed.ok) continue;
    const counts = loopCardinality(p.parsed.doc.segments, corpus.coverage.loops.schema);
    for (const n of Object.values(counts)) shapesSeen.add(n);
  }
  const declaredShapes = corpus.coverage.loops.shapes;
  const shapesHit = declaredShapes.filter((s) => shapesSeen.has(s)).length;
  const loopCoverage = declaredShapes.length === 0 ? 1 : shapesHit / declaredShapes.length;
  for (const s of declaredShapes) {
    if (!shapesSeen.has(s)) shortfalls.push(`Loop repetition shape ×${s} is never exercised`);
  }

  // ----- aggregate scores -----
  const roundTripFidelity = fidelityCount === 0 ? 1 : fidelitySum / fidelityCount;
  const adversarialGraceful = adversarial.length === 0 ? 1 : gracefulCount / adversarial.length;
  const deviationRecords = nonAdversarial.filter((r) => r.category === 'deviation');
  const deviationHandled = deviationRecords.filter((r) => {
    const rr = records.find((x) => x.name === r.name);
    return rr ? rr.roundTrip && rr.differentialMatch !== false : false;
  }).length;
  const deviationHandling = deviationRecords.length === 0 ? 1 : deviationHandled / deviationRecords.length;

  const dimensions: Record<string, DimensionScore> = {
    requiredSegmentCoverage: dim(reqCoverage, BENCHMARK_BAR.requiredSegmentCoverage),
    qualifierCoverage: dim(qualCoverage, BENCHMARK_BAR.qualifierCoverage),
    loopCoverage: dim(loopCoverage, BENCHMARK_BAR.loopCoverage),
    roundTripFidelity: dim(roundTripFidelity, BENCHMARK_BAR.roundTripFidelity),
    adversarialGraceful: dim(adversarialGraceful, BENCHMARK_BAR.adversarialGraceful),
    deviationHandling: dim(deviationHandling, BENCHMARK_BAR.deviationHandling),
  };

  // Forward/differential failures are hard fails even if coverage holds.
  const oracleClean = records.every((r) => r.forwardMatch !== false && r.differentialMatch !== false);
  const passed = oracleClean && Object.values(dimensions).every((d) => d.passed);

  return { mapHash, corpusHash, passed, dimensions, records, shortfalls };
}
