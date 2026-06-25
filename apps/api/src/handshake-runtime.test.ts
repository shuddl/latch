import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_214_STATUSEVENT, type MapArtifact } from '@latch/transform';
import { makeParty, runHandshake, type GoldenCase, type PartyConfig } from '@latch/handshake';
import { corpusRunner, buildGoldenFlow } from './handshake-runtime';

const FIXTURE_214 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/214/sample-214-001.edi', import.meta.url)),
  'utf8',
).trim();

const CASES_214: GoldenCase[] = [{ name: '214-real', input: FIXTURE_214 }];

function cfg214(org: string, map: MapArtifact): Omit<PartyConfig, 'keys'> {
  return {
    org,
    keyId: `${org}-key`,
    latchVersion: '1.0',
    canonicalVersions: ['1'],
    sets: ['214'],
    connectivity: ['as2'],
    sends: ['214'],
    golden: { '214': buildGoldenFlow(map, '214', CASES_214) },
    mapDigest: `digest-${org}`,
    commitments: { shipmentId: 'B10*02' },
    runCorpus: corpusRunner(map),
  };
}

describe('HSP co-certification wired to the real engine', () => {
  it('co-certifies a real 214 handshake end-to-end and produces a signed manifest', async () => {
    const initiator = await makeParty('initiator', cfg214('acme', MAP_214_STATUSEVENT));
    const responder = await makeParty('responder', cfg214('beta', MAP_214_STATUSEVENT));

    const out = await runHandshake(initiator, responder);
    expect(out.ok).toBe(true);
    expect(out.signedManifest?.manifest.coCertResultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.initiatorStatus).toBe('ACTIVE');
    // Sanity: the engine actually produced the expected canonical (real toCanonical, not echo).
    const produced = corpusRunner(MAP_214_STATUSEVENT)('214', CASES_214)[0]!;
    expect((produced.canonical as { statusCode?: string }).statusCode).toBe('X1');
  });

  it('fails co-certification when a party uses a map that mis-reads the data', async () => {
    // The responder's map points statusCode at the SCAC element — structurally valid,
    // semantically wrong, so its canonical output won't match the sender's intent.
    const brokenMap: MapArtifact = {
      ...MAP_214_STATUSEVENT,
      compiledHash: undefined,
      rules: MAP_214_STATUSEVENT.rules.map((r) =>
        r.kind === 'element' && r.path === 'statusCode'
          ? { ...r, source: { tag: 'B10', occurrence: 0, element: 3 } }
          : r,
      ),
    };
    const initiator = await makeParty('initiator', cfg214('acme', MAP_214_STATUSEVENT));
    const responder = await makeParty('responder', {
      ...cfg214('beta', MAP_214_STATUSEVENT),
      runCorpus: corpusRunner(brokenMap), // receiver mis-transforms the initiator's corpus
    });

    const out = await runHandshake(initiator, responder);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/co-certification/);
    expect(initiator.statusLog).toContain('COCERT_FAILED');
  });
});
