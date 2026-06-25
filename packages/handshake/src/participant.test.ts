import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './sign';
import { HspParticipant, type ParticipantConfig } from './participant';
import { driveHandshake } from './drive';
import type { CanonicalResult, GoldenCase } from './types';

// A trivial, deterministic "engine": canonical = { v: <case input> }. Two parties using this
// agree; a party using `skewed` produces { v: input + 'X' } and fails co-cert.
const engine =
  (skew = false) =>
  (_set: string, cases: GoldenCase[]): CanonicalResult[] =>
    cases.map((c) => ({ name: c.name, canonical: { v: skew ? `${c.input}X` : c.input } }));

const CASES: GoldenCase[] = [
  { name: 'c1', input: 'A' },
  { name: 'c2', input: 'B' },
];
const EXPECTED: CanonicalResult[] = engine()('214', CASES);

async function mkCfg(
  role: 'initiator' | 'responder',
  org: string,
  runCorpus: ParticipantConfig['runCorpus'],
): Promise<ParticipantConfig> {
  return {
    role,
    org,
    keyId: `${org}-key`,
    keys: await generateKeyPair(),
    latchVersion: '1.0',
    canonicalVersions: ['1'],
    sets: ['214'],
    connectivity: ['as2'],
    sends: ['214'],
    receives: ['214'],
    golden: { '214': { cases: CASES, expected: EXPECTED } },
    mapDigest: `digest-${org}`,
    commitments: { shipmentId: 'B10*02' },
    runCorpus,
  };
}

describe('HspParticipant over-the-wire handshake', () => {
  it('co-certifies a bilateral handshake end-to-end → both ACTIVE + countersigned manifest', async () => {
    const init = new HspParticipant(await mkCfg('initiator', 'acme', engine()));
    const resp = new HspParticipant(await mkCfg('responder', 'beta', engine()));

    const out = await driveHandshake(init, resp, 'session-1');

    expect(out.ok).toBe(true);
    expect(out.initiatorStatus).toBe('ACTIVE');
    expect(out.responderStatus).toBe('ACTIVE');
    expect(out.signedManifest?.initiatorSig).toBeTruthy();
    expect(out.signedManifest?.responderSig).toBeTruthy();
    expect(out.signedManifest?.manifest.coCertResultHash).toMatch(/^[0-9a-f]{64}$/);
    // Both sides converged on the identical manifest (so both can persist the same proof).
    expect(resp.signedManifest?.manifest).toEqual(init.signedManifest?.manifest);
    expect(resp.signedManifest?.responderSig).toBe(init.signedManifest?.responderSig);
  });

  it('fails CLOSED when the responder mis-reads the data (co-cert mismatch)', async () => {
    const init = new HspParticipant(await mkCfg('initiator', 'acme', engine()));
    const resp = new HspParticipant(await mkCfg('responder', 'beta', engine(true))); // skewed engine

    const out = await driveHandshake(init, resp, 'session-2');

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/co-certification/);
    // The initiator detects the mismatch on the responder's GOLDEN_RESULT for the initiator's set.
    expect([...init.statusLog, ...resp.statusLog]).toContain('FAILED');
    expect(init.signedManifest).toBeNull();
  });

  it('rejects a relationship the responder cannot fulfill', async () => {
    const initCfg = await mkCfg('initiator', 'acme', engine());
    const respCfg = await mkCfg('responder', 'beta', engine());
    // Responder sends a different set than the initiator wants to receive.
    const init = new HspParticipant({ ...initCfg, receives: ['990'], sends: ['990'], golden: { '990': { cases: CASES, expected: EXPECTED } } });
    const resp = new HspParticipant(respCfg);

    const out = await driveHandshake(init, resp, 'session-3');
    expect(out.ok).toBe(false);
    expect(resp.status).toBe('FAILED');
  });

  it('survives eviction: reconstructing BOTH sides from their snapshot before every transition still reaches ACTIVE', async () => {
    const initCfg = await mkCfg('initiator', 'acme', engine());
    const respCfg = await mkCfg('responder', 'beta', engine());

    // Seed: initiator starts, snapshot immediately (as a DO would persist before responding).
    const init0 = new HspParticipant(initCfg);
    const first = await init0.start('session-resume');
    let initSnap = init0.snapshot();
    let respSnap = new HspParticipant(respCfg).snapshot();

    const queue: { role: 'initiator' | 'responder'; env: (typeof first)[number] }[] = first.map((env) => ({ role: 'responder', env }));

    for (let steps = 0; steps < 1000 && queue.length > 0; steps++) {
      const { role, env } = queue.shift()!;
      // Rehydrate the target party purely from persisted state — the eviction/resume path.
      const cfg = role === 'responder' ? respCfg : initCfg;
      const snap = role === 'responder' ? respSnap : initSnap;
      const party = HspParticipant.fromSnapshot(cfg, snap);
      const replies = await party.receive(env);
      const next = party.snapshot();
      if (role === 'responder') respSnap = next;
      else initSnap = next;
      const peerRole = role === 'responder' ? 'initiator' : 'responder';
      for (const r of replies) queue.push({ role: peerRole, env: r });
    }

    expect(initSnap.status).toBe('ACTIVE');
    expect(respSnap.status).toBe('ACTIVE');
    expect(initSnap.signedManifest?.responderSig).toBeTruthy();
    expect(initSnap.signedManifest?.manifest).toEqual(respSnap.signedManifest?.manifest);
  });

  it('snapshot is JSON-serializable and round-trips exactly', async () => {
    const init = new HspParticipant(await mkCfg('initiator', 'acme', engine()));
    const resp = new HspParticipant(await mkCfg('responder', 'beta', engine()));
    await driveHandshake(init, resp, 'session-json');
    const snap = init.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});
