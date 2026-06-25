import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEdiCore, readElement } from '@latch/edi-core';
import type { Tender } from '@latch/canonical';
import {
  buildOutbound,
  respondToTender,
  toCanonical,
  deriveResponseEnvelope,
  buildOutboundEnvelope,
  MAP_204_TENDER,
  MAP_990_TENDERRESPONSE,
  type ResponseControls,
} from './index';

const edi = createEdiCore();
const FIX_204 = readFileSync(fileURLToPath(new URL('../../../fixtures/204/sample-204-001.edi', import.meta.url)), 'utf8').trim();

const CONTROLS: ResponseControls = {
  interchangeControlNumber: '000000200',
  groupControlNumber: '200',
  stControlNumber: '0001',
  isaDate: '260625',
  isaTime: '1030',
  gsDate: '20260625',
  gsTime: '1030',
  functionalIdCode: 'GF', // 990
};

describe('deriveResponseEnvelope — the 204↔990 reply, self-identity by role-swap', () => {
  it('addresses the 990 back to the 204 sender (we reply as the 204 receiver)', () => {
    const parsed = edi.parse(FIX_204);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const inbound = toCanonical(MAP_204_TENDER, parsed.value);
    expect(inbound.ok).toBe(true);
    if (!inbound.ok || inbound.value[0]?.kind !== 'Tender') return;
    const tender = inbound.value[0] as Tender;

    // The 204 went SHIPPERID → CARRIERID; our 990 must go CARRIERID → SHIPPERID.
    const env = deriveResponseEnvelope(tender, CONTROLS);
    expect(env).toBeDefined();
    if (!env) return;
    expect(env.interchange.senderId).toBe('CARRIERID');
    expect(env.interchange.receiverId).toBe('SHIPPERID');
    expect(env.group.senderCode).toBe('CARRIERID');
    expect(env.group.receiverCode).toBe('SHIPPERID');
    expect(env.group.version).toBe('004010');

    const response = respondToTender(tender, 'accept');
    const out = buildOutbound(MAP_990_TENDERRESPONSE, response, env);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The generated 990 interchange is correctly addressed back to the shipper.
    const wire = edi.parse(edi.serialize(out.value));
    expect(wire.ok).toBe(true);
    if (!wire.ok) return;
    expect(readElement(wire.value, { tag: 'ISA', occurrence: 0, element: 6 })?.trim()).toBe('CARRIERID');
    expect(readElement(wire.value, { tag: 'ISA', occurrence: 0, element: 8 })?.trim()).toBe('SHIPPERID');
    // And it still co-certifies semantically: parses back to the accepted TenderResponse.
    const back = toCanonical(MAP_990_TENDERRESPONSE, wire.value);
    expect(back.ok).toBe(true);
    if (!back.ok || back.value[0]?.kind !== 'TenderResponse') return;
    expect(back.value[0].decision).toBe('accept');
    expect(back.value[0].shipmentId).toBe(tender.shipmentId);
  });

  it('returns undefined (never throws) for a missing snapshot or nullish inputs', () => {
    const noSnap = { kind: 'Tender', canonicalVersion: '1', shipmentId: 'X', purpose: 'original', stops: [], freight: [], references: [] } as unknown as Tender;
    expect(deriveResponseEnvelope(noSnap, CONTROLS)).toBeUndefined();
    // Defensive: a null/undefined source or controls must fail closed, not crash.
    expect(deriveResponseEnvelope(null as unknown as Tender, CONTROLS)).toBeUndefined();
    expect(deriveResponseEnvelope(noSnap, null as unknown as ResponseControls)).toBeUndefined();
  });
});

describe('buildOutboundEnvelope — unsolicited outbound from explicit identities', () => {
  it('lays down our identity as sender and the partner as receiver (ZZ/004010 defaults)', () => {
    const env = buildOutboundEnvelope({
      self: { isaId: 'USCARRIER', gsCode: 'USCARRIER' },
      partner: { isaId: 'PARTNER01', gsCode: 'PARTNER01' },
      controls: CONTROLS,
    });
    expect(env.interchange.senderQualifier).toBe('ZZ');
    expect(env.interchange.senderId).toBe('USCARRIER');
    expect(env.interchange.receiverId).toBe('PARTNER01');
    expect(env.group.version).toBe('004010');

    // It produces a well-formed interchange through the 990 map.
    const response = respondToTender(
      { kind: 'Tender', canonicalVersion: '1', shipmentId: 'SHIP9', purpose: 'original', stops: [], freight: [], references: [], raw: {} } as unknown as Tender,
      'decline',
      'NO CAPACITY',
    );
    const out = buildOutbound(MAP_990_TENDERRESPONSE, response, env);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(edi.serialize(out.value)).toContain('ISA*00*');
  });
});
