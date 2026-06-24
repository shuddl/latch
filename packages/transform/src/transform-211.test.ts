import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEdiCore } from '@latch/edi-core';
import { bolSchema } from '@latch/canonical';
import { toCanonical, fromCanonical, MAP_211_BOL } from './index';

const SAMPLE_211 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/211/sample-211-001.edi', import.meta.url)),
  'utf8',
).trim();

const edi = createEdiCore();
const map = MAP_211_BOL;

describe('transform/toCanonical (211 → BOL) — three party groups + lading loop', () => {
  it('selects shipper/consignee/billTo by N1 qualifier and maps the AT1 freight loop', () => {
    const doc = edi.parse(SAMPLE_211);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value[0]!;
    if (rec.kind !== 'BOL') return;

    expect(rec.bolNumber).toBe('BOL77001');
    expect(rec.shipper).toMatchObject({ role: 'shipper', name: 'ACME SHIPPING CO', address: { city: 'CHICAGO' } });
    expect(rec.consignee).toMatchObject({ role: 'consignee', name: 'BETA RECEIVING', address: { city: 'DALLAS' } });
    expect(rec.billTo).toMatchObject({ role: 'billTo', name: 'PAYER LOGISTICS', address: { city: 'MEMPHIS' } });
    expect(rec.freight).toEqual([
      { pieces: 40, weight: 15000, weightUom: 'L', class: '70', commodity: 'PALLETIZED CONSUMER GOODS' },
    ]);
    expect(rec.references).toEqual([
      { qualifier: 'BM', value: 'BOL77001' },
      { qualifier: 'PO', value: 'PO99001' },
    ]);
    expect(bolSchema.safeParse(rec).success).toBe(true);
  });

  it('leaves billTo unset when no N1*BT group is present', () => {
    const noBt = SAMPLE_211.replace('N1*BT*PAYER LOGISTICS*93*PAY01~N3*900 DOCK RD~N4*MEMPHIS*TN*38101*US~', '')
      // fix the SE count: removed 3 segments (N1,N3,N4) → 20 - 3 = 17
      .replace('SE*20*0001~', 'SE*17*0001~');
    const doc = edi.parse(noBt);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value[0]!;
    if (rec.kind !== 'BOL') return;
    expect(rec.billTo).toBeUndefined();
    expect(rec.shipper.name).toBe('ACME SHIPPING CO'); // other parties still resolved
  });
});

describe('transform/fromCanonical (211) — byte-faithful round-trip through groups + loop', () => {
  it('reconstructs the interchange byte-for-byte', () => {
    const doc = edi.parse(SAMPLE_211);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    const back = fromCanonical(map, fwd.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(edi.serialize(back.value)).toBe(SAMPLE_211);
  });

  it('write-through edits the consignee name without touching shipper or freight', () => {
    const doc = edi.parse(SAMPLE_211);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    const edited = fwd.value.map((rec) =>
      rec.kind === 'BOL' ? { ...rec, consignee: { ...rec.consignee, name: 'BETA RENAMED' } } : rec,
    );
    const back = fromCanonical(map, edited);
    if (!back.ok) return;
    const wire = edi.serialize(back.value);
    expect(wire).toContain('N1*CN*BETA RENAMED*93*BETA01');
    expect(wire).toContain('N1*SH*ACME SHIPPING CO*93*ACME01'); // shipper untouched
    expect(wire).toContain('AT2*40*PLT*G*15000*L*70'); // freight untouched
  });
});
