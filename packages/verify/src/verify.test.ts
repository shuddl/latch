import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import type { CanonicalRecord } from '@latch/canonical';
import { certify, buildCorpus214, BENCHMARK_BAR } from './index';
import { forwardOracle } from './oracle';

// Tie the corpus to the on-disk fixture used by CI (docs/07: harness has teeth).
const fixturePath = fileURLToPath(new URL('../../../fixtures/214/sample-214-001.edi', import.meta.url));
const fixtureText = readFileSync(fixturePath, 'utf8').trim();

const corpus = buildCorpus214(fixtureText);
const result = certify(MAP_214_STATUSEVENT, corpus);

describe('verify — the Proof (214 injection at the benchmark bar)', () => {
  it('certifies the hand-authored 214 map: PASS at the full bar', () => {
    if (!result.passed) {
      console.error('Shortfalls:', result.shortfalls, result.dimensions);
    }
    expect(result.passed).toBe(true);
  });

  it('hits every benchmark dimension', () => {
    expect(result.dimensions.requiredSegmentCoverage!.value).toBe(BENCHMARK_BAR.requiredSegmentCoverage);
    expect(result.dimensions.qualifierCoverage!.value).toBe(BENCHMARK_BAR.qualifierCoverage);
    expect(result.dimensions.loopCoverage!.value).toBe(BENCHMARK_BAR.loopCoverage);
    expect(result.dimensions.roundTripFidelity!.value).toBeGreaterThanOrEqual(BENCHMARK_BAR.roundTripFidelity);
    expect(result.dimensions.adversarialGraceful!.value).toBe(BENCHMARK_BAR.adversarialGraceful);
    expect(result.dimensions.deviationHandling!.value).toBe(BENCHMARK_BAR.deviationHandling);
  });

  it('confirms the forward oracle against the real-fixture anchor', () => {
    const fixtureResult = result.records.find((r) => r.name.startsWith('fixture-214-001'));
    expect(fixtureResult?.forwardMatch).toBe(true);
    expect(fixtureResult?.differentialMatch).toBe(true);
    expect(fixtureResult?.roundTrip).toBe(true);
  });

  it('rejects every adversarial case gracefully (never silently mis-maps)', () => {
    const adv = result.records.filter((r) => r.category === 'adversarial');
    expect(adv).toHaveLength(3);
    expect(adv.every((r) => r.graceful === true)).toBe(true);
  });

  it('is deterministic: same (map,corpus) → identical hashes and verdict', () => {
    const again = certify(MAP_214_STATUSEVENT, corpus);
    expect(again.mapHash).toBe(result.mapHash);
    expect(again.corpusHash).toBe(result.corpusHash);
    expect(again.passed).toBe(result.passed);
  });
});

describe('verify — the bar has teeth (a broken map must FAIL)', () => {
  it('fails certification when a map mis-maps a field', () => {
    const broken = {
      ...MAP_214_STATUSEVENT,
      compiledHash: undefined,
      rules: MAP_214_STATUSEVENT.rules.map((r) =>
        r.kind === 'element' && r.path === 'statusCode'
          ? { ...r, source: { tag: 'B10', occurrence: 0, element: 3 } } // wrong: points at SCAC
          : r,
      ),
    };
    const bad = certify(broken, corpus);
    expect(bad.passed).toBe(false);
    expect(bad.shortfalls.length).toBeGreaterThan(0);
  });
});

describe('verify/oracle — forward canonical comparison', () => {
  it('treats semantically-equal canonical records as equal despite key order differences', () => {
    const expected: CanonicalRecord[] = [
      {
        shipmentId: '0510938',
        kind: 'StatusEvent',
        occurredAt: '2026-06-18T13:00:00',
        canonicalVersion: '1',
        reasonCode: 'NS',
        statusCode: 'X1',
        location: { country: 'US', city: 'MEMPHIS', state: 'TN' },
      },
    ];
    const out = forwardOracle(MAP_214_STATUSEVENT, fixtureText, expected);
    expect(out.match).toBe(true);
  });
});
