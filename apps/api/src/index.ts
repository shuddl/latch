// apps/api — Cloudflare Worker entry. Hosts the control-plane HTTP API and the
// inbound transaction-processing queue consumer, both backed by the production D1+R2
// store (docs/04, docs/08). Durable Objects are exported for the declared bindings.

import { createApp } from './app';
import { D1R2Store } from './store/d1r2';
import { KvRateLimiter } from './ratelimit';
import { ingestInbound } from './ingest';
import { createAnthropicClient } from '@latch/shared';
import { HandshakeHost } from './handshake/host';
import { engineFactoryForDO, handleHostRequest } from './handshake/do-runtime';
import { ControlSequencer } from './connection/sequencer';
import type { Env } from './env';

const app = createApp(
  (env) => new D1R2Store(env.LATCH_DB, env.LATCH_R2, env.LATCH_KV),
  // Build/heal-time AI is available only when the key is configured (a Cloudflare
  // secret). Without it, callers register explicit maps; the runtime is never affected.
  (env) =>
    env.ANTHROPIC_API_KEY
      ? createAnthropicClient({
          apiKey: env.ANTHROPIC_API_KEY,
          ...(env.ANTHROPIC_MODEL ? { model: env.ANTHROPIC_MODEL } : {}),
        })
      : null,
  // Per-tenant rate limiting on KV (a soft limit; fails open on a KV hiccup).
  (env) => new KvRateLimiter(env.LATCH_KV),
);

interface InboundMessage {
  tenantId: string;
  connectionId: string;
  raw: string;
}

export default {
  fetch: app.fetch,

  // txn-ingest consumer: the connectivity adapters (SFTP/AS2) archive raw inbound to
  // R2 and enqueue; here we transform via the pinned map and persist (docs/04).
  async queue(batch: MessageBatch<InboundMessage>, env: Env): Promise<void> {
    const store = new D1R2Store(env.LATCH_DB, env.LATCH_R2, env.LATCH_KV);
    for (const msg of batch.messages) {
      try {
        const { tenantId, connectionId, raw } = msg.body;
        const connection = await store.getConnection(tenantId, connectionId);
        if (!connection?.activeMapId) {
          msg.ack(); // nothing we can do; don't retry forever
          continue;
        }
        const artifact = await store.getMapArtifact(tenantId, connection.activeMapId);
        if (!artifact) {
          msg.ack();
          continue;
        }
        await ingestInbound(store, tenantId, connection, connection.activeMapId, artifact, raw);
        msg.ack();
      } catch (err) {
        console.error(JSON.stringify({ msg: 'queue processing failed', id: msg.id, error: String(err) }));
        msg.retry();
      }
    }
  },
};

// Per-connection state (task 2.3): atomic outbound control-number sequencing. A DO is
// single-threaded per connection, so control numbers are issued without races even under
// concurrent outbound sends; counters persist in DO storage and survive eviction.
//   POST /allocate → the next interchange/group/ST control-number triple (advances)
//   GET  /sequence → the last-issued triple (no advance)
export class ConnectionDO {
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}
  async fetch(req: Request): Promise<Response> {
    const seq = new ControlSequencer(this.state.storage);
    const { pathname } = new URL(req.url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (req.method === 'POST' && pathname.endsWith('/allocate')) return json(await seq.allocate());
    if (req.method === 'GET' && pathname.endsWith('/sequence')) return json(await seq.peek());
    return json({ error: 'no such connection route' }, 404);
  }
}

// Hosts one side of a bilateral handshake (docs/05, M6). Each request is one HSP transition;
// the participant state is rehydrated from this DO's storage every time, so the DO can be
// evicted and resumed mid-handshake. The engine-backed corpus runner is rebuilt per load from
// the pinned map, so no live transform state is held between transitions.
export class HandshakeDO {
  private readonly host: HandshakeHost;
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {
    this.host = new HandshakeHost(state.storage, engineFactoryForDO(state.storage, env));
  }
  async fetch(req: Request): Promise<Response> {
    return handleHostRequest(this.host, this.state.storage, req);
  }
}
