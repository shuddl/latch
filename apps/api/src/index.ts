// apps/api — Cloudflare Worker entry. Builds the production D1+R2 store per request
// and mounts the control-plane app (docs/08). Durable Objects are exported for the
// declared bindings; behavior arrives in M2 (ConnectionDO) and M6 (HandshakeDO).

import { createApp } from './app';
import { D1R2Store } from './store/d1r2';
import type { Env } from './env';

const app = createApp((env) => new D1R2Store(env.LATCH_DB, env.LATCH_R2, env.LATCH_KV));

export default app;

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
