// apps/api — Cloudflare Worker entry. Hosts the control-plane HTTP API and the
// inbound transaction-processing queue consumer, both backed by the production D1+R2
// store (docs/04, docs/08). Durable Objects are exported for the declared bindings.

import { createApp } from './app';
import { D1R2Store } from './store/d1r2';
import { KvRateLimiter } from './ratelimit';
import { ingestInbound } from './ingest';
import { createAnthropicClient } from '@latch/shared';
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

export class ConnectionDO {
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}
  async fetch(): Promise<Response> {
    return new Response('ConnectionDO: not yet implemented', { status: 501 });
  }
}

export class HandshakeDO {
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}
  async fetch(): Promise<Response> {
    return new Response('HandshakeDO: not yet implemented', { status: 501 });
  }
}
