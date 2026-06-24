import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEdiCore } from '@latch/edi-core';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import { build997, processInbound } from './index';

const FIXTURE_214 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/214/sample-214-001.edi', import.meta.url)),
  'utf8',
).trim();

const edi = createEdiCore();

describe('build997', () => {
  it('produces a valid, well-formed ack that routes back to the sender', () => {
    const parsed = edi.parse(FIXTURE_214);
    if (!parsed.ok) throw new Error('fixture did not parse');
    const ack = build997(parsed.value, true);

    // Round-trips through the serializer and re-parses cleanly.
    const wire = edi.serialize(ack);
    const reparsed = edi.parse(wire);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;

    expect(edi.validateEnvelope(reparsed.value)).toEqual([]);
    const ak1 = reparsed.value.segments.find((s) => s.tag === 'AK1');
    const ak9 = reparsed.value.segments.find((s) => s.tag === 'AK9');
    expect(ak1?.elements).toEqual(['QM', '1']); // GS01 + group control echoed
    expect(ak9?.elements[0]).toBe('A'); // accepted

    // Sender/receiver were swapped so the ack goes back to the original sender.
    const inIsa = parsed.value.segments.find((s) => s.tag === 'ISA')!;
    const outIsa = reparsed.value.segments.find((s) => s.tag === 'ISA')!;
    expect(outIsa.elements[5]?.trim()).toBe(inIsa.elements[7]?.trim());
  });

  it('marks rejection with AK9*R', () => {
    const parsed = edi.parse(FIXTURE_214);
    if (!parsed.ok) return;
    const ack = build997(parsed.value, false);
    expect(ack.segments.find((s) => s.tag === 'AK9')?.elements[0]).toBe('R');
  });
});

describe('processInbound', () => {
  it('transforms a valid 214 and accepts it', () => {
    const out = processInbound(FIXTURE_214, MAP_214_STATUSEVENT);
    expect(out.status).toBe('transformed');
    expect(out.ackStatus).toBe('accepted');
    expect(out.controls).toEqual({ isa: '000000001', gs: '1', st: '0001' });
    expect(out.transactionSet).toBe('214');
    const rec = out.canonical?.[0];
    expect(rec?.kind).toBe('StatusEvent');
    if (rec?.kind === 'StatusEvent') expect(rec.statusCode).toBe('X1');
    // The ack parses and is accepted.
    const ack = createEdiCore().parse(out.ack);
    expect(ack.ok).toBe(true);
  });

  it('rejects unparseable input gracefully (no ack possible)', () => {
    const out = processInbound('this is not EDI', MAP_214_STATUSEVENT);
    expect(out.status).toBe('error');
    expect(out.ackStatus).toBe('rejected');
    expect(out.ack).toBe('');
    expect(out.error).toBeTruthy();
  });

  it('rejects a parseable interchange that fails transform, with a 997*R', () => {
    // Drop the AT7 segment → statusCode is absent → canonical schema fails.
    const noStatus = FIXTURE_214.split('~')
      .filter((s) => !s.startsWith('AT7'))
      .join('~');
    const out = processInbound(noStatus, MAP_214_STATUSEVENT);
    expect(out.status).toBe('error');
    expect(out.ackStatus).toBe('rejected');
    expect(out.ack).not.toBe(''); // it parsed, so we can 997-reject it
    const ack = createEdiCore().parse(out.ack);
    if (ack.ok) expect(ack.value.segments.find((s) => s.tag === 'AK9')?.elements[0]).toBe('R');
  });
});
