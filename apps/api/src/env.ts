// apps/api — runtime bindings + per-request context (docs/04, docs/08).

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

import type { Store } from './store/store';
import type { Logger } from '@latch/shared';

export type Variables = {
  tenantId: string;
  requestId: string;
  store: Store;
  log: Logger;
};

export type AppEnv = { Bindings: Env; Variables: Variables };
