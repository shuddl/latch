import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_210_INVOICE } from '@latch/transform';
import { certify, buildCorpus210, BENCHMARK_BAR } from './index';

const fixturePath = fileURLToPath(new URL('../../../fixtures/210/sample-210-001.edi', import.meta.url));
const fixtureText = readFileSync(fixturePath, 'utf8').trim();

const corpus = buildCorpus210(fixtureText);
const result = certify(MAP_210_INVOICE, corpus);

describe('verify — the Proof (210 injection: group + charge loop at the bar)', () => {
  it('certifies the hand-authored 210 map: PASS at the full bar', () => {
    if (!result.passed) console.error('Shortfalls:', result.shortfalls, result.dimensions);
    expect(result.passed).toBe(true);
  });

  it('hits every benchmark dimension (incl. charge-loop shapes ×1 and ×2)', () => {
    expect(result.dimensions.requiredSegmentCoverage!.value).toBe(BENCHMARK_BAR.requiredSegmentCoverage);
    expect(result.dimensions.qualifierCoverage!.value).toBe(BENCHMARK_BAR.qualifierCoverage);
    expect(result.dimensions.loopCoverage!.value).toBe(BENCHMARK_BAR.loopCoverage);
    expect(result.dimensions.roundTripFidelity!.value).toBeGreaterThanOrEqual(BENCHMARK_BAR.roundTripFidelity);
    expect(result.dimensions.adversarialGraceful!.value).toBe(BENCHMARK_BAR.adversarialGraceful);
  });

  it('confirms forward + differential oracles (group + loop aware) on the fixture anchor', () => {
    const fixtureResult = result.records.find((r) => r.name.startsWith('fixture-210-001'));
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

describe('verify — the 210 bar has teeth (a broken group child must FAIL)', () => {
  it('fails when the bill-to group child reads the wrong sub-element', () => {
    const broken = {
      ...MAP_210_INVOICE,
      compiledHash: undefined,
      rules: MAP_210_INVOICE.rules.map((r) => {
        if (r.kind !== 'group' || r.path !== 'billTo') return r;
        return {
          ...r,
          fields: r.fields.map((f) =>
            f.kind === 'element' && f.path === 'name'
              ? { ...f, source: { tag: 'N1', occurrence: 0, element: 4 } } // wrong: id, not name
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
