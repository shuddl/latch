import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  signEnvelope,
  verifyEnvelope,
  makeParty,
  runHandshake,
  verifyManifestSig,
  type GoldenCase,
  type HspEnvelope,
  type PartyConfig,
} from './index';

// A deterministic inbound transform for tests: each case → a canonical echo. Both sides'
// "expected" use the same shape, so co-certification passes on the happy path.
const echo = (set: string, cases: GoldenCase[]) => cases.map((c) => ({ name: c.name, canonical: { set, v: c.input } }));
const expectedFor = (set: string, cases: GoldenCase[]) => cases.map((c) => ({ name: c.name, canonical: { set, v: c.input } }));

async function cfg(org: string, sends: string[]): Promise<Omit<PartyConfig, 'keys'>> {
  const golden: PartyConfig['golden'] = {};
  for (const set of sends) {
    const cases: GoldenCase[] = [{ name: `${set}-1`, input: `ISA*${set}~` }];
    golden[set] = { cases, expected: expectedFor(set, cases) };
  }
  return {
    org,
    keyId: `${org}-key`,
    latchVersion: '1.0',
    canonicalVersions: ['1'],
    sets: ['214', '204', '990'],
    connectivity: ['as2', 'sftp'],
    sends,
    golden,
    mapDigest: `digest-${org}`,
    commitments: { 'shipmentId': 'B10*02' },
    runCorpus: echo,
  };
}

describe('HSP — full bilateral handshake (docs/05)', () => {
  it('drives HELLO→…→ACTIVE and produces a verifiable co-signed manifest', async () => {
    const initiator = await makeParty('initiator', await cfg('acme', ['204']));
    const responder = await makeParty('responder', await cfg('beta', ['214', '990']));

    const out = await runHandshake(initiator, responder);
    expect(out.ok).toBe(true);
    expect(out.initiatorStatus).toBe('ACTIVE');
    expect(out.responderStatus).toBe('ACTIVE');

    // The state machine walked the documented sequence.
    expect(initiator.statusLog).toEqual([
      'INIT', 'HELLO_SENT', 'HELLO_OK', 'SPECS_EXCHANGED', 'MAPS_PROPOSED',
      'COCERT_RUNNING', 'COCERT_PASSED', 'ATTESTED', 'ACTIVE',
    ]);

    // The manifest is the proof both sides agree — and both signatures verify.
    const m = out.signedManifest!;
    expect(m.manifest.canonicalVersion).toBe('1');
    expect(m.manifest.flows).toEqual({ initiatorSends: ['204'], responderSends: ['214', '990'] });
    expect(m.manifest.coCertResultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyManifestSig(m.manifest, m.initiatorSig!, initiator.cfg.keys.publicKey)).toBe(true);
    expect(await verifyManifestSig(m.manifest, m.responderSig!, responder.cfg.keys.publicKey)).toBe(true);
    // A signature does NOT verify against the wrong key.
    expect(await verifyManifestSig(m.manifest, m.initiatorSig!, responder.cfg.keys.publicKey)).toBe(false);

    // Every transcribed envelope is signed and verifies against its sender's pinned key.
    const pub: Record<string, string> = {
      'acme-key': initiator.cfg.keys.publicKey,
      'beta-key': responder.cfg.keys.publicKey,
    };
    for (const env of out.transcript) {
      expect(await verifyEnvelope(env, pub[env.sender.keyId]!)).toBe(true);
    }
    // seq numbers are unique + monotonic (idempotency key for the DO).
    const seqs = out.transcript.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('falls back (FAILED) when there is no common canonical-model version', async () => {
    const a = await makeParty('initiator', { ...(await cfg('acme', ['204'])), canonicalVersions: ['1'] });
    const b = await makeParty('responder', { ...(await cfg('beta', ['214'])), canonicalVersions: ['2'] });
    const out = await runHandshake(a, b);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/canonical-model version/);
    expect(out.initiatorStatus).toBe('FAILED');
  });

  it('fails co-certification when a party does not reproduce the intended canonical', async () => {
    const initiator = await makeParty('initiator', await cfg('acme', ['204']));
    // The responder mis-transforms the initiator's 204 corpus → co-cert must catch it.
    const badResponder = await makeParty('responder', {
      ...(await cfg('beta', ['214'])),
      runCorpus: (set, cases) => cases.map((c) => ({ name: c.name, canonical: { set, v: 'WRONG' } })),
    });
    const out = await runHandshake(initiator, badResponder);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/co-certification/);
    expect(initiator.statusLog).toContain('COCERT_FAILED');
  });
});

describe('HSP — envelope signing', () => {
  it('verifies a signed envelope and detects tampering', async () => {
    const keys = await generateKeyPair();
    const env: HspEnvelope = {
      hspVersion: '1.0', sessionId: 'hs_test', type: 'HELLO', seq: 0,
      sender: { latchOrg: 'acme', keyId: 'k' }, payload: { hello: true },
    };
    const signed = await signEnvelope(env, keys.privateKey);
    expect(await verifyEnvelope(signed, keys.publicKey)).toBe(true);

    // Tamper with the payload → signature no longer verifies.
    const tampered = { ...signed, payload: { hello: false } };
    expect(await verifyEnvelope(tampered, keys.publicKey)).toBe(false);

    // A different key does not verify.
    const other = await generateKeyPair();
    expect(await verifyEnvelope(signed, other.publicKey)).toBe(false);

    // An unsigned envelope is never considered verified.
    expect(await verifyEnvelope(env, keys.publicKey)).toBe(false);
  });
});
