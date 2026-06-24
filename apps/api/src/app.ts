// The Latch control-plane API (docs/08). Pure of any specific storage or runtime:
// `createApp` takes a Store factory, so the same app runs on Cloudflare (D1R2Store)
// and in tests (InMemoryStore via `app.request()`). Deterministic engine wired in;
// no LLM on this path.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { LatchError, createLogger, newId } from '@latch/shared';
import {
  computeCompiledHash,
  mapArtifactSchema,
  type MapArtifact,
} from '@latch/transform';
import { certify } from '@latch/verify';
import { processInbound } from '@latch/pipeline';
import { ingestSpec } from '@latch/spec';
import { generateMap } from '@latch/mapgen';
import type { LlmClient } from '@latch/shared';
import type { AppEnv, Env } from './env';
import type { Store } from './store/store';
import {
  addSamplesInput,
  boundedText,
  createConnectionInput,
  createPartnerInput,
  goLiveInput,
  LIMITS,
} from './domain';
import { ingestInbound } from './ingest';
import { transactionSetDef, SUPPORTED_TRANSACTION_SETS } from './transaction-sets';
import { z } from 'zod';

const ORG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Resp {
  status: ContentfulStatusCode;
  body: unknown;
}

/**
 * Parse + Zod-validate a JSON body, raising a typed VALIDATION error on failure.
 * An empty body is treated as `undefined` so endpoints whose schema is fully
 * optional (e.g. `z.object({...}).default({})`) accept a bodyless POST instead of
 * 400ing — required-body schemas still reject `undefined` as before.
 */
async function readJson<S extends z.ZodTypeAny>(
  c: { req: { text: () => Promise<string> } },
  schema: S,
): Promise<z.infer<S>> {
  const body = (await c.req.text()).trim();
  let raw: unknown;
  if (body === '') {
    raw = undefined;
  } else {
    try {
      raw = JSON.parse(body);
    } catch {
      throw new LatchError('VALIDATION', 'Request body must be valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new LatchError('VALIDATION', 'Request did not pass validation', {
      detail: parsed.error.flatten(),
    });
  }
  return parsed.data;
}

export function createApp(
  getStore: (env: Env) => Store,
  getLlm: (env: Env) => LlmClient | null = () => null,
): Hono<AppEnv> {
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
    c.set('llm', getLlm(c.env));
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
      const def = transactionSetDef(connection.transactionSet);
      let artifact: MapArtifact;
      if (body.rules) {
        artifact = body.rules;
      } else if (def) {
        artifact = def.defaultMap; // hand-authored stand-in (AI mapgen needs the key)
      } else {
        throw new LatchError(
          'UNSUPPORTED',
          `No default map for ${connection.transactionSet} (supported: ${SUPPORTED_TRANSACTION_SETS}); provide an explicit map in "rules".`,
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

  // ── Generate a map from the guide + samples (build-time AI) ──────────────────
  app.post('/v1/connections/:id/generate-map', (c) =>
    idempotent(c, async () => {
      const store = c.get('store');
      const tenantId = c.get('tenantId');
      const llm = c.get('llm');
      const connection = await store.getConnection(tenantId, c.req.param('id'));
      if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');
      if (!llm) {
        throw new LatchError(
          'UNSUPPORTED',
          'AI map generation needs ANTHROPIC_API_KEY; register an explicit map instead.',
        );
      }
      const def = transactionSetDef(connection.transactionSet);
      if (!def) {
        throw new LatchError(
          'UNSUPPORTED',
          `Generation for ${connection.transactionSet} is not supported yet (supported: ${SUPPORTED_TRANSACTION_SETS}).`,
        );
      }
      const samples = await store.getSamples(tenantId, connection.id);
      if (samples.length === 0) {
        throw new LatchError('VALIDATION', 'Upload sample EDI before generating a map.');
      }
      const body = await readJson(
        c,
        z.object({ guideText: boundedText(LIMITS.maxGuideBytes, 'The companion guide').optional() }).default({}),
      );

      const { spec, lowConfidence } = await ingestSpec(llm, {
        transactionSet: connection.transactionSet,
        x12Version: connection.x12Version,
        ...(body.guideText ? { guideText: body.guideText } : {}),
        samples,
      });
      const artifact = await generateMap(llm, spec, {
        direction: connection.direction,
        canonicalVersion: '1',
        recordKind: def.recordKind,
      });
      const record = await store.createMap(tenantId, {
        connectionId: connection.id,
        transactionSet: connection.transactionSet,
        direction: artifact.direction,
        canonicalVersion: artifact.canonicalVersion,
        compiledHash: artifact.compiledHash ?? computeCompiledHash(artifact),
        artifact,
      });
      c.get('log').info('map generated', { connectionId: connection.id, mapId: record.id, lowConfidence });
      return { status: 201, body: { ...record, lowConfidence } };
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

    const def = transactionSetDef(record.transactionSet);
    if (!def) {
      throw new LatchError(
        'UNSUPPORTED',
        `Corpus synthesis for ${record.transactionSet} is not supported yet (supported: ${SUPPORTED_TRANSACTION_SETS}).`,
      );
    }
    const samples = await store.getSamples(tenantId, record.connectionId);
    if (samples.length === 0) {
      throw new LatchError('VALIDATION', 'Upload at least one sample EDI file before certifying.');
    }

    const corpus = def.buildCorpus(samples[0]!.trim());
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

    // The Spec Library accretes on every PASSING cert — each pass is independent proof that
    // this spec works (docs/04 the moat). Best-effort: never fail the cert on a library hiccup.
    if (result.passed) {
      try {
        const connection = await store.getConnection(tenantId, record.connectionId);
        if (connection) {
          await store.accreteSpecLibrary(tenantId, {
            partnerSignature: `${tenantId}::${connection.partnerId}`,
            transactionSet: record.transactionSet,
            x12Version: artifact.x12Version,
            spec: artifact,
          });
        }
      } catch (err) {
        c.get('log').error('spec-library accretion failed (non-fatal)', { error: String(err) });
      }
    }

    c.get('log').info('certification complete', { mapId, certId: cert.id, passed: result.passed });
    return c.json(cert, result.passed ? 200 : 422);
  });

  // The accreting Spec Library — proven specs available for reuse (the network moat).
  app.get('/v1/spec-library', async (c) => {
    const { transactionSet } = c.req.query();
    return c.json(
      await c.get('store').listSpecLibrary(c.get('tenantId'), {
        ...(transactionSet ? { transactionSet } : {}),
      }),
    );
  });
  app.get('/v1/spec-library/:id', async (c) => {
    const spec = await c.get('store').getSpecLibrarySpec(c.get('tenantId'), c.req.param('id'));
    if (!spec) throw new LatchError('NOT_FOUND', 'Spec not found');
    return c.json(spec);
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

  // ── Live traffic ─────────────────────────────────────────────────────────────
  // Inbound ingest (API/webhook transport; SFTP/AS2 adapters enqueue the same work).
  app.post('/v1/connections/:id/ingest', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const connection = await store.getConnection(tenantId, c.req.param('id'));
    if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');
    if (connection.status !== 'production' || !connection.activeMapId) {
      throw new LatchError('CONFLICT', 'Connection is not live; certify and go live first.');
    }
    const artifact = await store.getMapArtifact(tenantId, connection.activeMapId);
    if (!artifact) throw new LatchError('INTERNAL', 'Active map artifact missing');

    const { raw } = await readJson(c, z.object({ raw: boundedText(LIMITS.maxIngestBytes, 'The inbound EDI payload') }));
    const result = await ingestInbound(store, tenantId, connection, connection.activeMapId, artifact, raw);
    c.get('log').info('ingest', {
      connectionId: connection.id,
      txnId: result.transaction.id,
      status: result.transaction.status,
      duplicate: result.duplicate,
    });
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.get('/v1/connections/:id/transactions', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const connection = await store.getConnection(tenantId, c.req.param('id'));
    if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    return c.json(await store.listTransactions(tenantId, connection.id, limit));
  });

  app.get('/v1/transactions/:id', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const txn = await store.getTransaction(tenantId, c.req.param('id'));
    if (!txn) throw new LatchError('NOT_FOUND', 'Transaction not found');
    const canonical = await store.getTransactionCanonical(tenantId, txn.id);
    return c.json({ ...txn, canonical });
  });

  // Replay a stored transaction through the current (or a specified) map — a dry run
  // that recomputes canonical + ack without persisting, for diffing and debugging.
  app.post('/v1/transactions/:id/replay', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const txn = await store.getTransaction(tenantId, c.req.param('id'));
    if (!txn) throw new LatchError('NOT_FOUND', 'Transaction not found');
    const raw = await store.getTransactionRawIn(tenantId, txn.id);
    if (!raw) throw new LatchError('NOT_FOUND', 'Raw inbound for this transaction is unavailable');

    const body = await readJson(c, z.object({ mapId: z.string().optional() }).default({}));
    const connection = await store.getConnection(tenantId, txn.connectionId);
    const mapId = body.mapId ?? connection?.activeMapId ?? txn.mapId;
    if (!mapId) throw new LatchError('CONFLICT', 'No map to replay through.');
    const artifact = await store.getMapArtifact(tenantId, mapId);
    if (!artifact) throw new LatchError('NOT_FOUND', 'Map not found');

    const outcome = processInbound(raw, artifact);
    return c.json({ transactionId: txn.id, mapId, outcome });
  });

  // ── Self-heal (drift) ────────────────────────────────────────────────────────
  app.get('/v1/connections/:id/drift', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const connection = await store.getConnection(tenantId, c.req.param('id'));
    if (!connection) throw new LatchError('NOT_FOUND', 'Connection not found');
    return c.json(await store.listDriftEvents(tenantId, connection.id));
  });

  app.get('/v1/drift/:id', async (c) => {
    const ev = await c.get('store').getDriftEvent(c.get('tenantId'), c.req.param('id'));
    if (!ev) throw new LatchError('NOT_FOUND', 'Drift event not found');
    return c.json(ev);
  });

  app.post('/v1/drift/:id/approve', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const ev = await store.getDriftEvent(tenantId, c.req.param('id'));
    if (!ev) throw new LatchError('NOT_FOUND', 'Drift event not found');
    if (ev.status !== 'awaiting_approval') {
      throw new LatchError('CONFLICT', `Drift event is ${ev.status}, not awaiting approval.`);
    }
    return c.json(await store.updateDriftEvent(tenantId, ev.id, { status: 'applied', resolvedAt: Date.now() }));
  });

  app.post('/v1/drift/:id/dismiss', async (c) => {
    const store = c.get('store');
    const tenantId = c.get('tenantId');
    const ev = await store.getDriftEvent(tenantId, c.req.param('id'));
    if (!ev) throw new LatchError('NOT_FOUND', 'Drift event not found');
    if (ev.status === 'applied' || ev.status === 'dismissed' || ev.status === 'auto_applied') {
      throw new LatchError('CONFLICT', `Drift event is already resolved (${ev.status}).`);
    }
    return c.json(await store.updateDriftEvent(tenantId, ev.id, { status: 'dismissed', resolvedAt: Date.now() }));
  });

  return app;
}

