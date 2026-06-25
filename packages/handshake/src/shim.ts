// The Latch-aware shim (docs/05 §"Latch-aware shim", M6.2): the minimal HTTP contract a
// partner who will NOT adopt the full platform hosts so they can still co-certify a connection.
// A shim is just the RESPONDER side of HSP wired to the partner's OWN transform — the single
// thing they must supply (`runCorpus`: their interpretation of inbound EDI → canonical). It
// reuses `HspParticipant`, so a shim partner reaches the same Ed25519 co-signed manifest a
// full Latch node does; the only difference is who runs the engine. This is the bridge from
// one-sided onboarding (Phase 1) to full bilateral (Phase 3).
//
// Contract (two endpoints):
//   GET  /.well-known/latch-hsp  → capabilities (version, key, sets it sends/receives)
//   POST /hsp                    → { envelope } ⇒ { envelopes: [...] }  (one transition)
// The shim is always the responder: it never initiates, only answers the Latch initiator's
// signed envelopes. State is kept per session; a handshake completes in a handful of round trips.

import { generateKeyPair, type KeyPair } from './sign';
import { HspParticipant, type ParticipantConfig } from './participant';
import type { HspEnvelope } from './types';

/** Everything a shim partner declares. Identical to a responder participant config, minus the
 *  fixed role and with an optional pre-provisioned keypair. `runCorpus` is the partner's own
 *  EDI→canonical transform (it may call out to their internal system). */
export type ShimConfig = Omit<ParticipantConfig, 'role' | 'keys'> & { keys?: KeyPair };

/** What `GET /.well-known/latch-hsp` returns — enough for an initiator to open HELLO. */
export interface ShimCapabilities {
  latchVersion: string;
  org: string;
  keyId: string;
  publicKey: string;
  canonicalVersions: string[];
  /** Sets the partner SENDS (and therefore co-certifies the initiator against). */
  sends: string[];
  /** Sets the partner can RECEIVE. */
  receives: string[];
  connectivity: string[];
}

const MAX_SESSIONS = 1000;

export class Shim {
  private readonly cfg: ParticipantConfig;
  private readonly sessions = new Map<string, HspParticipant>();

  private constructor(cfg: ParticipantConfig) {
    this.cfg = cfg;
  }

  static async create(config: ShimConfig): Promise<Shim> {
    const keys = config.keys ?? (await generateKeyPair());
    return new Shim({ ...config, role: 'responder', keys });
  }

  get publicKey(): string {
    return this.cfg.keys.publicKey;
  }

  capabilities(): ShimCapabilities {
    return {
      latchVersion: this.cfg.latchVersion,
      org: this.cfg.org,
      keyId: this.cfg.keyId,
      publicKey: this.cfg.keys.publicKey,
      canonicalVersions: this.cfg.canonicalVersions,
      sends: this.cfg.sends,
      receives: this.cfg.receives,
      connectivity: this.cfg.connectivity,
    };
  }

  /** Process one inbound signed envelope, returning the shim's signed replies. */
  async handle(env: HspEnvelope): Promise<HspEnvelope[]> {
    const participant = this.sessionFor(env.sessionId);
    return participant.receive(env);
  }

  /** Inspect a session's status/manifest (the partner's view of the proof). */
  state(sessionId: string): { status: string; signedManifest: unknown; error: string | null } | null {
    const p = this.sessions.get(sessionId);
    if (!p) return null;
    return { status: p.status, signedManifest: p.signedManifest, error: p.error };
  }

  private sessionFor(sessionId: string): HspParticipant {
    let p = this.sessions.get(sessionId);
    if (!p) {
      // Bound memory: a shim host is small, and stale/abandoned sessions must not accumulate.
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      p = new HspParticipant(this.cfg);
      this.sessions.set(sessionId, p);
    }
    return p;
  }
}

/**
 * A runtime-agnostic `fetch` handler implementing the shim's two-endpoint contract — deploy it
 * on Workers, Node, or anything with the Fetch API. Unknown routes → 404; malformed bodies → 400.
 */
export function shimFetchHandler(shim: Shim): (req: Request) => Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname.endsWith('/.well-known/latch-hsp')) {
      return json(shim.capabilities());
    }
    if (req.method === 'POST' && pathname.endsWith('/hsp')) {
      let body: { envelope?: HspEnvelope };
      try {
        body = (await req.json()) as { envelope?: HspEnvelope };
      } catch {
        return json({ error: 'body must be JSON { envelope }' }, 400);
      }
      if (!body.envelope || typeof body.envelope !== 'object') return json({ error: 'missing envelope' }, 400);
      return json({ envelopes: await shim.handle(body.envelope) });
    }
    return json({ error: 'no such shim route' }, 404);
  };
}
