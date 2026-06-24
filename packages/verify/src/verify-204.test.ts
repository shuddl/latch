import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_204_TENDER } from '@latch/transform';
import { certify, buildCorpus204, BENCHMARK_BAR } from './index';

const fixturePath = fileURLToPath(new URL('../../../fixtures/204/sample-204-001.edi', import.meta.url));
const fixtureText = readFileSync(fixturePath, 'utf8').trim();

const corpus = buildCorpus204(fixtureText);
const result = certify(MAP_204_TENDER, corpus);

describe('verify — the Proof (204 injection: repeating loops at the bar)', () => {
  it('certifies the hand-authored 204 map: PASS at the full bar', () => {
    if (!result.passed) console.error('Shortfalls:', result.shortfalls, result.dimensions);
    expect(result.passed).toBe(true);
  });

  it('hits every benchmark dimension (incl. loop shapes ×1 and ×2)', () => {
    expect(result.dimensions.requiredSegmentCoverage!.value).toBe(BENCHMARK_BAR.requiredSegmentCoverage);
    expect(result.dimensions.qualifierCoverage!.value).toBe(BENCHMARK_BAR.qualifierCoverage);
    expect(result.dimensions.loopCoverage!.value).toBe(BENCHMARK_BAR.loopCoverage);
    expect(result.dimensions.roundTripFidelity!.value).toBeGreaterThanOrEqual(BENCHMARK_BAR.roundTripFidelity);
    expect(result.dimensions.adversarialGraceful!.value).toBe(BENCHMARK_BAR.adversarialGraceful);
  });

  it('confirms forward + differential oracles on the real-fixture anchor (loop-aware)', () => {
    const fixtureResult = result.records.find((r) => r.name.startsWith('fixture-204-001'));
    expect(fixtureResult?.forwardMatch).toBe(true);
    expect(fixtureResult?.differentialMatch).toBe(true);
    expect(fixtureResult?.roundTrip).toBe(true);
  });

  it('rejects every adversarial case gracefully', () => {
    const adv = result.records.filter((r) => r.category === 'adversarial');
    expect(adv).toHaveLength(3);
    expect(adv.every((r) => r.graceful === true)).toBe(true);
  });
});

describe('verify — the 204 bar has teeth (a broken loop child must FAIL)', () => {
  it('fails when a loop child element points at the wrong sub-element', () => {
    const broken = {
      ...MAP_204_TENDER,
      compiledHash: undefined,
      rules: MAP_204_TENDER.rules.map((r) => {
        if (r.kind !== 'loop' || r.path !== 'stops') return r;
        return {
          ...r,
          fields: r.fields.map((f) =>
            f.kind === 'element' && f.path === 'party.name'
              ? { ...f, source: { tag: 'N1', occurrence: 0, element: 4 } } // wrong: reads the id, not the name
              : f,
          ),
        };
      }),
    };
    const bad = certify(broken, corpus);
    expect(bad.passed).toBe(false);
    expect(bad.shortfalls.length).toBeGreaterThan(0);
  });
});
