import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_990_TENDERRESPONSE } from '@latch/transform';
import { certify, buildCorpus990, BENCHMARK_BAR } from './index';

// Tie the corpus to the on-disk fixture used by CI (docs/07: the harness has teeth).
const fixturePath = fileURLToPath(new URL('../../../fixtures/990/sample-990-001.edi', import.meta.url));
const fixtureText = readFileSync(fixturePath, 'utf8').trim();

const corpus = buildCorpus990(fixtureText);
const result = certify(MAP_990_TENDERRESPONSE, corpus);

describe('verify — the Proof (990 injection at the benchmark bar)', () => {
  it('certifies the hand-authored 990 map: PASS at the full bar', () => {
    if (!result.passed) console.error('Shortfalls:', result.shortfalls, result.dimensions);
    expect(result.passed).toBe(true);
  });

  it('hits every benchmark dimension', () => {
    expect(result.dimensions.requiredSegmentCoverage!.value).toBe(BENCHMARK_BAR.requiredSegmentCoverage);
    expect(result.dimensions.qualifierCoverage!.value).toBe(BENCHMARK_BAR.qualifierCoverage);
    expect(result.dimensions.loopCoverage!.value).toBe(BENCHMARK_BAR.loopCoverage);
    expect(result.dimensions.roundTripFidelity!.value).toBeGreaterThanOrEqual(BENCHMARK_BAR.roundTripFidelity);
    expect(result.dimensions.adversarialGraceful!.value).toBe(BENCHMARK_BAR.adversarialGraceful);
  });

  it('confirms the forward + differential oracles on the real-fixture anchor', () => {
    const fixtureResult = result.records.find((r) => r.name.startsWith('fixture-990-001'));
    expect(fixtureResult?.forwardMatch).toBe(true);
    expect(fixtureResult?.differentialMatch).toBe(true);
    expect(fixtureResult?.roundTrip).toBe(true);
  });

  it('exercises both decision codes (accept A / decline D) for full qualifier coverage', () => {
    const decline = result.records.find((r) => r.name.includes('declined'));
    expect(decline?.forwardMatch).toBe(true);
    expect(decline?.differentialMatch).toBe(true);
  });

  it('rejects every adversarial case gracefully', () => {
    const adv = result.records.filter((r) => r.category === 'adversarial');
    expect(adv).toHaveLength(3);
    expect(adv.every((r) => r.graceful === true)).toBe(true);
  });
});

describe('verify — the 990 bar has teeth (a broken codemap must FAIL)', () => {
  it('fails certification when the decision codemap is inverted', () => {
    const broken = {
      ...MAP_990_TENDERRESPONSE,
      compiledHash: undefined,
      rules: MAP_990_TENDERRESPONSE.rules.map((r) =>
        r.kind === 'codemap' && r.path === 'decision'
          ? { ...r, table: { A: 'decline', D: 'accept' } } // inverted: wrong semantics
          : r,
      ),
    };
    const bad = certify(broken, corpus);
    expect(bad.passed).toBe(false);
    expect(bad.shortfalls.length).toBeGreaterThan(0);
  });
});
