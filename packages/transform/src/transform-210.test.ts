import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEdiCore } from '@latch/edi-core';
import { invoiceSchema } from '@latch/canonical';
import { toCanonical, fromCanonical, MAP_210_INVOICE } from './index';

const SAMPLE_210 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/210/sample-210-001.edi', import.meta.url)),
  'utf8',
).trim();

const edi = createEdiCore();
const map = MAP_210_INVOICE;

describe('transform/toCanonical (210 → Invoice) — group + loop', () => {
  it('selects the N1*BT bill-to via a group and maps the L1 charges loop', () => {
    const doc = edi.parse(SAMPLE_210);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value[0]!;
    if (rec.kind !== 'Invoice') return;

    expect(rec.invoiceNumber).toBe('INV55001');
    expect(rec.shipmentId).toBe('SHIP44001');
    expect(rec.total).toBe(1750.5); // cast
    expect(rec.currency).toBe('USD');
    expect(rec.billTo).toEqual({
      role: 'billTo',
      name: 'PAYER LOGISTICS',
      idQualifier: '93',
      id: 'PAY01',
      address: { line1: '900 DOCK RD', city: 'MEMPHIS', state: 'TN', postalCode: '38101', country: 'US' },
    });
    expect(rec.charges).toEqual([
      { code: '400', amount: 1500 },
      { code: 'FUE', amount: 250.5 },
    ]);
    expect(invoiceSchema.safeParse(rec).success).toBe(true);
  });

  it('round-trips the group + loop interchange byte-for-byte', () => {
    const doc = edi.parse(SAMPLE_210);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    const back = fromCanonical(map, fwd.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(edi.serialize(back.value)).toBe(SAMPLE_210);
  });

  it('write-through edits the grouped bill-to name without disturbing the charges', () => {
    const doc = edi.parse(SAMPLE_210);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    const edited = fwd.value.map((rec) =>
      rec.kind === 'Invoice' ? { ...rec, billTo: { ...rec.billTo, name: 'PAYER RENAMED' } } : rec,
    );
    const back = fromCanonical(map, edited);
    if (!back.ok) return;
    const wire = edi.serialize(back.value);
    expect(wire).toContain('N1*BT*PAYER RENAMED*93*PAY01');
    expect(wire).toContain('L1*1**FR*1500.00****400'); // charges untouched
  });
});
