import { describe, it, expect } from 'vitest';
import { createEdiCore } from '@latch/edi-core';
import { tenderSchema, type TenderResponse } from '@latch/canonical';
import {
  buildOutbound,
  respondToTender,
  toCanonical,
  MAP_990_TENDERRESPONSE,
  MAP_204_TENDER,
  type OutboundEnvelope,
} from './index';

const edi = createEdiCore();

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

  it('refuses outbound generation for a map with repeating loops/groups (v1 limit)', () => {
    const out = buildOutbound(MAP_204_TENDER, response, ENV);
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
