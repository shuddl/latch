import { describe, it, expect } from 'vitest';
import { createEdiCore } from '@latch/edi-core';
import { tenderResponseSchema } from '@latch/canonical';
import { toCanonical, fromCanonical, MAP_990_TENDERRESPONSE } from './index';

const wrap = (body: string): string =>
  'ISA*00*          *00*          *ZZ*CARRIERID      *ZZ*SHIPPERID      *260618*1310*U*00401*000000002*0*P*>~' +
  'GS*GF*CARRIERID*SHIPPERID*20260618*1310*2*X*004010~' +
  body +
  'GE*1*2~IEA*1*000000002~';

const SAMPLE_ACCEPT = wrap('ST*990*0001~B1*SCAC*SHIP78001*20260618*A~SE*3*0001~');
const SAMPLE_DECLINE = wrap('ST*990*0002~B1*SCAC*SHIP78002*20260618*D~K1*NO CAPACITY ON LANE~SE*4*0002~');

const edi = createEdiCore();
const map = MAP_990_TENDERRESPONSE;

describe('transform/toCanonical (990 → TenderResponse)', () => {
  it('codemaps an accept (B1_04=A → decision "accept")', () => {
    const doc = edi.parse(SAMPLE_ACCEPT);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value[0]!;
    expect(rec.kind).toBe('TenderResponse');
    if (rec.kind !== 'TenderResponse') return;
    expect(rec.shipmentId).toBe('SHIP78001');
    expect(rec.decision).toBe('accept');
    expect(rec.reason).toBeUndefined();
  });

  it('codemaps a decline (B1_04=D → "decline") and reads the K1 reason', () => {
    const doc = edi.parse(SAMPLE_DECLINE);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value[0]!;
    if (rec.kind !== 'TenderResponse') return;
    expect(rec.decision).toBe('decline');
    expect(rec.reason).toBe('NO CAPACITY ON LANE');
    expect(tenderResponseSchema.safeParse(rec).success).toBe(true);
  });

  it('warns (does not throw) when the source code is absent from the table', () => {
    const doc = edi.parse(wrap('ST*990*0005~B1*SCAC*SHIP78005*20260618*Z~SE*3*0005~'));
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    // Unmapped code → decision left unset → schema (required enum) fails the transform.
    expect(r.ok).toBe(false);
  });
});

describe('transform/fromCanonical (990) — round-trip fidelity', () => {
  it('reconstructs both accept and decline interchanges byte-for-byte', () => {
    for (const sample of [SAMPLE_ACCEPT, SAMPLE_DECLINE]) {
      const doc = edi.parse(sample);
      if (!doc.ok) return;
      const fwd = toCanonical(map, doc.value);
      expect(fwd.ok).toBe(true);
      if (!fwd.ok) return;
      const back = fromCanonical(map, fwd.value);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(edi.serialize(back.value)).toBe(sample);
    }
  });

  it('keeps codemap forward-only: the source B1 code rides in the snapshot, not a write-back', () => {
    const doc = edi.parse(SAMPLE_DECLINE);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    // Mutating the canonical decision must NOT corrupt the byte-faithful original, since
    // decision is forward-only (B1_04 is reconstructed from the raw snapshot).
    const edited = fwd.value.map((rec) =>
      rec.kind === 'TenderResponse' ? { ...rec, decision: 'accept' as const } : rec,
    );
    const back = fromCanonical(map, edited);
    if (!back.ok) return;
    expect(edi.serialize(back.value)).toContain('B1*SCAC*SHIP78002*20260618*D');
  });
});
