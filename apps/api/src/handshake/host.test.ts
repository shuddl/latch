import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import type { GoldenCase } from '@latch/handshake';
import { corpusRunner, buildGoldenFlow } from '../handshake-runtime';
import { HandshakeHost, type HostSeed, type HostStorage } from './host';
import { orchestrateBilateral } from './orchestrator';

const FIXTURE_214 = readFileSync(
  fileURLToPath(new URL('../../../../fixtures/214/sample-214-001.edi', import.meta.url)),
  'utf8',
).trim();
const CASES: GoldenCase[] = [{ name: '214-real', input: FIXTURE_214 }];

/** A faithful stand-in for DurableObjectStorage: a Map with structured-clone-ish semantics. */
class MemoryStorage implements HostStorage {
  private readonly m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.m.set(key, value);
  }
}

function seed(role: 'initiator' | 'responder', org: string): HostSeed {
  return {
    role,
    org,
    keyId: `${org}-key`,
    latchVersion: '1.0',
    canonicalVersions: ['1'],
    sets: ['214'],
    connectivity: ['as2'],
    sends: ['214'],
    receives: ['214'],
    golden: { '214': buildGoldenFlow(MAP_214_STATUSEVENT, '214', CASES) },
    mapDigest: `digest-${org}`,
    commitments: { shipmentId: 'B10*02' },
  };
}

function host(): HandshakeHost {
  // Each load rebuilds the engine-backed corpus runner from the pinned map (stateless).
  return new HandshakeHost(new MemoryStorage(), async () => corpusRunner(MAP_214_STATUSEVENT));
}

describe('HandshakeHost + orchestrator (DO-shaped persistence over the real engine)', () => {
  it('orchestrates a real 214 bilateral handshake to a co-signed manifest, persisted in storage', async () => {
    const initiator = host();
    const responder = host();

    const out = await orchestrateBilateral(initiator, responder, seed('initiator', 'acme'), seed('responder', 'beta'), 'do-session-1');

    expect(out.ok).toBe(true);
    expect(out.initiatorStatus).toBe('ACTIVE');
    expect(out.responderStatus).toBe('ACTIVE');
    expect(out.signedManifest?.initiatorSig).toBeTruthy();
    expect(out.signedManifest?.responderSig).toBeTruthy();
    expect(out.signedManifest?.manifest.coCertResultHash).toMatch(/^[0-9a-f]{64}$/);

    // The manifest survives in each side's storage (a later GET /state returns it).
    const persisted = await initiator.state();
    expect(persisted.status).toBe('ACTIVE');
    expect(persisted.signedManifest?.manifest).toEqual(out.signedManifest?.manifest);
    const respPersisted = await responder.state();
    expect(respPersisted.signedManifest?.manifest).toEqual(out.signedManifest?.manifest);
  });

  it('keys are pinned on first configure and reused across transitions', async () => {
    const h = host();
    await h.configure(seed('initiator', 'acme'));
    const pk1 = await h.publicKey();
    // A second configure is a no-op (keys already pinned) — eviction must not rotate keys.
    await h.configure(seed('initiator', 'acme'));
    const pk2 = await h.publicKey();
    expect(pk1).toBeTruthy();
    expect(pk2).toBe(pk1);
  });

  it('fails CLOSED when one side hosts a map that mis-reads the data', async () => {
    const initiator = host();
    // Responder rebuilds a broken corpus runner (statusCode ← SCAC), so its canonical won't match.
    const brokenResponder = new HandshakeHost(new MemoryStorage(), async () =>
      corpusRunner({
        ...MAP_214_STATUSEVENT,
        compiledHash: undefined,
        rules: MAP_214_STATUSEVENT.rules.map((r) =>
          r.kind === 'element' && r.path === 'statusCode' ? { ...r, source: { tag: 'B10', occurrence: 0, element: 3 } } : r,
        ),
      }),
    );

    const out = await orchestrateBilateral(initiator, brokenResponder, seed('initiator', 'acme'), seed('responder', 'beta'), 'do-session-2');

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/co-certification|ACTIVE/);
    expect((await initiator.state()).signedManifest).toBeNull();
  });
});
