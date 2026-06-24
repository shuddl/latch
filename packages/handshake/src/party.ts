// The HSP state machine, driven (docs/05 §state machine). A `HandshakeParty` carries one
// side's keys, capabilities, golden corpora, and inbound transform; `runHandshake` shuttles
// signed envelopes between two parties through all six phases — HELLO → SPEC EXCHANGE → MAP
// NEGOTIATION → CO-CERTIFICATION → ATTESTATION → ACTIVATE — and returns the co-signed
// manifest. Pure of transport and storage: the same logic runs in a `HandshakeDO` over HTTPS
// or, here, between two in-process parties (so the protocol is provable without live peers).
//
// Co-certification is decoupled from the engine: each party supplies `runCorpus` (its inbound
// transform) and the golden corpus + intended canonical for the flows it sends, so the
// handshake never depends on @latch/transform — the real wiring slots in at the DO/API layer.

import { newId, stableStringify } from '@latch/shared';
import {
  generateKeyPair,
  sha256Hex,
  signEnvelope,
  signManifest,
  verifyEnvelope,
  verifyManifestSig,
  type KeyPair,
} from './sign';
import {
  HSP_VERSION,
  type CertManifest,
  type GoldenCase,
  type HandshakeStatus,
  type HspEnvelope,
  type HspParty,
  type SignedManifest,
} from './types';

export interface GoldenFlow {
  cases: GoldenCase[];
  /** What the SENDER means each case to become, canonically — the co-cert ground truth. */
  expected: { name: string; canonical: unknown }[];
}

export interface PartyConfig {
  org: string;
  keyId: string;
  keys: KeyPair;
  latchVersion: string;
  canonicalVersions: string[];
  sets: string[];
  connectivity: string[];
  /** Flows this party SENDS (it provides a golden corpus for each). */
  sends: string[];
  golden: Record<string, GoldenFlow>;
  mapDigest: string;
  commitments: Record<string, string>;
  /** This party's inbound transform: run a peer's corpus through its map → canonical results. */
  runCorpus: (set: string, cases: GoldenCase[]) => { name: string; canonical: unknown }[];
}

export class HandshakeParty {
  status: HandshakeStatus = 'INIT';
  readonly statusLog: HandshakeStatus[] = ['INIT'];
  constructor(
    readonly role: 'initiator' | 'responder',
    readonly cfg: PartyConfig,
  ) {}
  get identity(): HspParty {
    return { latchOrg: this.cfg.org, keyId: this.cfg.keyId };
  }
  advance(s: HandshakeStatus): void {
    this.status = s;
    this.statusLog.push(s);
  }
}

export interface HandshakeOutcome {
  ok: boolean;
  initiatorStatus: HandshakeStatus;
  responderStatus: HandshakeStatus;
  signedManifest?: SignedManifest;
  /** Every signed envelope exchanged, in order — the auditable transcript. */
  transcript: HspEnvelope[];
  error?: string;
}

/** Convenience: build a `HandshakeParty` generating a fresh key pair. */
export async function makeParty(
  role: 'initiator' | 'responder',
  cfg: Omit<PartyConfig, 'keys'> & { keys?: KeyPair },
): Promise<HandshakeParty> {
  const keys = cfg.keys ?? (await generateKeyPair());
  return new HandshakeParty(role, { ...cfg, keys });
}

function compareResults(
  expected: { name: string; canonical: unknown }[],
  got: { name: string; canonical: unknown }[],
): boolean {
  if (expected.length !== got.length) return false;
  const byName = new Map(got.map((r) => [r.name, stableStringify(r.canonical)]));
  return expected.every((e) => byName.get(e.name) === stableStringify(e.canonical));
}

/**
 * Drive a full bilateral handshake between two parties. Deterministic given the configs;
 * every cross-wire message is Ed25519-signed and verified by the receiver. On any failure
 * (version mismatch, bad signature, co-cert mismatch) both sides land in FAILED — the
 * caller falls back to one-sided onboarding (docs/05 §3) with no loss of correctness.
 */
export async function runHandshake(
  initiator: HandshakeParty,
  responder: HandshakeParty,
): Promise<HandshakeOutcome> {
  const sessionId = newId('handshake');
  const transcript: HspEnvelope[] = [];
  const pub: Record<string, string> = {
    [initiator.cfg.keyId]: initiator.cfg.keys.publicKey,
    [responder.cfg.keyId]: responder.cfg.keys.publicKey,
  };
  let seq = 0;

  // Send one signed envelope from `from`, verify it as `to`, append to the transcript.
  const exchange = async <P>(from: HandshakeParty, type: HspEnvelope['type'], payload: P): Promise<HspEnvelope<P>> => {
    const env = await signEnvelope<P>(
      { hspVersion: HSP_VERSION, sessionId, type, seq: seq++, sender: from.identity, payload },
      from.cfg.keys.privateKey,
    );
    const okSig = await verifyEnvelope(env, pub[from.cfg.keyId]!);
    if (!okSig) throw new Error(`signature verification failed for ${type}`);
    transcript.push(env);
    return env;
  };

  const fail = (error: string): HandshakeOutcome => {
    initiator.advance('FAILED');
    responder.advance('FAILED');
    return { ok: false, initiatorStatus: 'FAILED', responderStatus: 'FAILED', transcript, error };
  };

  try {
    // ── Phase 1: HELLO ──────────────────────────────────────────────────────
    await exchange(initiator, 'HELLO', {
      latchVersion: initiator.cfg.latchVersion,
      canonicalVersions: initiator.cfg.canonicalVersions,
      capabilities: { sets: initiator.cfg.sets, connectivity: initiator.cfg.connectivity },
      relationshipIntent: { send: initiator.cfg.sends, receive: responder.cfg.sends },
      publicKey: initiator.cfg.keys.publicKey,
    });
    initiator.advance('HELLO_SENT');
    const canonicalVersion = initiator.cfg.canonicalVersions.find((v) => responder.cfg.canonicalVersions.includes(v));
    if (!canonicalVersion) return fail('no common canonical-model version');
    responder.advance('HELLO_OK');
    await exchange(responder, 'HELLO_ACK', {
      canonicalVersion,
      supportedSets: responder.cfg.sets,
      connectivity: responder.cfg.connectivity,
      publicKey: responder.cfg.keys.publicKey,
    });
    initiator.advance('HELLO_OK');

    // ── Phase 2: SPEC EXCHANGE ──────────────────────────────────────────────
    const digestSpecs = async (p: HandshakeParty) => {
      const specDigests: Record<string, string> = {};
      for (const set of p.cfg.sends) specDigests[set] = await sha256Hex({ set, org: p.cfg.org });
      return specDigests;
    };
    await exchange(initiator, 'SPEC_OFFER', { specDigests: await digestSpecs(initiator) });
    await exchange(responder, 'SPEC_OFFER', { specDigests: await digestSpecs(responder) });
    initiator.advance('SPECS_EXCHANGED');
    responder.advance('SPECS_EXCHANGED');

    // ── Phase 3: MAP NEGOTIATION ────────────────────────────────────────────
    await exchange(initiator, 'MAP_PROPOSAL', { mapDigest: initiator.cfg.mapDigest, commitments: initiator.cfg.commitments });
    await exchange(responder, 'MAP_PROPOSAL', { mapDigest: responder.cfg.mapDigest, commitments: responder.cfg.commitments });
    initiator.advance('MAPS_PROPOSED');
    responder.advance('MAPS_PROPOSED');

    // ── Phase 4: CO-CERTIFICATION ───────────────────────────────────────────
    initiator.advance('COCERT_RUNNING');
    responder.advance('COCERT_RUNNING');
    const resultHashes: string[] = [];
    // For each flow a sender sends, the receiver runs the corpus and signs the result; the
    // sender verifies the signature and that the canonical output matches its intent.
    const coCertFlow = async (sender: HandshakeParty, receiver: HandshakeParty): Promise<boolean> => {
      for (const set of sender.cfg.sends) {
        const flow = sender.cfg.golden[set];
        if (!flow) return false;
        await exchange(sender, 'GOLDEN_SET', { set, cases: flow.cases });
        const results = receiver.cfg.runCorpus(set, flow.cases);
        const resultHash = await sha256Hex(results);
        const resultEnv = await exchange(receiver, 'GOLDEN_RESULT', { set, results, resultHash });
        if (!(await verifyEnvelope(resultEnv, pub[receiver.cfg.keyId]!))) return false;
        if (!compareResults(flow.expected, results)) return false;
        resultHashes.push(resultHash);
      }
      return true;
    };
    const coCertOk =
      (await coCertFlow(initiator, responder)) && (await coCertFlow(responder, initiator));
    if (!coCertOk) {
      initiator.advance('COCERT_FAILED');
      responder.advance('COCERT_FAILED');
      return fail('co-certification mismatch: a party did not reproduce the intended canonical');
    }
    initiator.advance('COCERT_PASSED');
    responder.advance('COCERT_PASSED');

    // ── Phase 5: ATTESTATION ────────────────────────────────────────────────
    const manifest: CertManifest = {
      hspVersion: HSP_VERSION,
      sessionId,
      canonicalVersion,
      parties: { initiator: initiator.identity, responder: responder.identity },
      mapDigests: { initiator: initiator.cfg.mapDigest, responder: responder.cfg.mapDigest },
      coCertResultHash: await sha256Hex(resultHashes),
      flows: { initiatorSends: initiator.cfg.sends, responderSends: responder.cfg.sends },
      createdAt: 0, // caller stamps the real time; kept fixed so the manifest hashes deterministically
    };
    const initiatorSig = await signManifest(manifest, initiator.cfg.keys.privateKey);
    const responderSig = await signManifest(manifest, responder.cfg.keys.privateKey);
    // Each side verifies the other's countersignature before trusting the manifest.
    const bothValid =
      (await verifyManifestSig(manifest, responderSig, responder.cfg.keys.publicKey)) &&
      (await verifyManifestSig(manifest, initiatorSig, initiator.cfg.keys.publicKey));
    if (!bothValid) return fail('manifest counter-signature did not verify');
    const signedManifest: SignedManifest = { manifest, initiatorSig, responderSig };
    initiator.advance('ATTESTED');
    responder.advance('ATTESTED');

    // ── Phase 6: ACTIVATE ───────────────────────────────────────────────────
    await exchange(initiator, 'ACTIVATE', { connectivity: responder.cfg.connectivity[0] ?? 'api', goLiveWindow: 'immediate' });
    await exchange(responder, 'ACTIVATE_ACK', {});
    initiator.advance('ACTIVE');
    responder.advance('ACTIVE');

    return {
      ok: true,
      initiatorStatus: 'ACTIVE',
      responderStatus: 'ACTIVE',
      signedManifest,
      transcript,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
