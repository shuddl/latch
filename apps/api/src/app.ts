// The Latch control-plane API (docs/08). Pure of any specific storage or runtime:
// `createApp` takes a Store factory, so the same app runs on Cloudflare (D1R2Store)
// and in tests (InMemoryStore via `app.request()`). Deterministic engine wired in;
// no LLM on this path.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { LatchError, createLogger, newId } from '@latch/shared';
import {
  MAP_214_STATUSEVENT,
  computeCompiledHash,
  mapArtifactSchema,
  type MapArtifact,
} from '@latch/transform';
import { buildCorpus214, certify } from '@latch/verify';
import type { AppEnv, Env } from './env';
import type { Store } from './store/store';
import {
  addSamplesInput,
  createConnectionInput,
  createPartnerInput,
  goLiveInput,
} from './domain';
import { z } from 'zod';

const ORG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Resp {
  status: ContentfulStatusCode;
  body: unknown;
}

/** Parse + Zod-validate a JSON body, raising a typed VALIDATION error on failure. */
async function readJson<S extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new LatchError('VALIDATION', 'Request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new LatchError('VALIDATION', 'Request did not pass validation', {
      detail: parsed.error.flatten(),
    });
  }
  return parsed.data;
}

export function createApp(getStore: (env: Env) => Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── Cross-cutting middleware ───────────────────────────────────────────────
  app.use('*', async (c, next) => {
    const requestId = c.req.header('X-Request-Id') ?? newId('transaction');
    const fallback = c.env.LATCH_DEV_DEFAULT_ORG ?? 'default';
    const header = c.req.header('X-Latch-Dev-Org');
    const tenantId = header && ORG_RE.test(header) ? header : fallback;

    c.set('requestId', requestId);
    c.set('tenantId', tenantId);
    c.set('store', getStore(c.env));
    c.set('log', createLogger({ requestId, tenantId, path: c.req.path, method: c.req.method }));
    c.header('X-Request-Id', requestId);
    await next();
  });

  app.onError((errRaw, c) => {
    if (errRaw instanceof LatchError) {
      return c.json(errRaw.toEnvelope(), errRaw.status as ContentfulStatusCode);
    }
    c.get('log')?.error('Unhandled error', { error: String(errRaw) });
    return c.json(
      { error: { code: 'INTERNAL', message: 'Something went wrong on our end.' } },
      500,
    );
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }, 404));

  // Run a mutating handler under optional Idempotency-Key replay protection.
  async function idempotent(c: Context<AppEnv>, run: () => Promise<Resp>) {
    const key = c.req.header('Idempotency-Key');
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    if (key) {
      const cached = await store.getIdempotent(tenantId, key);
      if (cached) return c.json(cached.body, cached.status as ContentfulStatusCode);
    }
    const res = await run();
    if (key && res.status < 300) await store.putIdempotent(tenantId, key, res);
    return c.json(res.body, res.status);
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/v1/health', (c) =>
    c.json({ status: 'ok', service: 'latch-api', tenant: c.get('tenantId'), time: new Date().toISOString() }),
  );

  // ── Partners ─────────────────────────────────────────────────────────────────
  app.post('/v1/partners', (c) =>
    idempotent(c, async () => {
      const input = await readJson(c, createPartnerInput);
      const partner = await c.get('store').createPartner(c.get('tenantId'), input);
      return { status: 201, body: partner };
    }),
  );
  app.get('/v1/partners', async (c) =>
    c.json(await c.get('store').listPartners(c.get('tenantId'))),
  );
  app.get('/v1/partners/:id', async (c) => {
    const partner = await c.get('store').getPartner(c.get('tenantId'), c.req.param('id'));
    if (!partner) throw new LatchError('NOT_FOUND', 'Partner not found');
    return c.json(partner);
  });

  // ── Connections ──────────────────────────────────────────────────────────────
  app.post('/v1/connections', (c) =>
    idempotent(c, async () => {
      const input = await readJson(c, createConnectionInput);
      const store = c.get('store');
      const tenantId = c.get('tenantId');
      const partner = await store.getPartner(tenantId, input.partnerId);
      if (!partner) throw new LatchError('VALIDATION', `Unknown partnerId ${input.partnerId}`);
      const connection = await store.createConnection(tenantId, input);
      return { status: 201, body: connection };
    }),
  );
  app.get('/v1/connections', async (c) => {
    const { partnerId, status } = c.req.query();
    return c.json(
      await c.get('store').listConnections(c.get('tenantId'), {
        ...(partnerId ? { partnerId } : {}),
        ...(status ? { status } : {}),
      }),
    );
  });
  app.get('/v1/connections/:id', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const connection = await store.getConnection(tenantId, c.req.param('id'));
    if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');
    const maps = await store.listMapsByConnection(tenantId, connection.id);
    const activeMap = connection.activeMapId
      ? await store.getMap(tenantId, connection.activeMapId)
      : null;
    const latestCert = activeMap?.latestCertId
      ? await store.getCertification(tenantId, activeMap.latestCertId)
      : null;
    return c.json({ ...connection, maps, activeMap, latestCert });
  });

  // ── Samples (drop the partner's EDI) ─────────────────────────────────────────
  app.post('/v1/connections/:id/samples', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const connection = await store.getConnection(tenantId, c.req.param('id'));
    if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');
    const { samples } = await readJson(c, addSamplesInput);
    const total = await store.addSamples(tenantId, connection.id, samples);
    return c.json({ connectionId: connection.id, sampleCount: total });
  });

  // ── Maps (register the declarative map; default to the 214 map) ──────────────
  app.post('/v1/connections/:id/maps', (c) =>
    idempotent(c, async () => {
      const store = c.get('store');
      const tenantId = c.get('tenantId');
      const connection = await store.getConnection(tenantId, c.req.param('id'));
      if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');

      const body = await readJson(c, z.object({ rules: mapArtifactSchema.optional() }).default({}));
      let artifact: MapArtifact;
      if (body.rules) {
        artifact = body.rules;
      } else if (connection.transactionSet === '214') {
        artifact = MAP_214_STATUSEVENT; // hand-authored stand-in until mapgen (needs Anthropic key)
      } else {
        throw new LatchError(
          'UNSUPPORTED',
          `No generator yet for ${connection.transactionSet}; provide an explicit map in "rules" (mapgen arrives in M3).`,
        );
      }

      if (artifact.direction !== connection.direction) {
        throw new LatchError(
          'VALIDATION',
          `Map direction (${artifact.direction}) must match the connection direction (${connection.direction}).`,
        );
      }

      const record = await store.createMap(tenantId, {
        connectionId: connection.id,
        transactionSet: connection.transactionSet,
        direction: artifact.direction,
        canonicalVersion: artifact.canonicalVersion,
        compiledHash: computeCompiledHash(artifact),
        artifact,
      });
      return { status: 201, body: record };
    }),
  );

  // ── Certify (the Proof) ──────────────────────────────────────────────────────
  app.post('/v1/maps/:id/certify', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const mapId = c.req.param('id');

    const record = await store.getMap(tenantId, mapId);
    if (!record) throw new LatchError('NOT_FOUND', 'Map not found');
    const artifact = await store.getMapArtifact(tenantId, mapId);
    if (!artifact) throw new LatchError('INTERNAL', 'Map artifact missing');

    if (record.transactionSet !== '214') {
      throw new LatchError(
        'UNSUPPORTED',
        `Corpus synthesis for ${record.transactionSet} arrives in M3; only 214 is certifiable today.`,
      );
    }
    const samples = await store.getSamples(tenantId, record.connectionId);
    if (samples.length === 0) {
      throw new LatchError('VALIDATION', 'Upload at least one sample EDI file before certifying.');
    }

    const corpus = buildCorpus214(samples[0]!.trim());
    const result = certify(artifact, corpus);

    const cert = await store.createCertification(tenantId, {
      mapId,
      connectionId: record.connectionId,
      result,
    });
    await store.updateMap(tenantId, mapId, {
      latestCertId: cert.id,
      ...(result.passed ? { status: 'certified' as const } : {}),
    });

    c.get('log').info('certification complete', { mapId, certId: cert.id, passed: result.passed });
    return c.json(cert, result.passed ? 200 : 422);
  });

  app.get('/v1/certifications/:id', async (c) => {
    const cert = await c.get('store').getCertification(c.get('tenantId'), c.req.param('id'));
    if (!cert) throw new LatchError('NOT_FOUND', 'Certification not found');
    return c.json(cert);
  });

  app.get('/v1/certifications/:id/report', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const cert = await store.getCertification(tenantId, c.req.param('id'));
    if (!cert) throw new LatchError('NOT_FOUND', 'Certification not found');
    const result = await store.getCertificationResult(tenantId, cert.id);
    return c.json({ certification: cert, result });
  });

  // ── Go live (promote a certified map → production) ───────────────────────────
  app.post('/v1/connections/:id/go-live', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const connection = await store.getConnection(tenantId, c.req.param('id'));
    if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');

    const body = await readJson(c, goLiveInput);
    // Choose the map: explicit, else the connection's most recently certified map.
    const maps = await store.listMapsByConnection(tenantId, connection.id);
    const chosen = body.mapId
      ? maps.find((m) => m.id === body.mapId)
      : maps.filter((m) => m.status === 'certified').sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!chosen) throw new LatchError('CONFLICT', 'No certified map to promote; certify first.');

    const cert = chosen.latestCertId
      ? await store.getCertification(tenantId, chosen.latestCertId)
      : null;
    if (!cert?.passed) {
      throw new LatchError('CONFLICT', 'That map has not passed certification at the benchmark bar.');
    }

    await store.updateMap(tenantId, chosen.id, { status: 'production' });
    const updated = await store.updateConnection(tenantId, connection.id, {
      status: 'production',
      activeMapId: chosen.id,
    });
    return c.json(updated);
  });

  return app;
}
