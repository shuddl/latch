import { describe, it, expect } from 'vitest';
import { createEdiCore } from './index';
import {
  enumerateElements,
  readElement,
  formatAddress,
  parseAddress,
  isPopulated,
  type ElementAddress,
} from './address';
import { groupSegments, loopCardinality, type LoopSchema } from './loops';
import { buildInterchange } from './envelope';

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

describe('edi-core/address', () => {
  it('addresses elements by tag/occurrence/index', () => {
    const doc = edi.parse(SAMPLE_214);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const b10_03: ElementAddress = { tag: 'B10', occurrence: 0, element: 3 };
    expect(readElement(doc.value, b10_03)).toBe('SCAC');
    expect(readElement(doc.value, { tag: 'AT7', occurrence: 0, element: 1 })).toBe('X1');
    expect(readElement(doc.value, { tag: 'MS1', occurrence: 0, element: 2 })).toBe('TN');
  });

  it('returns undefined for absent occurrences/elements (never throws)', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    expect(readElement(doc.value, { tag: 'AT7', occurrence: 5, element: 1 })).toBeUndefined();
    expect(readElement(doc.value, { tag: 'B10', occurrence: 0, element: 99 })).toBeUndefined();
    expect(isPopulated(doc.value, { tag: 'AT7', occurrence: 0, element: 3 })).toBe(false); // empty
  });

  it('round-trips address formatting', () => {
    const a: ElementAddress = { tag: 'B10', occurrence: 0, element: 2 };
    expect(formatAddress(a)).toBe('B10[0].02');
    expect(parseAddress('B10[0].02')).toEqual(a);
    expect(parseAddress('AT7[1].10')).toEqual({ tag: 'AT7', occurrence: 1, element: 10 });
    expect(parseAddress('not an address')).toBeUndefined();
  });

  it('enumerates exactly the populated elements, skipping empties', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const all = enumerateElements(doc.value);
    // AT7 has empty 03 and 04; they must not appear.
    const at7 = all.filter((e) => e.address.tag === 'AT7').map((e) => e.address.element);
    expect(at7).toEqual([1, 2, 5, 6, 7]);
    // Every enumerated value is non-empty.
    expect(all.every((e) => e.value !== '')).toBe(true);
  });
});

describe('edi-core/loops', () => {
  const status214: LoopSchema[] = [{ name: 'LX', start: 'LX', terminators: ['SE'] }];

  it('groups the 214 LX status loop, keeping heading in lead', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    // Group only the ST..SE business body (exclude envelope) for clarity.
    const body = doc.value.segments.filter((s) =>
      ['B10', 'L11', 'LX', 'AT7', 'MS1'].includes(s.tag),
    );
    const { lead, loops } = groupSegments(body, status214);
    expect(lead.map((s) => s.tag)).toEqual(['B10', 'L11']);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.segments.map((s) => s.tag)).toEqual(['LX', 'AT7', 'MS1']);
  });

  it('counts loop cardinality across repeated loops', () => {
    const body = [
      { tag: 'LX', elements: ['1'] },
      { tag: 'AT7', elements: ['X1'] },
      { tag: 'LX', elements: ['2'] },
      { tag: 'AT7', elements: ['D1'] },
    ];
    expect(loopCardinality(body, status214)).toEqual({ LX: 2 });
  });

  it('handles nested loops', () => {
    const schema: LoopSchema[] = [
      { name: 'S5', start: 'S5', terminators: ['SE'], groups: [{ name: 'N1', start: 'N1' }] },
    ];
    const body = [
      { tag: 'S5', elements: ['1'] },
      { tag: 'N1', elements: ['SH'] },
      { tag: 'N1', elements: ['CN'] },
      { tag: 'S5', elements: ['2'] },
      { tag: 'N1', elements: ['SH'] },
    ];
    const { loops } = groupSegments(body, schema);
    expect(loops).toHaveLength(2);
    expect(loops[0]!.children).toHaveLength(2);
    expect(loops[1]!.children).toHaveLength(1);
  });
});

describe('edi-core/envelope', () => {
  it('builds a valid interchange with correct control counts', () => {
    const doc = buildInterchange({
      delimiters: { element: '*', segment: '~', subElement: '>' },
      interchange: {
        senderQualifier: 'ZZ',
        senderId: 'SHIPPERID',
        receiverQualifier: 'ZZ',
        receiverId: 'CARRIERID',
        date: '260618',
        time: '1305',
        controlNumber: '000000001',
      },
      group: {
        functionalIdCode: 'QM',
        senderCode: 'SHIPPERID',
        receiverCode: 'CARRIERID',
        date: '20260618',
        time: '1305',
        controlNumber: '1',
        version: '004010',
      },
      transactions: [
        {
          code: '214',
          controlNumber: '0001',
          segments: [
            { tag: 'B10', elements: ['4938294', '0510938', 'SCAC'] },
            { tag: 'LX', elements: ['1'] },
            { tag: 'AT7', elements: ['X1', 'NS', '', '', '20260618', '1300', 'LT'] },
          ],
        },
      ],
    });

    const se = doc.segments.find((s) => s.tag === 'SE')!;
    expect(se.elements[0]).toBe('5'); // ST + 3 business + SE
    const ge = doc.segments.find((s) => s.tag === 'GE')!;
    expect(ge.elements[0]).toBe('1');
    const iea = doc.segments.find((s) => s.tag === 'IEA')!;
    expect(iea.elements[0]).toBe('1');

    // ISA is fixed-width 106; serialize→parse must round-trip and pass envelope checks.
    const isa = doc.segments.find((s) => s.tag === 'ISA')!;
    const wire = edi.serialize(doc);
    expect(wire.indexOf('~')).toBe(105); // ISA occupies positions 0..105
    expect(isa.elements).toHaveLength(16);

    const reparsed = edi.parse(wire);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(edi.validateEnvelope(reparsed.value)).toEqual([]);
  });
});
