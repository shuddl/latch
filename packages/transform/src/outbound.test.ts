import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEdiCore, readElement } from '@latch/edi-core';
import { tenderSchema, type CanonicalRecord, type TenderResponse } from '@latch/canonical';
import {
  buildOutbound,
  respondToTender,
  toCanonical,
  withCompiledHash,
  MAP_990_TENDERRESPONSE,
  MAP_204_TENDER,
  MAP_211_BOL,
  type MapArtifact,
  type OutboundEnvelope,
} from './index';

const edi = createEdiCore();

const fixture = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url)), 'utf8').trim();

/** Drop the lossless `raw` snapshot so we compare semantic canonical only. */
function stripRaw(rec: unknown): unknown {
  if (!rec || typeof rec !== 'object') return rec;
  const { raw: _raw, ...rest } = rec as { raw?: unknown } & Record<string, unknown>;
  void _raw;
  return rest;
}

const ENV: OutboundEnvelope = {
  stControlNumber: '0001',
  interchange: {
    senderQualifier: 'ZZ',
    senderId: 'CARRIERID',
    receiverQualifier: 'ZZ',
    receiverId: 'SHIPPERID',
    date: '260624',
    time: '0900',
    controlNumber: '000000100',
  },
  group: {
    functionalIdCode: 'GF',
    senderCode: 'CARRIERID',
    receiverCode: 'SHIPPERID',
    date: '20260624',
    time: '0900',
    controlNumber: '100',
    version: '004010',
  },
};

describe('buildOutbound — canonical → EDI (990 TenderResponse)', () => {
  const response: TenderResponse = {
    kind: 'TenderResponse',
    canonicalVersion: '1',
    shipmentId: 'SHIP78001',
    decision: 'accept',
  };

  it('generates a well-formed 990 interchange', () => {
    const out = buildOutbound(MAP_990_TENDERRESPONSE, response, ENV);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const wire = edi.serialize(out.value);
    expect(wire).toContain('ST*990*0001~');
    expect(wire).toContain('B1**SHIP78001**A~'); // shipmentId at B1-02, decision 'accept'→'A' at B1-04
    expect(wire.startsWith('ISA*')).toBe(true);
    expect(wire).toContain('IEA*1*000000100~');
  });

  it('round-trips: generated 990 parses back to the same canonical (the outbound proof)', () => {
    const out = buildOutbound(MAP_990_TENDERRESPONSE, response, ENV);
    if (!out.ok) return;
    const parsed = edi.parse(edi.serialize(out.value));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const back = toCanonical(MAP_990_TENDERRESPONSE, parsed.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const rec = back.value[0];
    if (rec?.kind !== 'TenderResponse') throw new Error('expected TenderResponse');
    expect(rec.shipmentId).toBe('SHIP78001');
    expect(rec.decision).toBe('accept');
  });

  it('reverses the codemap for a decline + carries the reason', () => {
    const declined: TenderResponse = { ...response, decision: 'decline', reason: 'NO CAPACITY' };
    const out = buildOutbound(MAP_990_TENDERRESPONSE, declined, ENV);
    if (!out.ok) return;
    const wire = edi.serialize(out.value);
    expect(wire).toContain('B1**SHIP78001**D~'); // decline → 'D'
    expect(wire).toContain('K1*NO CAPACITY~'); // reason emitted
  });

  it('rejects a record whose kind does not match the map', () => {
    const wrong = { kind: 'Tender', canonicalVersion: '1', shipmentId: 'X', purpose: 'original', stops: [], freight: [], references: [] } as unknown as CanonicalRecord;
    const out = buildOutbound(MAP_990_TENDERRESPONSE, wrong, ENV);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors[0]?.code).toBe('VALIDATION');
  });
});

describe('buildOutbound — occurrence indexing is preserved (no segment-shift on round-trip)', () => {
  // A flat map whose OPTIONAL occurrence-0 field (reasonCode ← REF#0) is absent while the
  // occurrence-1 field (statusDescription ← REF#1) is populated. The builder must still emit
  // REF#0 (empty) so re-parsing keeps occurrence 1 at occurrence 1 — and self-verify proves it.
  const refMap: MapArtifact = withCompiledHash({
    mapVersion: 'test-ref', direction: 'outbound', transactionSet: '999', x12Version: '004010',
    canonicalVersion: '1', recordKind: 'StatusEvent',
    rules: [
      { kind: 'const', path: 'kind', value: 'StatusEvent' },
      { kind: 'const', path: 'canonicalVersion', value: '1' },
      { kind: 'const', path: 'shipmentId', value: 'S1' },
      { kind: 'const', path: 'statusCode', value: 'X1' },
      { kind: 'const', path: 'occurredAt', value: '2026-06-24T09:00:00' },
      { kind: 'element', path: 'reasonCode', source: { tag: 'REF', occurrence: 0, element: 2 } },
      { kind: 'element', path: 'statusDescription', source: { tag: 'REF', occurrence: 1, element: 2 } },
    ],
  });

  it('emits a contiguous occurrence-0 placeholder so occurrence-1 does not shift', () => {
    const rec = {
      kind: 'StatusEvent', canonicalVersion: '1', shipmentId: 'S1', statusCode: 'X1',
      occurredAt: '2026-06-24T09:00:00', statusDescription: 'SECOND', raw: {},
    } as unknown as CanonicalRecord;
    const out = buildOutbound(refMap, rec, ENV);
    expect(out.ok).toBe(true); // self-verify: occurrence 1 round-trips because occ 0 is emitted empty
    if (!out.ok) return;
    // Two REF segments emitted; occurrence 1 still carries 'SECOND' (no shift to occ 0).
    const refs = out.value.segments.filter((s) => s.tag === 'REF');
    expect(refs.length).toBe(2);
    expect(readElement(out.value, { tag: 'REF', occurrence: 1, element: 2 })).toBe('SECOND');
    expect(readElement(out.value, { tag: 'REF', occurrence: 0, element: 2 })).toBeUndefined();
  });
});

describe('buildOutbound — non-flat sets (loops + groups), self-verified', () => {
  // The round-trip proof for sets WITH loops/groups: inbound a real fixture → canonical →
  // outbound → re-parse → the SAME semantic canonical. buildOutbound self-verifies, so a
  // success means the generated document provably reproduces the intended canonical.
  function assertRoundTrips(map: MapArtifact, raw: string) {
    const parsed = edi.parse(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const inbound = toCanonical(map, parsed.value);
    expect(inbound.ok).toBe(true);
    if (!inbound.ok || !inbound.value[0]) return;
    const record = inbound.value[0];

    const out = buildOutbound(map, record, ENV);
    expect(out.ok).toBe(true); // self-verify passed ⇒ the generated doc is faithful
    if (!out.ok) return;

    // Independently re-derive the canonical from the generated wire and compare.
    const reparsed = edi.parse(edi.serialize(out.value));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const back = toCanonical(map, reparsed.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(stripRaw(back.value[0])).toEqual(stripRaw(record));
  }

  it('round-trips a 204 Tender (stops/freight/references loops)', () => {
    assertRoundTrips(MAP_204_TENDER, fixture('204/sample-204-001.edi'));
  });

  it('round-trips a 211 BOL (N1 groups + AT detail loop)', () => {
    assertRoundTrips(MAP_211_BOL, fixture('211/sample-211-001.edi'));
  });

  it('returns UNSUPPORTED when a derived field cannot be reproduced (self-verify catches it)', () => {
    // A map whose `occurredAt` is derived (forward-only) with no element rules for its source:
    // buildOutbound can't emit those bytes, so the generated doc won't carry occurredAt and
    // self-verification fails closed rather than emitting a lossy document.
    const derivedMap: MapArtifact = withCompiledHash({
      mapVersion: 'test-derived', direction: 'outbound', transactionSet: '998', x12Version: '004010',
      canonicalVersion: '1', recordKind: 'StatusEvent',
      rules: [
        { kind: 'const', path: 'kind', value: 'StatusEvent' },
        { kind: 'const', path: 'canonicalVersion', value: '1' },
        { kind: 'element', path: 'shipmentId', source: { tag: 'B10', occurrence: 0, element: 1 } },
        { kind: 'element', path: 'statusCode', source: { tag: 'AT7', occurrence: 0, element: 1 } },
        { kind: 'derived', path: 'occurredAt', inputs: [{ tag: 'AT7', occurrence: 0, element: 5 }, { tag: 'AT7', occurrence: 0, element: 6 }], transform: 'dateTimeToIso' },
      ],
    });
    const rec = {
      kind: 'StatusEvent', canonicalVersion: '1', shipmentId: 'S1', statusCode: 'X1', occurredAt: '2026-06-24T09:00:00', raw: {},
    } as unknown as CanonicalRecord;
    const out = buildOutbound(derivedMap, rec, ENV);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors[0]?.code).toBe('UNSUPPORTED');
  });
});

describe('respondToTender — the 204↔990 pairing', () => {
  it('builds a TenderResponse that carries the tender shipmentId', () => {
    const tender = tenderSchema.parse({
      kind: 'Tender',
      canonicalVersion: '1',
      shipmentId: 'SHIPABC123',
      purpose: 'original',
      stops: [],
      freight: [],
      references: [],
    });
    const accept = respondToTender(tender, 'accept');
    expect(accept).toEqual({ kind: 'TenderResponse', canonicalVersion: '1', shipmentId: 'SHIPABC123', decision: 'accept' });

    const decline = respondToTender(tender, 'decline', 'lane full');
    expect(decline.decision).toBe('decline');
    expect(decline.reason).toBe('lane full');

    // End-to-end: tender → response → 990 wire → parse → canonical decision.
    const out = buildOutbound(MAP_990_TENDERRESPONSE, accept, ENV);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(edi.serialize(out.value)).toContain('B1**SHIPABC123**A~');
  });
});
