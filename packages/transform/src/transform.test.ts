import { describe, it, expect } from 'vitest';
import { createEdiCore } from '@latch/edi-core';
import { statusEventSchema } from '@latch/canonical';
import {
  toCanonical,
  fromCanonical,
  computeCompiledHash,
  withCompiledHash,
  MAP_214_STATUSEVENT,
  type MapArtifact,
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
const map = MAP_214_STATUSEVENT;

describe('transform/toCanonical (214 → StatusEvent)', () => {
  it('extracts the typed fields correctly', () => {
    const doc = edi.parse(SAMPLE_214);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    const ev = r.value[0]!;
    expect(ev.kind).toBe('StatusEvent');
    if (ev.kind !== 'StatusEvent') return;
    expect(ev.shipmentId).toBe('0510938');
    expect(ev.statusCode).toBe('X1');
    expect(ev.reasonCode).toBe('NS');
    expect(ev.occurredAt).toBe('2026-06-18T13:00:00'); // derived, advisory (G2)
    expect(ev.location).toEqual({ city: 'MEMPHIS', state: 'TN', country: 'US' });
  });

  it('produces a schema-valid canonical record', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    if (!r.ok) return;
    expect(statusEventSchema.safeParse(r.value[0]).success).toBe(true);
  });

  it('carries the lossless EDI snapshot in raw (raw-fidelity contract G1)', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const r = toCanonical(map, doc.value);
    if (!r.ok) return;
    const raw = (r.value[0] as { raw?: Record<string, unknown> }).raw;
    expect(raw?.['__edi']).toBeDefined();
  });
});

describe('transform/fromCanonical — round-trip fidelity (the moat)', () => {
  it('reconstructs the interchange byte-for-byte', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    const back = fromCanonical(map, fwd.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(edi.serialize(back.value)).toBe(SAMPLE_214);
  });

  it('propagates an edited typed field back into the EDI (write-through)', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    const edited = fwd.value.map((rec) =>
      rec.kind === 'StatusEvent' ? { ...rec, statusCode: 'D1' } : rec,
    );
    const back = fromCanonical(map, edited);
    if (!back.ok) return;
    const wire = edi.serialize(back.value);
    expect(wire).toContain('AT7*D1*NS'); // status code changed, rest intact
    expect(wire).toContain('B10*4938294*0510938*SCAC'); // untouched
  });

  it('does not mutate the caller record during reconstruction', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const fwd = toCanonical(map, doc.value);
    if (!fwd.ok) return;
    const snapshotBefore = JSON.stringify(fwd.value);
    fromCanonical(map, fwd.value);
    expect(JSON.stringify(fwd.value)).toBe(snapshotBefore);
  });
});

describe('transform — throw-free hot path (CLAUDE.md §2)', () => {
  it('returns a structured error when no ST/SE is present', () => {
    const doc = edi.parse(SAMPLE_214);
    if (!doc.ok) return;
    const stripped = {
      ...doc.value,
      segments: doc.value.segments.filter((s) => !['ST', 'SE'].includes(s.tag)),
    };
    const r = toCanonical(map, stripped);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('PARSE');
  });

  it('errors (does not throw) when reconstructing without a snapshot', () => {
    const fabricated = statusEventSchema.parse({
      kind: 'StatusEvent',
      canonicalVersion: '1',
      shipmentId: 'X',
      statusCode: 'X1',
      occurredAt: '2026-06-18T13:00:00',
    });
    const r = fromCanonical(map, [fabricated]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('TRANSFORM');
  });
});

describe('transform — MapArtifact identity hashing', () => {
  it('is deterministic and order-independent across object keys', () => {
    const h1 = computeCompiledHash(map);
    const reordered: MapArtifact = { ...map, compiledHash: undefined };
    expect(computeCompiledHash(reordered)).toBe(h1);
    expect(map.compiledHash).toBe(h1);
  });

  it('changes when a rule changes', () => {
    const mutated = withCompiledHash({
      ...map,
      compiledHash: undefined,
      rules: [...map.rules, { kind: 'const', path: 'statusDescription', value: 'x' }],
    });
    expect(mutated.compiledHash).not.toBe(map.compiledHash);
  });
});
