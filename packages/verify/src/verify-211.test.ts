import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_211_BOL } from '@latch/transform';
import { certify, buildCorpus211, BENCHMARK_BAR } from './index';

const fixturePath = fileURLToPath(new URL('../../../fixtures/211/sample-211-001.edi', import.meta.url));
const fixtureText = readFileSync(fixturePath, 'utf8').trim();

const corpus = buildCorpus211(fixtureText);
const result = certify(MAP_211_BOL, corpus);

describe('verify — the Proof (211 injection: 3 party groups + lading loop at the bar)', () => {
  it('certifies the hand-authored 211 map: PASS at the full bar', () => {
    if (!result.passed) console.error('Shortfalls:', result.shortfalls, result.dimensions);
    expect(result.passed).toBe(true);
  });

  it('hits every benchmark dimension (incl. N1 SH/CN/BT qualifiers + freight loop ×1/×2)', () => {
    expect(result.dimensions.requiredSegmentCoverage!.value).toBe(BENCHMARK_BAR.requiredSegmentCoverage);
    expect(result.dimensions.qualifierCoverage!.value).toBe(BENCHMARK_BAR.qualifierCoverage);
    expect(result.dimensions.loopCoverage!.value).toBe(BENCHMARK_BAR.loopCoverage);
    expect(result.dimensions.roundTripFidelity!.value).toBeGreaterThanOrEqual(BENCHMARK_BAR.roundTripFidelity);
    expect(result.dimensions.adversarialGraceful!.value).toBe(BENCHMARK_BAR.adversarialGraceful);
  });

  it('confirms forward + differential oracles (group + loop aware) on the fixture anchor', () => {
    const fixtureResult = result.records.find((r) => r.name.startsWith('fixture-211-001'));
    expect(fixtureResult?.forwardMatch).toBe(true);
    expect(fixtureResult?.differentialMatch).toBe(true);
    expect(fixtureResult?.roundTrip).toBe(true);
  });

  it('the no-billTo record passes the differential oracle (absent optional group stays unset)', () => {
    const noBt = result.records.find((r) => r.name.includes('no-billTo'));
    expect(noBt?.differentialMatch).toBe(true);
    expect(noBt?.roundTrip).toBe(true);
  });

  it('rejects every adversarial case gracefully', () => {
    const adv = result.records.filter((r) => r.category === 'adversarial');
    expect(adv).toHaveLength(3);
    expect(adv.every((r) => r.graceful === true)).toBe(true);
  });
});

describe('verify — the 211 bar has teeth (a broken party group must FAIL)', () => {
  it('fails when the shipper group selects the wrong N1 qualifier', () => {
    const broken = {
      ...MAP_211_BOL,
      compiledHash: undefined,
      rules: MAP_211_BOL.rules.map((r) =>
        r.kind === 'group' && r.path === 'shipper'
          ? { ...r, match: { element: 1, equals: 'CN' } } // wrong: points shipper at the consignee N1
          : r,
      ),
    };
    const bad = certify(broken, corpus);
    expect(bad.passed).toBe(false);
    expect(bad.shortfalls.length).toBeGreaterThan(0);
  });
});
