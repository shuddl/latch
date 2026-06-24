import { describe, it, expect } from 'vitest';
import type { LlmClient } from '@latch/shared';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import { buildCorpus214, certify } from '@latch/verify';
import type { LatchSpec } from '@latch/spec';
import { generateMap, patchMap } from './index';

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

const fakeClient = (payload: unknown): LlmClient => ({ extractJson: async () => payload });

const SPEC: LatchSpec = {
  transactionSet: '214',
  x12Version: '004010',
  segments: [],
  deviations: [],
  confidence: 1,
};

describe('generateMap', () => {
  it('produces a map that PASSES certification (the model proposes, the engine gates)', async () => {
    // The model returns rules; whatever it returns must certify to be trusted.
    const map = await generateMap(fakeClient(MAP_214_STATUSEVENT.rules), SPEC, {
      direction: 'inbound',
      canonicalVersion: '1',
      recordKind: 'StatusEvent',
    });
    expect(map.transactionSet).toBe('214');
    expect(map.recordKind).toBe('StatusEvent');
    expect(map.compiledHash).toBeTruthy();

    const result = certify(map, buildCorpus214(SAMPLE_214));
    expect(result.passed).toBe(true);
  });

  it('rejects invalid generated rules with a structured error', async () => {
    await expect(
      generateMap(fakeClient([{ kind: 'bogus' }]), SPEC, {
        direction: 'inbound',
        canonicalVersion: '1',
        recordKind: 'StatusEvent',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('patches a map and re-hashes it (heal proposal)', async () => {
    const base = await generateMap(fakeClient(MAP_214_STATUSEVENT.rules), SPEC, {
      direction: 'inbound',
      canonicalVersion: '1',
      recordKind: 'StatusEvent',
    });
    const extraRule = [
      ...MAP_214_STATUSEVENT.rules,
      { kind: 'const', path: 'statusDescription', value: 'patched' },
    ];
    const patched = await patchMap(fakeClient(extraRule), base, 'new optional field observed');
    expect(patched.compiledHash).not.toBe(base.compiledHash);
    expect(patched.rules.length).toBe(base.rules.length + 1);
  });
});
