import { describe, it, expect } from 'vitest';
import { createEdiCore } from './index';

// A realistic single-line 214 (status) interchange. Single-line is the canonical
// wire form; round-trip must reproduce it byte-for-byte.
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

describe('edi-core', () => {
  const edi = createEdiCore();

  it('round-trips a 214 byte-faithfully', () => {
    const parsed = edi.parse(SAMPLE_214);
    expect(edi.serialize(parsed)).toBe(SAMPLE_214);
  });

  it('detects delimiters from ISA', () => {
    const { delimiters } = edi.parse(SAMPLE_214);
    expect(delimiters.element).toBe('*');
    expect(delimiters.segment).toBe('~');
    expect(delimiters.subElement).toBe('>');
  });

  it('preserves populated elements across a multi-line variant', () => {
    const multiline = SAMPLE_214.replace(/~/g, '~\n');
    const parsed = edi.parse(multiline);
    // Element-level fidelity: the ST and L11 segments survive intact.
    const st = parsed.segments.find((s) => s.tag === 'ST');
    const l11 = parsed.segments.find((s) => s.tag === 'L11');
    expect(st?.elements).toEqual(['214', '0001']);
    expect(l11?.elements).toEqual(['BOL12345', 'BM']);
  });

  it('flags a broken envelope', () => {
    const parsed = edi.parse(SAMPLE_214);
    const broken = { ...parsed, segments: parsed.segments.filter((s) => s.tag !== 'GE') };
    const issues = edi.validateEnvelope(broken);
    expect(issues.some((i) => i.segment === 'GE')).toBe(true);
  });
});
