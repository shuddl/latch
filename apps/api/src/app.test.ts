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

const FIXTURE_990 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/990/sample-990-001.edi', import.meta.url)),
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

  it('accretes the Spec Library on a passing certification, exposed via /v1/spec-library', async () => {
    const { conn, map } = await onboardCertified(h);
    // Before certifying, the library is empty.
    expect(await h.json(await h.call('/v1/spec-library'))).toHaveLength(0);

    await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });

    const lib = await h.json(await h.call('/v1/spec-library'));
    expect(lib).toHaveLength(1);
    expect(lib[0].transactionSet).toBe('214');
    expect(lib[0].provenByCerts).toBe(1);

    // Re-certifying the same connection's map increments the proof count, not the entry count.
    await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    const lib2 = await h.json(await h.call('/v1/spec-library'));
    expect(lib2).toHaveLength(1);
    expect(lib2[0].provenByCerts).toBe(2);

    // The proven spec is fetchable and is a real map artifact.
    const spec = await h.json(await h.call(`/v1/spec-library/${lib2[0].id}`));
    expect(spec.transactionSet).toBe('214');
    expect(spec.recordKind).toBe('StatusEvent');
    void conn;
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

  it('onboards a second transaction set (990) end-to-end via the registry', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'Carrier Co' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '990', connectivity: { type: 'sftp' } },
      }),
    );
    await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples: [FIXTURE_990] } });

    // The default 990 map (resolved through the registry) certifies at the bar.
    const map = await h.json(await h.call(`/v1/connections/${conn.id}/maps`, { method: 'POST', body: {} }));
    const certRes = await h.call(`/v1/maps/${map.id}/certify`, { method: 'POST', body: {} });
    expect(certRes.status).toBe(200);
    expect((await h.json(certRes)).passed).toBe(true);

    await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} });
    const ingest = await h.json(
      await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: FIXTURE_990 } }),
    );
    expect(ingest.transaction.status).toBe('transformed');
    expect(ingest.transaction.transactionSet).toBe('990');

    // The canonical TenderResponse carries the codemapped decision.
    const detail = await h.json(await h.call(`/v1/transactions/${ingest.transaction.id}`));
    expect(detail.canonical[0].kind).toBe('TenderResponse');
    expect(detail.canonical[0].decision).toBe('accept');
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

  it('rejects an oversized sample upload (PG-5 input-size limit)', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'Big' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
      }),
    );
    const huge = 'X'.repeat(1_000_001); // 1 byte over the 1MB per-sample cap
    const res = await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples: [huge] } });
    expect(res.status).toBe(400);
    expect((await h.json(res)).error.code).toBe('VALIDATION');
  });

  it('rejects too many sample files in one upload (PG-5 count cap)', async () => {
    const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'Many' } }));
    const conn = await h.json(
      await h.call('/v1/connections', {
        method: 'POST',
        body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'sftp' } },
      }),
    );
    const samples = Array.from({ length: 51 }, () => 'ST*214*1~SE*1*1~');
    const res = await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples } });
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

  // ── Certifying a partner's OWN files (not the repo fixture) ────────────────────
  describe('partner samples must be confirmed before a map can certify', () => {
    // A different, equally valid partner 214: other PRO, city and time.
    const PARTNER_214 = FIXTURE_214.replace('0510938', '7777001')
      .replace('MEMPHIS*TN', 'CHICAGO*IL')
      .replace('20260618*1300', '20260701*0915');

    async function onboard(samples: string[], rules?: unknown) {
      const partner = await h.json(await h.call('/v1/partners', { method: 'POST', body: { name: 'Partner' } }));
      const conn = await h.json(
        await h.call('/v1/connections', {
          method: 'POST',
          body: { partnerId: partner.id, direction: 'inbound', transactionSet: '214', connectivity: { type: 'api' } },
        }),
      );
      await h.call(`/v1/connections/${conn.id}/samples`, { method: 'POST', body: { samples } });
      const map = await h.json(
        await h.call(`/v1/connections/${conn.id}/maps`, { method: 'POST', body: rules ? { rules } : {} }),
      );
      return { conn, map };
    }
    const review = async (mapId: string) => (await h.json(await h.call(`/v1/maps/${mapId}/samples`))).samples;
    const certify = (mapId: string) => h.call(`/v1/maps/${mapId}/certify`, { method: 'POST', body: {} });

    it('blocks an unconfirmed sample, then certifies once the operator confirms it', async () => {
      const { conn, map } = await onboard([PARTNER_214]);

      const blocked = await certify(map.id);
      expect(blocked.status).toBe(422);
      const report = await h.json(await h.call(`/v1/certifications/${(await h.json(blocked)).id}/report`));
      expect(report.result.shortfalls).toHaveLength(1);
      expect(report.result.shortfalls[0]).toMatch(/sample 1: .*has not been confirmed/);

      // The review shows what the map read, for a person to check.
      const [sample] = await review(map.id);
      expect(sample.confirmedBy).toBeNull();
      expect(sample.reading[0]).toMatchObject({
        kind: 'StatusEvent',
        shipmentId: '7777001',
        occurredAt: '2026-07-01T09:15:00',
        location: { city: 'CHICAGO', state: 'IL' },
      });
      expect(JSON.stringify(sample.reading)).not.toContain('__edi');

      const confirm = await h.call(`/v1/connections/${conn.id}/samples/${sample.hash}/confirm`, {
        method: 'POST',
        body: { expected: sample.reading },
      });
      expect(confirm.status).toBe(200);
      expect((await review(map.id))[0].confirmedBy).toBe('operator');

      const passed = await certify(map.id);
      expect(passed.status).toBe(200);
      expect((await h.json(passed)).passed).toBe(true);
      expect((await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} })).status).toBe(200);
    });

    it('the repo reference fixture is pre-confirmed (its expected output is hand-verified)', async () => {
      const { map } = await onboard([FIXTURE_214]);
      expect((await review(map.id))[0].confirmedBy).toBe('reference');
      expect((await certify(map.id)).status).toBe(200);
    });

    it('a confirmed expectation fails a map that reads the wrong element', async () => {
      // Confirm the truth using the correct map…
      const good = await onboard([PARTNER_214]);
      const [sample] = await review(good.map.id);
      await h.call(`/v1/connections/${good.conn.id}/samples/${sample.hash}/confirm`, {
        method: 'POST',
        body: { expected: sample.reading },
      });
      // …then register a map on the same connection that reads the state into the city.
      const wrong = JSON.parse(JSON.stringify(MAP_214_STATUSEVENT));
      delete wrong.compiledHash;
      wrong.rules.find((r: Json) => r.path === 'location.city').source.element = 2;
      const bad = await h.json(
        await h.call(`/v1/connections/${good.conn.id}/maps`, { method: 'POST', body: { rules: wrong } }),
      );
      const res = await certify(bad.id);
      expect(res.status).toBe(422);
      const report = await h.json(await h.call(`/v1/certifications/${(await h.json(res)).id}/report`));
      expect(report.result.records[0].forwardMatch).toBe(false);
    });

    it('every uploaded sample needs its own confirmation', async () => {
      const second = PARTNER_214.replace('7777001', '7777002');
      const { conn, map } = await onboard([PARTNER_214, second]);
      const samples = await review(map.id);
      expect(samples).toHaveLength(2);
      await h.call(`/v1/connections/${conn.id}/samples/${samples[0].hash}/confirm`, {
        method: 'POST',
        body: { expected: samples[0].reading },
      });
      expect((await certify(map.id)).status).toBe(422); // sample 2 still unconfirmed
      await h.call(`/v1/connections/${conn.id}/samples/${samples[1].hash}/confirm`, {
        method: 'POST',
        body: { expected: samples[1].reading },
      });
      expect((await certify(map.id)).status).toBe(200);
    });

    it('rejects a confirmation for an unknown sample, a bad body, or another tenant', async () => {
      const { conn, map } = await onboard([PARTNER_214]);
      const [sample] = await review(map.id);
      const path = `/v1/connections/${conn.id}/samples/${sample.hash}/confirm`;
      expect((await h.call(`/v1/connections/${conn.id}/samples/deadbeef/confirm`, { method: 'POST', body: { expected: sample.reading } })).status).toBe(404);
      expect((await h.call(path, { method: 'POST', body: { expected: [] } })).status).toBe(400);
      expect((await h.call(path, { method: 'POST', body: { expected: [{ kind: 'Nope' }] } })).status).toBe(400);
      expect((await h.call(path, { method: 'POST', org: 'other', body: { expected: sample.reading } })).status).toBe(404);
      expect((await certify(map.id)).status).toBe(422); // none of those confirmed anything
    });

    it('self-heal shadow re-certifies against the confirmed partner corpus', async () => {
      const { conn, map } = await onboard([PARTNER_214]);
      const [sample] = await review(map.id);
      await h.call(`/v1/connections/${conn.id}/samples/${sample.hash}/confirm`, { method: 'POST', body: { expected: sample.reading } });
      await certify(map.id);
      await h.call(`/v1/connections/${conn.id}/go-live`, { method: 'POST', body: {} });

      // Additive drift on live traffic: a new L11 qualifier value.
      const drifted = PARTNER_214.replace('L11*BOL12345*BM', 'L11*BOL12345*ZZ');
      const res = await h.json(await h.call(`/v1/connections/${conn.id}/ingest`, { method: 'POST', body: { raw: drifted } }));
      expect(res.drift).toBeTruthy();
      expect(JSON.parse(res.drift.detail).shadowPassed).toBe(true);
      expect(res.drift.status).toBe('auto_applied');
    });
  });
});
