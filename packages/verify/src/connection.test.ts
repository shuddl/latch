import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAP_214_STATUSEVENT,
  MAP_990_TENDERRESPONSE,
  MAP_204_TENDER,
  MAP_210_INVOICE,
  MAP_211_BOL,
  toCanonical,
  type MapArtifact,
} from '@latch/transform';
import { createEdiCore } from '@latch/edi-core';
import type { CanonicalRecord } from '@latch/canonical';
import {
  buildConnectionCorpus,
  buildCorpus214,
  buildCorpus990,
  buildCorpus204,
  buildCorpus210,
  buildCorpus211,
  certify,
  REFERENCE_FIXTURES,
  type GoldenCorpus,
} from './index';

const SETS: Record<string, { map: MapArtifact; build: (f: string) => GoldenCorpus }> = {
  '214': { map: MAP_214_STATUSEVENT, build: buildCorpus214 },
  '990': { map: MAP_990_TENDERRESPONSE, build: buildCorpus990 },
  '204': { map: MAP_204_TENDER, build: buildCorpus204 },
  '210': { map: MAP_210_INVOICE, build: buildCorpus210 },
  '211': { map: MAP_211_BOL, build: buildCorpus211 },
};

const onDisk = (set: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${set}/sample-${set}-001.edi`, import.meta.url)), 'utf8').trim();

const edi = createEdiCore();
/** What an operator would see and confirm: the map's reading of the sample. */
function reading(map: MapArtifact, input: string): CanonicalRecord[] {
  const parsed = edi.parse(input);
  if (!parsed.ok) throw new Error('sample did not parse');
  const out = toCanonical(map, parsed.value);
  if (!out.ok) throw new Error('sample did not transform');
  return out.value;
}

// A different, equally valid partner 214 (other PRO, city, time) — NOT the repo fixture.
const PARTNER_214 = REFERENCE_FIXTURES['214']!
  .replace('0510938', '7777001')
  .replace('MEMPHIS*TN', 'CHICAGO*IL')
  .replace('20260618*1300', '20260701*0915');

describe('reference fixtures', () => {
  it.each(Object.keys(SETS))('%s constant is pinned to the on-disk fixture', (set) => {
    expect(REFERENCE_FIXTURES[set]).toBe(onDisk(set));
  });
});

describe('buildConnectionCorpus', () => {
  it.each(Object.keys(SETS))('%s: the reference fixture certifies with its built-in anchor', (set) => {
    const { map, build } = SETS[set]!;
    const fixture = REFERENCE_FIXTURES[set]!;
    const result = certify(map, buildConnectionCorpus(build, fixture, [{ input: fixture }]));
    expect(result.shortfalls).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('a partner sample that is not the fixture never inherits the fixture expectation', () => {
    const corpus = buildConnectionCorpus(buildCorpus214, REFERENCE_FIXTURES['214']!, [{ input: PARTNER_214 }]);
    expect(corpus.records[0]!.expectedCanonical).toBeUndefined();
    expect(corpus.records.every((r) => r.requireAnchor || !r.expectedCanonical)).toBe(true);
  });

  it('an unconfirmed partner sample blocks certification with a plain-English reason', () => {
    const corpus = buildConnectionCorpus(buildCorpus214, REFERENCE_FIXTURES['214']!, [{ input: PARTNER_214 }]);
    const result = certify(MAP_214_STATUSEVENT, corpus);
    expect(result.passed).toBe(false);
    expect(result.records[0]!.unconfirmed).toBe(true);
    expect(result.shortfalls.join('\n')).toMatch(/sample 1: .*has not been confirmed/);
    // Nothing else fell short: confirmation is the only thing standing between it and a pass.
    expect(result.shortfalls).toHaveLength(1);
  });

  it('a confirmed partner sample certifies', () => {
    const expectedCanonical = reading(MAP_214_STATUSEVENT, PARTNER_214);
    const corpus = buildConnectionCorpus(buildCorpus214, REFERENCE_FIXTURES['214']!, [
      { input: PARTNER_214, expectedCanonical },
    ]);
    const result = certify(MAP_214_STATUSEVENT, corpus);
    expect(result.shortfalls).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.records[0]!.forwardMatch).toBe(true);
  });

  it('a confirmed expectation catches a map that reads the wrong element', () => {
    const expectedCanonical = reading(MAP_214_STATUSEVENT, PARTNER_214); // the operator-confirmed truth
    const wrong: MapArtifact = JSON.parse(JSON.stringify(MAP_214_STATUSEVENT));
    delete (wrong as { compiledHash?: string }).compiledHash;
    const city = wrong.rules.find((r) => r.kind === 'element' && r.path === 'location.city');
    if (city?.kind !== 'element') throw new Error('city rule missing');
    city.source.element = 2; // reads the state into the city

    const corpus = buildConnectionCorpus(buildCorpus214, REFERENCE_FIXTURES['214']!, [
      { input: PARTNER_214, expectedCanonical },
    ]);
    const result = certify(wrong, corpus);
    expect(result.passed).toBe(false);
    expect(result.records[0]!.forwardMatch).toBe(false);
  });

  it('every sample is a golden record, not just the first', () => {
    const second = PARTNER_214.replace('7777001', '7777002');
    const corpus = buildConnectionCorpus(buildCorpus214, REFERENCE_FIXTURES['214']!, [
      { input: PARTNER_214, expectedCanonical: reading(MAP_214_STATUSEVENT, PARTNER_214) },
      { input: second },
    ]);
    const result = certify(MAP_214_STATUSEVENT, corpus);
    expect(result.records.filter((r) => r.name.startsWith('sample'))).toHaveLength(2);
    expect(result.passed).toBe(false); // the second is unconfirmed
    expect(result.records[1]!.unconfirmed).toBe(true);
  });
});
