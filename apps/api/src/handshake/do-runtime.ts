// The Durable-Object runtime for HSP (docs/05, M6). Three pieces:
//   1. `engineFactoryForDO` — rebuilds the engine-backed corpus runner on every DO load by
//      reading the pinned {tenantId, mapId} from DO storage and loading that map from the store.
//      Fails CLOSED (canonical: null) when no map is pinned, so co-cert can never pass blind.
//   2. `handleHostRequest` — the thin HTTP surface a `HandshakeDO` exposes to the orchestrator:
//      POST /configure | /start | /receive and GET /state, each one transition, persisted.
//   3. `DurableObjectPeer` — the orchestrator's view of a REMOTE party: a `HandshakePeer` that
//      forwards each step to a peer DO over `stub.fetch` (real HSP-over-HTTPS).

import { corpusRunner } from '../handshake-runtime';
import { D1R2Store } from '../store/d1r2';
import type { Env } from '../env';
import type { HspEnvelope } from '@latch/handshake';
import { HandshakeHost, type HostSeed, type HostState, type HostStorage, type RunCorpusFactory } from './host';
import type { HandshakePeer } from './orchestrator';

/** Which map this DO uses to co-certify the peer's corpus (pinned at /configure). */
export interface EngineRef {
  tenantId: string;
  mapId: string;
}
const K_ENGINE = 'hsp:engine';

/** Rebuild the corpus runner from the pinned map; no map pinned → fail closed. */
export function engineFactoryForDO(storage: HostStorage, env: Env): RunCorpusFactory {
  return async () => {
    const ref = await storage.get<EngineRef>(K_ENGINE);
    if (!ref) return (_set, cases) => cases.map((c) => ({ name: c.name, canonical: null }));
    const store = new D1R2Store(env.LATCH_DB, env.LATCH_R2, env.LATCH_KV);
    const artifact = await store.getMapArtifact(ref.tenantId, ref.mapId);
    if (!artifact) return (_set, cases) => cases.map((c) => ({ name: c.name, canonical: null }));
    return corpusRunner(artifact);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Route one handshake HTTP request to the host. `storage` is the DO's storage (used both by the
 * host and to pin the engine ref); `host` wraps that same storage.
 */
export async function handleHostRequest(host: HandshakeHost, storage: HostStorage, req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  try {
    if (req.method === 'GET' && pathname.endsWith('/state')) {
      return json(await host.state());
    }
    if (req.method === 'POST' && pathname.endsWith('/configure')) {
      const body = (await req.json()) as { seed: HostSeed; tenantId: string; mapId: string };
      await storage.put(K_ENGINE, { tenantId: body.tenantId, mapId: body.mapId });
      await host.configure(body.seed);
      return json({ publicKey: await host.publicKey() });
    }
    if (req.method === 'POST' && pathname.endsWith('/start')) {
      const body = (await req.json()) as { sessionId: string };
      return json({ envelopes: await host.start(body.sessionId) });
    }
    if (req.method === 'POST' && pathname.endsWith('/receive')) {
      const body = (await req.json()) as { env: HspEnvelope };
      return json({ envelopes: await host.receive(body.env) });
    }
    return json({ error: 'no such handshake route' }, 404);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** A remote handshake party reached over HTTPS — the orchestrator drives two of these. */
export class DurableObjectPeer implements HandshakePeer {
  constructor(
    private readonly stub: DurableObjectStub,
    private readonly engine: EngineRef,
  ) {}

  async configure(seed: HostSeed): Promise<void> {
    await this.call('POST', '/configure', { seed, tenantId: this.engine.tenantId, mapId: this.engine.mapId });
  }
  async start(sessionId: string): Promise<HspEnvelope[]> {
    return (await this.call('POST', '/start', { sessionId })).envelopes as HspEnvelope[];
  }
  async receive(env: HspEnvelope): Promise<HspEnvelope[]> {
    return (await this.call('POST', '/receive', { env })).envelopes as HspEnvelope[];
  }
  async state(): Promise<HostState> {
    return (await this.call('GET', '/state')) as unknown as HostState;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ envelopes?: HspEnvelope[] } & Record<string, unknown>> {
    const init: RequestInit =
      body === undefined
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await this.stub.fetch(`https://handshake.internal${path}`, init);
    if (!res.ok) throw new Error(`handshake peer ${path} failed: ${res.status}`);
    return (await res.json()) as { envelopes?: HspEnvelope[] } & Record<string, unknown>;
  }
}
