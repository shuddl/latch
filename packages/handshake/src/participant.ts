// The HSP state machine as a REACTIVE, single-party, serializable participant — the form a
// `HandshakeDO` hosts over HTTPS (docs/05 §state machine). Where `runHandshake` (party.ts)
// drives both sides in one process for provability, an `HspParticipant` is exactly one side:
// it consumes one signed inbound envelope at a time and emits zero or more signed replies,
// persisting its whole protocol state between transitions so a Durable Object can be evicted
// and resumed mid-handshake. Two participants exchanging envelopes over any transport reach
// the identical signed manifest a co-located `runHandshake` would — same co-cert helpers,
// same manifest construction (cocert.ts), so the proof is transport-independent.
//
// Co-certification stays decoupled from the engine: the caller injects `runCorpus`. The
// machine fails CLOSED — any signature, version, relationship, manifest, or co-cert mismatch
// drives this side to FAILED and emits an ERROR envelope so the peer follows.

import { compareResults, buildManifest } from './cocert';
import { sha256Hex, signEnvelope, signManifest, verifyEnvelope, verifyManifestSig, type KeyPair } from './sign';
import {
  HSP_VERSION,
  type CanonicalResult,
  type CertManifest,
  type GoldenCase,
  type HandshakeStatus,
  type HspEnvelope,
  type HspParty,
  type HspType,
  type SignedManifest,
} from './types';

/** Flows this party SENDS, with the canonical each case is meant to become (co-cert truth). */
export interface ParticipantGolden {
  cases: GoldenCase[];
  expected: CanonicalResult[];
}

/** Everything a participant needs that ISN'T serialized: keys, the inbound transform, and
 *  the golden corpora it publishes. The DO supplies these freshly on every load. */
export interface ParticipantConfig {
  role: 'initiator' | 'responder';
  org: string;
  keyId: string;
  keys: KeyPair;
  latchVersion: string;
  canonicalVersions: string[];
  sets: string[];
  connectivity: string[];
  /** Sets this party sends (each needs a golden flow). */
  sends: string[];
  /** Sets this party wants to RECEIVE from the peer — the initiator's request, which the
   *  responder confirms it sends. Both sides derive the same co-cert queue from this. */
  receives: string[];
  golden: Record<string, ParticipantGolden>;
  mapDigest: string;
  commitments: Record<string, string>;
  runCorpus: (set: string, cases: GoldenCase[]) => CanonicalResult[];
}

/** One co-certification flow in protocol order: who owns (sends) it, and which set. */
interface CocertEntry {
  owner: 'initiator' | 'responder';
  set: string;
}

/** The fully JSON-serializable protocol state — what a DO persists between transitions. */
export interface ParticipantSnapshot {
  role: 'initiator' | 'responder';
  status: HandshakeStatus;
  statusLog: HandshakeStatus[];
  sessionId: string | null;
  outSeq: number;
  peer: { identity: HspParty; publicKey: string; mapDigest: string | null } | null;
  canonicalVersion: string | null;
  initiatorSends: string[];
  responderSends: string[];
  cocert: CocertEntry[];
  cocertCursor: number;
  resultHashes: string[];
  attestSent: boolean;
  manifest: CertManifest | null;
  signedManifest: SignedManifest | null;
  transcript: HspEnvelope[];
  error: string | null;
}

const TERMINAL: ReadonlySet<HandshakeStatus> = new Set(['ACTIVE', 'FAILED']);

function freshSnapshot(role: 'initiator' | 'responder'): ParticipantSnapshot {
  return {
    role,
    status: 'INIT',
    statusLog: ['INIT'],
    sessionId: null,
    outSeq: 0,
    peer: null,
    canonicalVersion: null,
    initiatorSends: [],
    responderSends: [],
    cocert: [],
    cocertCursor: 0,
    resultHashes: [],
    attestSent: false,
    manifest: null,
    signedManifest: null,
    transcript: [],
    error: null,
  };
}

export class HspParticipant {
  private s: ParticipantSnapshot;

  constructor(
    readonly cfg: ParticipantConfig,
    snapshot?: ParticipantSnapshot,
  ) {
    this.s = snapshot ?? freshSnapshot(cfg.role);
  }

  /** Restore a participant mid-handshake from persisted state (DO resume). */
  static fromSnapshot(cfg: ParticipantConfig, snapshot: ParticipantSnapshot): HspParticipant {
    return new HspParticipant(cfg, snapshot);
  }

  /** A deep, JSON-safe copy of the protocol state for persistence. */
  snapshot(): ParticipantSnapshot {
    return JSON.parse(JSON.stringify(this.s)) as ParticipantSnapshot;
  }

  get status(): HandshakeStatus {
    return this.s.status;
  }
  get statusLog(): readonly HandshakeStatus[] {
    return this.s.statusLog;
  }
  get signedManifest(): SignedManifest | null {
    return this.s.signedManifest;
  }
  get error(): string | null {
    return this.s.error;
  }
  get sessionId(): string | null {
    return this.s.sessionId;
  }

  private get identity(): HspParty {
    return { latchOrg: this.cfg.org, keyId: this.cfg.keyId };
  }

  private advance(status: HandshakeStatus): void {
    this.s.status = status;
    this.s.statusLog.push(status);
  }

  private async emit<P>(type: HspType, payload: P): Promise<HspEnvelope<P>> {
    const env = await signEnvelope<P>(
      {
        hspVersion: HSP_VERSION,
        sessionId: this.s.sessionId ?? '',
        type,
        seq: this.s.outSeq++,
        sender: this.identity,
        payload,
      },
      this.cfg.keys.privateKey,
    );
    this.s.transcript.push(env);
    return env;
  }

  private fail(detail: string): HspEnvelope[] {
    this.s.error = detail;
    this.advance('FAILED');
    // Best-effort ERROR so the peer also fails closed (unsigned-safe: peer treats ERROR specially).
    const env: HspEnvelope = {
      hspVersion: HSP_VERSION,
      sessionId: this.s.sessionId ?? '',
      type: 'ERROR',
      seq: this.s.outSeq++,
      sender: this.identity,
      payload: { code: 'HSP_FAIL', phase: this.s.status, detail, recoverable: false },
    };
    this.s.transcript.push(env);
    return [env];
  }

  /** Initiator only: produce the opening HELLO. */
  async start(sessionId: string): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'initiator') return this.fail('only the initiator may start a handshake');
    if (this.s.status !== 'INIT') return this.fail(`cannot start from status ${this.s.status}`);
    this.s.sessionId = sessionId;
    const hello = await this.emit('HELLO', {
      latchVersion: this.cfg.latchVersion,
      canonicalVersions: this.cfg.canonicalVersions,
      capabilities: { sets: this.cfg.sets, connectivity: this.cfg.connectivity },
      relationshipIntent: { send: this.cfg.sends, receive: this.cfg.receives },
      publicKey: this.cfg.keys.publicKey,
    });
    this.advance('HELLO_SENT');
    return [hello];
  }

  /**
   * Consume one inbound envelope; return zero or more signed replies. Pure of transport: a
   * driver pumps the returned envelopes to the peer and feeds the peer's replies back here
   * until both sides quiesce (ACTIVE) or one fails (FAILED).
   */
  async receive(env: HspEnvelope): Promise<HspEnvelope[]> {
    if (TERMINAL.has(this.s.status)) return [];
    if (env.type === 'ERROR') {
      this.s.error = `peer error: ${describeError(env.payload)}`;
      this.advance('FAILED');
      return [];
    }
    // Bind the session on first contact; reject envelopes that jump sessions.
    if (this.s.sessionId === null) this.s.sessionId = env.sessionId;
    if (env.sessionId !== this.s.sessionId) return this.fail('envelope session id mismatch');

    try {
      const sigOk = await this.verifyInbound(env);
      if (!sigOk) return this.fail(`signature verification failed for ${env.type}`);
      this.s.transcript.push(env);
      return await this.dispatch(env);
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** HELLO/HELLO_ACK carry the peer key inline (first contact); everything later uses it pinned. */
  private async verifyInbound(env: HspEnvelope): Promise<boolean> {
    if (env.type === 'HELLO' || env.type === 'HELLO_ACK') {
      const pk = (env.payload as { publicKey?: string }).publicKey;
      return typeof pk === 'string' && verifyEnvelope(env, pk);
    }
    if (!this.s.peer) return false;
    return verifyEnvelope(env, this.s.peer.publicKey);
  }

  private async dispatch(env: HspEnvelope): Promise<HspEnvelope[]> {
    switch (env.type) {
      case 'HELLO':
        return this.onHello(env.payload as HelloIn, env.sender);
      case 'HELLO_ACK':
        return this.onHelloAck(env.payload as HelloAckIn, env.sender);
      case 'SPEC_OFFER':
        return this.onSpecOffer();
      case 'MAP_PROPOSAL':
        return this.onMapProposal(env.payload as { mapDigest: string });
      case 'GOLDEN_SET':
        return this.onGoldenSet(env.payload as { set: string; cases: GoldenCase[] });
      case 'GOLDEN_RESULT':
        return this.onGoldenResult(env.payload as { set: string; results: CanonicalResult[]; resultHash: string });
      case 'ATTEST':
        return this.onAttest(env.payload as { manifest: CertManifest; initiatorSig: string });
      case 'ATTEST_ACK':
        return this.onAttestAck(env.payload as { responderSig: string });
      case 'ACTIVATE':
        return this.onActivate();
      case 'ACTIVATE_ACK':
        return this.onActivateAck();
      default:
        return this.fail(`unexpected envelope type ${env.type}`);
    }
  }

  // ── Phase 1: HELLO (responder) ─────────────────────────────────────────────
  private async onHello(p: HelloIn, sender: HspParty): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'responder') return this.fail('initiator received HELLO');
    // Pick the common canonical version using the INITIATOR's preference order (matches runHandshake).
    const canonicalVersion = p.canonicalVersions.find((v) => this.cfg.canonicalVersions.includes(v));
    if (!canonicalVersion) return this.fail('no common canonical-model version');
    // The relationship is defined by the initiator's intent: it sends `send`, we send `receive`.
    // We must send exactly what it asked to receive, and it must send what we want to receive.
    const responderSends = p.relationshipIntent.receive;
    if (!sameSet(responderSends, this.cfg.sends)) return this.fail('relationship intent does not match responder sends');
    if (!sameSet(p.relationshipIntent.send, this.cfg.receives)) return this.fail('initiator sends do not match responder receives');
    this.s.peer = { identity: sender, publicKey: p.publicKey, mapDigest: null };
    this.s.canonicalVersion = canonicalVersion;
    this.s.initiatorSends = p.relationshipIntent.send;
    this.s.responderSends = responderSends;
    this.s.cocert = buildCocertQueue(this.s.initiatorSends, this.s.responderSends);
    this.advance('HELLO_OK');
    const ack = await this.emit('HELLO_ACK', {
      canonicalVersion,
      supportedSets: this.cfg.sets,
      connectivity: this.cfg.connectivity,
      publicKey: this.cfg.keys.publicKey,
    });
    return [ack];
  }

  // ── Phase 1: HELLO_ACK (initiator) → start SPEC EXCHANGE ───────────────────
  private async onHelloAck(p: HelloAckIn, sender: HspParty): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'initiator') return this.fail('responder received HELLO_ACK');
    if (!this.cfg.canonicalVersions.includes(p.canonicalVersion)) return this.fail('responder chose an unsupported canonical version');
    // The responder must be able to send everything we asked to receive.
    if (!this.cfg.receives.every((set) => p.supportedSets.includes(set))) {
      return this.fail('responder cannot send all requested sets');
    }
    this.s.peer = { identity: sender, publicKey: p.publicKey, mapDigest: null };
    this.s.canonicalVersion = p.canonicalVersion;
    this.s.initiatorSends = this.cfg.sends;
    this.s.responderSends = this.cfg.receives; // what we requested == what the responder will send
    this.s.cocert = buildCocertQueue(this.s.initiatorSends, this.s.responderSends);
    this.advance('HELLO_OK');
    return [await this.emit('SPEC_OFFER', { specDigests: await this.specDigests() })];
  }

  // ── Phase 2: SPEC EXCHANGE ─────────────────────────────────────────────────
  private async onSpecOffer(): Promise<HspEnvelope[]> {
    if (this.cfg.role === 'responder') {
      // Responder answers the initiator's offer with its own, then awaits MAP_PROPOSAL.
      this.advance('SPECS_EXCHANGED');
      return [await this.emit('SPEC_OFFER', { specDigests: await this.specDigests() })];
    }
    // Initiator received the responder's counter-offer → move to MAP NEGOTIATION.
    this.advance('SPECS_EXCHANGED');
    return [await this.emit('MAP_PROPOSAL', { mapDigest: this.cfg.mapDigest, commitments: this.cfg.commitments })];
  }

  // ── Phase 3: MAP NEGOTIATION ───────────────────────────────────────────────
  private async onMapProposal(p: { mapDigest: string }): Promise<HspEnvelope[]> {
    if (!this.s.peer) return this.fail('MAP_PROPOSAL before HELLO');
    this.s.peer.mapDigest = p.mapDigest;
    if (this.cfg.role === 'responder') {
      this.advance('MAPS_PROPOSED');
      const reply = await this.emit('MAP_PROPOSAL', { mapDigest: this.cfg.mapDigest, commitments: this.cfg.commitments });
      // Responder may own the first co-cert entry only if the initiator sends nothing; drive it.
      return [reply, ...(await this.driveCocert())];
    }
    this.advance('MAPS_PROPOSED');
    this.advance('COCERT_RUNNING');
    return this.driveCocert();
  }

  // ── Phase 4: CO-CERTIFICATION ──────────────────────────────────────────────
  /** Emit the next GOLDEN_SET we own, or (when co-cert is complete) the initiator's ATTEST. */
  private async driveCocert(): Promise<HspEnvelope[]> {
    if (this.s.status === 'MAPS_PROPOSED') this.advance('COCERT_RUNNING');
    const cursor = this.s.cocertCursor;
    if (cursor < this.s.cocert.length) {
      const entry = this.s.cocert[cursor]!;
      if (entry.owner !== this.cfg.role) return []; // not our turn; the peer drives this one
      const golden = this.cfg.golden[entry.set];
      if (!golden) return this.fail(`missing golden flow for set ${entry.set}`);
      return [await this.emit('GOLDEN_SET', { set: entry.set, cases: golden.cases })];
    }
    // All flows co-certified.
    if (this.s.status === 'COCERT_RUNNING') this.advance('COCERT_PASSED');
    if (this.cfg.role === 'initiator' && !this.s.attestSent) return this.sendAttest();
    return [];
  }

  private async onGoldenSet(p: { set: string; cases: GoldenCase[] }): Promise<HspEnvelope[]> {
    const cursor = this.s.cocertCursor;
    const entry = this.s.cocert[cursor];
    if (!entry || entry.set !== p.set || entry.owner === this.cfg.role) return this.fail(`unexpected GOLDEN_SET for ${p.set}`);
    if (this.s.status === 'MAPS_PROPOSED') this.advance('COCERT_RUNNING');
    const results = this.cfg.runCorpus(p.set, p.cases);
    const resultHash = await sha256Hex(results);
    const reply = await this.emit('GOLDEN_RESULT', { set: p.set, results, resultHash });
    this.s.resultHashes.push(resultHash);
    this.s.cocertCursor++;
    return [reply, ...(await this.driveCocert())];
  }

  private async onGoldenResult(p: { set: string; results: CanonicalResult[]; resultHash: string }): Promise<HspEnvelope[]> {
    const cursor = this.s.cocertCursor;
    const entry = this.s.cocert[cursor];
    if (!entry || entry.set !== p.set || entry.owner !== this.cfg.role) return this.fail(`unexpected GOLDEN_RESULT for ${p.set}`);
    const golden = this.cfg.golden[p.set];
    if (!golden) return this.fail(`missing golden flow for set ${p.set}`);
    // Verify the receiver reproduced exactly our intended canonical, and that the hash matches.
    if ((await sha256Hex(p.results)) !== p.resultHash) return this.fail('GOLDEN_RESULT hash mismatch');
    if (!compareResults(golden.expected, p.results)) {
      return this.fail('co-certification mismatch: peer did not reproduce the intended canonical');
    }
    this.s.resultHashes.push(p.resultHash);
    this.s.cocertCursor++;
    return this.driveCocert();
  }

  // ── Phase 5: ATTESTATION ───────────────────────────────────────────────────
  private async sendAttest(): Promise<HspEnvelope[]> {
    const manifest = await this.composeManifest();
    if (!manifest) return this.fail('cannot compose manifest (missing peer)');
    const initiatorSig = await signManifest(manifest, this.cfg.keys.privateKey);
    this.s.manifest = manifest;
    this.s.signedManifest = { manifest, initiatorSig };
    this.s.attestSent = true;
    return [await this.emit('ATTEST', { manifest, initiatorSig })];
  }

  private async onAttest(p: { manifest: CertManifest; initiatorSig: string }): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'responder') return this.fail('initiator received ATTEST');
    if (this.s.status === 'COCERT_RUNNING') this.advance('COCERT_PASSED');
    const expected = await this.composeManifest();
    if (!expected) return this.fail('cannot compose manifest (missing peer)');
    // The initiator's manifest must match what we independently derived (no lying about flows/hashes).
    if (stable(p.manifest) !== stable(expected)) return this.fail('manifest does not match independently-derived manifest');
    if (!this.s.peer) return this.fail('ATTEST before HELLO');
    if (!(await verifyManifestSig(p.manifest, p.initiatorSig, this.s.peer.publicKey))) {
      return this.fail('initiator manifest signature did not verify');
    }
    const responderSig = await signManifest(p.manifest, this.cfg.keys.privateKey);
    this.s.manifest = p.manifest;
    this.s.signedManifest = { manifest: p.manifest, initiatorSig: p.initiatorSig, responderSig };
    this.advance('ATTESTED');
    return [await this.emit('ATTEST_ACK', { responderSig })];
  }

  private async onAttestAck(p: { responderSig: string }): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'initiator') return this.fail('responder received ATTEST_ACK');
    if (!this.s.manifest || !this.s.peer) return this.fail('ATTEST_ACK before ATTEST');
    if (!(await verifyManifestSig(this.s.manifest, p.responderSig, this.s.peer.publicKey))) {
      return this.fail('responder counter-signature did not verify');
    }
    this.s.signedManifest = { ...(this.s.signedManifest ?? { manifest: this.s.manifest }), responderSig: p.responderSig };
    this.advance('ATTESTED');
    // ── Phase 6: ACTIVATE ──
    return [await this.emit('ACTIVATE', { connectivity: this.cfg.connectivity[0] ?? 'api', goLiveWindow: 'immediate' })];
  }

  // ── Phase 6: ACTIVATE ──────────────────────────────────────────────────────
  private async onActivate(): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'responder') return this.fail('initiator received ACTIVATE');
    this.advance('ACTIVE');
    return [await this.emit('ACTIVATE_ACK', {})];
  }

  private async onActivateAck(): Promise<HspEnvelope[]> {
    if (this.cfg.role !== 'initiator') return this.fail('responder received ACTIVATE_ACK');
    this.advance('ACTIVE');
    return [];
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private async specDigests(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const set of this.cfg.sends) out[set] = await sha256Hex({ set, org: this.cfg.org });
    return out;
  }

  private async composeManifest(): Promise<CertManifest | null> {
    if (!this.s.peer || !this.s.canonicalVersion) return null;
    const self = this.identity;
    const peer = this.s.peer.identity;
    const initiator = this.cfg.role === 'initiator' ? self : peer;
    const responder = this.cfg.role === 'responder' ? self : peer;
    const initiatorMapDigest = this.cfg.role === 'initiator' ? this.cfg.mapDigest : (this.s.peer.mapDigest ?? '');
    const responderMapDigest = this.cfg.role === 'responder' ? this.cfg.mapDigest : (this.s.peer.mapDigest ?? '');
    return buildManifest({
      hspVersion: HSP_VERSION,
      sessionId: this.s.sessionId ?? '',
      canonicalVersion: this.s.canonicalVersion,
      initiator,
      responder,
      initiatorMapDigest,
      responderMapDigest,
      coCertResultHash: await sha256Hex(this.s.resultHashes),
      initiatorSends: this.s.initiatorSends,
      responderSends: this.s.responderSends,
    });
  }
}

// ── module helpers ─────────────────────────────────────────────────────────────
type HelloIn = {
  latchVersion: string;
  canonicalVersions: string[];
  capabilities: { sets: string[]; connectivity: string[] };
  relationshipIntent: { send: string[]; receive: string[] };
  publicKey: string;
};
type HelloAckIn = { canonicalVersion: string; supportedSets: string[]; connectivity: string[]; publicKey: string };

function buildCocertQueue(initiatorSends: string[], responderSends: string[]): CocertEntry[] {
  return [
    ...initiatorSends.map((set): CocertEntry => ({ owner: 'initiator', set })),
    ...responderSends.map((set): CocertEntry => ({ owner: 'responder', set })),
  ];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function stable(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function describeError(payload: unknown): string {
  const p = payload as { detail?: string; code?: string } | null;
  return p?.detail ?? p?.code ?? 'unknown';
}
