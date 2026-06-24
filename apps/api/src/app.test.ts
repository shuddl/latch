import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import type { LlmClient } from '@latch/shared';
import { createApp } from './app';
import { InMemoryStore } from './store/memory';
import type { Env } from './env';

// Fake build-time AI: returns rules for the map-generator prompt, a spec otherwise.
const fakeLlm = (): LlmClient => ({
  extractJson: async ({ system }) =>
    system.includes('transform rules')
      ? MAP_214_STATUSEVENT.rules
      : { transactionSet: '214', x12Version: '004010', segments: [], deviations: [], confidence: 1 },
});

const FIXTURE_214 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/214/sample-214-001.edi', import.meta.url)),
  'utf8',
).trim();

const ENV = {} as Env; // InMemoryStore ignores bindings

// Test-only loose JSON shape so property access in assertions stays readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function harness(getLlm: (env: Env) => LlmClient | null = () => null) {
  const store = new InMemoryStore();
  const app = createApp(() => store, getLlm);
  const call = (
    path: string,
    init: { method?: string; body?: unknown; org?: string; idemKey?: string } = {},
  ) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init.org) headers['X-Latch-Dev-Org'] = init.org;
    if (init.idemKey) headers['Idempotency-Key'] = init.idemKey;
    return app.request(
      path,
      {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      ENV,
    );
  };
  const json = (res: { json: () => Promise<unknown> }): Promise<Json> => res.json() as Promise<Json>;
  return { call, json };
}

type Harness = ReturnType<typeof harness>;

async function onboardCertified(h: Harness, org = 'default') {
  const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'R&L' }, org }));
  const conn = await h.json(
    await h.call('/v1/connections', {
      method: 'POST',
      org,
      body: {
        partnerId: partner.id,
        direction: 'inbound',
        transactionSet: '214',
        connectivity: { type: 'sftp', secretRef: 's' },
      },
    }),
  );
  await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', org, body: { samples: [FIXTURE_214] } });
  const map = await h.json(await h.call(`/v1/connections/${conn.id}/maps`, { method: 'POST', org, body: {} }));
  return { partner, conn, map };
}

describe('control-plane API', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('health is ok', async () => {
    const res = await h.call('/v1/health');
    expect(res.status).toBe(200);
    expect((await h.json(res)).status).toBe('ok');
  });

  it('runs the full hero flow: onboard → certify (PASS) → report → go-live', async () => {
    const { conn, map } = await onboardCertified(h);

    const certRes = await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    expect(certRes.status).toBe(200);
    const cert = await h.json(certRes);
    expect(cert.passed).toBe(true);
    expect(cert.roundtripFidelity).toBeGreaterThanOrEqual(0.999);

    const report = await h.json(await h.call(`/v1/certifications/${cert.id}/report`));
    expect(report.result.passed).toBe(true);
    expect(Array.isArray(report.result.records)).toBe(true);

    const live = await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} });
    expect(live.status).toBe(200);
    expect((await h.json(live)).status).toBe('production');

    const detail = await h.json(await h.call(`/v1/connections/${conn.id}`));
    expect(detail.activeMap.id).toBe(map.id);
    expect(detail.latestCert.passed).toBe(true);
  });

  it('processes live inbound traffic: ingest → transaction + 997, dedup, replay', async () => {
    const { conn, map } = await onboardCertified(h);
    await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} });

    // First ingest → 201, transformed, with an accepted 997.
    const first = await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: FIXTURE_214 } });
    expect(first.status).toBe(201);
    const ingest = await h.json(first);
    expect(ingest.duplicate).toBe(false);
    expect(ingest.transaction.status).toBe('transformed');
    expect(ingest.ackStatus).toBe('accepted');
    expect(ingest.ack).toContain('997');

    // Index + detail.
    const list = await h.json(await h.call(`/v1/connections/${conn.id}/transactions`));
    expect(list.length).toBe(1);
    const detail = await h.json(await h.call(`/v1/transactions/${ingest.transaction.id}`));
    expect(detail.canonical[0].statusCode).toBe('X1');

    // Re-ingesting the same control numbers is a no-op duplicate (200), still one txn.
    const dup = await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: FIXTURE_214 } });
    expect(dup.status).toBe(200);
    expect((await h.json(dup)).duplicate).toBe(true);
    expect((await h.json(await h.call(`/v1/connections/${conn.id}/transactions`))).length).toBe(1);

    // Replay recomputes through the current map (dry run).
    const replay = await h.json(
      await h.call(`/v1/transactions/${ingest.transaction.id}/replay`, { method: 'POST', body: {} }),
    );
    expect(replay.outcome.status).toBe('transformed');
    expect(replay.outcome.canonical[0].statusCode).toBe('X1');
  });

  it('self-heals: a drifted file opens a drift event; breaking drift awaits approval', async () => {
    const { conn, map } = await onboardCertified(h);
    await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} });

    // Additive drift: a new qualifier value on L11 — auto-applied, nothing to do.
    const additive = FIXTURE_214.replace('L11*BOL12345*BM~', 'L11*BOL12345*ZZ~');
    const r1 = await h.json(await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: additive } }));
    expect(r1.drift).toBeTruthy();
    expect(r1.drift.status).toBe('auto_applied');

    // Breaking drift: a brand-new segment — re-certified in shadow, held for approval.
    // Distinct ST control (part of the dedup key) so it isn't collapsed against the
    // additive case above, while keeping the interchange internally consistent.
    const breaking = FIXTURE_214.replace('ST*214*0001~', 'ST*214*0002~').replace(
      'MS1*MEMPHIS*TN*US~SE*7*0001~',
      'MS1*MEMPHIS*TN*US~N9*ZP*EXTRA~SE*8*0002~',
    );
    const r2 = await h.json(await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: breaking } }));
    expect(r2.drift.status).toBe('awaiting_approval');

    // The drift timeline lists both; approving the pending one applies it.
    const list = await h.json(await h.call(`/v1/connections/${conn.id}/drift`));
    expect(list.length).toBe(2);
    const approved = await h.json(await h.call(`/v1/drift/${r2.drift.id}/approve`, { method: 'POST', body: {} }));
    expect(approved.status).toBe('applied');

    // Approving an already-resolved event is a clean conflict.
    const again = await h.call(`/v1/drift/${r2.drift.id}/approve`, { method: 'POST', body: {} });
    expect(again.status).toBe(409);

    // Dismissing an already-resolved (auto-applied) event is likewise a conflict.
    const dismissResolved = await h.call(`/v1/drift/${r1.drift.id}/dismiss`, { method: 'POST', body: {} });
    expect(dismissResolved.status).toBe(409);
  });

  it('generates a map from samples via build-time AI, which then certifies', async () => {
    const hg = harness(() => fakeLlm());
    const partner = await hg.json(await hg.call('/v1/partners', { method: 'POST', body: { name: 'R&L' } }));
    const conn = await hg.json(
      await hg.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
      }),
    );
    await hg.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples: [FIXTURE_214] } });

    const gen = await hg.call(`/v1/connections/${conn.id}/generate-map`, { method: 'POST', body: {} });
    expect(gen.status).toBe(201);
    const map = await hg.json(gen);
    expect(map.compiledHash).toBeTruthy();

    // The generated map must pass the Proof — the engine, not the model, is the gate.
    const cert = await hg.json(await hg.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} }));
    expect(cert.passed).toBe(true);
  });

  it('generate-map is a clean 422 without the AI key', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'R&L' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
      }),
    );
    await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples: [FIXTURE_214] } });
    const res = await h.call(`/v1/connections/${conn.id}/generate-map`, { method: 'POST', body: {} });
    expect(res.status).toBe(422);
  });

  it('rejects ingest on a connection that is not live (409)', async () => {
    const { conn } = await onboardCertified(h); // certified path not run → still draft
    const res = await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: FIXTURE_214 } });
    expect(res.status).toBe(409);
  });

  it('a semantically broken map fails the bar (422) and cannot go live (409)', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'R&L' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: {
          partnerId: partner.id,
          direction: 'inbound',
          transactionSet: '214',
          connectivity: { type: 'sftp' },
        },
      }),
    );
    await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples: [FIXTURE_214] } });

    // statusCode reads B10-03 (SCAC) instead of AT7-01 — structurally valid, semantically wrong.
    const brokenRules = {
      ...MAP_214_STATUSEVENT,
      compiledHash: undefined,
      rules: MAP_214_STATUSEVENT.rules.map((r) =>
        r.kind === 'element' && r.path === 'statusCode'
          ? { ...r, source: { tag: 'B10', occurrence: 0, element: 3 } }
          : r,
      ),
    };
    const map = await h.json(
      await h.call(`/v1/connections/${conn.id}/maps`, { method: 'POST', body: { rules: brokenRules } }),
    );

    const certRes = await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    expect(certRes.status).toBe(422);
    expect((await h.json(certRes)).passed).toBe(false);

    const live = await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} });
    expect(live.status).toBe(409);
  });

  it('rejects a map whose direction does not match the connection', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'R&L' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
      }),
    );
    const outboundMap = { ...MAP_214_STATUSEVENT, compiledHash: undefined, direction: 'outbound' };
    const res = await h.call(`/v1/connections/${conn.id}/maps`, { method: 'POST', body: { rules: outboundMap } });
    expect(res.status).toBe(400);
    expect((await h.json(res)).error.code).toBe('VALIDATION');
  });

  it('certify without samples is a clean 400', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'X' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
      }),
    );
    const map = await h.json(await h.call(`/v1/connections/${conn.id}/maps`, { method: 'POST', body: {} }));
    const res = await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect((await h.json(res)).error.code).toBe('VALIDATION');
  });

  it('validates request bodies', async () => {
    const res = await h.call('/v1/partners', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect((await h.json(res)).error.code).toBe('VALIDATION');
  });

  it('rejects a connection to an unknown partner', async () => {
    const res = await h.call('/v1/connections', {
      method: 'POST',
      body: { partnerId: 'ptr_nope', direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
    });
    expect(res.status).toBe(400);
  });

  it('isolates tenants', async () => {
    const partner = await h.json(
      await h.call('/v1/partners', { method: 'POST', body: { name: 'Secret' }, org: 'org-a' }),
    );
    expect((await h.call(`/v1/partners/${partner.id}`, { org: 'org-a' })).status).toBe(200);
    expect((await h.call(`/v1/partners/${partner.id}`, { org: 'org-b' })).status).toBe(404);
  });

  it('replays idempotent POSTs', async () => {
    const a = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'Once' }, idemKey: 'k-1' }));
    const b = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'Once' }, idemKey: 'k-1' }));
    expect(a.id).toBe(b.id);
    expect((await h.json(await h.call('/v1/partners'))).length).toBe(1);
  });
});
