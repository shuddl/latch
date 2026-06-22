import { describe, it, expect } from 'vitest';
import { createEdiCore } from '@latch/edi-core';
import { createTransformEngine, mapArtifactSchema } from './index';

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

// Hand-authored inbound 214 → StatusEvent map. Stands in for mapgen output (M1.2);
// the engine is identical whether a human or the generator produced the rules.
const MAP = mapArtifactSchema.parse({
  id: 'map_demo_214_inbound',
  transactionSet: '214',
  direction: 'inbound',
  canonicalVersion: '1',
  recordKind: 'StatusEvent',
  rules: [
    { kind: 'scalar', path: 'shipmentId', segment: 'B10', element: 2 },
    { kind: 'scalar', path: 'statusCode', segment: 'AT7', element: 1 },
    { kind: 'scalar', path: 'reasonCode', segment: 'AT7', element: 2 },
    { kind: 'datetime', path: 'occurredAt', segment: 'AT7', dateElement: 5, timeElement: 6 },
    { kind: 'references', path: 'references', segment: 'L11', valueElement: 1, qualifierElement: 2 },
    { kind: 'scalar', path: 'location.city', segment: 'MS1', element: 1 },
    { kind: 'scalar', path: 'location.state', segment: 'MS1', element: 2 },
    { kind: 'scalar', path: 'location.country', segment: 'MS1', element: 3 },
  ],
});

describe('transform (214 ↔ StatusEvent)', () => {
  const edi = createEdiCore();
  const tf = createTransformEngine();

  it('extracts the canonical StatusEvent', () => {
    const parsed = edi.parse(SAMPLE_214);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = tf.toCanonical(MAP, parsed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rec = result.value[0];
    expect(rec?.kind).toBe('StatusEvent');
    if (rec?.kind !== 'StatusEvent') return;
    expect(rec.shipmentId).toBe('0510938');
    expect(rec.statusCode).toBe('X1');
    expect(rec.reasonCode).toBe('NS');
    expect(rec.occurredAt).toBe('2026-06-18T13:00:00');
    expect(rec.references).toEqual([{ qualifier: 'BM', value: 'BOL12345' }]);
    expect(rec.location).toEqual({ city: 'MEMPHIS', state: 'TN', country: 'US' });
  });

  it('round-trips EDI → canonical → EDI byte-faithfully', () => {
    const parsed = edi.parse(SAMPLE_214);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const toCanon = tf.toCanonical(MAP, parsed.value);
    expect(toCanon.ok).toBe(true);
    if (!toCanon.ok) return;

    const back = tf.fromCanonical(MAP, toCanon.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;

    expect(edi.serialize(back.value)).toBe(SAMPLE_214);
  });

  it('fromCanonical fails gracefully when the source was not preserved', () => {
    // Without raw.__source the engine cannot rebuild the envelope — it returns a
    // structured error rather than emitting a corrupt interchange.
    const orphan = {
      kind: 'StatusEvent' as const,
      canonicalVersion: '1' as const,
      shipmentId: '0510938',
      statusCode: 'X1',
      occurredAt: '2026-06-18T13:00:00',
    };
    const back = tf.fromCanonical(MAP, [orphan]);
    expect(back.ok).toBe(false);
  });
});
