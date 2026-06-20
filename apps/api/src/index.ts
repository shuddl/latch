// apps/api — Cloudflare Worker: REST control plane (docs/08).
// M0 scope: /v1/health + dev-stub auth + declared bindings. Real endpoints land in M1.

import { Hono } from 'hono';

export interface Env {
  LATCH_DB: D1Database;
  LATCH_KV: KVNamespace;
  LATCH_R2: R2Bucket;
  TXN_INGEST: Queue;
  TXN_EGRESS: Queue;
  RECERT: Queue;
  CONNECTION_DO: DurableObjectNamespace;
  HANDSHAKE_DO: DurableObjectNamespace;
  LATCH_DEV_DEFAULT_ORG?: string;
}

type Variables = { tenantId: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Dev-stub auth (CLAUDE.md §2.3): X-Latch-Dev-Org → tenant_id. The API shape does
// not change when Clerk lands at M5; only this middleware is replaced.
app.use('*', async (c, next) => {
  const org = c.req.header('X-Latch-Dev-Org') ?? c.env.LATCH_DEV_DEFAULT_ORG ?? 'default';
  c.set('tenantId', org);
  await next();
});

app.get('/v1/health', (c) =>
  c.json({
    status: 'ok',
    service: 'latch-api',
    tenant: c.get('tenantId'),
    time: new Date().toISOString(),
  }),
);

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }, 404),
);

export default app;

// Minimal Durable Objects so bindings are real and deployable. Behavior arrives in
// M2 (ConnectionDO: control-number sequencing) and M6 (HandshakeDO: HSP state).
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
