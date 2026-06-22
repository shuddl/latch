import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import { createApp } from './app';
import { InMemoryStore } from './store/memory';
import type { Env } from './env';

const FIXTURE_214 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/214/sample-214-001.edi', import.meta.url)),
  'utf8',
).trim();

const ENV = {} as Env; // InMemoryStore ignores bindings

// Test-only loose JSON shape so property access in assertions stays readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function harness() {
  const store = new InMemoryStore();
  const app = createApp(() => store);
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
