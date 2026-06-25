import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './sign';
import { HspParticipant, type ParticipantConfig } from './participant';
import { Shim, shimFetchHandler, type ShimConfig } from './shim';
import type { CanonicalResult, GoldenCase, HspEnvelope } from './types';

// A non-Latch "partner transform": canonical = { v: <input> }. `skew` models a partner whose
// interpretation disagrees, which must fail co-cert.
const engine =
  (skew = false) =>
  (_set: string, cases: GoldenCase[]): CanonicalResult[] =>
    cases.map((c) => ({ name: c.name, canonical: { v: skew ? `${c.input}X` : c.input } }));

const CASES: GoldenCase[] = [{ name: 'c1', input: 'A' }];
const EXPECTED: CanonicalResult[] = engine()('214', CASES);

async function initiatorCfg(): Promise<ParticipantConfig> {
  return {
    role: 'initiator',
    org: 'acme',
    keyId: 'acme-key',
    keys: await generateKeyPair(),
    latchVersion: '1.0',
    canonicalVersions: ['1'],
    sets: ['214'],
    connectivity: ['as2'],
    sends: ['214'],
    receives: ['214'],
    golden: { '214': { cases: CASES, expected: EXPECTED } },
    mapDigest: 'digest-acme',
    commitments: {},
    runCorpus: engine(), // full Latch node
  };
}

function shimCfg(runCorpus: ShimConfig['runCorpus']): ShimConfig {
  return {
    org: 'partner',
    keyId: 'partner-key',
    latchVersion: '1.0',
    canonicalVersions: ['1'],
    sets: ['214'],
    connectivity: ['as2'],
    sends: ['214'],
    receives: ['214'],
    golden: { '214': { cases: CASES, expected: EXPECTED } },
    mapDigest: 'digest-partner',
    commitments: {},
    runCorpus, // the partner's OWN transform — not the Latch engine
  };
}

/** Drive a Latch initiator against a shim purely over the shim's HTTP fetch contract. */
async function driveOverShimHttp(initiator: HspParticipant, handler: (r: Request) => Promise<Response>, sessionId: string) {
  const post = async (env: HspEnvelope): Promise<HspEnvelope[]> => {
    const res = await handler(
      new Request('https://partner.example/hsp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: env }),
      }),
    );
    const body = (await res.json()) as { envelopes?: HspEnvelope[] };
    return body.envelopes ?? [];
  };

  const queue: { toShim: boolean; env: HspEnvelope }[] = (await initiator.start(sessionId)).map((env) => ({ toShim: true, env }));
  for (let steps = 0; steps < 1000 && queue.length > 0; steps++) {
    const { toShim, env } = queue.shift()!;
    const replies = toShim ? await post(env) : await initiator.receive(env);
    for (const r of replies) queue.push({ toShim: !toShim, env: r });
  }
}

describe('Latch-aware shim (M6.2) — non-adopting partner co-certifies over HTTP', () => {
  it('serves capabilities at the well-known endpoint', async () => {
    const shim = await Shim.create(shimCfg(engine()));
    const res = await shimFetchHandler(shim)(new Request('https://partner.example/.well-known/latch-hsp'));
    expect(res.status).toBe(200);
    const caps = (await res.json()) as { org: string; sends: string[]; publicKey: string };
    expect(caps.org).toBe('partner');
    expect(caps.sends).toEqual(['214']);
    expect(caps.publicKey).toBe(shim.publicKey);
  });

  it('co-certifies a full handshake between a Latch node and a shim → countersigned manifest', async () => {
    const initiator = new HspParticipant(await initiatorCfg());
    const shim = await Shim.create(shimCfg(engine()));
    const handler = shimFetchHandler(shim);

    await driveOverShimHttp(initiator, handler, 'shim-session-1');

    expect(initiator.status).toBe('ACTIVE');
    expect(initiator.signedManifest?.initiatorSig).toBeTruthy();
    expect(initiator.signedManifest?.responderSig).toBeTruthy();
    // The shim (partner) holds the same proof for the session.
    const shimState = shim.state('shim-session-1');
    expect(shimState?.status).toBe('ACTIVE');
    expect((shimState?.signedManifest as { manifest?: unknown } | null)?.manifest).toEqual(initiator.signedManifest?.manifest);
  });

  it('fails CLOSED when the partner shim mis-reads the data', async () => {
    const initiator = new HspParticipant(await initiatorCfg());
    const shim = await Shim.create(shimCfg(engine(true))); // skewed partner transform

    await driveOverShimHttp(initiator, shimFetchHandler(shim), 'shim-session-2');

    expect(initiator.status).toBe('FAILED');
    expect(initiator.signedManifest).toBeNull();
  });

  it('rejects malformed shim requests', async () => {
    const handler = shimFetchHandler(await Shim.create(shimCfg(engine())));
    const postJson = (body: unknown) =>
      handler(new Request('https://partner.example/hsp', { method: 'POST', body: JSON.stringify(body) }));

    expect((await handler(new Request('https://partner.example/hsp', { method: 'POST', body: 'not json' }))).status).toBe(400);
    expect((await handler(new Request('https://partner.example/nope'))).status).toBe(404);
    // An array is `typeof 'object'` but not a valid envelope.
    expect((await postJson({ envelope: [] })).status).toBe(400);
    expect((await postJson({ envelope: null })).status).toBe(400);
    // A valid object missing a usable sessionId must not key the session map under undefined.
    expect((await postJson({ envelope: { type: 'HELLO' } })).status).toBe(400);
    expect((await postJson({ envelope: { type: 'HELLO', sessionId: '' } })).status).toBe(400);
  });
});
