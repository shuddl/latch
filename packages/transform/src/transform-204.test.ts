import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEdiCore } from '@latch/edi-core';
import { tenderSchema } from '@latch/canonical';
import { toCanonical, fromCanonical, MAP_204_TENDER } from './index';

const SAMPLE_204 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/204/sample-204-001.edi', import.meta.url)),
  'utf8',
).trim();

const edi = createEdiCore();
const map = MAP_204_TENDER;

describe('transform/toCanonical (204 → Tender) — repeating loops', () => {
  it('maps stops[], freight[], and references[] with nested party + casts', () => {
    const doc = edi.parse(SAMPLE_204);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value[0]!;
    expect(rec.kind).toBe('Tender');
    if (rec.kind !== 'Tender') return;

    expect(rec.shipmentId).toBe('SHIPABC123');
    expect(rec.scac).toBe('SCAC');
    expect(rec.purpose).toBe('original');

    expect(rec.stops).toHaveLength(2);
    expect(rec.stops[0]).toMatchObject({
      sequence: 1, // cast to number
      type: 'pickup', // codemap CL → pickup
      party: {
        role: 'shipper', // codemap N1 SH → shipper
        name: 'ACME SHIPPING CO',
        idQualifier: '93',
        id: 'ACME01',
        address: { line1: '100 MAIN ST', city: 'CHICAGO', state: 'IL', postalCode: '60601', country: 'US' },
      },
    });
    expect(rec.stops[1]?.type).toBe('delivery');
    expect(rec.stops[1]?.party.role).toBe('consignee');

    expect(rec.freight).toHaveLength(2);
    expect(rec.freight[0]).toEqual({ weight: 15000, weightUom: 'L', pieces: 40 });

    expect(rec.references).toEqual([{ qualifier: 'OW', value: 'ORDER789' }]);

    expect(tenderSchema.safeParse(rec).success).toBe(true);
  });
});

describe('transform/fromCanonical (204) — byte-faithful round-trip through loops', () => {
  it('reconstructs the multi-loop interchange byte-for-byte', () => {
    const doc = edi.parse(SAMPLE_204);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    const back = fromCanonical(map, fwd.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(edi.serialize(back.value)).toBe(SAMPLE_204);
  });

  it('write-through edits an uncast loop-child element (party name) without disturbing others', () => {
    const doc = edi.parse(SAMPLE_204);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    const edited = fwd.value.map((rec) => {
      if (rec.kind !== 'Tender') return rec;
      const stops = rec.stops.map((s, i) =>
        i === 0 ? { ...s, party: { ...s.party, name: 'ACME RENAMED' } } : s,
      );
      return { ...rec, stops };
    });
    const back = fromCanonical(map, edited);
    if (!back.ok) return;
    const wire = edi.serialize(back.value);
    expect(wire).toContain('N1*SH*ACME RENAMED*93*ACME01'); // stop 0 party renamed
    expect(wire).toContain('N1*CN*BETA RECEIVING*93*BETA01'); // stop 1 untouched
  });

  it('treats a whitespace-only numeric element as unset, not 0 (no Number("   ")=0 bug)', () => {
    // Pad the first AT8 weight (15000) with spaces only; a cast must skip it, not read 0.
    const padded = SAMPLE_204.replace('AT8*G*L*15000*40~S5*2', 'AT8*G*L*   *40~S5*2');
    const doc = edi.parse(padded);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    const rec = fwd.value[0]!;
    if (rec.kind !== 'Tender') return;
    expect(rec.freight[0]?.weight).toBeUndefined(); // skipped, not 0
    expect(rec.freight[0]?.pieces).toBe(40); // sibling still parsed
    // And the padded source still round-trips byte-faithfully (rides in the snapshot).
    const back = fromCanonical(map, fwd.value);
    if (!back.ok) return;
    expect(edi.serialize(back.value)).toBe(padded);
  });

  it('keeps cast/codemap loop children forward-only (a cast edit does not corrupt the wire)', () => {
    const doc = edi.parse(SAMPLE_204);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    const edited = fwd.value.map((rec) => {
      if (rec.kind !== 'Tender') return rec;
      const freight = rec.freight.map((f, i) => (i === 0 ? { ...f, weight: 99999 } : f));
      return { ...rec, freight };
    });
    const back = fromCanonical(map, edited);
    if (!back.ok) return;
    // weight is cast (forward-only): the original AT8 weight rides in the snapshot.
    expect(edi.serialize(back.value)).toContain('AT8*G*L*15000*40');
  });
});
