// HandshakeHost — the persistence shell a `HandshakeDO` wraps around one `HspParticipant`
// (docs/05 §state machine, M6). A Durable Object may be evicted between any two transitions,
// so the host holds NOTHING in memory across calls: every `start`/`receive` rehydrates the
// participant purely from Durable-Object storage (the serialized protocol snapshot + the
// session keypair) and the engine-backed corpus runner, applies one transition, and persists
// the new snapshot before replying. This is exactly the eviction/resume path proven in
// @latch/handshake's participant tests, lifted onto real storage.

import {
  HspParticipant,
  type CanonicalResult,
  type GoldenCase,
  type HspEnvelope,
  type KeyPair,
  type ParticipantConfig,
  type ParticipantSnapshot,
  type SignedManifest,
  generateKeyPair,
} from '@latch/handshake';

/** The subset of `DurableObjectStorage` the host needs (so it can be tested without workerd). */
export interface HostStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

/** The serializable seed that defines a party — everything except its keys and live engine. */
export type HostSeed = Omit<ParticipantConfig, 'keys' | 'runCorpus'>;

/** Rebuild the inbound transform (engine-backed) for this party. Stateless given the map, so
 *  it can be reconstructed on every DO load. */
export type RunCorpusFactory = () => Promise<(set: string, cases: GoldenCase[]) => CanonicalResult[]>;

const K_SEED = 'hsp:seed';
const K_SNAP = 'hsp:snapshot';
const K_PUB = 'hsp:pub';
const K_PRIV = 'hsp:priv';

export interface HostState {
  status: string;
  statusLog: readonly string[];
  signedManifest: SignedManifest | null;
  error: string | null;
  sessionId: string | null;
}

export class HandshakeHost {
  constructor(
    private readonly storage: HostStorage,
    private readonly runCorpusFactory: RunCorpusFactory,
  ) {}

  /** First call for a session: pin the seed + a fresh keypair. Idempotent per DO instance. */
  async configure(seed: HostSeed): Promise<void> {
    if (await this.storage.get(K_SEED)) return; // already configured — keys are pinned
    const keys = await generateKeyPair();
    await this.storage.put(K_SEED, seed);
    await this.storage.put(K_PUB, keys.publicKey);
    // privateKey is a non-extractable CryptoKey at runtime; DO storage persists it via
    // structured clone (it is never serialized to JSON, so it never leaves the runtime).
    await this.storage.put(K_PRIV, keys.privateKey);
  }

  /** The party's pinned public key (base64 SPKI), for the peer/orchestrator to learn. */
  async publicKey(): Promise<string | undefined> {
    return this.storage.get<string>(K_PUB);
  }

  async start(sessionId: string): Promise<HspEnvelope[]> {
    const participant = await this.load();
    const out = await participant.start(sessionId);
    await this.persist(participant);
    return out;
  }

  async receive(env: HspEnvelope): Promise<HspEnvelope[]> {
    const participant = await this.load();
    const out = await participant.receive(env);
    await this.persist(participant);
    return out;
  }

  async state(): Promise<HostState> {
    const participant = await this.load();
    return {
      status: participant.status,
      statusLog: participant.statusLog,
      signedManifest: participant.signedManifest,
      error: participant.error,
      sessionId: participant.sessionId,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private async load(): Promise<HspParticipant> {
    const seed = await this.storage.get<HostSeed>(K_SEED);
    if (!seed) throw new Error('handshake host not configured');
    const publicKey = await this.storage.get<string>(K_PUB);
    const privateKey = await this.storage.get(K_PRIV);
    if (!publicKey || privateKey === undefined) throw new Error('handshake host missing session keys');
    const keys: KeyPair = { publicKey, privateKey };
    const runCorpus = await this.runCorpusFactory();
    const cfg: ParticipantConfig = { ...seed, keys, runCorpus };
    const snapshot = await this.storage.get<ParticipantSnapshot>(K_SNAP);
    return snapshot ? HspParticipant.fromSnapshot(cfg, snapshot) : new HspParticipant(cfg);
  }

  private async persist(participant: HspParticipant): Promise<void> {
    await this.storage.put(K_SNAP, participant.snapshot());
  }
}
