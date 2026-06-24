import { describe, it, expect } from 'vitest';
import { createEdiCore } from '@latch/edi-core';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import { buildCorpus214, type CertificationResult } from '@latch/verify';
import {
  buildBaseline,
  detectDrift,
  decideHeal,
  driftCase,
  shadowReCertify,
} from './index';

const SAMPLE_214 =
  'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260618*1305*U*00401*000000001*0*P*>~' +
  'GS*QM*SHIPPERID*CARRIERID*20260618*1305*1*X*004010~' +
  'ST*214*0001~' +
  'B10*4938294*0510938*SCAC~' +
  'L11*BOL12345*BM~' +
  'LX*1~' +
  'AT7*X1*NS***20260618*1300*LT~' +
  'MS1*MEMPHIS*TN*US~' +
  'SE*7*0001~' +
  'GE*1*1~' +
  'IEA*1*000000001~';

const edi = createEdiCore();
function parse(raw: string) {
  const r = edi.parse(raw);
  if (!r.ok) throw new Error('parse failed');
  return r.value;
}

const baseline = buildBaseline([parse(SAMPLE_214)]);
const corpus = buildCorpus214(SAMPLE_214);

describe('drift detection', () => {
  it('reports no drift for traffic identical to the certified shape', () => {
    expect(detectDrift(baseline, parse(SAMPLE_214))).toEqual([]);
  });

  it('catches a new qualifier value (changed_qualifier)', () => {
    const drifted = parse(SAMPLE_214.replace('L11*BOL12345*BM~', 'L11*BOL12345*ZZ~'));
    const findings = detectDrift(baseline, drifted);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'changed_qualifier', segment: 'L11', evidence: 'ZZ' });
  });

  it('catches a brand-new segment (new_segment)', () => {
    const drifted = parse(
      SAMPLE_214.replace('MS1*MEMPHIS*TN*US~SE*7*0001~', 'MS1*MEMPHIS*TN*US~N9*ZP*EXTRA~SE*8*0001~'),
    );
    const findings = detectDrift(baseline, drifted);
    expect(findings.some((f) => f.kind === 'new_segment' && f.segment === 'N9')).toBe(true);
  });
});

describe('self-heal decisioning', () => {
  it('auto-applies additive drift that still certifies (nothing for the operator to do)', () => {
    const driftedRaw = SAMPLE_214.replace('L11*BOL12345*BM~', 'L11*BOL12345*ZZ~');
    const findings = detectDrift(baseline, parse(driftedRaw));
    const shadow = shadowReCertify(MAP_214_STATUSEVENT, corpus, driftCase('drift-zz', driftedRaw));
    expect(shadow.passed).toBe(true);
    expect(decideHeal(findings, shadow)).toBe('auto_applied');
  });

  it('escalates a new segment for approval even if shadow still passes', () => {
    const driftedRaw = SAMPLE_214.replace(
      'MS1*MEMPHIS*TN*US~SE*7*0001~',
      'MS1*MEMPHIS*TN*US~N9*ZP*EXTRA~SE*8*0001~',
    );
    const findings = detectDrift(baseline, parse(driftedRaw));
    const shadow = shadowReCertify(MAP_214_STATUSEVENT, corpus, driftCase('drift-n9', driftedRaw));
    expect(shadow.passed).toBe(true);
    expect(decideHeal(findings, shadow)).toBe('awaiting_approval');
  });

  it('holds (keeps the last-good map) when a patch would not pass the bar', () => {
    const failing = {
      passed: false,
      dimensions: {},
      records: [],
      shortfalls: ['x'],
      mapHash: 'm',
      corpusHash: 'c',
    } as unknown as CertificationResult;
    expect(decideHeal([{ kind: 'new_segment', segment: 'N9', detail: '', evidence: 'N9' }], failing)).toBe('hold');
  });
});
