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
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(edi.serialize(parsed.value)).toBe(SAMPLE_214);
  });

  it('detects delimiters from ISA', () => {
    const parsed = edi.parse(SAMPLE_214);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.delimiters.element).toBe('*');
    expect(parsed.value.delimiters.segment).toBe('~');
    expect(parsed.value.delimiters.subElement).toBe('>');
  });

  it('returns a structured error on non-X12 input — never throws', () => {
    const r = edi.parse('this is not EDI');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('PARSE');
  });

  it('preserves populated elements across a multi-line variant', () => {
    const multiline = SAMPLE_214.replace(/~/g, '~\n');
    const parsed = edi.parse(multiline);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const st = parsed.value.segments.find((s) => s.tag === 'ST');
    const l11 = parsed.value.segments.find((s) => s.tag === 'L11');
    expect(st?.elements).toEqual(['214', '0001']);
    expect(l11?.elements).toEqual(['BOL12345', 'BM']);
  });

  it('flags a broken envelope', () => {
    const parsed = edi.parse(SAMPLE_214);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const broken = {
      ...parsed.value,
      segments: parsed.value.segments.filter((s) => s.tag !== 'GE'),
    };
    const issues = edi.validateEnvelope(broken);
    expect(issues.some((i) => i.segment === 'GE')).toBe(true);
  });
});
