import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryAdapter } from '@latch/connectivity';
import { MAP_214_STATUSEVENT } from '@latch/transform';
import { InMemoryStore } from './store/memory';
import { ingestFromAdapter } from './connectivity';
import type { Connection } from './domain';

const FIXTURE_214 = readFileSync(
  fileURLToPath(new URL('../../../fixtures/214/sample-214-001.edi', import.meta.url)),
  'utf8',
).trim();

// Stand up a live (production) 214 connection directly in the store — the transport test
// cares about the drain→ingest path, not the onboarding flow (covered by app.test.ts).
async function liveConnection(store: InMemoryStore): Promise<Connection> {
  const tenantId = 'default';
  const partner = await store.createPartner(tenantId, { name: 'Carrier' });
  const conn = await store.createConnection(tenantId, {
    partnerId: partner.id,
    direction: 'inbound',
    transactionSet: '214',
    x12Version: '004010',
    connectivity: { type: 'sftp' },
  });
  const map = await store.createMap(tenantId, {
    connectionId: conn.id,
    transactionSet: '214',
    direction: 'inbound',
    canonicalVersion: '1',
    compiledHash: MAP_214_STATUSEVENT.compiledHash!,
    artifact: MAP_214_STATUSEVENT,
  });
  await store.updateConnection(tenantId, conn.id, { status: 'production', activeMapId: map.id });
  return (await store.getConnection(tenantId, conn.id))!;
}

describe('ingestFromAdapter — transport → pipeline, no network or credentials', () => {
  it('drains an SFTP-style drop into transactions and sends a 997 back', async () => {
    const store = new InMemoryStore();
    const conn = await liveConnection(store);
    const adapter = new InMemoryAdapter([{ name: 'inbound-214.edi', content: FIXTURE_214 }]);

    const res = await ingestFromAdapter(store, 'default', conn, adapter);

    expect(res.processed).toEqual(['inbound-214.edi']);
    expect(res.failed).toEqual([]);
    // A transaction was persisted via the same pipeline the HTTP path uses.
    const txns = await store.listTransactions('default', conn.id);
    expect(txns.length).toBe(1);
    expect(txns[0]!.status).toBe('transformed');
    // The 997 went back out the same transport, and the inbound file was acked (archived).
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0]!.content).toContain('997');
    expect(adapter.acked).toEqual(['inbound-214.edi']);
    expect(await adapter.poll()).toEqual([]);
  });

  it('re-delivery is a safe no-op (control-number dedup), not a duplicate transaction', async () => {
    const store = new InMemoryStore();
    const conn = await liveConnection(store);

    await ingestFromAdapter(store, 'default', conn, new InMemoryAdapter([{ name: 'a.edi', content: FIXTURE_214 }]));
    // Same interchange arrives again on a fresh poll.
    await ingestFromAdapter(store, 'default', conn, new InMemoryAdapter([{ name: 'a.edi', content: FIXTURE_214 }]));

    const txns = await store.listTransactions('default', conn.id);
    expect(txns.length).toBe(1); // deduped on control numbers
  });

  it('refuses to drain a connection that is not live', async () => {
    const store = new InMemoryStore();
    const tenantId = 'default';
    const partner = await store.createPartner(tenantId, { name: 'Carrier' });
    const draft = await store.createConnection(tenantId, {
      partnerId: partner.id,
      direction: 'inbound',
      transactionSet: '214',
      x12Version: '004010',
      connectivity: { type: 'sftp' },
    });
    const adapter = new InMemoryAdapter([{ name: 'x.edi', content: FIXTURE_214 }]);
    await expect(ingestFromAdapter(store, tenantId, draft, adapter)).rejects.toThrow(/not live/);
  });
});
